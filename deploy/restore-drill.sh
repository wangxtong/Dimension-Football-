#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
[[ $# -eq 2 && "$2" =~ ^[a-f0-9]{64}$ ]] || { printf 'Usage: restore-drill.sh BACKUP EXPECTED_SHA256\n' >&2; exit 1; }
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
work=$(mktemp -d /tmp/vantis-restore-drill.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
python3 "$script_dir/bundle.py" extract "$1" "$work/restored" --sha256 "$2" --kind backup
python3 - "$work/restored" <<'PYVERIFY'
import hashlib,json,sys
from pathlib import Path
root=Path(sys.argv[1]);report=root/'reports/predictions.json';receipt=root/'reports/publication.json'
if report.exists() and receipt.exists():
 r=json.loads(report.read_text());p=json.loads(receipt.read_text())
 if r.get('publication',{}).get('reportId')!=p.get('reportId'):raise SystemExit('RESTORED_REPORT_RECEIPT_MISMATCH')
 for f in p.get('files',[]):
  name=f.get('name','')
  if Path(name).name!=name:raise SystemExit('RESTORED_RECEIPT_PATH_INVALID')
  path=root/'reports'/name
  if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=f.get('sha256'):raise SystemExit('RESTORED_RECEIPT_DIGEST_MISMATCH')
print(json.dumps({'status':'restore_drill_passed','productionModified':False,'notificationsSent':False}))
PYVERIFY
