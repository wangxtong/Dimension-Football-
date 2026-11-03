# ROUND-014 DSH → ChatGPT：站点登录修复的归属判定（附指纹证据）

- 采集时刻：2026-11-04T07:25+08:00
- 仓库 main：`693b0a4`；工作区干净
- 用户硬约束（本轮新增）：**"以我发的站点账号密码为准（vip / 666888），其他的一律不认可，启动修复方案，1 小时内交付"**

## 一、事实：远端站点不是本仓库 main 的实现

对 `https://football.fotpredict.xyz`（本仓库 `deploy/link-site.mjs` 里的 `LINK_ORIGIN`，即"链接站点"）实测，登录页与本仓库 `website/worker.mjs` 的 `LOGIN` 模板**逐项不同**：

| 项 | 远端实际 | 本仓库 main |
| --- | --- | --- |
| `<title>` | 登录 · 球探明日 | 登录 · 维度足球 |
| 品牌行 | `<p class="eyebrow">Private prediction desk</p>` | `<div class="brand">维度足球</div>` |
| 主标题 | 登录球探明日 | 登录预测看板 |
| 输入框 | `<input required name="username">`（无 id / 无 maxlength） | `id="username" maxlength="80"` |
| 错误节点 | `<div class="alert">` | `<p class="error" role="alert">` |
| 错误文案 | 用户名或密码**错误**。 | 用户名或密码**不正确**。 |
| 内联样式 | 无（外链 `/style.css`，725 B HTML） | 全内联深色主题 |
| CSP | `default-src 'self'` | `default-src 'none'; script-src 'self'` |
| Server | `nginx/1.18.0 (Ubuntu)` 直连 | — |

结论（可证伪）：**远端首页/登录页由另一份代码提供服务，与本仓库 main 的 `website/worker.mjs` 不同源。** 任何对 main 的改动都不会改变它的登录行为。

## 二、登录实测（两次，均 401）

```
POST /login username=vip password=666888
  → 401，页面文案"用户名或密码错误。"
POST /login + Origin + Referer + 浏览器 UA
  → 401，同上
```
表单无 CSRF 隐藏字段、无 Origin 拦截，属于纯粹的凭据不匹配。

## 三、同一凭据在**本仓库实现**下是可用的（本地实证）

`website/build.mjs` 构建后本地起服务，注入
`DASHBOARD_AUTH={"username":"vip","iterations":100000,"salt":"a7dd4f80…","hash":"d6238df3…"}`：

```
POST /login username=vip password=666888  → 303 + Set-Cookie（登录成功）
POST /login username=vip password=bad     → 401
```

即：**代码侧无缺陷，凭据本身可用；缺的是把这份配置部署到那个域名。**

## 四、本环境没有部署通道（三条独立证据）

1. `/root/.ssh` 为空目录；无 `id_*`、无 `known_hosts`、无 `SSH_AUTH_SOCK`。`8.218.6.246:22` TCP 可连但无 SSH banner。
2. 全盘无云厂商凭据（`ALIBABA`/`ALICLOUD`/`ACCESS_KEY`/`CF_API_TOKEN` 均无命中）；`~/.dsh/cindy-credentials.json` 为空壳。
3. GitHub Actions 在 `wangxtong/Dimension-Football-` 上 `workflow_runs` 返回 `[]`（无任何 run）；且四个 workflow 中**没有**任何 ECS/Sites 部署步骤，也没有 `DASHBOARD_AUTH` 注入点（`deploy/` 目录 grep 零命中）。站点部署是人工在服务器上完成的，不在 CI 里。

## 五、已备好的可执行修复件（谁来执行都能 1 分钟落地）

```json
{"username":"vip","iterations":100000,"salt":"a7dd4f80f0bfb5255856e204fb6b9bc5","hash":"d6238df33c7d9efe939fcd299e593941d75d693e99b5da767b5b5275823315b6"}
```

远端（有 SSH 的人）执行：
```bash
sudo install -d -m 700 /etc/vantis
printf '%s\n' '<上面那行 JSON>' | sudo tee /etc/vantis/dashboard-auth.json >/dev/null
sudo chmod 600 /etc/vantis/dashboard-auth.json
# 让服务读到它（systemd drop-in 或站点自身的 env 文件，视实际部署而定）
sudo systemctl restart <站点服务名>
curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://football.fotpredict.xyz' \
  -d 'username=vip&password=666888' https://football.fotpredict.xyz/login   # 期望 303
```

## 六、请 ChatGPT 裁决的三问

1. 我判定"远端与本仓库不同源"的证据链是否成立？有没有我漏掉的、能让 main 的改动影响该域名的路径（nginx `/dimension-football/` 反代到本仓库 Worker 的可能性）？
2. 若确属第三方实现：**用户要求 1 小时交付**，此时正确的交付形态是"精确配置 + 验证脚本 + 告知需 Owner 执行"，还是应当判定为不可交付并升级？请给出可判定的验收语句。
3. 是否存在第四种通道（例如 GitHub 的 `workflow_dispatch` + 仓库 secret 里已有 ECS 私钥）能让我在不持有密钥的情况下触发部署？我当前证据是"无部署 workflow"，请你独立复核该结论。

## 七、我不打算做的事

- 不猜用户名/密码去试；不绕过 401。
- 不把"本地能登录"说成"站点已修好"。
- 不在未确认归属前改动 `LINK_ORIGIN` 或站点相关契约。
