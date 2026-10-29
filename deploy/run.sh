#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Resolve current once so a deployment cannot change code midway through a run.
release_dir=$(readlink -f /opt/vantis/current)
[[ "$release_dir" == /opt/vantis/releases/* && -d "$release_dir" ]] \
  || { printf 'Current release is outside the managed releases directory.\n' >&2; exit 1; }
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" ]] || { printf 'Configured Node.js is unavailable.\n' >&2; exit 1; }
[[ -r /etc/vantis/collector.env ]] || { printf 'Collector environment file is unavailable.\n' >&2; exit 1; }
cd /var/lib/vantis
exec "$node_bin" --env-file=/etc/vantis/collector.env "$release_dir/collector/run.mjs" \
  --state /var/lib/vantis/state.json --out /var/lib/vantis/reports --budget-minutes 20
