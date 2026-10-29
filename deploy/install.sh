#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Run once as root on a Linux ECS / lightweight server with systemd.
# Usage: sudo env NODE_BIN=/usr/local/bin/node bash deploy/install.sh [SOURCE_DIR]
die() { printf 'Install failed: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run this script as root.'
[[ $# -le 1 ]] || die 'Usage: install.sh [SOURCE_DIR]'
[[ -d /run/systemd/system ]] || die 'This server must be running systemd.'
for command_name in systemctl getent useradd install tar flock readlink runuser git curl timeout; do
  command -v "$command_name" >/dev/null || die "Missing command: $command_name"
done

source_dir=$(cd -- "${1:-$(dirname -- "${BASH_SOURCE[0]}")/..}" && pwd -P)
for deployment_file in release.sh sync.sh vantis-collector.service vantis-collector.timer vantis-sync.service vantis-sync.timer; do
  [[ -f "$source_dir/deploy/$deployment_file" ]] || die "Missing deployment file: $deployment_file"
done

exec 8>/run/lock/vantis-install.lock
flock -n 8 || die 'Another installation is running.'

node_bin=${NODE_BIN:-$(command -v node || true)}
[[ -n "$node_bin" && -x "$node_bin" ]] || die 'Install Node.js 24+ system-wide first, or set NODE_BIN to its absolute path.'
node_bin=$(readlink -f -- "$node_bin")
case "$node_bin" in
  /root/*|/home/*|/run/user/*) die 'Node.js must be outside user home directories because the service uses ProtectHome=true.' ;;
esac
node_major=$("$node_bin" -p 'Number(process.versions.node.split(".")[0])')
[[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 24 )) || die 'Node.js 24 or later is required.'

if ! getent passwd vantis >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/vantis --no-create-home --shell /usr/sbin/nologin vantis
fi
[[ $(id -u vantis) -ne 0 ]] || die 'The vantis account must not be root.'
getent group vantis >/dev/null || die 'A group named vantis is required.'
runuser -u vantis -- "$node_bin" --version >/dev/null || die 'The vantis user cannot execute this Node.js installation.'

for managed_dir in /opt/vantis /opt/vantis/releases /etc/vantis /var/lib/vantis /var/lib/vantis/reports /var/lib/vantis-sync; do
  [[ ! -L "$managed_dir" ]] || die "Managed directory must not be a symbolic link: $managed_dir"
done
install -d -o root -g root -m 0755 /opt/vantis /opt/vantis/releases
install -d -o root -g vantis -m 0750 /etc/vantis
install -d -o vantis -g vantis -m 0750 /var/lib/vantis /var/lib/vantis/reports
install -d -o root -g root -m 0755 /var/lib/vantis-sync
# Preserve existing contents while allowing the service user to resume old state.
chown -hR vantis:vantis /var/lib/vantis
[[ ! -L /etc/vantis/collector.env && ! -L /etc/vantis/node-path ]] || die 'Configuration files must not be symbolic links.'

# Existing credentials are preserved across installation and release updates.
if [[ ! -e /etc/vantis/collector.env ]]; then
  (set -o noclobber; cat > /etc/vantis/collector.env <<'ENV'
# Fill in one provider on this server. Do not put this file in Git.
# Preference: FOOTBALL_DATA_API_KEY > FOOTBALL_DATA_API_TOKEN > API_FOOTBALL_KEY
FOOTBALL_DATA_API_KEY=
FOOTBALL_DATA_API_TOKEN=
API_FOOTBALL_KEY=
ENV
  )
fi
[[ -f /etc/vantis/collector.env ]] || die '/etc/vantis/collector.env must be a regular file.'
chown root:vantis /etc/vantis/collector.env
chmod 0640 /etc/vantis/collector.env

node_path_tmp="/etc/vantis/.node-path-$$"
trap 'rm -f -- "$node_path_tmp"' EXIT
printf '%s\n' "$node_bin" > "$node_path_tmp"
chown root:vantis "$node_path_tmp"
chmod 0640 "$node_path_tmp"
mv -T -- "$node_path_tmp" /etc/vantis/node-path

install -o root -g root -m 0644 "$source_dir/deploy/vantis-collector.service" /etc/systemd/system/vantis-collector.service
install -o root -g root -m 0644 "$source_dir/deploy/vantis-collector.timer" /etc/systemd/system/vantis-collector.timer
install -o root -g root -m 0644 "$source_dir/deploy/vantis-sync.service" /etc/systemd/system/vantis-sync.service
install -o root -g root -m 0644 "$source_dir/deploy/vantis-sync.timer" /etc/systemd/system/vantis-sync.timer
bash "$source_dir/deploy/release.sh" "$source_dir"
systemctl daemon-reload
systemctl enable --now vantis-collector.timer vantis-sync.timer

printf '%s\n' \
  'Installed. Fill one credential in /etc/vantis/collector.env using a local editor.' \
  'Then verify one run: systemctl start vantis-collector.service' \
  'Logs: journalctl -u vantis-collector.service -n 100 --no-pager' \
  'Schedule: systemctl list-timers vantis-collector.timer vantis-sync.timer' \
  'Git main is checked every two minutes; tested commits are published automatically.' \
  'Sync logs: journalctl -u vantis-sync.service -n 100 --no-pager'
