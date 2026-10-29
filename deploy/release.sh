#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Cloud Effect / Yunxiao host deployment command:
# sudo bash /path/to/checked-out-source/deploy/release.sh /path/to/checked-out-source
# Run install.sh once before using this script. No credentials are accepted as arguments.
die() { printf 'Release failed: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run this script as root.'
[[ $# -le 1 ]] || die 'Usage: release.sh [SOURCE_DIR]'
for command_name in tar flock find readlink; do
  command -v "$command_name" >/dev/null || die "Missing command: $command_name"
done
[[ -f /etc/vantis/node-path && ! -L /etc/vantis/node-path ]] || die 'Run deploy/install.sh first.'
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" ]] || die 'The configured Node.js executable is unavailable.'
node_major=$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 24 )) || die 'Node.js 24 or later is required.'

source_dir=$(cd -- "${1:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)
for source_file in package.json collector/run.mjs config/collection.json deploy/run.sh; do
  [[ -f "$source_dir/$source_file" ]] || die "Missing source file: $source_file"
done

exec 9>/run/lock/vantis-deploy.lock
flock -n 9 || die 'Another release is running.'
[[ -d /opt/vantis/releases && ! -L /opt/vantis/releases ]] || die 'Run deploy/install.sh first.'
[[ ! -e /opt/vantis/current || -L /opt/vantis/current ]] || die '/opt/vantis/current must be a symbolic link.'

release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
stage_dir="/opt/vantis/releases/.staging-$release_id"
release_dir="/opt/vantis/releases/$release_id"
link_path="/opt/vantis/.current-$release_id"
cleanup() {
  # These paths are constructed solely from the fixed install root and date/PID.
  [[ ! -d "$stage_dir" ]] || rm -rf -- "$stage_dir"
  [[ ! -L "$link_path" ]] || rm -f -- "$link_path"
}
trap cleanup EXIT
mkdir -- "$stage_dir"

# Copy only runtime source, never the checkout's .git, root .env files, reports,
# checkpoints or other workspace files. Tar does not print file contents or names.
tar -C "$source_dir" --exclude='.env' --exclude='.env.*' --exclude='node_modules' \
  --exclude='*.log' -cf - -- collector config deploy package.json \
  | tar -C "$stage_dir" --no-same-owner --no-same-permissions -xf -
[[ -z $(find "$stage_dir" -type l -print -quit) ]] || die 'Runtime source must not contain symbolic links.'
chown -R root:root "$stage_dir"
find "$stage_dir" -type d -exec chmod 0755 {} +
find "$stage_dir" -type f -exec chmod 0644 {} +
chmod 0755 "$stage_dir"/deploy/*.sh

# This loads the CLI and its imports without network access or state writes.
"$node_bin" "$stage_dir/collector/run.mjs" --help >/dev/null
mv -- "$stage_dir" "$release_dir"
ln -s -- "$release_dir" "$link_path"
mv -Tf -- "$link_path" /opt/vantis/current

# An active collector keeps using its existing release; the next run uses current.
# No release/state/credential directories are deleted or overwritten here.
printf 'Published release: %s\n' "$release_dir"
