#!/usr/bin/env bash
# 把最新一期研究日报灌进 R2，供 Worker 的 /api/research-daily 读取。
#   R2_BUCKET=dimension-football-research bash ops/cloudflare/seed-r2.sh [日报JSON路径]
set -euo pipefail
BUCKET="${R2_BUCKET:-dimension-football-research}"
SRC="${1:-${DF_RUNTIME_ROOT:-$HOME/.df-runtime}/reports/research-daily/latest.json}"
[ -f "$SRC" ] || { echo "找不到日报：$SRC" >&2; exit 2; }

read -r ID DAY GEN < <(node -e '
  const d=require(process.argv[1]);
  if(!d.reportId||!d.beijingDay||!d.generatedAt) throw new Error("日报缺少 reportId/beijingDay/generatedAt");
  console.log(d.reportId, d.beijingDay, d.generatedAt);
' "$SRC")

echo "报告 $ID（$DAY，$GEN）→ r2://$BUCKET"
npx --yes wrangler@4 r2 object put "$BUCKET/research-daily/reports/$ID.json" --file "$SRC" --content-type application/json

POINTER="$(mktemp)"
trap 'rm -f "$POINTER"' EXIT
node -e '
  const d=require(process.argv[1]);
  require("fs").writeFileSync(process.argv[2], JSON.stringify({version:1,reportId:d.reportId,generatedAt:d.generatedAt,beijingDay:d.beijingDay}));
' "$SRC" "$POINTER"
npx --yes wrangler@4 r2 object put "$BUCKET/research-daily/current.json" --file "$POINTER" --content-type application/json

echo "完成。核验：curl -b <cookie> https://<你的域>/api/research-daily | head -c 200"
