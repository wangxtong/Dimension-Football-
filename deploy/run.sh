#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
release_dir=$(readlink -f /opt/vantis/current)
[[ "$release_dir" == /opt/vantis/releases/* && -d "$release_dir" ]] || exit 1
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" ]] || exit 1
cd /var/lib/vantis
# Kernel releases this lock on exit/crash; children inherit it until they exit.
exec 9>/var/lib/vantis/operations/run.lock
flock -n 9 || exit 0
exec "$node_bin" --env-file=/etc/vantis/collector.env "$release_dir/collector/operations.mjs" tick \
  --root /var/lib/vantis --release "$release_dir" --config /etc/vantis/operations.json
