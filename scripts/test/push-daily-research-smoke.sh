#!/usr/bin/env bash
# Mocked control-plane smoke; never contacts real GitHub/Telegram/providers.
set -euo pipefail
TARGET="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/push-daily-research.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
FAKE_SHA="693b0a45089098f43eccf70dc3d5dd6f89905d76"
mkdir -p "$ROOT/mock-bin" "$ROOT/repo/collector" "$ROOT/runtime" "$ROOT/home"
printf '# empty safe test env\n' > "$ROOT/env"; chmod 600 "$ROOT/env"
cat > "$ROOT/mock-bin/git" <<'MOCKGIT'
#!/usr/bin/env bash
case " $* " in
  *" rev-parse "*) printf '%s\n' "${MOCK_LOCAL_SHA:?}" ;;
  *" status "*) [ "${MOCK_STATUS_FAIL:-0}" = 1 ] && exit 42
    [ "${MOCK_DIRTY:-0}" = 1 ] && printf ' M collector/orchestrate.mjs\n' || true ;;
  *) echo "UNEXPECTED_GIT" >&2; exit 90 ;;
esac
MOCKGIT
cat > "$ROOT/mock-bin/curl" <<'MOCKCURL'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${MOCK_TRACE:?}"
case "$*" in
  *"commits/main"*) printf '{"sha":"%s"}\n' "${MOCK_REMOTE_SHA:?}" ;;
  *"contents/docs/latest-daily.md"*) if [[ " $* " == *" -X PUT "* ]]; then printf '{"commit":{"sha":"abcdef0123456789abcdef0123456789abcdef01"}}\n'; else printf '{"sha":"feed0123456789abcdef0123456789abcdef0123"}\n'; fi ;;
  *) echo "UNEXPECTED_CURL" >&2; exit 91 ;;
esac
MOCKCURL
cat > "$ROOT/mock-bin/node" <<'MOCKNODE'
#!/usr/bin/env bash
printf 'node %s\n' "$*" >> "${MOCK_TRACE:?}"
case "$*" in
  *"orchestrate.mjs"*"--mode private-research"*) echo "mock private research lane" ;;
  *"research-daily-report.mjs"*) mkdir -p "$DF_RUNTIME_ROOT/reports/research-daily"; printf 'TEST ONLY - NOT A REAL FORECAST\n' > "$DF_RUNTIME_ROOT/reports/research-daily/latest.md"; printf '{"kind":"research-daily-1x2","mode":"research-reference","commercialReleaseGate":"BLOCKED","externalTelegramSent":false,"strictMarkets":{"releasedCandidates":0},"codeSha":"%s","reportId":"%064d"}\n' "$MOCK_REMOTE_SHA" 0 > "$DF_RUNTIME_ROOT/reports/research-daily/latest.json"; echo "mock report" ;;
  *"publish-research-daily.mjs"*) code="${MOCK_BAD_WEB:-0}"; printf '{"reportId":"%064d","status":"research-authenticated-web-verified","commercialReleaseGate":"BLOCKED"}\n' "$code" ;;
  *"publish-research-telegram.mjs"*) code="${MOCK_BAD_TG:-0}"; printf '{"codeSha":"%s","reportId":"%064d","status":"accepted","messageId":42}\n' "$MOCK_REMOTE_SHA" "$code" > "$DF_RUNTIME_ROOT/reports/research-daily/telegram-receipt.json"; echo "mock TG" ;;
  *) echo "UNEXPECTED_NODE" >&2; exit 92 ;;
esac
MOCKNODE
chmod +x "$ROOT/mock-bin/"*
pass=0; fail=0
run_case() {
  local name="$1" expected="$2" marker="$3"; shift 3
  : > "$ROOT/trace"
  local status=0
  env -u DF_DRY_RUN PATH="$ROOT/mock-bin:$PATH" HOME="$ROOT/home" \
    DF_REPO_ROOT="$ROOT/repo" DF_RUNTIME_ROOT="$ROOT/runtime" DF_ENV_FILE="$ROOT/env" \
    GITHUB_TOKEN="MOCK_NOT_A_SECRET" MOCK_TRACE="$ROOT/trace" \
    MOCK_REMOTE_SHA="$FAKE_SHA" MOCK_LOCAL_SHA="$FAKE_SHA" MOCK_DIRTY=0 \
    "$@" bash "$TARGET" > "$ROOT/output" 2>&1 || status=$?
  local okay=1
  if [ "$expected" = 0 ] && [ "$status" -ne 0 ]; then okay=0; fi
  if [ "$expected" != 0 ] && [ "$status" -eq 0 ]; then okay=0; fi
  if [ -n "$marker" ] && ! grep -q "$marker" "$ROOT/output"; then okay=0; fi
  local allow=0; for arg in "$@"; do [ "$arg" = 'MOCK_ALLOW_PUBLICATION=1' ] && allow=1; done
  if [ "$allow" = 0 ] && grep -Eq 'node .*publish-research-telegram|curl .*contents/docs/latest-daily' "$ROOT/trace"; then okay=0; fi
  if [ "$expected" != 0 ] && [ "$allow" = 1 ] && grep -q 'curl .*contents/docs/latest-daily' "$ROOT/trace"; then okay=0; fi
  if [ "$okay" = 1 ]; then printf 'PASS %s (exit=%s)\n' "$name" "$status"; pass=$((pass+1))
  else printf 'FAIL %s (exit=%s)\n' "$name" "$status"; cat "$ROOT/output"; cat "$ROOT/trace"; fail=$((fail+1)); fi
}
run_case 'default research-only/no publication' 0 'DONE (dry-run)'
run_case 'invalid dry-run value rejected' 1 'INVALID_DRY_RUN' DF_DRY_RUN=oops
run_case 'local remote SHA mismatch rejected' 1 'EXECUTING_SHA_MISMATCH' MOCK_LOCAL_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
run_case 'dirty worktree rejected' 1 'WORKTREE_DIRTY' MOCK_DIRTY=1
run_case 'git status failure must fail closed' 1 'WORKTREE_STATUS_UNAVAILABLE' MOCK_STATUS_FAIL=1
run_case 'main publication blocked' 1 'DIRECT_MAIN_WRITE_BLOCKED' DF_DRY_RUN=0 DF_TARGET_BRANCH=main DF_RESEARCH_OUTBOUND_APPROVED_SHA="$FAKE_SHA"
run_case 'missing per-SHA approval blocked' 1 'RESEARCH_OUTBOUND_NOT_APPROVED_FOR_SHA' DF_DRY_RUN=0 DF_TARGET_BRANCH=draft/research-snapshot
run_case 'wrong-SHA approval blocked' 1 'RESEARCH_OUTBOUND_NOT_APPROVED_FOR_SHA' DF_DRY_RUN=0 DF_TARGET_BRANCH=draft/research-snapshot DF_RESEARCH_OUTBOUND_APPROVED_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
run_case 'same-ID mocked Web+TG+branch is accepted' 0 'DONE  日报=' MOCK_ALLOW_PUBLICATION=1 DF_DRY_RUN=0 DF_TARGET_BRANCH=draft/research-snapshot DF_RESEARCH_OUTBOUND_APPROVED_SHA="$FAKE_SHA"
run_case 'wrong Web report ID blocks before TG' 1 'WEB_READBACK_MISMATCH' MOCK_BAD_WEB=1 MOCK_ALLOW_PUBLICATION=1 DF_DRY_RUN=0 DF_TARGET_BRANCH=draft/research-snapshot DF_RESEARCH_OUTBOUND_APPROVED_SHA="$FAKE_SHA"
run_case 'wrong TG report ID blocks before branch sync' 1 'TELEGRAM_RECEIPT_MISMATCH' MOCK_BAD_TG=1 MOCK_ALLOW_PUBLICATION=1 DF_DRY_RUN=0 DF_TARGET_BRANCH=draft/research-snapshot DF_RESEARCH_OUTBOUND_APPROVED_SHA="$FAKE_SHA"
printf 'TOTAL pass=%s fail=%s (all mocked; no real data or external delivery)\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
