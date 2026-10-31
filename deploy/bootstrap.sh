#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
# Offline application bundle; optional official Node runtime download is explicit.
[[ $EUID -eq 0 && $# -ge 2 && $# -le 3 && "$2" =~ ^[a-f0-9]{64}$ ]] || { printf 'Usage: bootstrap.sh /absolute/release.tar EXPECTED_SHA256 [--install-node]\n' >&2; exit 1; }
install_node=false
if [[ $# -eq 3 ]]; then [[ "$3" == --install-node ]] || exit 1;install_node=true;fi
[[ "$1" == /* && -f "$1" && ! -L "$1" ]] || exit 1
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
for command in python3 sha256sum mktemp; do command -v "$command" >/dev/null; done
work=$(mktemp -d /tmp/vantis-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
python3 "$script_dir/bundle.py" extract "$1" "$work/source" --sha256 "$2" >/dev/null
chmod 0755 "$work"
find "$work/source" -type d -exec chmod 0755 {} +
find "$work/source" -type f -exec chmod 0644 {} +
# P0: runtime installation changes /opt/vantis-node. Require a trusted,
# root-controlled verifier and a signed approval BEFORE running install-node.sh.
# This deliberately fails closed on fresh hosts until an authorized Workbench
# administrator stages the verifier and a usable preflight Node independently.
verifier=/opt/vantis/deployment/release-authorization.mjs
preflight_node=${NODE_BIN:-$(command -v node || true)}
[[ -n "$preflight_node" && -x "$preflight_node" ]] || { printf 'RELEASE_AUTH_PREFLIGHT_NODE_REQUIRED\\n' >&2; exit 1; }
preflight_node=$(readlink -f -- "$preflight_node")
python3 - "$verifier" "$preflight_node" <<'PYTRUST' || { printf 'RELEASE_AUTH_TRUSTED_RUNTIME_REQUIRED\\n' >&2; exit 1; }
import os, stat, sys
from pathlib import Path
for path, is_file in ((Path(sys.argv[1]), True), (Path(sys.argv[2]), True)):
    if not path.is_absolute(): sys.exit(1)
    for entry in (*reversed(path.parents), path):
        try: mode = os.lstat(entry)
        except OSError: sys.exit(1)
        if mode.st_uid != 0 or mode.st_mode & 0o022 or stat.S_ISLNK(mode.st_mode): sys.exit(1)
        if entry == path:
            if not stat.S_ISREG(mode.st_mode): sys.exit(1)
        elif not stat.S_ISDIR(mode.st_mode): sys.exit(1)
PYTRUST
"$preflight_node" "$verifier" "$work/source/vantis-manifest.json" >/dev/null || { printf 'SIGNED_RELEASE_APPROVAL_REQUIRED_BEFORE_RUNTIME_INSTALL\\n' >&2; exit 1; }
candidate=${NODE_BIN:-$(command -v node || true)}
usable=false
if [[ -n "$candidate" && -x "$candidate" ]]; then
  candidate=$(readlink -f "$candidate")
  case "$candidate" in /root/*|/home/*|/run/user/*) ;; *)
    if "$candidate" --input-type=module -e 'import * as h from "node:http";const [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<14||typeof h.setGlobalProxyFromEnv!=="function"||!AbortSignal.any)process.exit(1)' 2>/dev/null;then usable=true;fi;;
  esac
fi
if [[ "$usable" != true ]]; then
  [[ "$install_node" == true ]] || { printf 'SYSTEM_NODE_24_14_REQUIRED; rerun with --install-node for the pinned official runtime.\n' >&2;exit 1; }
  candidate=$(bash "$work/source/deploy/install-node.sh")
fi
NODE_BIN="$candidate" bash "$work/source/deploy/install.sh" "$work/source"
