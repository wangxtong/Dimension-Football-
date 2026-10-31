#!/usr/bin/env python3
"""Offline reproducible release archives and bounded, verified recovery snapshots.

SHA256 integrity does not establish provenance: obtain the expected archive digest
from the approved CI result over an authenticated channel before installing.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

MAX_BYTES = 512 * 1024 * 1024
MAX_FILES = 20000
MANIFEST = 'vantis-manifest.json'
ROOTS = {'collector', 'config', 'deploy', 'website', 'scripts'}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def safe_name(name):
    p = PurePosixPath(name)
    return bool(name) and not p.is_absolute() and '..' not in p.parts and str(p) == name and '\\' not in name

def excluded(name):
    parts = PurePosixPath(name).parts
    return any(part in {'.git','node_modules','.auth','.browser-state','storage','browsers','__pycache__','id_rsa','id_ed25519','github_deploy_key'}
               or part.startswith(('.env','runtime-secrets')) or part.endswith(('.auth.json','.pyc','.log','.lock','.pem','.key')) for part in parts)

def write_archive(output, files, metadata):
    if not files or len(files) > MAX_FILES or sum(len(b) for b in files.values()) > MAX_BYTES:
        raise ValueError('BUNDLE_SIZE_INVALID')
    manifest = {'version': 1, **metadata, 'files': {n: {'sha256': digest(b), 'size': len(b)} for n,b in sorted(files.items())}}
    with open(output, 'xb') as raw:
        # gzip timestamps are not used: plain tar is deterministic and works offline.
        with tarfile.open(fileobj=raw, mode='w') as archive:
            for name, data in sorted({**files, MANIFEST: json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()}.items()):
                info = tarfile.TarInfo(name); info.size = len(data); info.mode = 0o640; info.mtime = 0
                archive.addfile(info, io.BytesIO(data))
    return {'kind': metadata['kind'], 'sourceCommit': metadata.get('sourceCommit'), 'sha256': digest(Path(output).read_bytes()), 'files': len(files)}

def build(source, commit, output):
    if not re.fullmatch('[a-f0-9]{40}', commit):
        raise ValueError('FULL_COMMIT_REQUIRED')
    def git(*args):
        return subprocess.check_output(['git','--no-optional-locks','-C',str(source),*args])
    records = git('ls-tree','-r','-z',commit).split(b'\0')
    files = {}
    for record in records:
        if not record: continue
        meta, raw_name = record.split(b'\t',1); mode, kind, oid = meta.split()
        name = raw_name.decode('utf8')
        if PurePosixPath(name).parts[0] not in ROOTS and name != 'package.json': continue
        if excluded(name): continue
        if not safe_name(name) or mode not in {b'100644',b'100755'} or kind != b'blob':
            raise ValueError('UNSAFE_SOURCE_ENTRY')
        files[name] = git('cat-file','blob',oid.decode())
    for required in ['collector/operations.mjs','deploy/release-contract.json','package.json']:
        if required not in files: raise ValueError('RELEASE_INPUT_MISSING')
    contract = json.loads(files['deploy/release-contract.json'])
    return write_archive(output,files,{'kind':'release','sourceCommit':commit,'supportedStateSchemas':contract['supportedStateSchemas'],
        'toolingDigest':digest(b''.join(n.encode()+b'\0'+files[n] for n in sorted(files) if n.startswith('deploy/')))})

def inspect_archive(archive, expected=None, kind=None):
    path = Path(archive)
    if path.stat().st_size > MAX_BYTES + 32 * 1024 * 1024: raise ValueError('ARCHIVE_TOO_LARGE')
    raw = path.read_bytes()
    if expected is not None and (not re.fullmatch('[a-f0-9]{64}',expected) or digest(raw) != expected):
        raise ValueError('ARCHIVE_DIGEST_MISMATCH')
    files = {}; total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as tar:
        for member in tar:
            if not member.isfile() or not safe_name(member.name) or member.name in files:
                raise ValueError('UNSAFE_ARCHIVE_ENTRY')
            total += member.size
            if member.size < 0 or total > MAX_BYTES or len(files) >= MAX_FILES: raise ValueError('ARCHIVE_TOO_LARGE')
            files[member.name] = tar.extractfile(member).read()
    manifest = json.loads(files.pop(MANIFEST))
    if manifest.get('version') != 1 or manifest.get('kind') not in {'release','backup'} or kind and manifest['kind'] != kind:
        raise ValueError('MANIFEST_INVALID')
    if set(files) != set(manifest['files']): raise ValueError('MANIFEST_FILES_MISMATCH')
    for name,data in files.items():
        if manifest['files'][name] != {'sha256':digest(data),'size':len(data)}: raise ValueError('FILE_DIGEST_MISMATCH')
        if excluded(name): raise ValueError('SECRET_OR_RUNTIME_PATH_REJECTED')
    if manifest['kind'] == 'release':
        if not re.fullmatch('[a-f0-9]{40}',manifest.get('sourceCommit','')): raise ValueError('COMMIT_INVALID')
        if any(PurePosixPath(n).parts[0] not in ROOTS and n != 'package.json' for n in files): raise ValueError('RELEASE_PATH_INVALID')
    else:
        for name,data in files.items():
            if not backup_allowed(name): raise ValueError('BACKUP_PATH_INVALID')
            if name.endswith('.json'): json.loads(data)
    return manifest,files

def extract(archive, destination, expected, kind='release'):
    manifest,files = inspect_archive(archive,expected,kind)
    target = Path(destination)
    if target.is_symlink() or target.exists() and any(target.iterdir()): raise ValueError('DESTINATION_NOT_EMPTY')
    target.mkdir(parents=True,exist_ok=True)
    for name,data in files.items():
        out=target/name; out.parent.mkdir(parents=True,exist_ok=True)
        with open(out,'xb') as stream: stream.write(data)
        out.chmod(0o640)
    manifest['archiveSha256']=digest(Path(archive).read_bytes())
    (target/MANIFEST).write_text(json.dumps(manifest,sort_keys=True)+'\n')
    return {'status':'verified_extracted','kind':kind,'files':len(files),'sourceCommit':manifest.get('sourceCommit')}

def backup_allowed(name):
    p=PurePosixPath(name)
    return safe_name(name) and not excluded(name) and (p.parts[0] in {'reports','state','operations'}
        or len(p.parts)==1 and re.fullmatch(r'state\.json(?:\.[a-z-]+\.json)?',name) is not None)

def backup(root, output):
    root=Path(root); files={}
    for path in root.rglob('*'):
        name=path.relative_to(root).as_posix()
        if not backup_allowed(name): continue
        if path.is_symlink(): raise ValueError('BACKUP_SYMLINK_REJECTED')
        if path.is_file(): files[name]=path.read_bytes()
    return write_archive(output,files,{'kind':'backup','stateSchemaVersion':1})

def verify_directory(root):
    root=Path(root)
    manifest=json.loads((root/MANIFEST).read_text())
    if manifest.get('version')!=1 or manifest.get('kind')!='release' or not re.fullmatch('[a-f0-9]{40}',manifest.get('sourceCommit','')):
        raise ValueError('MANIFEST_INVALID')
    actual=set()
    for path in root.rglob('*'):
        if path.is_symlink(): raise ValueError('SOURCE_SYMLINK_REJECTED')
        if not path.is_file():continue
        name=path.relative_to(root).as_posix()
        if name==MANIFEST:continue
        actual.add(name)
        if not safe_name(name) or excluded(name): raise ValueError('SOURCE_PATH_INVALID')
        data=path.read_bytes()
        if manifest['files'].get(name)!={'sha256':digest(data),'size':len(data)}: raise ValueError('FILE_DIGEST_MISMATCH')
    if actual!=set(manifest['files']):raise ValueError('MANIFEST_FILES_MISMATCH')
    return {'status':'verified','sourceCommit':manifest['sourceCommit'],'toolingDigest':manifest['toolingDigest']}

def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='command',required=True)
    b=sub.add_parser('build'); b.add_argument('source');b.add_argument('commit');b.add_argument('output')
    v=sub.add_parser('verify');v.add_argument('archive');v.add_argument('--sha256')
    e=sub.add_parser('extract');e.add_argument('archive');e.add_argument('destination');e.add_argument('--sha256',required=True);e.add_argument('--kind',choices=['release','backup'],default='release')
    b=sub.add_parser('backup');b.add_argument('root');b.add_argument('output')
    d=sub.add_parser('verify-directory');d.add_argument('root')
    a=p.parse_args()
    if a.command=='build':result=build(a.source,a.commit,a.output)
    elif a.command=='verify':
        m,files=inspect_archive(a.archive,a.sha256);result={'status':'verified','kind':m['kind'],'sourceCommit':m.get('sourceCommit'),'files':len(files),'provenanceVerified':bool(a.sha256)}
    elif a.command=='extract': result=extract(a.archive,a.destination,a.sha256,a.kind)
    elif a.command=='verify-directory':result=verify_directory(a.root)
    else:result=backup(a.root,a.output)
    print(json.dumps(result))

if __name__=='__main__':
    try: main()
    except Exception as error:
        code=str(error)
        print(json.dumps({'status':'failed','code':code if re.fullmatch('[A-Z_]{3,80}',code) else 'BUNDLE_OPERATION_FAILED'}))
        raise SystemExit(1)
