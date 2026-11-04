#!/usr/bin/env bash
# 把最新一期研究日报同步到 Cloudflare KV，供线上 Worker 的 /api/research-daily 读取。
# 站点数据不会自己跟着账本走：每日链路跑完必须执行这一步，否则页面停在旧一期。
# 需要的环境变量（放在 DF_ENV_FILE 里，不进仓库）：
#   CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_KV_NAMESPACE_ID
set -euo pipefail

RUNTIME_ROOT="${DF_RUNTIME_ROOT:-$HOME/.df-runtime}"
SRC="${1:-$RUNTIME_ROOT/reports/research-daily/latest.json}"

: "${CLOUDFLARE_API_TOKEN:?缺少 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?缺少 CLOUDFLARE_ACCOUNT_ID}"
: "${CLOUDFLARE_KV_NAMESPACE_ID:?缺少 CLOUDFLARE_KV_NAMESPACE_ID}"
[ -f "$SRC" ] || { echo "找不到日报：$SRC" >&2; exit 2; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
node -e '
const fs = require("node:fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!d.reportId || !d.beijingDay || !d.generatedAt) throw new Error("日报缺少 reportId/beijingDay/generatedAt");
fs.writeFileSync(process.argv[2] + "/report.json", JSON.stringify(d));
fs.writeFileSync(process.argv[2] + "/pointer.json", JSON.stringify({ version: 1, reportId: d.reportId, generatedAt: d.generatedAt, beijingDay: d.beijingDay }));
console.log(d.reportId);
' "$SRC" "$TMP" > "$TMP/id"

put() {
  local key="$1" file="$2" enc
  enc="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$key")"
  curl -sS --fail-with-body --max-time 40 -X PUT \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' \
    --data-binary "@$file" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces/$CLOUDFLARE_KV_NAMESPACE_ID/values/$enc" > /dev/null
  echo "kv put $key"
}

ID="$(cat "$TMP/id")"
put "research-daily/reports/$ID.json" "$TMP/report.json"
put "research-daily/current.json" "$TMP/pointer.json"
echo "KV 同步完成：$ID"
