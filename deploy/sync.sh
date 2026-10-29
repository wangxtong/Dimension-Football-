#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Public Git source polling. No GitHub API, access token or inbound port is used.
die() { printf 'Sync failed: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run this script as root.'
[[ $# -eq 0 ]] || die 'Usage: sync.sh'
for command_name in git curl tar timeout runuser find flock readlink mktemp; do
  command -v "$command_name" >/dev/null || die "Missing command: $command_name"
done
for managed_dir in /opt/vantis /opt/vantis/releases /etc/vantis /var/lib/vantis-sync; do
  [[ -d "$managed_dir" && ! -L "$managed_dir" ]] || die "Invalid managed directory: $managed_dir"
done
[[ -f /etc/vantis/node-path && ! -L /etc/vantis/node-path ]] || die 'The Node.js path file is unavailable.'
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" ]] || die 'The configured Node.js executable is unavailable.'

exec 6>/run/lock/vantis-sync.lock
flock -n 6 || die 'Another synchronization is running.'
current_dir=$(readlink -f /opt/vantis/current)
[[ "$current_dir" == /opt/vantis/releases/* && -d "$current_dir" ]] || die 'Current release is outside the managed releases directory.'
[[ -f "$current_dir/deploy/release.sh" && ! -L "$current_dir/deploy/release.sh" ]] || die 'The installed release script is unavailable.'

# Ignore user/system Git configuration and credential helpers. The source is a
# fixed public HTTPS repository, so this check never needs credentials.
safe_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
remote_line=$(timeout 60s env -i PATH="$safe_path" HOME=/nonexistent \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  git -c credential.helper= -c http.sslVerify=true -c http.followRedirects=false \
  -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 ls-remote --exit-code --refs \
  'https://github.com/wangxtong/Dimension-Football-.git' refs/heads/main) \
  || die 'Cannot resolve the public main branch; the current release was kept.'
[[ "$remote_line" != *$'\n'* ]] || die 'The remote returned more than one branch result.'
read -r remote_commit remote_ref extra <<< "$remote_line"
[[ "$remote_commit" =~ ^[0-9a-fA-F]{40}$ && "$remote_ref" == refs/heads/main && -z "$extra" ]] \
  || die 'The remote returned an invalid branch commit.'
remote_commit=${remote_commit,,}
current_commit=''
if [[ -f "$current_dir/.source-commit" && ! -L "$current_dir/.source-commit" ]]; then
  IFS= read -r current_commit < "$current_dir/.source-commit" || true
fi
[[ "$current_commit" != "$remote_commit" ]] || exit 0

work_dir=$(mktemp -d /var/lib/vantis-sync/.work.XXXXXXXX)
cleanup() {
  # mktemp creates this root-owned directory under the fixed synchronization root.
  [[ ! -d "$work_dir" ]] || rm -rf -- "$work_dir"
}
trap cleanup EXIT
chmod 0755 "$work_dir"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --fail --silent --show-error --location --retry 3 --connect-timeout 15 --max-time 180 \
  --output "$work_dir/source.tar.gz" \
  "https://codeload.github.com/wangxtong/Dimension-Football-/tar.gz/$remote_commit"
source_dir="$work_dir/source"
mkdir -- "$source_dir"
tar --extract --gzip --file "$work_dir/source.tar.gz" --directory "$source_dir" \
  --strip-components=1 --no-same-owner --no-same-permissions
for source_file in package.json collector/run.mjs config/collection.json deploy/run.sh; do
  [[ -f "$source_dir/$source_file" ]] || die "Pinned source is missing: $source_file"
done
[[ -z $(find "$source_dir" -type l -print -quit) ]] || die 'Pinned source must not contain symbolic links.'
[[ -d "$source_dir/collector/test" && -d "$source_dir/collector/sources/test" ]] || die 'Pinned source is missing the test directories.'
# Tests can read source but cannot modify the root-owned deployment input.
find "$source_dir" -type d -exec chmod 0755 {} +
find "$source_dir" -type f -exec chmod 0644 {} +
mapfile -d '' -t test_files < <(find "$source_dir/collector/test" "$source_dir/collector/sources/test" \
  -type f -name '*.test.mjs' -print0)
(( ${#test_files[@]} > 0 )) || die 'Pinned source contains no collector tests.'
printf 'Testing Git commit: %s\n' "$remote_commit"
if ! (cd -- "$source_dir" && runuser -u vantis -- env -i PATH="$safe_path" \
  HOME=/var/lib/vantis USER=vantis LOGNAME=vantis LANG=C.UTF-8 TMPDIR=/tmp \
  "$node_bin" --test --test-reporter=spec "${test_files[@]}") > "$work_dir/tests.log" 2>&1; then
  tail -n 120 "$work_dir/tests.log" >&2
  die "Tests failed for $remote_commit; the current release was kept."
fi
tail -n 10 "$work_dir/tests.log"
# Use the installed root-owned release script, not a script from the download.
VANTIS_COMMIT="$remote_commit" bash "$current_dir/deploy/release.sh" "$source_dir"
printf 'Synchronized Git commit: %s\n' "$remote_commit"
