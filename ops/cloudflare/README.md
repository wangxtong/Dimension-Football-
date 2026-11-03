# Cloudflare Workers · 原GitHub私有仓库直连（研究版）

目标：直接使用原始仓库 `wangxtong/Dimension-Football-`，无需公开仓库、二次克隆或 Railway/阿里云中转。**此Draft只配置不含商业预测发布的研究看板，不代表Cloudflare已部署。**

## 1. Cloudflare账号授权（仅Owner本人在官方界面完成）
- 登录 https://dash.cloudflare.com/ ，打开 **Workers & Pages**。
- 建立新 Worker，或在现有 Worker 的 **Settings → Builds → Connect** 选择 GitHub。
- 授权 **Cloudflare Workers and Pages** GitHub App 访问 `wangxtong/Dimension-Football-`（Only select repositories），仅授予本仓库；Cloudflare账号使用与仓库Owner可授权的GitHub身份。
- 选择原仓库而不是空的/公开的镜像仓库。不要发GitHub Token、Cloudflare Token、站点密码给聊天或写入仓库。
- **独立研究Worker名称**：`dimension-football-research`，须与根目录 `wrangler.jsonc` 的 `name` 完全一致。如果连接的是已有Worker且名称不同，先通过独立PR同步配置中的name，不能忽略名称冲突。
- **研究分支**：`draft/a1-cloudflare-native-git-20261104`。先独立预览/验收，禁止直接选main作为未门禁批准的正式自动部署分支。

## 2. Cloudflare Workers Builds配置
- Root directory: repo root `/`。
- Build command: `node website/build.mjs dist` (Node.js >= 24)。
- Deploy command: `npx wrangler deploy`。
- Wrangler configuration: root `wrangler.jsonc`，Worker entry `dist/server/index.js`。
- 此分支默认 `HOSTED_PUBLICATION_ENABLED=false` 和 `VANTIS_RESEARCH_WEB_ENABLED=false`；仅验证受密码保护的看板，没有预测外发。
- 真正部署后，在Cloudflare Worker的Variables/Secrets设置 `DASHBOARD_AUTH` (格式含username/iterations=100000/随机salt/PBKDF2-SHA256 hash)、`DASHBOARD_SESSION_SECRET`（64位随机十六进制）与 `DASHBOARD_ORIGIN`（访问的精确HTTPS origin）。不可在仓库配置、CI日志、聊天中写明文密码。缺任一配置则Worker按预期返回503，不得宣称可登录。
- R2：本阶段**没有声明BUCKET绑定**，因为研究发布入口默认关闭。启用真实研究原件存储前，应在Cloudflare账户中新建/选定经授权的R2桶，绑定变量名 `BUCKET`，通过单独独立审计的PR配置与回滚/数据保留，不能使用本仓的OpenAI Sites `website/.openai/hosting.json` 代替Cloudflare R2。
- 正式生产不开通 `RELEASE_GATE`。不发布没有真实来源、完整RAW哈希、赛前冻结、官方FT和同报告Web/TG回执的预测。

## 3. 验收必须有实际执行证据
1. GitHub Draft HEAD 精确40位SHA → 同一HEAD真实Node24/Python/Chromium必需Actions全部绿色（无关键失败/跳过）。
2. Cloudflare Workers Builds 的实际运行ID/构建日志及成功部署对应SHA；不能用GitHub构建成功代替Cloudflare上线。
3. Worker HTTPS `GET /login` 返回200且页面展示维度足球；错误凭据401、正确凭据303+cookie（仅由持有账号的授权验收者执行）。禁止匿名401 HTML作为交付通过。
4. 真实研发数据上链需补R2持久化、reportId/完整SHA256读回、Telegram accepted消息ID、官方FT与旧版无回归；任何一项欠缺=研究部分可用但**商业交付失败**。
5. Cloudflare rollback前后用Worker版本/部署ID、运行状态、实际结果读回证明；不能只凭本地页面截图。

## 4. 当前权限边界
ChatGPT仅已连接原GitHub仓库；当前Cloudflare浏览器会话未登录、无Cloudflare部署API身份。因此本文件+PR不能自行为用户完成Cloudflare GitHub OAuth授权；必须用Cloudflare账号在官方UI完成一次授权。授权完成后才可真实部署并验收。测试之前不要合并main或宣称已上线。
