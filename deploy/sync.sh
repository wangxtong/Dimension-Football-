#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
[[ $EUID -eq 0 && $# -eq 0 ]] || exit 1
# Default artifact mode does not attempt anonymous private-repository access.
IFS= read -r mode < /etc/vantis/source-mode
[[ "$mode" == artifact ]] && exit 0
[[ "$mode" == deploy-key ]] || { printf 'SOURCE_MODE_INVALID\n' >&2; exit 1; }
exec 6>/run/lock/vantis-sync.lock
flock -n 6 || exit 0
current_dir=$(readlink -f /opt/vantis/current)
[[ "$current_dir" == /opt/vantis/releases/* ]] || exit 1
safe_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
remote_commit=$(timeout 180s env -i PATH="$safe_path" HOME=/nonexistent bash /opt/vantis/deployment/git-source.sh) \
  || { printf 'PRIVATE_SOURCE_SYNC_FAILED_CURRENT_KEPT\n' >&2; exit 1; }
[[ "$remote_commit" =~ ^[a-f0-9]{40}$ ]] || exit 1
current_commit='';[[ ! -f "$current_dir/.source-commit" ]] || IFS= read -r current_commit < "$current_dir/.source-commit"
[[ "$remote_commit" != "$current_commit" ]] || exit 0
work_dir=$(mktemp -d /var/lib/vantis-sync/.work.XXXXXXXX)
check_dir=$work_dir/check-source
cleanup(){
  if [[ -f "$check_dir/.git" ]]; then
    git -c core.hooksPath=/dev/null --git-dir=/var/lib/vantis-sync/source.git worktree remove --force "$check_dir" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$work_dir"
}
trap cleanup EXIT
python3 /opt/vantis/deployment/bundle.py build /var/lib/vantis-sync/source.git "$remote_commit" "$work_dir/release.tar" >/dev/null
archive_sha=$(sha256sum "$work_dir/release.tar");archive_sha=${archive_sha%% *}
python3 /opt/vantis/deployment/bundle.py extract "$work_dir/release.tar" "$work_dir/source" --sha256 "$archive_sha" >/dev/null
chmod 0755 "$work_dir"
find "$work_dir/source" -type d -exec chmod 0755 {} +
find "$work_dir/source" -type f -exec chmod 0644 {} +
IFS= read -r node_bin < /etc/vantis/node-path
# Read-only Git identity grants no right to activate arbitrary main commits.
"$node_bin" /opt/vantis/deployment/release-authorization.mjs "$work_dir/source/vantis-manifest.json" >/dev/null \
  || { printf 'SIGNED_SOURCE_RELEASE_APPROVAL_MISSING_CURRENT_KEPT\n' >&2; exit 1; }
# Keep regression tests in a separate disposable source checkout, never inside
# the runtime archive or installed release. Both inputs bind to the same SHA.
git -c core.hooksPath=/dev/null --git-dir=/var/lib/vantis-sync/source.git worktree add --detach "$check_dir" "$remote_commit" >/dev/null 2>&1 \
  || { printf 'TEST_SOURCE_PREPARATION_FAILED_CURRENT_KEPT\n' >&2; exit 1; }
[[ "$(git -C "$check_dir" rev-parse HEAD)" == "$remote_commit" ]] || exit 1
find "$check_dir" -type d -exec chmod 0755 {} +
find "$check_dir" -type f -exec chmod 0644 {} +
mapfile -d '' -t tests < <(find "$check_dir/collector/test" "$check_dir/collector/sources/test" "$check_dir/website/test" -name '*.test.mjs' -type f -print0)
(( ${#tests[@]} > 0 )) || exit 1
(cd "$check_dir" && timeout 300s runuser -u vantis-check -- env -i PATH="$safe_path" HOME=/nonexistent TMPDIR=/tmp \
  "$node_bin" --test "${tests[@]}") >/dev/null 2>&1 || { printf 'RELEASE_TESTS_FAILED_CURRENT_KEPT\n' >&2; exit 1; }
python3 /opt/vantis/deployment/bundle.py verify-directory "$work_dir/source" >/dev/null
bash /opt/vantis/deployment/release.sh "$work_dir/source"
