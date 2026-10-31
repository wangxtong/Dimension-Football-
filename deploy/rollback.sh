#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
[[ $EUID -eq 0 && $# -eq 1 && "$1" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9]+$ ]] || { printf 'Usage: rollback.sh RELEASE_ID\n' >&2; exit 1; }
release=/opt/vantis/releases/$1
[[ -d "$release" && ! -L "$release" && -f "$release/.release-contract.json" && -f "$release/.release.json" ]] || exit 1
exec 8>/run/lock/vantis-deploy.lock
flock -n 8 || exit 1
exec 9>/var/lib/vantis/operations/run.lock
flock -w 210 9 || exit 1
python3 /opt/vantis/deployment/persistent-config.py check-contract "$release/.release-contract.json" >/dev/null
IFS= read -r node_bin < /etc/vantis/node-path
runuser -u vantis -- "$node_bin" --env-file=/etc/vantis/collector.env "$release/collector/operations.mjs" self-check --root /var/lib/vantis --release "$release" --config /etc/vantis/operations.json
runuser -u vantis -- "$node_bin" "$release/collector/orchestrate.mjs" --help >/dev/null
link=/opt/vantis/.rollback-$$
trap '[[ ! -L "$link" ]] || rm -f -- "$link"' EXIT
ln -s "$release" "$link";mv -Tf "$link" /opt/vantis/current
install -o vantis -g vantis -m 0640 "$release/.release.json" /var/lib/vantis/operations/.release.json.new
mv -T /var/lib/vantis/operations/.release.json.new /var/lib/vantis/operations/release.json
systemctl try-restart vantis-report.service || { printf 'REPORT_SERVICE_RESTART_FAILED\n' >&2; exit 1; }
printf 'ROLLBACK_INSTALLED; persistent state preserved; health/readback verification required.\n'
