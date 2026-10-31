#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
release_dir=$(readlink -f /opt/vantis/current)
[[ "$release_dir" == /opt/vantis/releases/* && -d "$release_dir" ]] || exit 1
IFS= read -r node_bin < /etc/vantis/node-path
# Health never loads provider/notification secrets or performs collection.
exec "$node_bin" "$release_dir/collector/operations.mjs" health --root /var/lib/vantis \
  --release "$release_dir" --config /etc/vantis/operations.json
