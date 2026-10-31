#!/usr/bin/env python3
"""Add only the Dimension Football namespace to the existing HTTPS server.

The CLI is fixed to the approved host/config. Tests inject temporary files and a
fake command runner; they never inspect or modify the actual ECS configuration.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import uuid

CONFIG=Path('/etc/nginx/sites-available/football-prediction')
HOST='football.fotpredict.xyz'
BEGIN='# BEGIN DIMENSION_FOOTBALL_MANAGED_V1'
END='# END DIMENSION_FOOTBALL_MANAGED_V1'
SNIPPET='''    # BEGIN DIMENSION_FOOTBALL_MANAGED_V1
    location = /dimension-football {
        return 308 /dimension-football/;
    }
    location ^~ /dimension-football/ {
        proxy_pass http://127.0.0.1:8787/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 3s;
        proxy_read_timeout 15s;
        proxy_send_timeout 15s;
        client_max_body_size 16k;
        proxy_no_cache 1;
        proxy_cache_bypass 1;
        add_header Cache-Control "no-store" always;
        access_log off;
    }
    # END DIMENSION_FOOTBALL_MANAGED_V1
'''

def tokens(text):
    """Bounded nginx lexical scanner: comments/quoted braces are never blocks."""
    if len(text)>2_000_000:raise ValueError('NGINX_CONFIG_TOO_LARGE')
    result=[];i=0
    while i<len(text):
        if text[i].isspace():i+=1;continue
        if text[i]=='#':
            end=text.find('\n',i);i=len(text) if end<0 else end+1;continue
        start=i
        if text[i] in '{};':result.append((text[i],i,i+1));i+=1;continue
        value=[];quote=None
        while i<len(text):
            c=text[i]
            if c=='\\':
                if i+1>=len(text):raise ValueError('NGINX_PARSE_UNCLOSED_ESCAPE')
                value.append(text[i+1]);i+=2;continue
            if quote:
                if c==quote:quote=None
                else:value.append(c)
                i+=1;continue
            if c in "\"'":quote=c;i+=1;continue
            if c=='$' and i+1<len(text) and text[i+1]=='{':
                end=text.find('}',i+2)
                if end<0:raise ValueError('NGINX_PARSE_UNCLOSED_VARIABLE')
                value.append(text[i:end+1]);i=end+1;continue
            if c.isspace() or c in '{};#':break
            value.append(c);i+=1
        if quote:raise ValueError('NGINX_PARSE_UNCLOSED_QUOTE')
        if i==start:raise ValueError('NGINX_PARSE_INVALID')
        result.append((''.join(value),start,i))
    return result

def parse(text):
    root={'name':'root','args':[],'children':[],'directives':[],'start':0,'open':-1,'end':len(text)}
    stack=[root];pending=[]
    for value,start,end in tokens(text):
        punctuation=text[start:end]==value and value in '{};'
        if punctuation and value=='{':
            if not pending:raise ValueError('NGINX_PARSE_UNEXPECTED_BLOCK')
            child={'name':pending[0][0],'args':[v[0] for v in pending[1:]],'children':[],'directives':[],
                   'start':pending[0][1],'open':start,'end':None}
            stack[-1]['children'].append(child);stack.append(child);pending=[]
        elif punctuation and value==';':
            if not pending:raise ValueError('NGINX_PARSE_EMPTY_DIRECTIVE')
            stack[-1]['directives'].append([v[0] for v in pending]);pending=[]
        elif punctuation and value=='}':
            if pending or len(stack)==1:raise ValueError('NGINX_PARSE_UNEXPECTED_CLOSE')
            stack.pop()['end']=end
        else:pending.append((value,start,end))
    if pending or len(stack)!=1:raise ValueError('NGINX_PARSE_INCOMPLETE')
    return root

def walk(block):
    yield block
    for child in block['children']:yield from walk(child)

def plan(text):
    candidates=[]
    for block in walk(parse(text)):
        names=[d[1:] for d in block['directives'] if d[0]=='server_name']
        listens=[d[1:] for d in block['directives'] if d[0]=='listen']
        if block['name']=='server' and any(HOST in row for row in names) and any(
            row and (row[0]=='443' or row[0].endswith(':443')) for row in listens):candidates.append(block)
    if len(candidates)!=1:raise ValueError('NGINX_TLS_SERVER_NOT_UNIQUE')
    target=candidates[0];body=text[target['open']+1:target['end']-1]
    if text.count(BEGIN)!=text.count(END) or text.count(BEGIN)>1:raise ValueError('NGINX_MANAGED_MARKERS_INVALID')
    if BEGIN in text:
        begin=text.index(BEGIN);end=text.index(END)+len(END)
        if not target['open']<begin<end<target['end']:raise ValueError('NGINX_MANAGED_MARKERS_WRONG_SERVER')
        start=text.rfind('\n',0,begin)+1
        if text[start:begin].strip():raise ValueError('NGINX_MANAGED_MARKER_NOT_STANDALONE')
        finish=text.find('\n',end)
        if finish<0 or text[end:finish].strip():raise ValueError('NGINX_MANAGED_MARKER_NOT_STANDALONE')
        # Preserve all unmanaged content exactly, including any other locations.
        outside=body[:start-target['open']-1]+body[finish+1-target['open']-1:]
        if any('dimension-football' in v for v,_,_ in tokens(outside)):raise ValueError('NGINX_NAMESPACE_CONFLICT')
        updated=text[:start]+SNIPPET+text[finish+1:]
    else:
        if any('dimension-football' in v for v,_,_ in tokens(body)):raise ValueError('NGINX_NAMESPACE_CONFLICT')
        # Insert before the closing brace, preserving that brace's indentation.
        close=target['end']-1;line_start=text.rfind('\n',0,close)+1
        if text[line_start:close].strip():line_start=close
        prefix='\n' if line_start and text[line_start-1]!='\n' else ''
        updated=text[:line_start]+prefix+SNIPPET+text[line_start:]
    parse(updated)
    return updated

def atomic_replace(path,data,metadata):
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.dimension-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as output:
            output.write(data);output.flush();os.fchmod(output.fileno(),stat.S_IMODE(metadata.st_mode))
            if os.geteuid()==0:os.fchown(output.fileno(),metadata.st_uid,metadata.st_gid)
            os.fsync(output.fileno())
        os.replace(tmp,path)
        directory=os.open(path.parent,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def command(args):
    try:return subprocess.run(args,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20,check=False).returncode==0
    except (OSError,subprocess.TimeoutExpired):return False

def apply(path=CONFIG,runner=command):
    path=Path(path);metadata=path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):raise ValueError('NGINX_CONFIG_NOT_REGULAR')
    original=path.read_bytes();candidate=plan(original.decode('utf8')).encode('utf8')
    if original==candidate:
        if not runner(['nginx','-t']):raise ValueError('NGINX_EXISTING_VALIDATION_FAILED')
        return {'status':'unchanged','changed':False,'namespace':'/dimension-football/'}
    backup=path.with_name(path.name+'.dimension-backup.'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'.'+uuid.uuid4().hex[:8])
    with open(backup,'xb') as output:os.fchmod(output.fileno(),0o600);output.write(original);output.flush();os.fsync(output.fileno())
    if path.stat().st_ino!=metadata.st_ino or path.read_bytes()!=original:raise ValueError('NGINX_CONFIG_CHANGED_CONCURRENTLY')
    atomic_replace(path,candidate,metadata)
    valid=runner(['nginx','-t'])
    loaded=valid and runner(['systemctl','reload','nginx'])
    if not loaded:
        if path.read_bytes()!=candidate:raise ValueError('NGINX_CONFIG_CHANGED_RESTORE_SKIPPED')
        atomic_replace(path,original,metadata)
        # A failed validation never changed the active config; a failed reload may have.
        restored=runner(['nginx','-t'])
        if valid and restored:restored=runner(['systemctl','reload','nginx'])
        if not restored:raise ValueError('NGINX_ORIGINAL_RESTORED_MANUAL_RELOAD_REQUIRED')
        raise ValueError('NGINX_VALIDATION_FAILED_RESTORED' if not valid else 'NGINX_RELOAD_FAILED_RESTORED')
    return {'status':'namespace_configured_not_endpoint_verified','changed':True,'namespace':'/dimension-football/',
            'backup':str(backup),'previousSha256':hashlib.sha256(original).hexdigest()}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    if not args.apply:
        text=CONFIG.read_text();print(json.dumps({'status':'plan_only','changeRequired':plan(text)!=text,'target':str(CONFIG),'namespace':'/dimension-football/'}));return
    if os.geteuid()!=0:raise ValueError('NGINX_APPLY_REQUIRES_ROOT')
    with open('/run/lock/dimension-football-nginx.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX);print(json.dumps(apply()))

if __name__=='__main__':
    try:main()
    except Exception as error:
        code=str(error);print(json.dumps({'status':'failed','code':code if code.startswith('NGINX_') and code.replace('_','').isalnum() else 'NGINX_OPERATION_FAILED'}));raise SystemExit(1)
