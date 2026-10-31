# 维度足球 · 长期采集任务

把原来的云端定时采集整理为可审阅、可部署的 Node.js 24 项目。本地采集入口为 `npm run collect`；生产目标是由现有阿里云 ECS 保存持久状态并统一发布，Sites 保留原网址与登录。GitHub Actions 在 ECS 实机验收前保留每小时归档，验收切换后只作手动灾备。核心 HTTP 采集无 npm 第三方依赖；可选浏览器运行时采用锁定版本的 Crawlee + Playwright。

本版取得赛程、历史比分和已实现的数据源证据，分别生成基础赛前预测与严格盘口筛选结果，保存进度并输出报告。采集命令本身不发送 Telegram；生产交付编排在配置后发送有持久回执的小时摘要。项目不调用 OpenAI API，也不下注。`forecast` 是历史统计模型的胜平负概率；`candidate` 是通过盘口证据门槛后仍需人工复核的候选，两者分别计数。

**本次切换的验收起点：ECS 尚未完成实机部署和 HTTPS 供数验收；网站当前使用含 9 场普通预测的真实 bootstrap 恢复快照。** 快照保留原生成时间，不能算作持续采集或实时网站发布。源码提交、测试通过、GitHub 归档成功都不能替代 ECS 与原站点的同报告回读验收。

## 先在本机验证

在仓库根目录使用 Node.js 24：

```sh
npm test
npm run collect -- --demo
```

`--demo` 完全离线，使用虚构比赛；报告醒目标记“模拟”，正式候选与模拟结果分开，默认检查点存入 `.collection-state-demo/state.json`。不要把模拟报告作为实际比赛建议。

正式采集至少配置一家赛程服务：football-data.org 的 `FOOTBALL_DATA_API_KEY`（也接受 `FOOTBALL_DATA_API_TOKEN`）、API-Football / API-Sports 直连服务的 `API_FOOTBALL_KEY`，或 Sportmonks 的 `SPORTMONKS_API_TOKEN`。默认按该顺序选择已配置且可用的源；同一家 `KEY` 优先于 `TOKEN`。只配置一家时没有备用服务。随后执行：

```sh
npm run collect -- --state .collection-state/state.json --out reports --budget-minutes 20
```

也可以提供自行维护的真实赛程 JSON：

```sh
npm run collect -- --input /path/to/fixtures.json --state .collection-state/state.json --out reports
```

`FIXTURES_FILE` 环境变量与 `--input` 对应。默认正式入口缺少 API key、又没有赛程文件时会明确失败，不会用演示数据补齐。真实赛程文件的字段与人工证据导入方式见[迁移与部署说明](docs/CLOUD_TASK_MIGRATION.md)。

没有私有凭据时可显式使用官方公开源：`npm run fixtures:public` 取得有限赛程样本；`npm run collect:public` 另取德甲当前及上一赛季的完赛历史，生成基础预测和公开证据分析。输出默认在 `reports/public/`，状态独立保存在 `.collection-state/public/`。TheSportsDB 使用官方共享免费 Key `123`，其余四个联赛各取最多一场，缺少对应历史时逐场说明；不是五大联赛完整实时服务。命令默认整轮最多 5 分钟。公开归档工作流在过渡期每小时第 17 分钟执行，**只归档，不自动更新网站或发送通知**；Actions 调度可能延迟。详情见 [公开信息源](docs/PUBLIC_SOURCES.md)。

环境变量不会从 `.env` 自动加载。本地可将一种凭据保存在 Git 忽略的 `.env.local` 中，再运行 `node --env-file=.env.local collector/run.mjs`。生产 ECS 从服务配置加载秘密，将状态和报告放在发布目录之外；自动与手动执行统一经过 `deploy/run.sh` 的 OS 锁，不能另起独立采集进程。云效的部署变量不会自动成为后续服务的环境变量。

## 赛前预测与报告

`npm run collect:public` 会生成 `predictions.html`、`predictions.md`、`predictions.json`。页面逐场展示主胜 / 平 / 客胜概率、预期进球、比分参考、历史样本和缺项。即使盘口来源不足，历史充分的比赛仍会有基础预测；严格盘口候选不会因此放宽门槛。GitHub 的“公开数据过渡归档与灾备”工作流将结果写入 Summary 并保存可下载产物。

报告现在按普通预测、严格盘口候选、暂不可评估三类展示，并提供球队相对实力、数据检查项、回测和预测有效期。实际文件生成、GitHub Summary 写入及附件上传分别记录在 `publication.json`；最终回执见本轮 `publication-receipt` 附件。严格盘口增加真实初盘来源与时间校验及持久档案；已接通香港赛马会第一方公开 HDC 报价，独立于球探渠道；双源同时有效和真实初盘仍逐场核验。外部看板与 Telegram 配置见 [网站和通知](docs/DELIVERY.md)。

当前模型是按主客场、进失球和时间衰减估计的泊松基线，带按时间滚动回测；尚未做概率校准，不使用盘口或伤停数据。缺历史、球队 ID 或样本不足时不输出默认概率。通用入口也支持 `npm run collect -- --input fixtures.json --history history.json`，身份与历史字段见 [预测实现说明](docs/FORECASTING.md)。

## 信息源自动更新与故障切换

每轮采集检查官方赛程响应的结构、身份、时间戳与五大联赛覆盖。主源完整时不消耗备用配额；主源不可用或不完整时按配置尝试其他已接入服务，保留覆盖更完整的一整份赛程，不拼接不同服务的赛事 ID。有效的空赛程表示该窗口没有比赛，属于成功。Sportmonks 使用有界分页，未读完不能视作完整覆盖。

`config/sources.json` 设置来源顺序、连续失败阈值和冷却时间。普通故障连续两轮后指数退避；401/402/403、限流及配额耗尽采用单独冷却，并读取有界的 `Retry-After`。冷却期间跳过请求，到期后的下一轮自动探测恢复。深度分析固定使用 API-Football 身份；商业分析材料与公开证据并行采集，未核实独立性的盘口不会替换正式证据。详情见 [信息源维护说明](docs/SOURCE_MANAGEMENT.md)。

健康状态保存在检查点旁的 `state.json.sources.json`；报告增加本轮尝试、失败原因、切换记录和公开来源状态。可离线查看，不需要凭据：

```sh
npm run sources:status -- --state .collection-state/state.json
```

这是随实际采集轮次执行的自动维护机制；ECS 分层任务按各自周期运行，过渡期 Actions 归档仍为每小时。冷却时间不是新的独立定时器，增加调度频率也不能绕过来源预算和冷却。

## 商业预测与盘口接口

配置 `SPORTMONKS_API_TOKEN`、`THE_ODDS_API_KEY`、`ISPORTS_API_KEY` 后，正式采集自动取得 Sportmonks 赛前胜平负模型、The Odds API 多公司市场参考及 iSports 当日亚洲盘，并写入同一轮 JSON / 消息版报告。无密钥不请求，401/402/403 与限流持久冷却；现有公开爬虫独立工作。

```sh
npm run providers:status
node --env-file=.env.local collector/run.mjs --provider-status
```

纳米、Opta、Sportradar、LSports、TXODDS 目前只登记商务接入要求，未接通数据。商业盘口暂不增加正式独立来源票，iSports 初盘字段没有时间时不构造初盘轨迹。配置、实际覆盖、费用边界与验证范围见 [商业信息源说明](docs/COMMERCIAL_SOURCES.md)。

## 开源爬虫与浏览器采集

网页采集已加入 robots 规则、域名串行限速、GET 有限重试、429 冷却、条件缓存复验、访问挑战识别和格式诊断。球探 XML/JS 快照与天天盈球列表采用 HTTP；安装浏览器运行时后，Statarea 页面通过 **Crawlee 3.18.2 + Playwright 1.64.1** 执行 JavaScript 再送入同一身份核验与解析流程。

```sh
npm run crawler:install
npm run crawler:doctor
npm run crawl:check -- --source all
```

`auto` 模式会探测依赖、Chromium 和 JavaScript 执行能力；浏览器运行环境不可用时使用 HTTP 并记录原因。`VANTIS_CRAWLER_ENGINE=crawlee` 强制要求浏览器。服务器可将依赖装入发布目录之外的固定位置，保留系统代理与 TLS 验证；已有授权登录状态可由站点专用文件载入。登录过期或验证页面会记录阻断原因，不能把该页面当成预测数据。

工具选择、自动环境检查、持久安装、会话配置、缓存时效和验证边界见 [开源爬虫接入说明](docs/CRAWLER_INTEGRATION.md)。`crawl:check` 只检查公开抓取链路，返回内容不等于已取得有效比赛预测。

## GitHub Actions：过渡归档与手动灾备

`.github/workflows/public-sources.yml` 保留 UTC 每小时第 17 分钟采集，直到 ECS 完成实机验收。也可在 main 分支手动 **Run workflow**；源码 push 不触发额外一轮采集。该工作流只执行采集、GitHub `archive`、Summary 和附件操作，不注入 Telegram 或站点探测令牌，不调用 `website`、`telegram` 或 `all`。

- 归档渠道为 `repositoryArchive`；GitHub 写入和回读成功不能把 `externalWebsite` 改为已发布。
- 检查点独立保存在 `.collection-state/disaster-public/`。cache 只尽力恢复和加速，会失效或被清理；未命中时明确记录从空状态开始。它不是自动、可靠的跨轮持久数据库，更不是 ECS 生产历史。
- 报告、最终 `publication-receipt` 和独立检查点 artifact 保留 30 天。检查点 artifact 是可下载的人工恢复证据，工作流不会自动从它恢复，也不会把它写入 ECS 或恢复通知 outbox。
- 需要的现有来源凭据仍从 Actions Secrets 注入；无需新增 PAT。`GITHUB_TOKEN` 只用于固定私有仓库的数据归档。

**只有在 ECS 调度、持久备份、原站点同报告回读及通知账本均验收后，才把仓库变量 `VANTIS_ECS_PRIMARY` 设置为字符串 `true`。** 此变量会跳过公开归档的 schedule，保留手动灾备；本次源码修改不会设置远端变量。启用 ECS 通知前，还须确认升级前已开始的旧版 Actions 发送作业已经结束，不能认为工作流文件更新会改变正在执行的作业。灾备运行不能自动接管网站或通知，恢复实时服务需重新核对 ECS 状态与同报告回执。

旧 `.github/workflows/collection.yml` 另有整点 schedule，以 `VANTIS_COLLECTION_ENABLED` 门控，仍保留手动与 push 验收入口。切换 ECS 时应保持其定时采集禁用，避免重复消耗来源配额；它不负责网站或 Telegram 交付。旧云端计划是否仍在运行须按实际记录检查，本仓库不会自动停用它。

## 阿里云 ECS：持久状态与唯一生产发布端

以下是目标部署流程，不代表服务器已安装或已接通。复用现有 ECS，不改变仓库私有性、Sites 身份或通知目标。完整安装、恢复和实机验收步骤见 [运维说明](docs/OPERATIONS.md) 与 [部署入口](deploy/README.md)。

1. 先用既有 Workbench 做无秘密的只读检查，确认 Node.js 24.14+、磁盘、服务和现存状态。系统依赖须已安装；新版 bootstrap 不在线下载安装 Node，也不匿名下载私库。
2. 从批准的完整提交构建带摘要清单的离线制品，通过既有 Workbench/云效传输。默认 `artifact` 模式不启用源码轮询。需要 Git 同步时另行配置固定私库只读 deploy key 与已核验主机密钥；不使用新的 PAT 或 Actions OIDC 作为 ECS 身份。
3. 在服务器核验制品摘要并安装。秘密置于 `/etc/vantis/collector.env` 与独立报告服务配置；状态置于 `/var/lib/vantis`，发布目录只读。普通升级保留秘密、检查点和报告。
4. 统一入口 `/opt/vantis/deployment/run.sh` 取得 OS 锁后运行分层编排。systemd 每分钟 tick；初始任务目标周期为赛程 15 分钟、盘口 2 分钟、交付 1 分钟、赛果 1 小时。排队和预算会导致延迟，不保证实时 SLA；Telegram 默认每 UTC 小时最多一条摘要，不随盘口轮次刷屏。
5. 报告服务只监听 loopback，需既有可信 HTTPS 入口反代并完成授权回读，再让原 Sites 使用该入口。只有原站点回读同 reportId、报告摘要一致，且 `mode=ecs`、`health=available` 时，才能记录 `externalWebsite: published` 与 `servedVerified:true`。bootstrap、GitHub artifact、服务启动或 CI 成功都不能替代该条件。

构建和校验示例（占位 SHA 必须换成实际已批准值）：

```sh
python3 deploy/bundle.py build . FULL_40_CHARACTER_SHA /tmp/vantis-release.tar
python3 deploy/bundle.py verify /tmp/vantis-release.tar --sha256 EXPECTED_64_CHARACTER_SHA256
```

持久备份应覆盖检查点、来源状态、`reports/replays/`、预测 ledger、完整 `.delivery/` 和运维记录，尤其不能遗漏 `.delivery/outbox/`。备份与恢复使用统一锁，恢复演练验证摘要和报告身份；不要删除账本或把未知通知重置为未发送。每次切换核对 `operations/release.json`、`operations/health.json`、真实网站回读和通知回执，再决定是否停用过渡归档。

## 当前数据覆盖

| 数据 | 已实现的能力 | 限制 |
| --- | --- | --- |
| 赛程 | football-data.org、API-Football 或 Sportmonks 官方 API，英超、西甲、意甲、德甲、法甲，默认未来 7 天 | 需要所选服务的 API key；账号权限与上游可用性影响覆盖 |
| 亚洲盘 | 球探公开快照中的 M88、12Bet、SBOBET | 三家公司共享一个网站采集渠道，统一只算 **一个独立来源组**；排除皇冠；另有 HKJC 第一方独立渠道；实时可用性与真实初盘仍逐场核验 |
| 辅助预测 | Statarea 已发布页面的 1X2 概率 | 仅覆盖已发布的当日至未来 3 天页面；不是亚洲盘赢盘概率 |
| 商业分析材料 | Sportmonks 1X2 模型、The Odds API 市场参考、iSports 当日亚洲盘 | 分别需要对应凭据与权益；市场价格不是模型胜率，未通过独立性核验不增加正式票 |
| 其他来源 | 记录来源能力及具体缺失原因 | 天天盈球只监测免费赛前列表，不生成预测票；未实现或需要授权的来源不生成证据 |

因此，只有内置自动来源时通常会得到 `source_insufficient`，而不会强行拼凑成符合双来源要求的候选。站点能访问、博彩公司的数量、相同内容的多个页面都不会自动变成独立预测共识。已确认的原任务规则见 [config/cloud-task.md](config/cloud-task.md)。

API-Football 每轮向五个联赛各请求一次 `next=99`，再按精确未来时间窗口过滤；只保留 `NS`，不采用时间未定的 `TBD`。达到 99 场上限且不能证明窗口已覆盖时标记数据不完整。每小时运行约需 120 次赛程 API 请求/天，运行前请核对套餐额度和赛季权限。其 [Free 套餐](https://www.api-football.com/pricing) 目前只有 100 次/天且有赛季限制。备用请求、Sportmonks 分页、商业分析材料与深度分析请求另计；基础模式切换到 API-Football 不会额外自动开启深度分析。

跨服务的球队名称须命中现有精确别名；尚未识别的名称可能导致盘口或辅助信号无法匹配，此时保留来源不足，不使用模糊匹配补齐。

## 输出和目录

### 全部赛事逐项分析

`analyze:full` 是独立的离线分析入口，与亚洲盘候选筛选分别统计。每场都会执行赛程身份、近况、主客场、交锋、休息间隔、伤停、首发、胜平负、大小球2.5、亚洲盘事实、独立预测及正式门槛检查；某项缺数据不会停止其它维度。输入须为已授权取得的 API-Football 响应，不会联网或读取密钥。

```sh
npm run analyze:full -- --evidence /path/to/evidence.json --markets /path/to/snapshot.json --history /path/to/history.json --independent reports/latest.json --out outputs/full-analysis
```

`evidence.json` 包含 `{fixtures, evidence}`：`fixtures` 为本项目标准赛程，`evidence` 为带 `kind`（`fixtures/history/injuries/lineups/predictions`）、逐场 `fixtureId` 及原始官方 `data` 的响应。赔率输入为 `{fetchedAt, fixtures:[{fixture, pages:[{data,fetchedAt,httpDate}]}]}`；`history` 是 `{data}` 响应数组；`independent` 是现有采集报告。完整原始记录应保存在仓库外或 Git 忽略目录中。

输出独立 HTML 和 JSON，按最新官方赛程核验旧赔率的身份，保留每家公司的配对报价、更新时间、全部缺项和唯一市场参考方向。去水概率只描述价格；不代表真实胜率。3小时研究参考与5分钟正式报价时效分开，正式推荐仍需原有完整评估，不会因为报告已生成而自动变成可下注。空伤停记录、尚未公布首发和缺初盘轨迹分别报告。

只生成报告，不会自动发送频道消息。`collector/run.mjs --deep-analysis` 会先完成原有证据筛选，再对同一完整输入池补取上述官方材料并生成 `reports/full-analysis/latest.html` 与 JSON；缺亚洲盘不会阻止补取其它维度。通用采集入口在仅配置 `API_FOOTBALL_KEY`、未指定输入文件时也默认启用此流程；这不证明 ECS 分层编排已经调用它，需以实际 lane 记录确认。深度模式必须配置 `API_FOOTBALL_KEY`，明确优先采用该服务的赛程ID，避免跨供应商ID误配。每轮官方深度请求预算最多250次，超预算逐项记录未取得材料；正式候选数量与逐项分析覆盖量分开。

现有服务不因本地文件改动而更新；应用制品切换与部署工具升级分别验收。48场规模若每小时执行一次深度分析，至多约6,000次深度请求/天，另计基础赛程请求；不能把该预算直接套用到两分钟盘口任务。大输入池需要相应配额或数据缓存，尚未取到的记录不能当成完整证据。

每轮在 `reports/` 生成带 UTC 时间戳的 JSON、简报与消息草稿，以及 `latest.json`、`latest-brief.md`、`latest-message.md`。消息草稿只是文件，不会发送到外部服务。

```text
.github/workflows/public-sources.yml  过渡小时归档；ECS验收后可切为仅手动灾备
.github/workflows/collection.yml  旧通用采集；定时执行由独立变量门控
collector/orchestrate.mjs         ECS分层采集与交付入口
collector/operations.mjs          持久调度与健康检查
collector/                        数据源、筛选、进度、报告与测试
config/collection.json            运行预算、时效与筛选阈值
config/sources.json               官方赛程源优先级与失败冷却
config/crawler.json               网页爬虫限速、重试、缓存与请求预算
config/cloud-task.md              从可读取记录整理的原任务规则
docs/CLOUD_TASK_MIGRATION.md       输入契约、迁移步骤和已知限制
docs/OPERATIONS.md                ECS制品安装、持久备份与实机验收
```

原有 `pitchsignal/` 网页目录独立保留；本次长期采集的运行入口在仓库根目录。

可直接下载 `artifacts/Dimension-Football-collection.zip` 获取独立源码包。需要重新打包时运行 `python scripts/package.py`；它只打包明确列出的源码目录，排除密钥、数据库、检查点和报告。
