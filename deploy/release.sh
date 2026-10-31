#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Cloud Effect / Yunxiao host deployment command:
# sudo bash /opt/vantis/deployment/release.sh /path/to/checked-out-source
# Run install.sh once before using this script. No credentials are accepted as arguments.
die() { printf 'Release failed: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run this script as root.'
[[ $# -le 1 ]] || die 'Usage: release.sh [SOURCE_DIR]'
for command_name in tar flock find readlink runuser; do
  command -v "$command_name" >/dev/null || die "Missing command: $command_name"
done
source_commit=${VANTIS_COMMIT:-}
[[ -z "$source_commit" || "$source_commit" =~ ^[0-9a-fA-F]{40}$ ]] || die 'VANTIS_COMMIT must be a full 40-character Git commit SHA.'
[[ -f /etc/vantis/node-path && ! -L /etc/vantis/node-path ]] || die 'Run deploy/install.sh first.'
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" ]] || die 'The configured Node.js executable is unavailable.'
node_major=$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 24 )) || die 'Node.js 24 or later is required.'

source_dir=$(cd -- "${1:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)
for source_file in package.json collector/run.mjs config/collection.json; do
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
# checkpoints, deployment tools or other workspace files. Infrastructure lives
# separately in /opt/vantis/deployment and is never replaced by a Git sync.
tar -C "$source_dir" --exclude='.env' --exclude='.env.*' --exclude='node_modules' \
  --exclude='.auth' --exclude='.browser-state' --exclude='*.auth.json' --exclude='storage' --exclude='browsers' \
  --exclude='*.providers.json' --exclude='*.sources.json' --exclude='*.crawl.json' --exclude='*.lock' \
  --exclude='*.log' -cf - -- collector config package.json \
  | tar -C "$stage_dir" --no-same-owner --no-same-permissions -xf -
[[ -z $(find "$stage_dir" -type l -print -quit) ]] || die 'Runtime source must not contain symbolic links.'
chown -R root:root "$stage_dir"
find "$stage_dir" -type d -exec chmod 0755 {} +
find "$stage_dir" -type f -exec chmod 0644 {} +
if [[ -n "$source_commit" ]]; then
  printf '%s\n' "${source_commit,,}" > "$stage_dir/.source-commit"
  chmod 0644 "$stage_dir/.source-commit"
fi

# This loads the CLI and its imports without network access or state writes.
runuser -u vantis -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  HOME=/var/lib/vantis USER=vantis LOGNAME=vantis LANG=C.UTF-8 \
  "$node_bin" "$stage_dir/collector/run.mjs" --help >/dev/null
mv -- "$stage_dir" "$release_dir"
ln -s -- "$release_dir" "$link_path"
mv -Tf -- "$link_path" /opt/vantis/current

# An active collector keeps using its existing release; the next run uses current.
# No release/state/credential directories are deleted or overwritten here.
printf 'Published release: %s\n' "$release_dir"
[[ -z "$source_commit" ]] || printf 'Source commit: %s\n' "${source_commit,,}"
