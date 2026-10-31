#!/usr/bin/env python3
"""Read-only verification of restored publication evidence; never alters production."""
import hashlib
import json
from pathlib import Path
import re
import sys

REPORT_ID = re.compile(r'[a-f0-9]{64}\Z')
BASENAME = re.compile(r'[A-Za-z0-9_.-]+\Z')

def reject(code):
    raise ValueError(code)

def load_object(path):
    if path.is_symlink() or not path.is_file():
        reject('RESTORED_REPORT_RECEIPT_INCOMPLETE')
    try:
        value = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, UnicodeError):
        reject('RESTORED_JSON_INVALID')
    if not isinstance(value, dict):
        reject('RESTORED_JSON_INVALID')
    return value

def verify_restore(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        reject('RESTORED_ROOT_INVALID')
    folder = root / 'reports'
    report_path, receipt_path = folder / 'predictions.json', folder / 'publication.json'
    if not report_path.is_file() and not receipt_path.is_file():
        reject('RESTORED_PUBLICATION_EVIDENCE_MISSING')
    report = load_object(report_path)
    receipt = load_object(receipt_path)
    report_id = receipt.get('reportId')
    if not isinstance(report_id, str) or not REPORT_ID.fullmatch(report_id) or report.get('publication', {}).get('reportId') != report_id:
        reject('RESTORED_REPORT_RECEIPT_MISMATCH')
    if receipt.get('version') != 1 or not isinstance(receipt.get('channels'), dict) or receipt['channels'].get('files', {}).get('status') != 'published':
        reject('RESTORED_PUBLICATION_NOT_COMPLETE')
    files = receipt.get('files')
    if not isinstance(files, list) or not 1 <= len(files) <= 30:
        reject('RESTORED_FILE_INDEX_INVALID')
    visited = set()
    for item in files:
        if not isinstance(item, dict):
            reject('RESTORED_FILE_INDEX_INVALID')
        name, expected = item.get('name'), item.get('sha256')
        if not isinstance(name, str) or not BASENAME.fullmatch(name) or name in {'.', '..'} or name in visited:
            reject('RESTORED_RECEIPT_PATH_INVALID')
        if not isinstance(expected, str) or not REPORT_ID.fullmatch(expected):
            reject('RESTORED_FILE_INDEX_INVALID')
        visited.add(name)
        target = folder / name
        if target.is_symlink() or not target.is_file():
            reject('RESTORED_RECEIPT_FILE_MISSING')
        digest = hashlib.sha256()
        with target.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != expected:
            reject('RESTORED_RECEIPT_DIGEST_MISMATCH')
    if 'predictions.json' not in visited:
        reject('RESTORED_PREDICTIONS_UNINDEXED')
    return {'status': 'restore_drill_passed', 'publicationEvidenceVerified': True,
            'verifiedFiles': len(files), 'productionModified': False, 'notificationsSent': False}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            reject('RESTORE_VERIFY_ARGUMENT_INVALID')
        result = verify_restore(sys.argv[1])
        print(json.dumps(result, separators=(',', ':')))
    except Exception as error:
        code = str(error)
        if not re.fullmatch(r'[A-Z_]{4,80}', code):
            code = 'RESTORED_VALIDATION_FAILED'
        print(json.dumps({'status': 'blocked', 'code': code,
                          'publicationEvidenceVerified': False, 'productionModified': False}))
        raise SystemExit(2)
