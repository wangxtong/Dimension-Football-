# 网站、实时盘口与 Telegram 交付

网站地址：https://dimension-football-live-wangxtong.secretmelon37.chatgpt.site 。看板使用独立的用户名/密码登录，不要求访客拥有 ChatGPT 账号。源码位于 `website/`，服务端由 Sites Worker 承载；修改源码后需重新构建并部署。报告刷新不需要重新部署网站。

## 自动更新与回执

`.github/workflows/public-sources.yml` 每小时第 17 分钟（UTC）运行，也支持手动触发及相关代码合并触发；GitHub 调度可能延迟。每轮最多采集 2 分钟。原 `collection.yml` 不重复推送这个网站。

后台通过本轮 `GITHUB_TOKEN` 将 `predictions.json` 与 OpenLigaDB 的规范化原始数据写入专用 `published-reports` 分支，回读并核验报告 ID 和文件 SHA-256 后，才记录 `externalWebsite: published`。这是数据交付回执，不是用户已打开网页的证明。最后单独同步 `publication.json`。分支首次创建为无父提交的数据分支，不含工作流；后续更新不强推。

看板每 5 分钟读取新报告，每 30 秒复查有效期。到期或开赛的预测移入“暂不可评估”；严格候选还需全部配对报价有效。读取失败保留上次报告并提示；报告与回执 ID 不一致时显示同步中。后台小时频率无法保证亚洲盘每 5 分钟都新鲜，严格候选在两轮之间可能很快到期，不能声称持续实时有效。

报告文件、GitHub 附件、Summary、网站数据和通知分别记录结果。最终回执同时见 Actions 的 `publication-receipt` 附件和网站数据分支。普通预测仍为未校准统计基线，缺少报价不会隐藏已有预测。

## Telegram 凭据入口

`collector/delivery.mjs` 已实现发送器；`config/delivery.json` 控制渠道。需要在仓库 Actions Secrets 中配置：

- `TELEGRAM_BOT_TOKEN`：机器人令牌。
- `TELEGRAM_CHAT_ID`：接收用户或群组的数字 ID（群组 ID 可以为负数）。

配置入口：https://github.com/wangxtong/Dimension-Football-/settings/secrets/actions 。不要写进仓库、前端、报告、日志或普通 Repository Variables。`.env.example` 仅保留空占位；本地运行需由外部环境注入变量。

任何一项缺失即 `not_configured`，不访问 Telegram。模拟报告不发送，超过 1 小时的报告不发送。文本仅含本轮分类数量、生成时间和网站链接。返回消息 ID 且目标 Chat ID 匹配才记 `accepted`，它表示 Telegram 接收，不表示收件人已读。回执只存目标 ID 的哈希指纹。网络异常或回执不确定记 `unknown`，同一报告不自动重发；人工核对后再处理。新的采集报告有独立 ID，可独立发送。

发送失败或结果未知时，通知步骤返回非零状态；后续网站回执同步与附件保存仍按 `always()` 执行。HTTP 拒绝回执将缺失群地址、禁言、机器人不在群中、群迁移、无效令牌和限流映射为固定错误码。HTTP 400/403 时追加一次只读 `getMe` 核对公开机器人用户名，不重发消息，不保存原始错误正文、令牌或 Chat ID。目标指纹可用于核对 Secrets 是否填写了预期群地址。

## 新增香港赛马会独立公开报价

`collector/sources/hkjc.mjs` 从 [官方 HDC 页面](https://bet.hkjc.com/en/football/hdc) 使用的公开只读操作获取数据，不需要账户、Cookie 或 API Key。请求固定为 `https://info.cld.hkjc.com/graphql/base-get/`，GraphQL 操作保存在 `hkjc-query.graphql`；GET 也必须带 `Content-Type: application/json`。每轮一次请求、最多 8 秒、响应上限 2 MB，不翻页冒充完整覆盖。

核验联赛代码及名称、显式球队别名、主客方向、开赛时间差不超过 5 分钟、非进行中、全场 HDC、开放主盘口和完整 H/A 双边价格。拆分盘口取两线均值，如 `-0.5/-1.0` 对应主队 -0.75；依据 [马会足球博彩规则 3.8](https://consvc.hkjc.com/-/media/Sites/JCBW/Special/betting-rules/Football_Rule_3_Eng_20260429)。不把 HHA 三项让球或半场盘混入亚洲盘。

独立来源组为 `hkjc-first-party`，区别于球探的 `titan007`。价格来自博彩公司自身，不把同一网站的多家公司重复计票。供应商 `updateAt` 原样保留为 `sourceUpdatedAt` 和 `providerPoolUpdatedAt`，不将它解释为真实开盘时间或最后一次变价时间。仅该固定自动来源可采用第一方当前开放盘口快照：检查服务器 Date、Age 与 Cache-Control（上限 60 秒），记录 `sourceAsOf`，报价最多有效 5 分钟且不跨开赛。其它来源与手工导入仍适用原更新时间门槛。

2026-10-31 05:38 UTC 本地实采：官方响应 159 场，匹配输入 13 场中的 12 场、共 24 条双边报价；9 场普通预测、4 场历史不足、0 场严格盘口候选。球探本轮被 robots 规则阻止，因此这些比赛只有一个当前有效独立来源组。HKJC 没有提供可验证的真实初盘，本次没有制造初盘。接入第二个适配器不等于每场已满足双源条件。

## 网站密码登录

`website/worker.mjs` 在服务端验证共享访问账号。Sites 入口允许访客到达应用登录页，但报告、脚本、样式和 `/api/` 报告代理都需通过应用会话验证。发布时先在原所有者权限下部署并验证受保护 Worker，再切换平台访问策略。不能把旧静态版本直接开放。

Sites 运行时 Secrets 使用 `DASHBOARD_AUTH`（含 username、100000 次 PBKDF2-SHA256 的 salt/hash 与 iterations）、`DASHBOARD_SESSION_SECRET`（随机 32 字节十六进制值）和 `DASHBOARD_ORIGIN`（站点来源）。密码原文不进入源码或浏览器。账号和密码由所有者指定，不在文档中公布。更换密码哈希或会话签名密钥会使旧会话失效，修改运行时配置后需重新部署。

会话有效期 12 小时，Cookie 使用 `__Host-`、Secure、HttpOnly 和 SameSite=Lax。登录、退出只接受同源 POST；页面和接口禁止缓存。退出会清除当前浏览器 Cookie。失败尝试按运行实例及请求 IP 限制为 10 次/10 分钟；这是有界内存保护，并非跨实例持久限流。看板没有账户注册、个人权限或支付功能。

报告代理只访问固定 GitHub 数据分支的三个允许文件，不转发客户端 Cookie 或 Authorization。**仓库现为 Private**，Worker 不再使用匿名 `raw.githubusercontent.com`，而是以固定 GitHub Contents API 地址读取 base64 文件。必须在 Sites Worker 运行时安全设置 `REPORTS_GITHUB_TOKEN`：限定到 `wangxtong/Dimension-Football-` 的只读 Contents 权限，令牌只留在服务端，不进入 HTML、浏览器请求、GitHub 仓库或源码。未配置密钥时返回 503；403、重定向、文件名不匹配、无效编码和响应过大均失败关闭。GitHub Actions 临时的 `GITHUB_TOKEN` **不能**当成网站运行时令牌；发布前先完成运行时密钥配置，再在预览环境实测登录、三类报表和报告 ID 匹配。

构建：`node website/build.mjs /tmp/dimension-site-build`。构建目录包含 `.openai/hosting.json` 与 `server/index.js`；发布归档将构建目录放在 `dist/` 下，并在归档根目录保留同一份 `.openai/hosting.json`，入口为 `dist/server/index.js`。Worker 内嵌明确列出的静态资源，产物不包含运行时 Secrets。`npm test` 覆盖认证、签名伪造、过期、密码轮换、来源校验、限流和未授权接口访问。

已核对目标群的哈希指纹记录在 `config/delivery.json` 的 `telegram.destinationFingerprint`。仅当 Secrets 漏写超级群 ID 的负号、且补回后与预期指纹完全一致时，发送器自动恢复负号并记录 `configurationAdjusted`；其它收件地址不匹配时拒绝发送。迁移通知目标需同步核对新群并更新该指纹，不会盲目把任意正数个人 ID 改成群 ID。
