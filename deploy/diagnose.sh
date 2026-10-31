#!/usr/bin/env bash
set -Eeuo pipefail
# Read-only: inspect unit metadata, never env/secrets, collection, networking, or service controls.
python3 - <<'PYDIAG'
import json, os, shutil, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path

UNIT_NAMES = ('vantis-collector.service', 'vantis-collector.timer', 'vantis-health.timer',
              'vantis-sync.service', 'vantis-sync.timer', 'vantis-report.service')
REQUIRED_FIELDS = ('LoadState', 'ActiveState', 'SubState', 'Result', 'ExecMainStatus')

def probe(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=4, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip()[:2000] if result.returncode == 0 else None

units, probe_errors = {}, []
for name in UNIT_NAMES:
    output = probe(['systemctl', 'show', name,
                    '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,NextElapseUSecRealtime'])
    values = {}
    if output:
        for line in output.splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                if key in (*REQUIRED_FIELDS, 'NextElapseUSecRealtime') and key not in values:
                    values[key] = value[:120]
    if not all(key in values for key in REQUIRED_FIELDS):
        probe_errors.append(name + ':SYSTEMCTL_PROBE_UNAVAILABLE')
        units[name] = {}
        continue
    # Never output arbitrary unverified command text in a diagnostic receipt.
    if (values['LoadState'] != 'loaded' or values['ActiveState'] not in
            {'active', 'inactive', 'activating', 'deactivating', 'failed'} or
            values['Result'] not in {'success', '', 'exit-code', 'timeout', 'signal', 'core-dump'} or
            not values['ExecMainStatus'].isdigit()):
        probe_errors.append(name + ':UNIT_STATUS_INVALID')
        units[name] = {}
        continue
    units[name] = values
    if (values['ActiveState'] == 'failed' or values['Result'] not in ('', 'success') or
            int(values['ExecMainStatus']) != 0):
        probe_errors.append(name + ':UNIT_RUNTIME_FAILURE')

root = Path('/var/lib/vantis')
release = Path('/opt/vantis/current')
result = {
    'checkedAt': datetime.now(timezone.utc).isoformat(),
    'hostname': os.uname().nodename, 'platform': os.uname().machine,
    'node': probe(['node', '--version']), 'python': probe(['python3', '--version']),
    'units': units, 'probeErrors': probe_errors,
    'diagnosticStatus': 'blocked' if probe_errors else 'inspection_only',
    'productionReleaseStatus': 'BLOCKED', 'journalReviewed': False,
    'currentRelease': str(release.resolve()) if release.exists() else None,
    'statePresent': (root / 'state/state.json').is_file(),
    'legacyStatePresent': (root / 'state.json').is_file(),
    'reportPresent': (root / 'reports/predictions.json').is_file(),
    'healthPresent': (root / 'operations/health.json').is_file(),
    'freeDiskBytes': shutil.disk_usage(root if root.exists() else '/').free,
    'deployKeyPresent': Path('/etc/vantis/github_deploy_key').is_file(),
    'knownHostsPresent': Path('/etc/vantis/github_known_hosts').is_file(),
    'secretsRead': False, 'remoteConnectivityTested': False
}
print(json.dumps(result, ensure_ascii=False, indent=2))
sys.exit(2 if probe_errors else 0)
PYDIAG
