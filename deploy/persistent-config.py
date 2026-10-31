#!/usr/bin/env python3
"""One explicit production state path; preserve legacy state without migrating it."""
import argparse
import json
import os
from pathlib import Path
import tempfile

PUBLIC_BASE='https://football.fotpredict.xyz/dimension-football/'
STATE_PATHS={'state.json','state/state.json'}

def state_relative(config):
    # Pre-upgrade installations had no selector and always used the root file.
    value=config.get('stateRelativePath','state.json')
    if value not in STATE_PATHS:raise ValueError('STATE_RELATIVE_PATH_INVALID')
    return value

def check_contract(config,contract,state=None):
    selected=state_relative(config)
    # Old releases always used root state.json; do not infer support for new paths.
    if selected not in contract.get('supportedStatePaths',['state.json']):raise ValueError('RELEASE_STATE_PATH_INCOMPATIBLE')
    if state is not None and state.get('version') not in contract.get('supportedStateSchemas',[]):raise ValueError('RELEASE_STATE_SCHEMA_INCOMPATIBLE')
    return {'status':'state_compatible','stateRelativePath':selected}

def configure(path,root,new_config=False):
    path=Path(path);root=Path(root)
    if path.is_symlink():raise ValueError('OPERATIONS_CONFIG_SYMLINK')
    config=json.loads(path.read_text());before=dict(config)
    if new_config or 'stateRelativePath' not in config:
        old=(root/'state.json').is_file();current=(root/'state/state.json').is_file()
        if old and current:raise ValueError('MULTIPLE_STATE_PATHS_REQUIRE_EXPLICIT_SELECTION')
        config['stateRelativePath']='state.json' if old else 'state/state.json'
    state_relative(config)
    if config.get('publicReportOrigin') is None:config['publicReportOrigin']=PUBLIC_BASE
    if config!=before:
        original=path.stat();fd,tmp=tempfile.mkstemp(prefix='.operations.',dir=path.parent)
        try:
            with os.fdopen(fd,'w') as f:
                os.fchmod(f.fileno(),0o640)
                if os.geteuid()==0:os.fchown(f.fileno(),original.st_uid,original.st_gid)
                json.dump(config,f,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
            os.replace(tmp,path)
        finally:
            if os.path.exists(tmp):os.unlink(tmp)
    return {'status':'persistent_path_configured','stateRelativePath':config['stateRelativePath'],'originConfigured':bool(config.get('publicReportOrigin')),'liveAcceptance':'not_verified'}

if __name__=='__main__':
    try:
        parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['configure','state-path','check-contract']);parser.add_argument('contract',nargs='?');parser.add_argument('--new-config',action='store_true');args=parser.parse_args()
        path=Path('/etc/vantis/operations.json');root=Path('/var/lib/vantis')
        if args.mode=='state-path':print(root/state_relative(json.loads(path.read_text())))
        elif args.mode=='check-contract':
            if not args.contract:raise ValueError('RELEASE_CONTRACT_REQUIRED')
            config=json.loads(path.read_text());state_path=root/state_relative(config)
            state=json.loads(state_path.read_text()) if state_path.exists() else None
            print(json.dumps(check_contract(config,json.loads(Path(args.contract).read_text()),state)))
        else:
            if os.geteuid()!=0:raise ValueError('CONFIGURATION_REQUIRES_ROOT')
            print(json.dumps(configure(path,root,args.new_config)))
    except Exception as error:
        code=str(error);print(json.dumps({'status':'failed','code':code if code.replace('_','').isupper() else 'PERSISTENT_CONFIGURATION_FAILED'}));raise SystemExit(1)
