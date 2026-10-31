#!/usr/bin/env bash
set -Eeuo pipefail
umask 027
die(){ printf 'INSTALL_FAILED: %s\n' "$1" >&2; exit 1; }
[[ $EUID -eq 0 && $# -eq 1 && -d /run/systemd/system ]] || die 'ROOT_SYSTEMD_AND_VERIFIED_SOURCE_REQUIRED'
source_dir=$(cd -- "$1" && pwd -P)
for command in python3 systemctl getent useradd install flock readlink runuser git timeout sha256sum; do command -v "$command" >/dev/null || die 'REQUIRED_TOOL_MISSING'; done
# Incoming bundle.py is untrusted until independently approved.
exec 8>/run/lock/vantis-install.lock
flock -n 8 || die 'INSTALL_ALREADY_RUNNING'
node_bin=${NODE_BIN:-$(command -v node || true)}
[[ -n "$node_bin" && -x "$node_bin" ]] || die 'SYSTEM_NODE_24_14_REQUIRED'
node_bin=$(readlink -f "$node_bin")
case "$node_bin" in /root/*|/home/*|/run/user/*) die 'NODE_MUST_BE_SYSTEM_WIDE';; esac
# Verify approval before changing accounts, tools, units or persistent state.
# For upgrades prefer the already installed root-controlled verifier, never
# allow incoming release code to weaken an existing production check.
release_verifier=/opt/vantis/deployment/release-authorization.mjs
# Never let a candidate artifact authenticate itself on first installation.
# This verifier must be staged and audited independently by the ECS operator.
trusted_bundle=/opt/vantis/deployment/bundle.py
python3 - "$release_verifier" "$trusted_bundle" "$node_bin" <<'PYTRUST' || die 'ROOT_TRUSTED_VERIFIER_REQUIRED'
import os, stat, sys
from pathlib import Path
p=Path(sys.argv[1])
for entry in (*reversed(p.parents), p):
    try: info=os.lstat(entry)
    except OSError: sys.exit(1)
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode): sys.exit(1)
    if entry == p:
        if not stat.S_ISREG(info.st_mode): sys.exit(1)
    elif not stat.S_ISDIR(info.st_mode): sys.exit(1)
PYTRUST
"$node_bin" --input-type=module -e 'import * as h from "node:http";const [a,b]=process.versions.node.split(".").map(Number);if(a!==24||b<14||typeof h.setGlobalProxyFromEnv!=="function"||!AbortSignal.any)process.exit(1)' || die 'NODE_24_14_CAPABILITY_REQUIRED'
python3 "$trusted_bundle" verify-directory "$source_dir" >/dev/null || die 'TRUSTED_SOURCE_VERIFICATION_FAILED'
"$node_bin" "$release_verifier" "$source_dir/vantis-manifest.json" >/dev/null || die 'SIGNED_RELEASE_APPROVAL_REQUIRED'
if ! getent passwd vantis >/dev/null; then useradd --system --user-group --home-dir /var/lib/vantis --no-create-home --shell /usr/sbin/nologin vantis; fi
if ! getent passwd vantis-check >/dev/null; then useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin vantis-check; fi
[[ $(id -u vantis) -ne 0 ]] || die 'SERVICE_USER_MUST_NOT_BE_ROOT'
[[ $(id -u vantis-check) -ne 0 && " $(id -Gn vantis-check) " != *' vantis '* ]] || die 'TEST_USER_MUST_NOT_READ_PRODUCTION_GROUP'
for dir in /opt/vantis /opt/vantis/releases /opt/vantis/deployment /etc/vantis /var/lib/vantis /var/lib/vantis/operations /var/lib/vantis/state /var/lib/vantis/reports /var/lib/vantis-sync; do [[ ! -L "$dir" ]] || die 'MANAGED_PATH_SYMLINK'; done
install -d -o root -g root -m 0755 /opt/vantis /opt/vantis/releases /opt/vantis/deployment /var/lib/vantis-sync
install -d -o root -g vantis -m 0750 /etc/vantis
install -d -o vantis -g vantis -m 0750 /var/lib/vantis /var/lib/vantis/operations /var/lib/vantis/operations/evidence /var/lib/vantis/state /var/lib/vantis/reports
if [[ ! -e /var/lib/vantis/operations/tasks.json ]]; then install -o vantis -g vantis -m 0640 "$source_dir/deploy/tasks.json" /var/lib/vantis/operations/tasks.json; fi
for file in collector.env report.env operations.json source-mode node-path; do [[ ! -L "/etc/vantis/$file" ]] || die 'CONFIG_SYMLINK'; done
if [[ ! -e /etc/vantis/collector.env ]]; then
  install -o root -g vantis -m 0640 /dev/null /etc/vantis/collector.env
  printf '# Provider and delivery secrets are configured here by the owner; never commit this file.\n' > /etc/vantis/collector.env
fi
if [[ ! -e /etc/vantis/report.env ]]; then
  install -o root -g vantis -m 0640 /dev/null /etc/vantis/report.env
  printf 'REPORTS_DIRECTORY=/var/lib/vantis/reports\nREPORTS_PORT=8787\n# Service tokens are created separately without printing. Loopback only; HTTPS required.\n' > /etc/vantis/report.env
fi
python3 "$source_dir/deploy/ensure-report-secrets.py"
new_config=()
if [[ ! -e /etc/vantis/operations.json ]]; then
  install -o root -g vantis -m 0640 "$source_dir/deploy/operations.json" /etc/vantis/operations.json
  new_config=(--new-config)
fi
python3 "$source_dir/deploy/persistent-config.py" configure "${new_config[@]}"
if [[ ! -e /etc/vantis/source-mode ]]; then printf 'artifact\n' > /etc/vantis/source-mode; chmod 0644 /etc/vantis/source-mode; fi
printf '%s\n' "$node_bin" > /etc/vantis/.node-path.new
chown root:vantis /etc/vantis/.node-path.new;chmod 0640 /etc/vantis/.node-path.new
mv -T /etc/vantis/.node-path.new /etc/vantis/node-path
# Full regression tests run against the exact source SHA in CI; the runtime
# archive deliberately contains no tests/module mocks. Installation validates
# runtime syntax and the inert entrypoint without production secrets or root.
chown -R root:root "$source_dir"
find "$source_dir" -type d -exec chmod 0755 {} +
find "$source_dir" -type f -exec chmod 0644 {} +
mapfile -d '' -t modules < <(find "$source_dir/collector" "$source_dir/website" -name '*.mjs' -type f -print0)
(( ${#modules[@]} > 0 )) || die 'RUNTIME_MODULES_MISSING'
for module in "${modules[@]}"; do
  timeout 10s runuser -u vantis-check -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/nonexistent TMPDIR=/tmp "$node_bin" --check "$module" >/dev/null 2>&1 || die 'RUNTIME_SYNTAX_FAILED'
done
timeout 30s runuser -u vantis-check -- env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/nonexistent TMPDIR=/tmp "$node_bin" "$source_dir/collector/orchestrate.mjs" --help >/dev/null 2>&1 || die 'ENTRYPOINT_HELP_FAILED'
python3 "$trusted_bundle" verify-directory "$source_dir" >/dev/null
runuser -u vantis -- "$node_bin" --env-file=/etc/vantis/collector.env "$source_dir/collector/operations.mjs" self-check \
  --root /var/lib/vantis --release "$source_dir" --config /etc/vantis/operations.json || die 'CAPABILITY_OR_ENTRYPOINT_CHECK_FAILED'
for src in "$source_dir"/deploy/*; do
  [[ -f "$src" && ! -L "$src" ]] || continue
  name=${src##*/};mode=0644;[[ "$name" != *.sh ]] || mode=0755
  install -o root -g root -m "$mode" "$src" "/opt/vantis/deployment/.$name.new"
  mv -T "/opt/vantis/deployment/.$name.new" "/opt/vantis/deployment/$name"
done
python3 - "$source_dir/vantis-manifest.json" <<'PYMETA'
import json,sys
from pathlib import Path
m=json.loads(Path(sys.argv[1]).read_text());p=Path('/opt/vantis/deployment/.tool-version.new');p.write_text(m['toolingDigest']+'\n');p.chmod(0o644);p.replace(p.with_name('.tool-version'))
PYMETA
for name in vantis-collector vantis-health vantis-sync; do
  for kind in service timer; do install -o root -g root -m 0644 "$source_dir/deploy/$name.$kind" "/etc/systemd/system/$name.$kind"; done
done
install -o root -g root -m 0644 "$source_dir/deploy/vantis-report.service" /etc/systemd/system/vantis-report.service
systemctl daemon-reload
bash /opt/vantis/deployment/release.sh "$source_dir"
systemctl enable --now vantis-health.timer vantis-collector.timer
systemctl enable vantis-report.service
# Missing report credentials fail closed; health reports the exact inactive/failed service.
systemctl restart vantis-report.service || die 'REPORT_SERVICE_RESTART_FAILED'
IFS= read -r mode < /etc/vantis/source-mode
if [[ "$mode" == deploy-key ]]; then systemctl enable --now vantis-sync.timer; else systemctl disable --now vantis-sync.timer; fi
printf 'INSTALL_COMPLETED; verify operations/health.json and authenticated Site report readback before acceptance.\n'
