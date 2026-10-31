#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# -eq 2 && "$2" =~ ^[a-f0-9]{64}$ ]] || { printf 'Usage: restore-drill.sh BACKUP EXPECTED_SHA256\n' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
work=$(mktemp -d /tmp/vantis-restore-drill.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
# The archive digest proves the extracted bytes, not the completeness of
# publication evidence. Missing report/receipt or empty file index must block.
python3 "$script_dir/bundle.py" extract "$1" "$work/restored" --sha256 "$2" --kind backup >/dev/null
python3 "$script_dir/restore-verify.py" "$work/restored"
