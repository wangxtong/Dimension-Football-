#!/usr/bin/env bash
# 维度足球每日自动链路：采集 -> 结算 -> 研究日报 -> Telegram -> 页面同步
#
# 设计约束：
#   1. 全部运行状态落在 DF_RUNTIME_ROOT（默认 ~/.df-runtime），不依赖 /tmp；
#   2. 凭证只从环境或 .env 文件读取，绝不写入仓库；
#   3. 任一步失败立即以非零码退出并打印原始报错，不静默跳过。
set -uo pipefail

REPO_ROOT="${DF_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNTIME_ROOT="${DF_RUNTIME_ROOT:-$HOME/.df-runtime}"
ENV_FILE="${DF_ENV_FILE:-$HOME/df/.env.local}"
STATE_DIR="$RUNTIME_ROOT/state"
OUT_DIR="$RUNTIME_ROOT/reports"
TARGET_BRANCH="${DF_TARGET_BRANCH:-main}"
DRY_RUN="${DF_DRY_RUN:-1}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { log "FAILED: $*"; exit 1; }

[ -d "$REPO_ROOT/collector" ] || fail "REPO_ROOT 不可用: $REPO_ROOT"
[ -f "$ENV_FILE" ] || fail "凭证文件缺失: $ENV_FILE (chmod 600)"
mkdir -p "$STATE_DIR" "$OUT_DIR"

set -a; . "$ENV_FILE"; set +a

# GitHub 令牌：优先 GITHUB_TOKEN，其次既有 header 文件，最后 git credential
GH_HEADER="$(mktemp)"; trap 'rm -f "$GH_HEADER"' EXIT
if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf 'Authorization: Bearer %s\n' "$GITHUB_TOKEN" > "$GH_HEADER"
elif [ -f "${DF_GH_HEADER:-/tmp/.h}" ]; then
  cp "${DF_GH_HEADER:-/tmp/.h}" "$GH_HEADER"
else
  TOKEN="$(git -C "$REPO_ROOT" credential fill <<<'protocol=https
host=github.com' 2>/dev/null | sed -n 's/^password=//p')"
  [ -n "$TOKEN" ] || fail "无 GitHub 令牌（GITHUB_TOKEN / DF_GH_HEADER / git credential 均不可用）"
  printf 'Authorization: Bearer %s\n' "$TOKEN" > "$GH_HEADER"
fi

SHA="$(curl -fsS -H @"$GH_HEADER" \
  'https://api.github.com/repos/wangxtong/Dimension-Football-/commits/main' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["sha"])')" \
  || fail "无法读取 main HEAD"
# Exact code identity is mandatory: the remote SHA alone does not describe the checked-out code.
LOCAL_SHA="$(git -C "$REPO_ROOT" rev-parse --verify HEAD 2>/dev/null)" || fail "LOCAL_HEAD_UNAVAILABLE"
[ "$LOCAL_SHA" = "$SHA" ] || fail "EXECUTING_SHA_MISMATCH local=$LOCAL_SHA remote=$SHA"
[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ] || fail "WORKTREE_DIRTY: 拒绝把未提交代码记作远程main SHA"

# The research CLI does NOT verify GitHub CI or authorize a commercial release.
# Any non-dry-run research outbound requires explicit per-SHA approval, and must never push to main.
[ "$DRY_RUN" = "0" ] || [ "$DRY_RUN" = "1" ] || fail "INVALID_DRY_RUN: 只接受0或1"
if [ "$DRY_RUN" = "0" ]; then
  [ "$TARGET_BRANCH" != "main" ] && [ "$TARGET_BRANCH" != "master" ] || fail "DIRECT_MAIN_WRITE_BLOCKED: 必须走分支及PR审查"
  [ "${DF_RESEARCH_OUTBOUND_APPROVED_SHA:-}" = "$SHA" ] || fail "RESEARCH_OUTBOUND_NOT_APPROVED_FOR_SHA"
fi
log "[1/6] fixtures lane sha=$SHA"
node "$REPO_ROOT/collector/orchestrate.mjs" --lane fixtures --mode private-research \
  --state "$STATE_DIR/state.json" --out "$OUT_DIR" > "$RUNTIME_ROOT/fixtures.log" 2>&1 \
  || { tail -n 20 "$RUNTIME_ROOT/fixtures.log"; fail "fixtures lane"; }
tail -n 3 "$RUNTIME_ROOT/fixtures.log"

log "[2/6] results lane"
node "$REPO_ROOT/collector/orchestrate.mjs" --lane results --mode private-research \
  --state "$STATE_DIR/state.json" --out "$OUT_DIR" > "$RUNTIME_ROOT/results.log" 2>&1 \
  || { tail -n 20 "$RUNTIME_ROOT/results.log"; fail "results lane"; }
tail -n 2 "$RUNTIME_ROOT/results.log"

log "[3/6] daily report"
GITHUB_SHA="$SHA" node "$REPO_ROOT/collector/research-daily-report.mjs" --root "$RUNTIME_ROOT" \
  > "$RUNTIME_ROOT/report.log" 2>&1 \
  || { tail -n 20 "$RUNTIME_ROOT/report.log"; fail "daily report"; }
tail -n 1 "$RUNTIME_ROOT/report.log"
[ -f "$OUT_DIR/research-daily/latest.md" ] || fail "日报未生成: $OUT_DIR/research-daily/latest.md"
[ -f "$OUT_DIR/research-daily/latest.json" ] || fail "研究JSON未生成: $OUT_DIR/research-daily/latest.json"
# Bind every downstream channel to the report produced by this exact checked-out SHA.
REPORT_ID="$(python3 - "$OUT_DIR/research-daily/latest.json" "$SHA" <<'PY_REPORT'
import json, re, sys
try:
    row = json.load(open(sys.argv[1], encoding='utf-8'))
    assert row.get('kind') == 'research-daily-1x2'
    assert row.get('mode') == 'research-reference'
    assert row.get('commercialReleaseGate') == 'BLOCKED'
    assert row.get('externalTelegramSent') is False
    assert row.get('strictMarkets', {}).get('releasedCandidates') == 0
    assert row.get('codeSha') == sys.argv[2]
    assert re.fullmatch(r'[a-f0-9]{64}', row.get('reportId', ''))
    print(row['reportId'])
except Exception:
    sys.exit(1)
PY_REPORT
)" || fail "RESEARCH_REPORT_ID_INVALID"

if [ "$DRY_RUN" = "1" ]; then
  log "[4/6] Web SKIPPED (research dry-run)"
  log "[5/6] Telegram SKIPPED (research dry-run)"
  log "[6/6] GitHub branch sync SKIPPED (research dry-run)"
  log "DONE (dry-run) reportId=$REPORT_ID 日报=$OUT_DIR/research-daily/latest.md"
  exit 0
fi

# The actual authenticated Site POST+GET readback is mandatory in live research
# mode. A GitHub Markdown commit is NOT a substitute for web delivery.
log "[4/6] authenticated Site Web POST + GET"
node "$REPO_ROOT/collector/publish-research-daily.mjs" --root "$RUNTIME_ROOT" \
  > "$RUNTIME_ROOT/web.log" 2>&1 \
  || { tail -n 20 "$RUNTIME_ROOT/web.log"; fail "WEB_NOT_DELIVERED"; }
python3 - "$RUNTIME_ROOT/web.log" "$REPORT_ID" <<'PY_WEB' || fail "WEB_READBACK_MISMATCH"
import json, sys
try:
    record = json.loads(open(sys.argv[1], encoding='utf-8').read().strip().splitlines()[-1])
    assert record.get('reportId') == sys.argv[2]
    assert record.get('status') == 'research-authenticated-web-verified'
    assert record.get('commercialReleaseGate') == 'BLOCKED'
except Exception:
    sys.exit(1)
PY_WEB

log "[5/6] Telegram research receipt"
node "$REPO_ROOT/collector/publish-research-telegram.mjs" --root "$RUNTIME_ROOT" \
  > "$RUNTIME_ROOT/telegram.log" 2>&1 \
  || { tail -n 20 "$RUNTIME_ROOT/telegram.log"; fail "TELEGRAM_NOT_DELIVERED"; }
python3 - "$OUT_DIR/research-daily/telegram-receipt.json" "$REPORT_ID" "$SHA" <<'PY_TG' || fail "TELEGRAM_RECEIPT_MISMATCH"
import json, sys
try:
    receipt = json.load(open(sys.argv[1], encoding='utf-8'))
    assert receipt.get('reportId') == sys.argv[2]
    assert receipt.get('codeSha') == sys.argv[3]
    assert receipt.get('status') == 'accepted'
    assert isinstance(receipt.get('messageId'), int) and receipt['messageId'] > 0
except Exception:
    sys.exit(1)
PY_TG

log "[6/6] archive GitHub draft branch -> $TARGET_BRANCH:docs/latest-daily.md"
python3 - "$OUT_DIR/research-daily/latest.md" "$TARGET_BRANCH" "$GH_HEADER" <<'PY' || fail "page sync"
import base64, json, subprocess, sys
src, branch, header = sys.argv[1], sys.argv[2], sys.argv[3]
content = base64.b64encode(open(src, 'rb').read()).decode()
repo = 'wangxtong/Dimension-Football-'
path = 'docs/latest-daily.md'
url = 'https://api.github.com/repos/%s/contents/%s' % (repo, path)
cur = json.loads(subprocess.check_output(['curl', '-fsS', '-H', '@' + header, url + '?ref=' + branch]).decode())
body = {'message': 'chore: 更新最近一期研究日报（自动链路）', 'content': content, 'branch': branch}
if cur.get('sha'):
    body['sha'] = cur['sha']
res = json.loads(subprocess.check_output(['curl', '-fsS', '-X', 'PUT', '-H', '@' + header,
    '-H', 'Content-Type: application/json', '-d', json.dumps(body), url]).decode())
print('page commit:', ((res.get('commit') or {}).get('sha') or res.get('message', ''))[:10])
PY

log "DONE  日报=$OUT_DIR/research-daily/latest.md  状态=$STATE_DIR/state.json"
