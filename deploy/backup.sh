#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $EUID -eq 0 && $# -eq 1 && "$1" == /* && "$1" != /var/lib/vantis/* ]] || { printf 'Usage: backup.sh /absolute/outside-state/backup.tar\n' >&2; exit 1; }
# All production/manual orchestrator runs must use run.sh and this same OS lock.
exec 9>/var/lib/vantis/operations/run.lock
flock -w 210 9 || exit 1
python3 /opt/vantis/deployment/bundle.py backup /var/lib/vantis "$1"
