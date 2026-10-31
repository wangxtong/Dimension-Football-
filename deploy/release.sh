#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
die(){ printf 'RELEASE_FAILED: %s\n' "$1" >&2; exit 1; }
[[ $EUID -eq 0 && $# -eq 1 ]] || die 'ROOT_AND_VERIFIED_SOURCE_REQUIRED'
source_dir=$(cd -- "$1" && pwd -P)
python3 /opt/vantis/deployment/bundle.py verify-directory "$source_dir" >/dev/null
exec 9>/run/lock/vantis-deploy.lock
flock -n 9 || die 'DEPLOY_ALREADY_RUNNING'
IFS= read -r node_bin < /etc/vantis/node-path
[[ "$node_bin" == /* && -x "$node_bin" && -d /opt/vantis/releases && ! -L /opt/vantis/releases ]] || die 'INSTALL_REQUIRED'
[[ ! -e /opt/vantis/current || -L /opt/vantis/current ]] || die 'CURRENT_MUST_BE_SYMLINK'
python3 /opt/vantis/deployment/persistent-config.py check-contract "$source_dir/deploy/release-contract.json" >/dev/null
release_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
stage=/opt/vantis/releases/.staging-$release_id
release=/opt/vantis/releases/$release_id
link=/opt/vantis/.current-$release_id
trap '[[ ! -d "$stage" ]] || rm -rf -- "$stage"; [[ ! -L "$link" ]] || rm -f -- "$link"' EXIT
mkdir "$stage"
# Verified archive contains only runtime/source allowlisted files; infrastructure remains separate.
cp -R "$source_dir/collector" "$source_dir/config" "$source_dir/website" "$source_dir/package.json" "$stage/"
cp "$source_dir/deploy/release-contract.json" "$stage/.release-contract.json"
python3 - "$source_dir/vantis-manifest.json" "$stage" <<'PYMETA'
import json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());p=Path(sys.argv[2]);(p/'.source-commit').write_text(m['sourceCommit']+'\n')
deployed=Path('/opt/vantis/deployment/.tool-version').read_text().strip()
(p/'.release.json').write_text(json.dumps({'sourceCommit':m['sourceCommit'],'artifactDigest':m.get('archiveSha256'),'sourceToolingDigest':m['toolingDigest'],'deployedToolingDigest':deployed,'supportedStateSchemas':m['supportedStateSchemas']})+'\n')
PYMETA
chown -R root:root "$stage"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
runuser -u vantis -- "$node_bin" --env-file=/etc/vantis/collector.env "$stage/collector/operations.mjs" self-check --root /var/lib/vantis --release "$stage" --config /etc/vantis/operations.json || die 'CAPABILITY_OR_ENTRYPOINT_CHECK_FAILED'
runuser -u vantis -- "$node_bin" "$stage/collector/orchestrate.mjs" --help >/dev/null || die 'ENTRYPOINT_HELP_FAILED'
mv "$stage" "$release"
ln -s "$release" "$link"
mv -Tf "$link" /opt/vantis/current
install -o vantis -g vantis -m 0640 "$release/.release.json" /var/lib/vantis/operations/.release.json.new
mv -T /var/lib/vantis/operations/.release.json.new /var/lib/vantis/operations/release.json
systemctl try-restart vantis-report.service || { printf 'REPORT_SERVICE_RESTART_FAILED; inspect health or rollback.\n' >&2; exit 1; }
printf 'RELEASE_INSTALLED %s; runtime health and report delivery acceptance remain required.\n' "$release_id"
