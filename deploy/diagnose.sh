#!/usr/bin/env bash
set -uo pipefail
# Read-only: no env/secret file reads, service changes, collection or network calls.
python3 - <<'PYDIAG'
import json,os,shutil,subprocess
from datetime import datetime,timezone
from pathlib import Path
def command(args):
 try:return subprocess.run(args,capture_output=True,text=True,timeout=4,check=False).stdout.strip()[:2000]
 except Exception:return None
units={}
for name in ['vantis-collector.service','vantis-collector.timer','vantis-health.timer','vantis-sync.service','vantis-sync.timer','vantis-report.service']:
 text=command(['systemctl','show',name,'--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,NextElapseUSecRealtime'])
 units[name]=dict(line.split('=',1) for line in (text or '').splitlines() if '=' in line)
root=Path('/var/lib/vantis');release=Path('/opt/vantis/current')
result={'checkedAt':datetime.now(timezone.utc).isoformat(),'hostname':os.uname().nodename,'platform':os.uname().machine,
 'node':command(['node','--version']),'python':command(['python3','--version']),'units':units,
 'currentRelease':str(release.resolve()) if release.exists() else None,'statePresent':(root/'state/state.json').is_file(),'legacyStatePresent':(root/'state.json').is_file(),
 'reportPresent':(root/'reports/predictions.json').is_file(),'healthPresent':(root/'operations/health.json').is_file(),
 'freeDiskBytes':shutil.disk_usage(root if root.exists() else '/').free,
 'deployKeyPresent':Path('/etc/vantis/github_deploy_key').is_file(),'knownHostsPresent':Path('/etc/vantis/github_known_hosts').is_file(),
 'secretsRead':False,'remoteConnectivityTested':False}
print(json.dumps(result,ensure_ascii=False,indent=2))
PYDIAG
