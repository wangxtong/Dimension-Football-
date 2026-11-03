#!/usr/bin/env bash
# 站点登录验收：凭据只从环境变量读，绝不写入仓库或日志。
#   SITE_ORIGIN=https://football.fotpredict.xyz SITE_USER=vip SITE_PASS=*** bash scripts/verify-site-login.sh
set -u
ORIGIN="${SITE_ORIGIN:-https://football.fotpredict.xyz}"
USER_NAME="${SITE_USER:-}"
PASS="${SITE_PASS:-}"
if [ -z "$USER_NAME" ] || [ -z "$PASS" ]; then
  echo 'SITE_USER / SITE_PASS 未设置；凭据不入仓库与日志。' >&2
  exit 2
fi
BASE="${ORIGIN%/}"
JAR="$(mktemp)"; trap 'rm -f "$JAR"' EXIT
code=$(curl -sS -c "$JAR" -o /dev/null -w '%{http_code}' -X POST \
  -H "Origin: $BASE" -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode "username=$USER_NAME" --data-urlencode "password=$PASS" \
  --max-time 25 "$BASE/login" || echo 000)
echo "login=$code"
case "$code" in
  303|302) ;;
  *) echo "FAIL: 登录未通过（期望 302/303，实际 $code）" >&2; exit 1;;
esac
if ! grep -qv '^#' "$JAR"; then echo 'FAIL: 未拿到会话 cookie' >&2; exit 1; fi
home=$(curl -sS -b "$JAR" -o /dev/null -w '%{http_code}' --max-time 25 "$BASE/" || echo 000)
echo "home=$home"
[ "$home" = 200 ] || { echo "FAIL: 登录后首页 $home" >&2; exit 1; }
wrong=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Origin: $BASE" \
  --data-urlencode "username=$USER_NAME" --data-urlencode 'password=__wrong__' \
  --max-time 25 "$BASE/login" || echo 000)
echo "wrong_password=$wrong"
[ "$wrong" = 401 ] || { echo "FAIL: 错误密码未返回 401（实际 $wrong）" >&2; exit 1; }
echo 'PASS: 站点接受该账号，且错误密码被拒。'
