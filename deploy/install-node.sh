#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
# Opt-in, pinned official runtime. Never replaces /usr/bin/node or invokes npm.
[[ $EUID -eq 0 && $# -eq 0 ]] || { printf 'NODE_INSTALL_REQUIRES_ROOT\n' >&2; exit 1; }
version=v24.19.0
case $(uname -m) in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; *) printf 'NODE_ARCH_UNSUPPORTED\n' >&2; exit 1;; esac
for command in curl python3 sha256sum mktemp flock stat; do command -v "$command" >/dev/null; done
[[ ! -L /opt/vantis-node ]] || exit 1
install -d -o root -g root -m 0755 /opt/vantis-node
exec 7>/run/lock/vantis-node-install.lock
flock -w 300 7 || exit 1
target=/opt/vantis-node/node-$version-linux-$arch
[[ ! -L "$target" ]] || exit 1
if [[ -d "$target" ]]; then
  [[ ! -L "$target/bin" && -f "$target/bin/node" && ! -L "$target/bin/node" && $(stat -c %u "$target/bin/node") == 0 && $(stat -c %a "$target/bin/node") == 755 ]] || { printf 'EXISTING_NODE_RUNTIME_INVALID\n' >&2; exit 1; }
  [[ $("$target/bin/node" --version) == "$version" ]] || { printf 'EXISTING_NODE_RUNTIME_INVALID\n' >&2; exit 1; }
  printf '%s\n' "$target/bin/node";exit 0
fi
work=$(mktemp -d /opt/vantis-node/.node-install.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
archive=node-$version-linux-$arch.tar.xz
download(){ curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --silent --show-error --location --max-redirs 3 --retry 2 --connect-timeout 15 --max-time 300 --output "$2" "$1"; }
download "https://nodejs.org/dist/$version/SHASUMS256.txt" "$work/SHASUMS256.txt"
download "https://nodejs.org/dist/$version/$archive" "$work/$archive"
python3 - "$work" "$archive" "$version" "$arch" <<'PYNODE'
import hashlib,re,sys,tarfile
from pathlib import Path
root=Path(sys.argv[1]);archive=sys.argv[2];version=sys.argv[3];arch=sys.argv[4]
matches=[]
for line in (root/'SHASUMS256.txt').read_text().splitlines():
 fields=line.split()
 if len(fields)==2 and fields[1]==archive and re.fullmatch('[a-fA-F0-9]{64}',fields[0]):matches.append(fields[0].lower())
if len(matches)!=1:raise SystemExit('NODE_MANIFEST_ENTRY_INVALID')
path=root/archive
if path.stat().st_size>200_000_000:raise SystemExit('NODE_ARCHIVE_TOO_LARGE')
if hashlib.sha256(path.read_bytes()).hexdigest()!=matches[0]:raise SystemExit('NODE_ARCHIVE_CHECKSUM_MISMATCH')
prefix=f'node-{version}-linux-{arch}'
# Extract just the standalone runtime and license, never archive symlinks/npm hooks.
stage=root/'runtime';(stage/'bin').mkdir(parents=True)
with tarfile.open(path,'r:xz') as tar:
 for name,target in [(prefix+'/bin/node',stage/'bin/node'),(prefix+'/LICENSE',stage/'LICENSE')]:
  members=[m for m in tar.getmembers() if m.name==name]
  if len(members)!=1 or not members[0].isfile() or members[0].size>200_000_000:raise SystemExit('NODE_ARCHIVE_MEMBER_INVALID')
  target.write_bytes(tar.extractfile(members[0]).read())
(stage/'bin/node').chmod(0o755);(stage/'LICENSE').chmod(0o644)
PYNODE
[[ $("$work/runtime/bin/node" --version) == "$version" ]] || exit 1
"$work/runtime/bin/node" --input-type=module -e 'import * as h from "node:http";if(typeof h.setGlobalProxyFromEnv!=="function"||!AbortSignal.any)process.exit(1)'
chown -R root:root "$work/runtime"
chmod 0755 "$work/runtime" "$work/runtime/bin"
mv -T "$work/runtime" "$target"
printf '%s\n' "$target/bin/node"
