#!/usr/bin/env python3
"""Create missing machine tokens without displaying, rotating or exporting them."""
import fcntl
import grp
import json
import os
from pathlib import Path
import re
import secrets
import stat
import tempfile

SPECS=[('report.env','REPORTS_READ_TOKEN',r'[A-Za-z0-9_-]{32,200}'),
       ('collector.env','REPORTS_PROBE_TOKEN',r'[a-f0-9]{64}')]

def read_regular(path):
    try:fd=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
    except FileNotFoundError:return ''
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size>1_000_000:raise ValueError('CREDENTIAL_FILE_INVALID')
        with os.fdopen(fd,'r',encoding='utf8') as source:fd=None;return source.read()
    finally:
        if fd is not None:os.close(fd)

def patch_missing(text,key,pattern):
    lines=text.splitlines(keepends=True);matches=[]
    for i,line in enumerate(lines):
        match=re.match(r'^\s*(?:export\s+)?'+re.escape(key)+r'\s*=\s*(.*?)\s*$',line)
        if match:matches.append((i,match.group(1)))
    if len(matches)>1:raise ValueError('DUPLICATE_MACHINE_TOKEN_ASSIGNMENT')
    if matches:
        i,raw=matches[0]
        parsed=re.fullmatch(r'''(?:'([^']*)'|"([^"]*)"|([^\s#]*))\s*(?:#.*)?''',raw)
        if not parsed:raise ValueError('EXISTING_MACHINE_TOKEN_INVALID')
        value=next((v for v in parsed.groups() if v is not None),'')
        if value:
            if not re.fullmatch(pattern,value):raise ValueError('EXISTING_MACHINE_TOKEN_INVALID')
            return text,False
        lines[i]=key+'='+secrets.token_hex(32)+'\n'
        return ''.join(lines),True
    return text+('' if not text or text.endswith('\n') else '\n')+key+'='+secrets.token_hex(32)+'\n',True

def atomic_secret(path,text,uid,gid):
    fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf8') as output:
            os.fchmod(output.fileno(),0o640)
            if os.geteuid()==0:os.fchown(output.fileno(),uid,gid)
            output.write(text);output.flush();os.fsync(output.fileno())
        os.replace(tmp,path)
        directory=os.open(path.parent,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)

def ensure(directory=Path('/etc/vantis'),uid=0,gid=None):
    directory=Path(directory)
    if directory.is_symlink() or not directory.is_dir():raise ValueError('CREDENTIAL_DIRECTORY_INVALID')
    gid=os.getgid() if gid is None else gid
    fd=os.open(directory/'.machine-token.lock',os.O_RDWR|os.O_CREAT|getattr(os,'O_NOFOLLOW',0),0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX)
        planned=[]
        # Validate both existing assignments before creating either token.
        for name,key,pattern in SPECS:
            path=directory/name;text=read_regular(path);updated,created=patch_missing(text,key,pattern)
            planned.append((path,key,text,updated,created))
        for path,key,original,updated,created in planned:
            if read_regular(path)!=original:raise ValueError('CREDENTIAL_FILE_CHANGED_CONCURRENTLY')
            if created:atomic_secret(path,updated,uid,gid)
            else:
                safe=os.open(path,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0))
                try:
                    os.fchmod(safe,0o640)
                    if os.geteuid()==0:os.fchown(safe,uid,gid)
                finally:os.close(safe)
        return {'status':'machine_tokens_ready','createdKeys':[key for _,key,_,_,created in planned if created],
                'preservedKeys':[key for _,key,_,_,created in planned if not created],'secretValuesPrinted':False}
    finally:os.close(fd)

if __name__=='__main__':
    try:
        if os.geteuid()!=0:raise ValueError('MACHINE_TOKEN_SETUP_REQUIRES_ROOT')
        print(json.dumps(ensure(gid=grp.getgrnam('vantis').gr_gid)))
    except Exception as error:
        code=str(error);print(json.dumps({'status':'failed','code':code if re.fullmatch('[A-Z_]{3,80}',code) else 'MACHINE_TOKEN_SETUP_FAILED'}));raise SystemExit(1)
