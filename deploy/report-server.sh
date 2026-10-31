#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
release=$(readlink -f /opt/vantis/current)
[[ "$release" == /opt/vantis/releases/* && -d "$release" ]] || exit 1
IFS= read -r node_bin < /etc/vantis/node-path
# Separate secret scope: this service never loads provider or Telegram credentials.
exec "$node_bin" --env-file=/etc/vantis/report.env "$release/collector/report-server.mjs"
