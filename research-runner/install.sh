#!/usr/bin/env bash
# Install only the independently named research account, paths, slice and units.
set +x
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export LC_ALL=C
umask 077

die() { printf 'RESEARCH_INSTALL_BLOCKED: %s\n' "$1" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: sudo bash install.sh --target-instance-id i-j6c4g9s2y6b5irl5gcr9 --manifest-sha256 FULL_SHA256 [--enable]'
}
expected_instance='i-j6c4g9s2y6b5irl5gcr9'
requested_instance=''
manifest_sha=''
enable=false
while (( $# )); do
  case "$1" in
    --target-instance-id) (( $# >= 2 )) || die ARGUMENT_REQUIRED; requested_instance=$2; shift 2 ;;
    --manifest-sha256) (( $# >= 2 )) || die ARGUMENT_REQUIRED; manifest_sha=$2; shift 2 ;;
    --enable) enable=true; shift ;;
    --help) usage; exit 0 ;;
    *) die UNKNOWN_ARGUMENT ;;
  esac
done
[[ $EUID -eq 0 ]] || die ROOT_REQUIRED
[[ "$requested_instance" == "$expected_instance" ]] || die EXPLICIT_TARGET_INSTANCE_REQUIRED
[[ "$manifest_sha" =~ ^[a-f0-9]{64}$ ]] || die EXTERNAL_MANIFEST_SHA256_REQUIRED
[[ -d /run/systemd/system ]] || die LIVE_SYSTEMD_REQUIRED

for command in curl python3 systemctl systemd-analyze sha256sum stat find install \
  getent useradd date readlink awk df grep chmod chown mktemp mv timedatectl cut; do
  command -v "$command" >/dev/null || die REQUIRED_TOOL_MISSING
done
[[ $(readlink -f -- /usr/bin/python3) == /usr/bin/python3* ]] || die SYSTEM_PYTHON_REQUIRED
/usr/bin/python3 -I -B -c 'import sys;sys.exit(0 if sys.version_info >= (3,10) else 1)' || die PYTHON_3_10_REQUIRED
systemd_version=$(systemctl --version | awk 'NR==1 {print $2}')
[[ "$systemd_version" =~ ^[0-9]+$ && "$systemd_version" -ge 249 ]] || die SYSTEMD_249_REQUIRED
[[ -f /sys/fs/cgroup/cgroup.controllers ]] || die CGROUP_V2_REQUIRED
for controller in cpu memory pids io; do
  grep -qw "$controller" /sys/fs/cgroup/cgroup.controllers || die RESOURCE_CONTROLLER_MISSING
done
[[ $(timedatectl show --property=NTPSynchronized --value 2>/dev/null || true) == yes ]] \
  || die UTC_CLOCK_SYNCHRONIZATION_REQUIRED

# Reject symlinks and writable ancestors before trusting source or target paths.
trusted_chain() {
  local item=$1 owner mode
  [[ "$item" == /* ]] || die ABSOLUTE_PATH_REQUIRED
  while :; do
    [[ ! -L "$item" && -e "$item" ]] || die UNSAFE_PATH_ANCESTOR
    owner=$(stat -c '%u' -- "$item")
    mode=$(stat -c '%a' -- "$item")
    [[ "$owner" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || die ROOT_OWNED_PATH_REQUIRED
    (( (8#$mode & 8#022) == 0 )) || die WRITABLE_PATH_ANCESTOR
    [[ "$item" != / ]] || break
    item=${item%/*}; [[ -n "$item" ]] || item=/
  done
}
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
trusted_chain "$source_dir"
[[ -z $(find "$source_dir" -type l -print -quit) ]] || die SOURCE_SYMLINK_REJECTED
[[ -z $(find "$source_dir" \( ! -user root -o -perm /022 \) -print -quit) ]] || die SOURCE_PERMISSIONS_UNSAFE
[[ -f "$source_dir/SHA256SUMS" ]] || die MANIFEST_REQUIRED
actual_manifest_sha=$(sha256sum -- "$source_dir/SHA256SUMS"); actual_manifest_sha=${actual_manifest_sha%% *}
[[ "$actual_manifest_sha" == "$manifest_sha" ]] || die MANIFEST_SHA256_MISMATCH
declare -A indexed=()
while IFS=' ' read -r digest relative extra || [[ -n "${digest:-}" ]]; do
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -n "$relative" && -z "${extra:-}" ]] || die INVALID_MANIFEST
  [[ "$relative" =~ ^[A-Za-z0-9_./-]+$ && "$relative" != /* && "/$relative/" != *'/../'* && "/$relative/" != *'/./'* ]] || die MANIFEST_PATH_REJECTED
  [[ ! ${indexed[$relative]+yes} && -f "$source_dir/$relative" ]] || die MANIFEST_DUPLICATE_OR_MISSING_FILE
  indexed[$relative]=1
done < "$source_dir/SHA256SUMS"
for required in runner.py install.sh README.md \
  systemd/dimension-research.slice \
  systemd/dimension-research-collector.service systemd/dimension-research-collector.timer \
  systemd/dimension-research-heartbeat.service systemd/dimension-research-heartbeat.timer \
  systemd/dimension-research-reconcile.service systemd/dimension-research-reconcile.timer; do
  [[ ${indexed[$required]+yes} ]] || die MANIFEST_REQUIRED_FILE_MISSING
done
(cd -- "$source_dir" && sha256sum --check --strict --status SHA256SUMS) || die SOURCE_CHECKSUM_FAILED
/usr/bin/python3 -I -B "$source_dir/runner.py" --help >/dev/null 2>&1 || die RUNNER_HELP_FAILED

for parent in /opt /etc /var/lib /etc/systemd/system; do trusted_chain "$parent"; done
for path in /opt/dimension-research /etc/dimension-research /var/lib/dimension-research; do
  [[ ! -e "$path" && ! -L "$path" ]] || die PREEXISTING_RESEARCH_PATH_REFUSED
done
! getent passwd dimension-research >/dev/null || die PREEXISTING_ACCOUNT_REFUSED
! getent group dimension-research >/dev/null || die PREEXISTING_GROUP_REFUSED
! compgen -G '/etc/systemd/system/dimension-research*' >/dev/null || die PREEXISTING_UNIT_REFUSED
! compgen -G '/etc/systemd/system/dr-t50-*' >/dev/null || die PREEXISTING_EVENT_UNIT_REFUSED
for folder in /var/lib/systemd/timers /run/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
  ! compgen -G "$folder/*dimension-research*" >/dev/null || die PREEXISTING_SYSTEMD_STATE_REFUSED
done
available_memory=$(awk '/^MemAvailable:/ {printf "%.0f\n", $2 * 1024}' /proc/meminfo)
[[ "$available_memory" =~ ^[0-9]+$ && "$available_memory" -ge 536870912 ]] || die INSUFFICIENT_AVAILABLE_MEMORY
for filesystem in /opt /etc /var/lib; do
  available_disk=$(df -PB1 -- "$filesystem" | awk 'NR==2 {print $4}')
  [[ "$available_disk" =~ ^[0-9]+$ && "$available_disk" -ge 2147483648 ]] || die INSUFFICIENT_FREE_DISK
done

# IMDSv2 only, no proxy or redirects. Never read a RAM credential endpoint.
metadata_token=$(curl -q --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 3 \
  --max-filesize 4096 --request PUT --header 'X-aliyun-ecs-metadata-token-ttl-seconds:60' \
  'http://100.100.100.200/latest/api/token') || die INSTANCE_METADATA_UNAVAILABLE
[[ "$metadata_token" =~ ^[A-Za-z0-9._~+/=-]{8,4096}$ ]] || die INSTANCE_METADATA_TOKEN_INVALID
actual_instance=$(printf 'header = "X-aliyun-ecs-metadata-token: %s"\n' "$metadata_token" | \
  curl -q --config - --noproxy '*' --fail --silent --show-error --connect-timeout 1 --max-time 3 \
  --max-filesize 256 'http://100.100.100.200/latest/meta-data/instance-id') || die INSTANCE_ID_UNAVAILABLE
unset metadata_token
[[ "$actual_instance" == "$expected_instance" ]] || die LIVE_INSTANCE_ID_MISMATCH

# Read one named credential as data. No sourcing, eval, command substitution,
# provider status requests, credential output, or modification of the old file.
credential_source=/etc/vantis/collector.env
trusted_chain "$credential_source"
[[ -f "$credential_source" ]] || die AUTHORIZED_KEY_SOURCE_MISSING
api_key=''; key_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?API_FOOTBALL_KEY[[:space:]]*= ]]; then
    (( key_count += 1 ))
    value=${line#*=}
    value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && ${#value} -ge 2 ]] || [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then value=${value:1:${#value}-2}; fi
    [[ "$value" =~ ^[A-Za-z0-9_-]{8,256}$ ]] || die API_KEY_FORMAT_UNSUPPORTED
    api_key=$value
  fi
done < "$credential_source"
unset value line
[[ "$key_count" == 1 && -n "$api_key" ]] || die UNIQUE_API_KEY_REQUIRED

units_installed=false
on_error() {
  local status=$?
  trap - ERR
  if [[ "$units_installed" == true ]]; then
    systemctl disable --now dimension-research-collector.timer dimension-research-reconcile.timer \
      dimension-research-heartbeat.timer >/dev/null 2>&1 || true
    systemctl stop dimension-research-collector.service dimension-research-reconcile.service \
      dimension-research-heartbeat.service >/dev/null 2>&1 || true
  fi
  unset api_key
  printf 'RESEARCH_INSTALL_FAILED; new files preserved for inspection; existing services unchanged.\n' >&2
  exit "$status"
}
trap on_error ERR

useradd --system --user-group --home-dir /var/lib/dimension-research --no-create-home --shell /usr/sbin/nologin dimension-research
[[ $(getent passwd dimension-research | cut -d: -f3) -ne 0 ]] || die NON_ROOT_SERVICE_ACCOUNT_REQUIRED
install -d -o root -g root -m 0755 /opt/dimension-research
install -d -o root -g dimension-research -m 0750 /etc/dimension-research
install -d -o dimension-research -g dimension-research -m 0700 /var/lib/dimension-research
install -o root -g root -m 0444 "$source_dir/runner.py" /opt/dimension-research/runner.py
install -o root -g root -m 0444 "$source_dir/SHA256SUMS" /opt/dimension-research/SHA256SUMS.source
install -o root -g root -m 0444 "$source_dir/README.md" /opt/dimension-research/README.md
cat > /etc/dimension-research/config.json <<'CONFIG'
{
  "data_dir": "/var/lib/dimension-research",
  "max_daily_requests": 500,
  "max_slot_requests": 5,
  "quota_reserve": 500,
  "max_data_bytes": 536870912,
  "min_free_bytes": 1073741824,
  "request_timeout_seconds": 10,
  "max_response_bytes": 2097152
}
CONFIG
chown root:dimension-research /etc/dimension-research/config.json
chmod 0440 /etc/dimension-research/config.json
credential_temp=$(mktemp /etc/dimension-research/.api.env.XXXXXXXX)
printf 'API_FOOTBALL_KEY=%s\n' "$api_key" > "$credential_temp"
unset api_key
chown root:root "$credential_temp"
chmod 0600 "$credential_temp"
mv -T -- "$credential_temp" /etc/dimension-research/api.env
printf '{"version":1,"targetInstanceId":"%s","installedAt":"%s","sourceManifestSHA256":"%s","mode":"RESEARCH_ONLY","forecastRelease":"BLOCKED"}\n' \
  "$actual_instance" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$manifest_sha" > /etc/dimension-research/installation.json
chown root:dimension-research /etc/dimension-research/installation.json
chmod 0440 /etc/dimension-research/installation.json
chmod 0555 /opt/dimension-research

for name in dimension-research.slice dimension-research-collector.service dimension-research-collector.timer \
  dimension-research-heartbeat.service dimension-research-heartbeat.timer \
  dimension-research-reconcile.service dimension-research-reconcile.timer; do
  unit="$source_dir/systemd/$name"
  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/${unit##*/}"
done
units_installed=true
systemd-analyze verify /etc/systemd/system/dimension-research*.service /etc/systemd/system/dimension-research*.timer \
  /etc/systemd/system/dimension-research.slice >/dev/null 2>&1 || die SYSTEMD_UNIT_VERIFICATION_FAILED
systemd-analyze calendar '*-*-* *:00/10:00 UTC' >/dev/null || die UTC_CALENDAR_INVALID
systemctl daemon-reload
systemctl start dimension-research.slice
cgroup_path=$(systemctl show --property=ControlGroup --value dimension-research.slice)
[[ "$cgroup_path" =~ ^/[A-Za-z0-9_.:/-]+/dimension-research\.slice$ ]] || die CGROUP_PATH_UNVERIFIED
cgroup_root="/sys/fs/cgroup$cgroup_path"
IFS=' ' read -r cpu_quota cpu_period < "$cgroup_root/cpu.max"
[[ "$cpu_quota" =~ ^[0-9]+$ && "$cpu_period" =~ ^[0-9]+$ ]] \
  && (( cpu_quota * 100 == cpu_period * 20 )) || die CPU_QUOTA_NOT_ENFORCED
IFS= read -r memory_max < "$cgroup_root/memory.max"
IFS= read -r swap_max < "$cgroup_root/memory.swap.max"
IFS= read -r tasks_max < "$cgroup_root/pids.max"
[[ "$memory_max" == 268435456 && "$swap_max" == 0 && "$tasks_max" == 32 ]] || die RESOURCE_LIMIT_NOT_ENFORCED
grep -q 'rbps=2097152' "$cgroup_root/io.max" \
  && grep -q 'wbps=1048576' "$cgroup_root/io.max" || die IO_BANDWIDTH_LIMIT_NOT_ENFORCED
if [[ "$enable" == true ]]; then
  systemctl enable --now dimension-research-heartbeat.timer dimension-research-reconcile.timer dimension-research-collector.timer
  systemctl start dimension-research-heartbeat.service dimension-research-reconcile.service
fi
printf 'RESEARCH_INSTALL_COMPLETED enabled=%s; verify isolated slice limits, journal, real slots and cross-process readback.\n' "$enable"
