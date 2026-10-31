#!/usr/bin/env bash
set -Eeuo pipefail
# Called only by installed root-owned tooling. Never reads/prints key content.
[[ $EUID -eq 0 ]] || exit 1
key=/etc/vantis/github_deploy_key
hosts=/etc/vantis/github_known_hosts
for path in "$key" "$hosts"; do
  [[ -f "$path" && ! -L "$path" && $(stat -c %u "$path") == 0 ]] || { printf 'GIT_IDENTITY_OR_HOST_KEYS_MISSING\n' >&2; exit 1; }
done
[[ $(stat -c %a "$key") == 600 || $(stat -c %a "$key") == 400 ]] || { printf 'DEPLOY_KEY_PERMISSIONS_INVALID\n' >&2; exit 1; }
[[ $(stat -c %a "$hosts") == 644 || $(stat -c %a "$hosts") == 600 || $(stat -c %a "$hosts") == 400 ]] || exit 1
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND='ssh -F /dev/null -i /etc/vantis/github_deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/vantis/github_known_hosts -o GlobalKnownHostsFile=/dev/null -o ConnectTimeout=15'
export GIT_SSH_VARIANT=ssh
repo=/var/lib/vantis-sync/source.git
[[ ! -L "$repo" ]] || exit 1
if [[ ! -d "$repo" ]]; then git -c init.templateDir= init --bare "$repo" >/dev/null; fi
git -c core.hooksPath=/dev/null -C "$repo" fetch --no-tags --depth=1 \
  git@github.com:wangxtong/Dimension-Football-.git refs/heads/main:refs/heads/main
git -C "$repo" rev-parse refs/heads/main
