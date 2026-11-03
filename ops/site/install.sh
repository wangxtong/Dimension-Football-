#!/usr/bin/env bash
# 维度足球看板 · 任意 Linux 服务器一键部署（不依赖阿里云、不依赖 CI）。
#   SITE_PASS='你的密码' SITE_USER=vip SITE_ORIGIN='https://你的域名' bash ops/site/install.sh
# 需要：root 或 sudo、Node >= 24、systemd。
set -euo pipefail

SITE_USER_NAME="${SITE_USER:-vip}"
SITE_PASS="${SITE_PASS:?必须设置 SITE_PASS}"
SITE_ORIGIN="${SITE_ORIGIN:?必须设置 SITE_ORIGIN，例如 https://football.example.com}"
SITE_PORT="${SITE_PORT:-8099}"
APP_DIR="${SITE_APP_DIR:-/opt/dimension-site}"
DATA_DIR="${SITE_DATA_DIR:-/var/lib/dimension-site}"
CONF_DIR="${SITE_CONF_DIR:-/etc/dimension-site}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

need_node=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$need_node" -ge 24 ] || { echo "需要 Node >= 24（当前 $need_node）" >&2; exit 1; }

echo '== 1/5 构建静态资源'
rm -rf "$APP_DIR/dist"
node "$REPO/website/build.mjs" "$APP_DIR/dist"
install -d -m 755 "$APP_DIR" "$DATA_DIR/research-daily/reports" "$CONF_DIR"
install -m 644 "$REPO/ops/site/server.mjs" "$APP_DIR/server.mjs"

echo '== 2/5 生成鉴权配置（密码只在本机算哈希，不落磁盘明文）'
ENV_FILE="$CONF_DIR/env"
if [ -f "$ENV_FILE" ]; then
  echo '   已存在 '"$ENV_FILE"'，保留原配置（改密码请先生成新文件）'
else
  AUTH=$(SITE_USER_NAME="$SITE_USER_NAME" SITE_PASS="$SITE_PASS" node -e '
    const { randomBytes, pbkdf2Sync } = require("node:crypto");
    const salt = randomBytes(16).toString("hex");
    const hash = pbkdf2Sync(process.env.SITE_PASS, Buffer.from(salt, "hex"), 100000, 32, "sha256").toString("hex");
    process.stdout.write(JSON.stringify({ username: process.env.SITE_USER_NAME, iterations: 100000, salt, hash }));
  ')
  SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')
  umask 077
  cat > "$ENV_FILE" <<EOF
DASHBOARD_AUTH='$AUTH'
DASHBOARD_SESSION_SECRET='$SECRET'
SITE_ORIGIN='$SITE_ORIGIN'
SITE_PORT='$SITE_PORT'
SITE_BIND='127.0.0.1'
SITE_DIST='$APP_DIR/dist'
SITE_DATA='$DATA_DIR'
EOF
  chmod 600 "$ENV_FILE"
fi

echo '== 3/5 安装日报数据（首次部署把仓库快照里的日报搬过去）'
if [ -f "$REPO/ops/runtime/df-runtime.tar.gz" ] && [ -z "$(ls -A "$DATA_DIR/research-daily/reports" 2>/dev/null)" ]; then
  tar -xzf "$REPO/ops/runtime/df-runtime.tar.gz" -C "$DATA_DIR" --strip-components=2 \
    --wildcards '*/reports/research-daily/*' 2>/dev/null || true
  echo '   已从快照恢复日报；若为空请先跑一次每日链路'
fi

echo '== 4/5 安装 systemd 服务'
cat > /etc/systemd/system/dimension-site.service <<EOF
[Unit]
Description=Dimension Football dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/server.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now dimension-site.service
sleep 2

echo '== 5/5 自检'
curl -fsS -o /dev/null "http://127.0.0.1:$SITE_PORT/login" && echo '   本地登录页 OK'
SITE_ORIGIN="$SITE_ORIGIN" SITE_USER="$SITE_USER_NAME" SITE_PASS="$SITE_PASS" \
  bash "$REPO/scripts/verify-site-login.sh" || { echo '   公网验收未通过；检查 DNS 与反代' >&2; exit 1; }
echo '完成。'
