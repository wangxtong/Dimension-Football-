#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
# Never inherit caller-controlled command search paths during root bootstrap.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Offline application bundle; optional official Node runtime download is explicit.
[[ $EUID -eq 0 && $# -ge 2 && $# -le 3 && "$2" =~ ^[a-f0-9]{64}$ ]] || { printf 'Usage: bootstrap.sh /absolute/release.tar EXPECTED_SHA256 [--install-node]\n' >&2; exit 1; }
install_node=false
if [[ $# -eq 3 ]]; then [[ "$3" == --install-node ]] || exit 1;install_node=true;fi
[[ "$1" == /* && -f "$1" && ! -L "$1" ]] || exit 1
for command in python3 mktemp readlink; do command -v "$command" >/dev/null || exit 1; done
work=$(mktemp -d /tmp/vantis-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
# Before running ANY code delivered in the archive (including bundle.py and
# install-node.sh), verify approval with independently staged root-owned tools.
# If no trusted preflight Node/verifier/bundle parser exists, do not bootstrap.
verifier=/opt/vantis/deployment/release-authorization.mjs
trusted_bundle=/opt/vantis/deployment/bundle.py
preflight_node=${NODE_BIN:-$(command -v node || true)}
[[ -n "$preflight_node" && -x "$preflight_node" ]] || { printf 'RELEASE_AUTH_PREFLIGHT_NODE_REQUIRED\n' >&2; exit 1; }
preflight_node=$(readlink -f -- "$preflight_node")
python3 -I - "$verifier" "$trusted_bundle" "$preflight_node" <<'PYTRUST' || { printf 'RELEASE_AUTH_TRUSTED_RUNTIME_REQUIRED\n' >&2; exit 1; }
import os, stat, sys
from pathlib import Path
for path in map(Path, sys.argv[1:]):
    if not path.is_absolute(): sys.exit(1)
    for entry in (*reversed(path.parents), path):
        try: info = os.lstat(entry)
        except OSError: sys.exit(1)
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode): sys.exit(1)
        if entry == path:
            if not stat.S_ISREG(info.st_mode): sys.exit(1)
        elif not stat.S_ISDIR(info.st_mode): sys.exit(1)
PYTRUST
# Standard-library-only, read-only archive/SHA preflight. No incoming archive
# code runs before the signed manifest identity is independently checked.
python3 -I - "$1" "$2" "$work/preflight-manifest.json" <<'PYMANIFEST' || { printf 'RELEASE_ARCHIVE_PREFLIGHT_FAILED\n' >&2; exit 1; }
import hashlib, json, sys, tarfile
from pathlib import Path
archive_path, expected, out = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
if archive_path.stat().st_size > 544 * 1024 * 1024: sys.exit(1)
h = hashlib.sha256()
with archive_path.open('rb') as src:
    for chunk in iter(lambda: src.read(1024 * 1024), b''): h.update(chunk)
if h.hexdigest() != expected: sys.exit(1)
with tarfile.open(archive_path, mode='r:') as tar:
    found = [item for item in tar if item.name == 'vantis-manifest.json']
    if len(found) != 1 or not found[0].isfile() or found[0].size > 4 * 1024 * 1024: sys.exit(1)
    src = tar.extractfile(found[0])
    if src is None: sys.exit(1)
    manifest = json.loads(src.read())
if not isinstance(manifest, dict) or manifest.get('kind') != 'release': sys.exit(1)
manifest['archiveSha256'] = expected
out.write_text(json.dumps(manifest, sort_keys=True) + '\n')
PYMANIFEST
env -i PATH="$PATH" HOME=/nonexistent "$preflight_node" "$verifier" "$work/preflight-manifest.json" >/dev/null || { printf 'SIGNED_RELEASE_APPROVAL_REQUIRED_BEFORE_RUNTIME_INSTALL\n' >&2; exit 1; }
# The first invocation of code from the release happens only after approval.
python3 -I "$trusted_bundle" extract "$1" "$work/source" --sha256 "$2" >/dev/null
chmod 0755 "$work"
find "$work/source" -type d -exec chmod 0755 {} +
find "$work/source" -type f -exec chmod 0644 {} +
candidate=${NODE_BIN:-$(command -v node || true)}
usable=false
if [[ -n "$candidate" && -x "$candidate" ]]; then
  candidate=$(readlink -f "$candidate")
  case "$candidate" in /root/*|/home/*|/run/user/*) ;; *)
    if env -i PATH="$PATH" HOME=/nonexistent "$candidate" --input-type=module -e 'import * as h from "node:http";const [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<14||typeof h.setGlobalProxyFromEnv!=="function"||!AbortSignal.any)process.exit(1)' 2>/dev/null;then usable=true;fi;;
  esac
fi
if [[ "$usable" != true ]]; then
  [[ "$install_node" == true ]] || { printf 'SYSTEM_NODE_24_14_REQUIRED; rerun with --install-node for the pinned official runtime.\n' >&2;exit 1; }
  candidate=$(bash "$work/source/deploy/install-node.sh")
fi
env -i PATH="$PATH" HOME=/root NODE_BIN="$candidate" bash "$work/source/deploy/install.sh" "$work/source"
