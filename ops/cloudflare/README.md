# Cloudflare Workers 部署（研究看板）

## 一次性的前置：建 R2 桶

`wrangler.jsonc` 里绑定了 `BUCKET` → 桶名 `dimension-football-research`。桶不存在时部署会直接失败（`bucket not found`），这是预期行为，不是配置错误。

控制台：**R2 → Create bucket → 名字填 `dimension-football-research` → 位置选 Automatic**。

## 两个必须设置的 secret

Worker 启动时缺这两个会拒绝服务：

```sh
npx wrangler secret put DASHBOARD_AUTH          # 粘下面这段 JSON
npx wrangler secret put DASHBOARD_SESSION_SECRET # 32 字节十六进制随机值
```

`DASHBOARD_AUTH` 的格式（密码不进源码，只放 PBKDF2 的 salt 与 hash）：

```json
{"username":"vip","iterations":100000,"salt":"<32 位 hex>","hash":"<64 位 hex>"}
```

生成方法：

```sh
node -e 'const{randomBytes,pbkdf2Sync}=require("node:crypto");const s=randomBytes(16).toString("hex");
console.log(JSON.stringify({username:"vip",iterations:100000,salt:s,hash:pbkdf2Sync(process.env.P,"hex" in{}? undefined:Buffer.from(s,"hex"),100000,32,"sha256").toString("hex")}))' 
```

（实际用 `SITE_PASS=... bash ops/site/install.sh` 会一步生成，见 `ops/site/README.md`。）

## 部署

```sh
npm run cloudflare:build   # 产出 dist/server/index.js
npx wrangler deploy        # 读 wrangler.jsonc
```

认证用 `CLOUDFLARE_API_TOKEN`（Workers Scripts:Edit + R2:Edit + Account Settings:Read）。

## 或者走控制台 Git 集成

Workers & Pages → Create → Connect to Git → 选私有主仓 `wangxtong/Dimension-Football-` → 构建命令 `npm run cloudflare:build` → 部署命令 `npx wrangler deploy`。**建桶与两个 secret 仍要单独做**，Git 集成不会替你创建它们。

## 验收（四条，缺一不算通过）

```sh
SITE_ORIGIN=https://<你的域> SITE_USER=vip SITE_PASS=*** bash scripts/verify-site-login.sh
```

期望：`login=303`、`home=200`、`wrong_password=401`，且

```sh
curl -b <cookie> https://<你的域>/api/research-daily
```

返回 `reportId 3f6b6579b40a3d0d…`、`sevenDays.scored 4`、`brier 0.8265282518511182`。

## 已知坑

- 只开 `HOSTED_PUBLICATION_ENABLED` 不够，`/api/research-daily` 会 404 `RESEARCH_WEB_DISABLED`；两个开关都要 true。
- 日报进 R2 需要先灌一次：`node collector/publish-research-daily.mjs` 写入 `research-daily/current.json` 与 `research-daily/reports/<reportId>.json`。
- 不要把密码、token 写进仓库或提交信息。

## 自定义域名：实测结论（2026-11-04）

- `curl -H 'Host: football.fotpredict.xyz' https://dimension-football-research.anan220920shan.workers.dev/login` → **403**。workers.dev 端点校验 Host，**不能靠阿里云加一条 CNAME 指过来**。
- 该 Cloudflare 账号下 **没有任何 zone**（`GET /zones` 返回空），且 token 无 `zone.create` 权限（POST 返回 403）。所以自定义域必须由账号 Owner 在控制台完成：
  1. Cloudflare 控制台 → **Add a site** → 填 `fotpredict.xyz` → 选 Free 计划；
  2. 记下 Cloudflare 给的两条 NS；
  3. 到阿里云万网把 `fotpredict.xyz` 的 NS 从 `dns9/dns10.hichina.com` 改成这两条；
  4. 等 zone 变 **Active**，再 Worker → Settings → Domains & Routes → Add custom domain 填 `football.fotpredict.xyz`。
- **延迟不会因此变快**：workers.dev 从国内实测 5–8.6 秒，是国际链路问题；绑定自定义域只解决"能否稳定打开"，要真正低延迟需要国内主机 + 备案。这一点不要混淆。


