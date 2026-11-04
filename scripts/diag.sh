#!/usr/bin/env bash
set +e
OUT=diag.md; : > "$OUT"
red() { sed -E \
 -e 's/(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/***REDACTED***/g' \
 -e 's/[0-9]{8,10}:[A-Za-z0-9_-]{30,}/***REDACTED***/g' \
 -e 's/sk-[A-Za-z0-9_-]{16,}/***REDACTED***/g' \
 -e 's/(Bearer|Basic) +[A-Za-z0-9._~+\/=-]{10,}/\1 ***REDACTED***/Ig' \
 -e "s/((api|secret|token|password|cookie|auth|key)[A-Za-z0-9_]*[\"' ]*[:=] *[\"']?)[^\"' ,}]{6,}/\1***REDACTED***/Ig"; }
S() { printf '\n## %s\n' "$1" >> "$OUT"; }
R() { { echo '```'; bash -c "$1" 2>&1 | head -n "${2:-150}" | red; echo '```'; } >> "$OUT"; }

S "1 Git"
R "git branch --show-current; git rev-parse HEAD; git log --oneline -15; git status --short | head -30"
S "2 目录树(2层)"
R "find . -maxdepth 2 -not -path './.git*' -not -path '*/node_modules*' | sort" 200
S "3 旧部署残留文件"
R "find deploy ops/site -type f 2>/dev/null; git ls-files | grep -iE 'sites|hosting|workbench|aliyun|ecs'" 120
S "4 旧引用命中"
R "grep -rnE 'deploy/|ops/site|includeMacauslot|aliyun|link-site|hosting' --exclude-dir=.git --exclude-dir=node_modules . | cut -c1-200" 120
S "5 CI/构建配置"
R "cat .github/workflows/*.yml" 250
S "6 部署与依赖配置"
R "cat wrangler.* package.json 2>/dev/null" 150
S "7 模型参数"
R "grep -rnE 'venue-poisson|halfLife|half_life|HISTORY_DAYS|calibrat' --include=*.js --include=*.ts --include=*.json --include=*.py . --exclude-dir=node_modules | cut -c1-200" 60
S "8 CI最近运行"
R "gh run list --limit 5 2>&1" 20
R "gh run view \$(gh run list --limit 1 --json databaseId -q '.[0].databaseId') --log-failed 2>&1 | tail -80" 80

if grep -qE 'gh[pousr]_|github_pat_|sk-[A-Za-z0-9]{16}|[0-9]{8,10}:[A-Za-z0-9_-]{30,}' "$OUT"; then
  echo "检测到疑似密钥，已删除 diag.md"; rm -f "$OUT"; exit 1
fi
echo "完成: $OUT ($(wc -l < "$OUT") 行)"
