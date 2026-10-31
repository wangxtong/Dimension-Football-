# 维度足球 · 长期采集任务

把原来的云端定时采集整理为可审阅、可部署的 Node.js 24 项目。入口为 `npm run collect`，GitHub Actions 支持手动运行与每小时运行。项目没有 npm 第三方依赖。

本版负责取得赛程和已实现的数据源证据、按规则逐场筛选、保存进度并输出报告。它不调用 OpenAI API，不发送 Telegram 消息，也不下注。`candidate` 表示证据门槛通过后仍需人工复核的候选，不代表已经发布的推荐。

## 先在本机验证

在仓库根目录使用 Node.js 24：

```sh
npm test
npm run collect -- --demo
```

`--demo` 完全离线，使用虚构比赛；报告醒目标记“模拟”，正式候选与模拟结果分开，默认检查点存入 `.collection-state-demo/state.json`。不要把模拟报告作为实际比赛建议。

正式采集至少配置一家赛程服务：football-data.org 的 `FOOTBALL_DATA_API_KEY`（也接受 `FOOTBALL_DATA_API_TOKEN`），或 API-Football / API-Sports 直连服务的 `API_FOOTBALL_KEY`。两家均配置时默认优先使用 football-data.org，失败或覆盖不完整时自动尝试 API-Football；同一家 `KEY` 优先于 `TOKEN`。只配置一家时没有备用服务。随后执行：

```sh
npm run collect -- --state .collection-state/state.json --out reports --budget-minutes 20
```

也可以提供自行维护的真实赛程 JSON：

```sh
npm run collect -- --input /path/to/fixtures.json --state .collection-state/state.json --out reports
```

`FIXTURES_FILE` 环境变量与 `--input` 对应。默认正式入口缺少 API key、又没有赛程文件时会明确失败，不会用演示数据补齐。真实赛程文件的字段与人工证据导入方式见[迁移与部署说明](docs/CLOUD_TASK_MIGRATION.md)。

环境变量不会从 `.env` 自动加载。本地可将一种凭据保存在 Git 忽略的 `.env.local` 中，再运行 `node --env-file=.env.local collector/run.mjs`。ECS / 轻量服务器可用同一命令，将 `--env-file`、`--state`、`--out` 指向发布目录以外的固定路径，并由系统调度器每小时执行；云效的部署变量不会自动成为后续定时任务的环境变量。

## 信息源自动更新与故障切换

每轮采集检查官方赛程响应的结构、身份、时间戳与五大联赛覆盖。主源完整时不消耗备用配额；主源不可用或不完整时最多尝试另一家一次，保留覆盖更完整的一整份赛程，不拼接不同服务的赛事 ID。有效的空赛程表示该窗口没有比赛，属于成功。

`config/sources.json` 设置来源顺序、连续失败阈值和冷却时间。普通故障连续两轮后指数退避；401/403、限流及配额耗尽采用单独冷却，并读取有界的 `Retry-After`。冷却期间跳过请求，到期后的下一轮自动探测恢复。深度分析固定使用 API-Football 身份；盘口和辅助预测当前没有已验证的同类备用接口，不进行替换。详情、回退边界及新来源接入条件见 [信息源维护说明](docs/SOURCE_MANAGEMENT.md)。

健康状态保存在检查点旁的 `state.json.sources.json`；报告增加本轮尝试、失败原因、切换记录和公开来源状态。可离线查看，不需要凭据：

```sh
npm run sources:status -- --state .collection-state/state.json
```

这是随现有采集轮次执行的自动维护机制；默认调度仍为每小时，冷却时间不是新的独立定时器。

## 部署到 GitHub Actions

1. 将项目文件上传到仓库默认分支，确认 **Actions** 中出现“维度足球长期采集”。
2. 在 **Settings → Secrets and variables → Actions → Secrets** 添加一种服务对应的密钥：`FOOTBALL_DATA_API_KEY` / `FOOTBALL_DATA_API_TOKEN`，或 `API_FOOTBALL_KEY`。如果使用仓库中的真实赛程文件，可在 **Variables** 添加 `FIXTURES_FILE`，值为该文件的仓库内路径。
3. 先用 **Run workflow**，勾选 `demo` 做一次离线验证，再取消 `demo` 验证真实数据源。
4. 原云端长期采集计划目前仍启用；确认新任务可用后，先停用旧采集计划，再把仓库变量 `VANTIS_COLLECTION_ENABLED` 设为字符串 `true`，开启新计划。这个项目不会修改原计划或自动发布任务。

工作流为 UTC 每小时第 0 分钟触发，对应北京时间每小时整点；GitHub 的排队与高负载可能造成延迟，不能当作准点服务。定时工作流只从默认分支触发，详见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

每轮内部预算最多 20 分钟，整个作业最多 25 分钟；相同工作流不会同时运行。检查点通过 cache 在多轮间恢复，失败时也尝试保存；报告作为 Actions artifact 保留 30 天。**cache 会失效或被清理，不是永久数据库。** 需要可靠长期续跑时，把同一命令部署在持久服务器上，并为状态文件与报告配置持久目录及备份。

## 阿里云 ECS / 轻量服务器与 Git 自动部署

仓库也提供无需云效组织的 ECS 原生同步方式：以 root 运行 `deploy/bootstrap.sh <完整提交SHA>`，安装官方 Node.js 24、验证该提交的全部测试并安装服务。`vantis-sync.timer` 每两分钟检查固定仓库的 `main` 分支，新提交测试通过后原子发布；`vantis-collector.timer` 每小时执行采集。凭据在服务器的 `/etc/vantis/collector.env` 中配置，源码中不包含真实值。具体路径与日志命令见 [部署文件说明](deploy/README.md)。

Linux 服务器的首次安装、每小时 systemd 调度、固定密钥和检查点目录见 [部署文件说明](deploy/README.md)。云效 Flow 使用 GitHub 仓库的 `main` 分支，开启代码提交触发，并按 [阿里云代码源触发文档](https://help.aliyun.com/zh/yunxiao/user-guide/code-source-trigger) 将该流水线的 Webhook 添加到 GitHub 仓库。

构建阶段使用 Node.js 24，执行以下命令并将 `vantis-source.tar.gz` 作为制品上传。无需安装 npm 依赖，凭据也不进入构建产物。

```sh
node --test collector/test/*.test.mjs collector/sources/test/*.test.mjs
tar --exclude='.env' --exclude='.env.*' --exclude='node_modules' --exclude='*.log' -czf vantis-source.tar.gz collector config deploy package.json
```

主机部署阶段将制品下载至固定路径（例如 `/opt/vantis/incoming/vantis-source.tar.gz`），解压到该次专用的临时目录，然后以 root 执行解压目录中的 `deploy/release.sh`。首次安装要先执行 `deploy/install.sh`，并在服务器 `/etc/vantis/collector.env` 填写一种 API 凭据。主机仍需单独安装系统级 Node.js 24；在 Flow 构建集群选择 Node.js 版本不会安装到服务器。

代码推送触发的是源码更新；每小时采集由服务器的 `vantis-collector.timer` 负责。首次成功执行、检查报告和定时器后，再停用其他重复采集计划。此配置不包含 Telegram 自动发布。

## 当前数据覆盖

| 数据 | 已实现的能力 | 限制 |
| --- | --- | --- |
| 赛程 | football-data.org 或 API-Football 官方 API，英超、西甲、意甲、德甲、法甲，默认未来 7 天 | 需要所选服务的 API key；账号权限与上游可用性影响覆盖 |
| 亚洲盘 | 球探公开快照中的 M88、12Bet、SBOBET | 三家公司共享一个网站采集渠道，统一只算 **一个独立来源组**；排除皇冠；不具备第二个自动亚洲盘来源与完整初盘轨迹 |
| 辅助预测 | Statarea 已发布页面的 1X2 概率 | 仅覆盖已发布的当日至未来 3 天页面；不是亚洲盘赢盘概率 |
| 其他来源 | 记录来源能力及具体缺失原因 | 天天盈球只监测免费赛前列表，不生成预测票；未实现或需要授权的来源不生成证据 |

因此，只有内置自动来源时通常会得到 `source_insufficient`，而不会强行拼凑成符合双来源要求的候选。站点能访问、博彩公司的数量、相同内容的多个页面都不会自动变成独立预测共识。已确认的原任务规则见 [config/cloud-task.md](config/cloud-task.md)。

API-Football 每轮向五个联赛各请求一次 `next=99`，再按精确未来时间窗口过滤；只保留 `NS`，不采用时间未定的 `TBD`。达到 99 场上限且不能证明窗口已覆盖时标记数据不完整。每小时运行约需 120 次赛程 API 请求/天，运行前请核对套餐额度和赛季权限。其 [Free 套餐](https://www.api-football.com/pricing) 目前只有 100 次/天且有赛季限制。故障切换每轮最多再使用备用服务的 5 次赛程请求，深度分析请求另计；切换到 API-Football 不会额外自动开启深度分析。

跨服务的球队名称须命中现有精确别名；尚未识别的名称可能导致盘口或辅助信号无法匹配，此时保留来源不足，不使用模糊匹配补齐。

## 输出和目录

### 全部赛事逐项分析

`analyze:full` 是独立的离线分析入口，与亚洲盘候选筛选分别统计。每场都会执行赛程身份、近况、主客场、交锋、休息间隔、伤停、首发、胜平负、大小球2.5、亚洲盘事实、独立预测及正式门槛检查；某项缺数据不会停止其它维度。输入须为已授权取得的 API-Football 响应，不会联网或读取密钥。

```sh
npm run analyze:full -- --evidence /path/to/evidence.json --markets /path/to/snapshot.json --history /path/to/history.json --independent reports/latest.json --out outputs/full-analysis
```

`evidence.json` 包含 `{fixtures, evidence}`：`fixtures` 为本项目标准赛程，`evidence` 为带 `kind`（`fixtures/history/injuries/lineups/predictions`）、逐场 `fixtureId` 及原始官方 `data` 的响应。赔率输入为 `{fetchedAt, fixtures:[{fixture, pages:[{data,fetchedAt,httpDate}]}]}`；`history` 是 `{data}` 响应数组；`independent` 是现有采集报告。完整原始记录应保存在仓库外或 Git 忽略目录中。

输出独立 HTML 和 JSON，按最新官方赛程核验旧赔率的身份，保留每家公司的配对报价、更新时间、全部缺项和唯一市场参考方向。去水概率只描述价格；不代表真实胜率。3小时研究参考与5分钟正式报价时效分开，正式推荐仍需原有完整评估，不会因为报告已生成而自动变成可下注。空伤停记录、尚未公布首发和缺初盘轨迹分别报告。

只生成报告，不会自动发送频道消息。`collector/run.mjs --deep-analysis` 会先完成原有证据筛选，再对同一完整输入池补取上述官方材料并生成 `reports/full-analysis/latest.html` 与 JSON；缺亚洲盘不会阻止补取其它维度。仅配置 `API_FOOTBALL_KEY`、未指定输入文件的正式采集也默认启用此流程，因此已安装的 ECS 启动脚本在同步新版运行源码后同样生效。深度模式必须配置 `API_FOOTBALL_KEY`，明确优先采用该服务的赛程ID，避免跨供应商ID误配。每轮官方深度请求预算最多250次，超预算逐项记录未取得材料；正式候选数量与逐项分析覆盖量分开。

API-Football 单服务的 ECS 在同步该版本运行源码后，每轮自动启用逐项分析，无需替换独立部署脚本；只配置 football-data 的原有采集仍可运行。现有服务不因本地文件改动而更新，必须完成Git同步及服务器版本切换。48场规模每小时运行至多约6,000次深度请求/天，另计基础赛程请求；大输入池需要更高配额或数据缓存，不能把尚未取到的记录当成完整证据。

每轮在 `reports/` 生成带 UTC 时间戳的 JSON、简报与消息草稿，以及 `latest.json`、`latest-brief.md`、`latest-message.md`。消息草稿只是文件，不会发送到外部服务。

```text
.github/workflows/collection.yml  手动及每小时调度
collector/                        数据源、筛选、进度、报告与测试
config/collection.json            运行预算、时效与筛选阈值
config/sources.json               官方赛程源优先级与失败冷却
config/cloud-task.md              从可读取记录整理的原任务规则
docs/CLOUD_TASK_MIGRATION.md       输入契约、迁移步骤和已知限制
```

原有 `pitchsignal/` 网页目录独立保留；本次长期采集的运行入口在仓库根目录。

可直接下载 `artifacts/Dimension-Football-collection.zip` 获取独立源码包。需要重新打包时运行 `python scripts/package.py`；它只打包明确列出的源码目录，排除密钥、数据库、检查点和报告。
