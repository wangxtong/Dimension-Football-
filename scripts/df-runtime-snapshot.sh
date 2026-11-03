#!/usr/bin/env bash
# 维度足球运行状态快照：把"链路跑起来所必需、且丢了就无法复现"的状态固化进仓库，
# 使容器重启后不必从零重采集。
#
# 用法:
#   scripts/df-runtime-snapshot.sh save      当前运行时 -> ops/runtime/df-runtime.tar.gz
#   scripts/df-runtime-snapshot.sh restore   仓库快照 -> 当前运行时（不覆盖已更新的文件）
#   scripts/df-runtime-snapshot.sh verify    校验快照可解包且必需成员齐全
#
# 快照只含可复现的运行状态，不含任何凭证；凭证始终留在仓库之外。
set -euo pipefail

REPO_ROOT="${DF_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME_ROOT="${DF_RUNTIME_ROOT:-$HOME/.df-runtime}"
SNAPSHOT_DIR="$REPO_ROOT/ops/runtime"
SNAPSHOT="$SNAPSHOT_DIR/df-runtime.tar.gz"

# 必需成员：缺任一则恢复后链路不完整
REQUIRED_STATE=(state.json state.json.lanes.json state.json.sources.json)
REQUIRED_REPORT=(research-daily/latest.md forecast-ledger)

list_members() { tar -tzf "$1"; }

cmd_save() {
  [ -d "$RUNTIME_ROOT/state" ] || { echo "运行时缺失: $RUNTIME_ROOT/state" >&2; exit 1; }
  mkdir -p "$SNAPSHOT_DIR"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  mkdir -p "$tmp/state" "$tmp/reports"
  # state：全部 JSON（含 history/lanes/sources 副作用文件）
  find "$RUNTIME_ROOT/state" -maxdepth 1 -name '*.json' -exec cp {} "$tmp/state/" \;
  # reports：只取不可重建的部分
  cp -r "$RUNTIME_ROOT/reports/forecast-ledger" "$tmp/reports/" 2>/dev/null || true
  cp -r "$RUNTIME_ROOT/reports/research-daily" "$tmp/reports/" 2>/dev/null || true
  for f in latest.json latest.md latest-brief.md predictions.json; do
    [ -f "$RUNTIME_ROOT/reports/$f" ] && cp "$RUNTIME_ROOT/reports/$f" "$tmp/reports/" || true
  done
  tar -czf "$SNAPSHOT" -C "$tmp" state reports
  echo "saved $SNAPSHOT ($(du -h "$SNAPSHOT" | cut -f1))"
  cmd_verify
}

cmd_restore() {
  [ -f "$SNAPSHOT" ] || { echo "快照缺失: $SNAPSHOT" >&2; exit 1; }
  cmd_verify
  mkdir -p "$RUNTIME_ROOT/state" "$RUNTIME_ROOT/reports"
  local tmp; tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  tar -xzf "$SNAPSHOT" -C "$tmp"
  # 不覆盖运行时里更新的文件
  cp -rn "$tmp/state/." "$RUNTIME_ROOT/state/" 2>/dev/null || true
  for d in forecast-ledger research-daily; do
    [ -d "$tmp/reports/$d" ] && cp -rn "$tmp/reports/$d" "$RUNTIME_ROOT/reports/" || true
  done
  for f in latest.json latest.md latest-brief.md predictions.json; do
    [ -f "$tmp/reports/$f" ] && cp -n "$tmp/reports/$f" "$RUNTIME_ROOT/reports/" || true
  done
  echo "restored into $RUNTIME_ROOT"
}

cmd_verify() {
  [ -f "$SNAPSHOT" ] || { echo "快照缺失: $SNAPSHOT" >&2; exit 1; }
  local members; members="$(list_members "$SNAPSHOT")"
  local miss=0
  for f in "${REQUIRED_STATE[@]}"; do
    grep -qx "state/$f" <<<"$members" || { echo "缺少 state/$f" >&2; miss=1; }
  done
  for f in "${REQUIRED_REPORT[@]}"; do
    grep -q "^reports/$f" <<<"$members" || { echo "缺少 reports/$f" >&2; miss=1; }
  done
  local ledger; ledger="$(grep -c '^reports/forecast-ledger/.*\.json$' <<<"$members" || true)"
  [ "$ledger" -gt 0 ] || { echo "账本为空" >&2; miss=1; }
  [ "$miss" = "0" ] || exit 1
  echo "verify ok: state=$(grep -c '^state/.*\.json$' <<<"$members") ledger=$ledger"
}

case "${1:-}" in
  save) cmd_save ;;
  restore) cmd_restore ;;
  verify) cmd_verify ;;
  *) echo "用法: $0 {save|restore|verify}" >&2; exit 2 ;;
esac
