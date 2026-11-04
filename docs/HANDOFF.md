# 交接文档 · 维度足球 1X2 研究预测

> 写给下一个接手的人或 Agent。读这篇就够了，不需要翻聊天记录。
> 采集时刻：2026-11-04 07:55 北京时间。main = `31f3df3db25ad59c26779e96aee86f37a5caf156`。

## 一句话

把公开赛程、历史比分与盘口证据，走一条确定性链路算成胜平负概率，冻结进不可变账本，生成每日研究日报并分发。目标不是"猜得准"，是**每个数字都能追回到输入、代码版本和冻结时刻**。

## 一、现在能跑通什么（已验证，可复现）

| 能力 | 命令 | 期望 |
| --- | --- | --- |
| 全量测试 | `npm test` | 982 用例，979 通过 / 0 失败 / 3 跳过 |
| 端到端日报 | `bash scripts/push-daily-research.sh` | 五步全过，产出新 `reportId` |
| 每日自动推送 | 定时器 10:10（10:20 兜底） | 北京时间，已注入 Telegram |
| 站点登录 | `bash scripts/verify-site-login.sh` | 303 / 200 / 401 三段 |
| 看板读数 | 见 `ops/site/README.md` | 账本 4 场、Brier 0.8265282518511182 |

自动推送有真实触发实证：`schedule-651dee16` 在 `2026-11-03T02:10:00.191Z` 投递，同次运行 `telegram-receipt.json` 记录 `messageId 322`。

## 二、现在卡在哪（三件，都缺权限而不是缺代码）

1. **`football.fotpredict.xyz` 不是本仓库的部署。** 该域名的登录页与本仓库 `website/worker.mjs` 指纹不同，是第三方实现；vip/666888 对它返回 401 属预期。本仓库的站点在 Cloudflare Workers，见 `ops/cloudflare/README.md`。
2. **本环境没有部署通道。** `/root/.ssh` 空目录；全盘无云厂商凭据；GitHub Actions `workflow_runs` 返回 `[]`（runner 不启动），且四个 workflow 里没有任何 ECS/Sites 部署步骤，`deploy/` grep 不到 `DASHBOARD_AUTH`。站点是人工拷上去的。
3. **Cloudflare 已登录但未接通。** 用户浏览器已登录 dash.cloudflare.com；Draft PR #99 只有 `wrangler.jsonc`（Worker 名 `dimension-football-research`、`main: dist/server/index.js`）与 `ops/cloudflare/README.md`，且 **双开关 false、无 R2 绑定** —— 直接部署上去是空壳，看不到账本。

## 三、资产清单

| 路径 | 是什么 | 状态 |
| --- | --- | --- |
| `website/worker.mjs` | 看板 Worker：登录、`/api/research-daily`、账本读取 | 可用，已本地实测 |
| `website/research-daily-store.mjs` | 日报存储，依赖 `env.BUCKET`（R2/KV 同形接口） | 需要 R2 或文件 shim |
| `ops/site/` | **独立部署包**：`install.sh` + `server.mjs` + README | 已实测 303/200/401 + 真实账本 |
| `scripts/verify-site-login.sh` | 登录验收，凭据只走环境变量 | 已入库 |
| `scripts/push-daily-research.sh` | 五步编排：赛程→赛果→日报→TG→站点 | 已入库 |
| `ops/runtime/df-runtime.tar.gz` | 运行时快照：9 份 state + 825 条账本 | 1.35 MB |
| `docs/ROUND-014-DEEPSEEK.md` | 站点不同源证据与无部署通道证据 | 已入库 |

账本数字（2026-11-04 实测）：825 条 JSON；**4 场已评分**；命中率 `0`；Brier `0.8265282518511182`（三分类盲猜约 0.667，**当前劣于盲猜**）；LogLoss `1.3214`。4 场没有统计意义，不要拿它证明模型好坏。

## 四、踩过的坑（别重犯）

- **Railway 方案已按用户指示删除**：PR #93 关闭、分支 `feat/portable-private-research-worker-20261103` 删除。那 5 个文件从未进入 main。别再提。
- **临时隧道不可用**：cloudflared 与 localhost.run 在这台容器的出网环境都建不起稳定长连接。别再把隧道当生产入口。
- **不要把密码写进仓库**：`DASHBOARD_AUTH` 只存 PBKDF2 的 salt/hash；安装脚本用 `SITE_PASS` 环境变量现算。
- **不要用"本地能登录"冒充"站点已修好"**：远端那套不是我们的代码，本地 303 只证明代码侧无缺陷。
- **Actions 的 `[]` 不是"没触发"，是 runner 没起来**：计费根因，不是代码问题。

## 五、接手第一小时该做什么（按优先级）

1. **拿到一个能做写操作的入口**，二选一：
   - Cloudflare API Token（Workers Scripts:Edit + R2:Edit + Account Settings:Read），用 `CLOUDFLARE_API_TOKEN` 环境变量跑 `npx wrangler@4 deploy`；
   - 或装 MCP 连接器 `dsh plugin --profile <profile> add @deepseek-ai/dsh-mcp-client`，接 `https://mcp.cloudflare.com/mcp`（OAuth，不用贴 token，但需重启 web）。
2. **建 R2 桶 → 部署 → 灌日报 → 开双开关**：`HOSTED_PUBLICATION_ENABLED=true` 与 `VANTIS_RESEARCH_WEB_ENABLED=true` 都开，否则 `/api/research-daily` 返回 `RESEARCH_WEB_DISABLED`（这个 404 我踩过）。
3. **验收四件事**：`POST /login` → 303；`GET /` → 200；`GET /api/research-daily` → `reportId c23a698f823c15dc…`、`sevenDays.scored 4`、`brier 0.8265282518511182`；错误密码 → 401。
4. **换域名**（可选）：DNS 在阿里云万网，`football` 是一条 A 记录指向 `8.218.6.246`，TTL 600。改成新入口即可。

## 六、不许做

- 不猜账号密码、不绕过 401。
- 不把 `commercialReleaseGate` 从 `BLOCKED` 改成别的；不对外发投注建议。
- 不把"CI 绿"或"服务起来了"当成功能验收；只认响应码、`reportId` 和账本读数。
- 不覆盖已有运行时状态：`ops/runtime/df-runtime.tar.gz` 的恢复是 `cp -rn`，不覆盖较新文件。
