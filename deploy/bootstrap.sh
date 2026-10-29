#!/usr/bin/env bash
set -Eeuo pipefail
umask 027

# Run on the target Linux host as root. The commit is mandatory and immutable.
# Usage: bash bootstrap.sh <40-character-Git-commit> [--deployment-dir /absolute/tools-directory]
# No credentials are downloaded, accepted as arguments, or written by this script.
# Installation also enables public Git main polling every two minutes.
die() { printf 'Bootstrap failed: %s\n' "$*" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || die 'Run this script as root.'
[[ $# -ge 1 && "$1" =~ ^[0-9a-fA-F]{40}$ ]] || die 'Supply one full 40-character Git commit SHA.'
commit=${1,,}
shift
deployment_dir=''
deployment_files=(bootstrap.sh install.sh release.sh run.sh sync.sh vantis-collector.service vantis-collector.timer vantis-sync.service vantis-sync.timer)
if (( $# )); then
  [[ $# -eq 2 && "$1" == --deployment-dir && "$2" == /* ]] \
    || die 'Optional argument must be --deployment-dir followed by an absolute directory.'
  [[ -d "$2" && ! -L "$2" ]] || die 'Deployment tool directory must be a real directory, not a symbolic link.'
  deployment_dir=$(cd -- "$2" && pwd -P)
  for deployment_file in "${deployment_files[@]}"; do
    [[ -f "$deployment_dir/$deployment_file" && ! -L "$deployment_dir/$deployment_file" ]] \
      || die "Missing regular deployment tool: $deployment_file"
  done
fi
[[ $(uname -s) == Linux ]] || die 'This script supports Linux only.'
[[ -d /run/systemd/system ]] || die 'This server must be running systemd.'
case $(uname -m) in
  x86_64) node_arch=x64 ;;
  aarch64|arm64) node_arch=arm64 ;;
  *) die 'Only Linux x86_64 and arm64 are supported.' ;;
esac
for command_name in curl tar xz sha256sum mktemp find readlink flock bash; do
  command -v "$command_name" >/dev/null || die "Missing command: $command_name"
done

exec 7>/run/lock/vantis-bootstrap.lock
flock -n 7 || die 'Another bootstrap is running.'
work_dir=$(mktemp -d /tmp/vantis-bootstrap.XXXXXXXX)
node_stage=''
cleanup() {
  # Both temporary roots are created here with mktemp under fixed directories.
  [[ -z "$node_stage" || ! -d "$node_stage" ]] || rm -rf -- "$node_stage"
  [[ ! -d "$work_dir" ]] || rm -rf -- "$work_dir"
}
trap cleanup EXIT

download() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --fail --silent --show-error --location --retry 3 \
    --connect-timeout 15 --max-time 300 --output "$2" "$1"
}

# Reuse a suitable system installation. Home-directory installs cannot be used
# with the collector's ProtectHome setting, so those need a system-wide runtime.
node_bin=''
candidate=$(command -v node || true)
if [[ -n "$candidate" && -x "$candidate" ]]; then
  candidate=$(readlink -f -- "$candidate")
  case "$candidate" in
    /root/*|/home/*|/run/user/*) ;;
    *)
      if candidate_major=$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null) \
        && [[ "$candidate_major" =~ ^[0-9]+$ ]] && (( candidate_major >= 24 )); then
        node_bin=$candidate
      fi
      ;;
  esac
fi

if [[ -z "$node_bin" ]]; then
  download 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' "$work_dir/SHASUMS256.txt"
  archive=''
  checksum=''
  node_version=''
  archive_pattern="^node-(v24[.][0-9]+[.][0-9]+)-linux-${node_arch}[.]tar[.]xz$"
  while read -r digest filename remainder; do
    if [[ "$digest" =~ ^[0-9a-fA-F]{64}$ && "$filename" =~ $archive_pattern ]]; then
      [[ -z "$archive" ]] || die 'Official manifest contains more than one matching Node.js archive.'
      archive=$filename
      checksum=$digest
      node_version=${BASH_REMATCH[1]}
    fi
  done < "$work_dir/SHASUMS256.txt"
  [[ -n "$archive" && -n "$checksum" && -n "$node_version" ]] || die 'No official Node.js 24 archive matches this architecture.'

  # Pin the tarball to the version selected by the manifest, even if latest-v24.x
  # changes during the download. Verify before extracting or executing anything.
  download "https://nodejs.org/dist/$node_version/$archive" "$work_dir/$archive"
  (cd -- "$work_dir"; printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status) \
    || die 'Official Node.js archive SHA256 verification failed.'

  runtime_root=/opt/vantis-node
  [[ ! -L "$runtime_root" ]] || die '/opt/vantis-node must not be a symbolic link.'
  install -d -o root -g root -m 0755 "$runtime_root"
  runtime_dir="$runtime_root/${archive%.tar.xz}"
  [[ ! -L "$runtime_dir" ]] || die 'The selected runtime directory must not be a symbolic link.'
  if [[ ! -e "$runtime_dir" ]]; then
    node_stage=$(mktemp -d "$runtime_root/.staging.XXXXXXXX")
    tar --extract --xz --file "$work_dir/$archive" --directory "$node_stage" \
      --strip-components=1 --no-same-owner --no-same-permissions
    [[ -x "$node_stage/bin/node" ]] || die 'Official Node.js archive is missing bin/node.'
    [[ $("$node_stage/bin/node" -p 'process.version') == "$node_version" ]] || die 'Downloaded Node.js version does not match the manifest.'
    chown -hR root:root "$node_stage"
    chmod -R a+rX "$node_stage"
    chmod 0755 "$node_stage"
    mv -T -- "$node_stage" "$runtime_dir"
    node_stage=''
  fi
  node_bin="$runtime_dir/bin/node"
  [[ -x "$node_bin" && $("$node_bin" -p 'process.version') == "$node_version" ]] \
    || die 'An existing runtime directory is incomplete; inspect it before retrying.'
fi
printf 'Using Node.js %s\n' "$("$node_bin" --version)"

# Only this repository is accepted, and the URL always contains the full commit.
download "https://codeload.github.com/wangxtong/Dimension-Football-/tar.gz/$commit" "$work_dir/source.tar.gz"
source_dir="$work_dir/source"
mkdir -- "$source_dir"
tar --extract --gzip --file "$work_dir/source.tar.gz" --directory "$source_dir" \
  --strip-components=1 --no-same-owner --no-same-permissions
if [[ -n "$deployment_dir" ]]; then
  # The local bundle may supply newer infrastructure than the pinned collector.
  # Only these fixed deployment filenames may be overlaid; collector is untouched.
  [[ ! -L "$source_dir/deploy" ]] || die 'Pinned source deployment directory must not be a symbolic link.'
  mkdir -p -- "$source_dir/deploy"
  for deployment_file in "${deployment_files[@]}"; do
    target_file="$source_dir/deploy/$deployment_file"
    [[ ! -L "$target_file" && ( ! -e "$target_file" || -f "$target_file" ) ]] \
      || die "Invalid pinned deployment target: $deployment_file"
    install -m 0644 -- "$deployment_dir/$deployment_file" "$target_file"
  done
  printf '%s\n' 'Using a local deployment-tool bundle; the collector source commit is unchanged.'
fi
for source_file in package.json collector/run.mjs deploy/install.sh deploy/release.sh; do
  [[ -f "$source_dir/$source_file" ]] || die "The pinned source is missing: $source_file"
done
[[ -d "$source_dir/collector/test" && -d "$source_dir/collector/sources/test" ]] || die 'The pinned source is missing test directories.'
mapfile -d '' -t test_files < <(find "$source_dir/collector/test" "$source_dir/collector/sources/test" \
  -type f -name '*.test.mjs' -print0)
(( ${#test_files[@]} > 0 )) || die 'The pinned source contains no collector tests.'
printf 'Testing pinned source: %s\n' "$commit"
if ! "$node_bin" --test --test-reporter=spec "${test_files[@]}" > "$work_dir/tests.log" 2>&1; then
  tail -n 120 "$work_dir/tests.log" >&2
  die 'Collector tests failed; no collector release was installed.'
fi
tail -n 10 "$work_dir/tests.log"

NODE_BIN="$node_bin" VANTIS_COMMIT="$commit" bash "$source_dir/deploy/install.sh" "$source_dir"
printf '%s\n' \
  "Bootstrap completed for commit $commit." \
  'Next: configure one credential with sudoedit /etc/vantis/collector.env' \
  'Then: systemctl start vantis-collector.service' \
  'Verify: journalctl -u vantis-collector.service -n 100 --no-pager' \
  'Schedule: systemctl list-timers vantis-collector.timer vantis-sync.timer' \
  'Git main is checked every two minutes; successful test runs trigger atomic code releases.' \
  'Sync logs: journalctl -u vantis-sync.service -n 100 --no-pager'
