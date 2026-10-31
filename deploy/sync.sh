#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Private repository sync with an exact-SHA, external root-owned release gate.
# A successful unit-test run alone NEVER authorizes a production version change.
die() { printf 'Sync blocked: %s\n' "$*" >&2; exit 1; }
[[ "$EUID" -eq 0 ]] || die 'Run this script as root.'
[[ "$#" -eq 0 ]] || die 'Usage: sync.sh'
for command_name in git tar timeout runuser find flock readlink mktemp stat; do
  command -v "$command_name" >/dev/null || die "Missing command: $command_name"
done
for managed_dir in /opt/vantis /opt/vantis/releases /opt/vantis/deployment /etc/vantis /var/lib/vantis-sync; do
  [[ -d "$managed_dir" && ! -L "$managed_dir" ]] || die "Invalid managed directory: $managed_dir"
done
[[ -f /etc/vantis/node-path && ! -L /etc/vantis/node-path ]] || die 'Node path missing.'
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" ]] || die 'Node is unavailable.'

exec 6>/run/lock/vantis-sync.lock
flock -n 6 || die 'Another synchronization is running.'
current_dir=$(readlink -f /opt/vantis/current)
[[ "$current_dir" == /opt/vantis/releases/* && -d "$current_dir" ]] || die 'Invalid current release.'
release_script=/opt/vantis/deployment/release.sh
gate=/opt/vantis/deployment/release-gate.mjs
askpass=/opt/vantis/deployment/private-git-askpass.sh
for file in "$release_script" "$gate" "$askpass"; do
  [[ -f "$file" && ! -L "$file" && $(stat -c '%u' "$file") == 0 ]] || die 'Trusted deployment tooling is missing.'
done
[[ -f /etc/vantis/github-read-token && ! -L /etc/vantis/github-read-token ]] || die 'Private repository credentials are missing.'
[[ $(stat -c '%u:%a' /etc/vantis/github-read-token) == '0:600' ]] || die 'Repository token must be root-owned 0600.'

safe_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
origin='https://github.com/wangxtong/Dimension-Football-.git'
auth_git() {
  timeout 180s env -i PATH="$safe_path" HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 GIT_ASKPASS="$askpass" \
    git -c credential.helper= -c http.sslVerify=true -c http.followRedirects=false \
        -c http.lowSpeedLimit=1 -c http.lowSpeedTime=30 "$@"
}
remote_line=$(auth_git ls-remote --exit-code --refs "$origin" refs/heads/main) \
  || die 'Private main could not be authenticated; old release retained.'
[[ "$remote_line" != *$'\n'* ]] || die 'Multiple remote branch entries.'
read -r remote_commit remote_ref extra <<< "$remote_line"
[[ "$remote_commit" =~ ^[0-9a-fA-F]{40}$ && "$remote_ref" == refs/heads/main && -z "$extra" ]] || die 'Unexpected remote ref.'
remote_commit=$(printf '%s' "$remote_commit" | tr 'A-F' 'a-f')
current_commit=''
if [[ -f "$current_dir/.source-commit" && ! -L "$current_dir/.source-commit" ]]; then
  IFS= read -r current_commit < "$current_dir/.source-commit" || true
fi
[[ "$current_commit" != "$remote_commit" ]] || exit 0

# No approval means NO download, tests-as-promotion or production switch.
"$node_bin" "$gate" "$remote_commit" || die 'Release approval is missing or blocked.'

work_dir=$(mktemp -d /var/lib/vantis-sync/.work.XXXXXXXX)
cleanup() { [[ ! -d "$work_dir" ]] || rm -rf -- "$work_dir"; }
trap cleanup EXIT
chmod 0755 "$work_dir"
git init -q "$work_dir/repository"
chmod 0700 "$work_dir/repository"
auth_git -C "$work_dir/repository" fetch -q --no-tags --depth=1 "$origin" refs/heads/main \
  || die 'Private source fetch failed; old release retained.'
fetched=$(git -C "$work_dir/repository" rev-parse FETCH_HEAD)
[[ "$fetched" == "$remote_commit" ]] || die 'Remote ref advanced during download; retry a later cycle.'
source_dir="$work_dir/source"
mkdir -- "$source_dir"
git -C "$work_dir/repository" archive --format=tar FETCH_HEAD |
  tar --extract --file - --directory "$source_dir" --no-same-owner --no-same-permissions
marker="$source_dir/.vantis-verified-commit"
[[ ! -e "$marker" && ! -L "$marker" ]] || die 'Repository must not supply its own verified-source marker.'
printf '%s\n' "$remote_commit" > "$marker"
chmod 0600 "$marker"
for source_file in package.json collector/run.mjs config/collection.json; do
  [[ -f "$source_dir/$source_file" ]] || die "Missing source file: $source_file"
done
[[ -z $(find "$source_dir" -type l -print -quit) ]] || die 'Pinned source contains symbolic links.'
[[ -d "$source_dir/collector/test" && -d "$source_dir/collector/sources/test" ]] || die 'Tests missing.'
find "$source_dir" -type d -exec chmod 0755 {} +
find "$source_dir" -type f -exec chmod 0644 {} +
# The release script requires this marker to remain root-only.
chmod 0600 "$marker"
mapfile -d '' -t test_files < <(find "$source_dir/collector/test" "$source_dir/collector/sources/test" \
  -type f -name '*.test.mjs' -print0)
(( "${#test_files[@]}" > 0 )) || die 'No tests found.'
printf 'Testing approved exact Git commit: %s\n' "$remote_commit"
if ! (cd -- "$source_dir" && runuser -u vantis -- env -i PATH="$safe_path" \
  HOME=/var/lib/vantis USER=vantis LOGNAME=vantis LANG=C.UTF-8 TMPDIR=/tmp \
  "$node_bin" --test --test-reporter=spec "${test_files[@]}") > "$work_dir/tests.log" 2>&1; then
  tail -n 120 "$work_dir/tests.log" >&2
  die 'Approved source failed local tests; existing version retained.'
fi
tail -n 10 "$work_dir/tests.log"
# Second check covers approval expiration or removal during source download.
"$node_bin" "$gate" "$remote_commit" || die 'Release approval changed before promotion.'
VANTIS_COMMIT="$remote_commit" bash "$release_script" "$source_dir"
printf 'Synchronized approved commit: %s\n' "$remote_commit"
