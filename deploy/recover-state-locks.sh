#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 && $# -eq 0 ]] || exit 1
# Stop scheduling first; this script never stops or kills a collector for you.
[[ $(systemctl is-active vantis-collector.timer || true) != active ]] || { printf 'STOP_SCHEDULER_BEFORE_RECOVERY\n' >&2; exit 1; }
service_state=$(systemctl show vantis-collector.service --property=ActiveState --value)
[[ "$service_state" == inactive || "$service_state" == failed ]] || exit 1
exec 9>/var/lib/vantis/operations/run.lock
flock -n 9 || exit 1
release=$(readlink -f /opt/vantis/current)
[[ "$release" == /opt/vantis/releases/* ]] || exit 1
IFS= read -r node_bin < /etc/vantis/node-path
state_path=$(python3 /opt/vantis/deployment/persistent-config.py state-path)
for state in "$state_path" /var/lib/vantis/reports/publication.json; do
  [[ ! -f "$state.lock" ]] || runuser -u vantis -- "$node_bin" "$release/collector/recover-lock.mjs" --state "$state"
done
printf 'RECOVERY_CHECK_COMPLETED; only confirmed dead local owners were removed.\n'
