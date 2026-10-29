# 云端长期采集迁移与部署

## 迁移范围

本项目把可读取记录中的长期采集约束、可复用的数据源与调度行为整理成普通 Node.js 文件。它可以脱离 Codex/ChatGPT 定时执行，不需要 OpenAI API key，也不依赖当前聊天持续打开。

这是一次代码实现，不是原云端任务完整提示词或执行环境的导出。原云端长期采集计划仍启用；原本另一条自动发布计划保持原状。新项目生成报告与消息草稿，没有任何 Telegram 发送入口。

## 环境和命令

要求 Node.js 24。项目没有 npm 第三方依赖，不需要运行 `npm install` 或 `npm ci`。

```sh
# 检查与离线模拟
npm test
npm run collect -- --demo

# 生产：通过环境注入 FOOTBALL_DATA_API_KEY
npm run collect -- --state .collection-state/state.json --out reports --budget-minutes 20

# 生产：读取自行维护的真实赛程文件
npm run collect -- --input /srv/dimension-football/fixtures.json --state /srv/dimension-football/state/state.json --out /srv/dimension-football/reports
```

| 配置 | 用途 |
| --- | --- |
| `FOOTBALL_DATA_API_KEY` | football-data.org 官方 API token；仅通过请求头传入官方 API 主机 |
| `FIXTURES_FILE` / `--input FILE` | 改用本地真实赛程文件；数据维护方负责按时更新 |
| `--config FILE` | 读取运行策略 JSON；默认 `config/collection.json` |
| `--state FILE` | 检查点路径；生产默认 `.collection-state/state.json`，模拟默认 `.collection-state-demo/state.json` |
| `--out DIR` | 报告输出目录；默认 `reports` |
| `--budget-minutes N` | 本轮预算，最多 20 分钟 |
| `--demo` | 无网络、虚构数据验证；报告必须标记模拟，不能作为生产赛程 |
| `--evidence FILE --accept-reviewed-evidence` | 显式导入已人工核验的结构化证据；启用标志不是真实性证明 |

不要在代码、报告、赛程或检查点中保存密钥。工作流将密钥限制在生产执行步骤的环境中，不打印环境变量或请求头。

## 赛程文件

传入 JSON 数组或包含 `fixtures` 数组的对象，每场比赛必须具有下面的字段；`kickoff`、`updatedAt` 使用带时区的 ISO 8601 时间，示例日期仅用于说明结构，实际运行前应由数据维护方替换为当时最新真实赛程。

```json
[
  {
    "id": "your-provider-stable-match-id",
    "league": "PL",
    "home": "真实主队名称",
    "away": "真实客队名称",
    "kickoff": "2026-10-30T19:00:00Z",
    "source": "你的真实赛程来源名称",
    "status": "SCHEDULED",
    "updatedAt": "2026-10-29T12:00:00Z"
  }
]
```

`id` 必须稳定且唯一；身份字段包括 `id`、联赛、主客队、开赛时间、来源。重复 ID 如果身份冲突会报错。赛前状态为 `SCHEDULED` 或 `TIMED`；已经开赛、取消、超出窗口或没有可核实时效的场次不会作为候选。内置网络数据源仅匹配五大联赛代码 `PL`、`PD`、`SA`、`BL1`、`FL1`。

`FIXTURES_FILE` 指向文件时不会替你更新文件。不要把陈旧赛程文件误当作长期赛程服务；默认正式入口缺 key 且没有输入文件会失败，API 不可用也会在报告中标出失败或覆盖缺口。

## 证据、来源独立性与候选

程序不会把“网站可打开”当作获得预测。已经实现的自动数据与限制如下：

| 来源 | 输出 | 没有实现的能力 |
| --- | --- | --- |
| football-data.org | 五大联赛未来赛前赛程 | 盘口、预测 |
| 球探 titan007 | M88、12Bet、SBOBET 赛前全场亚洲盘快照，身份及时效核验 | 第二个独立网站来源、完整可核实初盘轨迹 |
| Statarea | 已发布页面、严格匹配场次的 1X2 信号 | 亚洲盘赢盘概率、任意未来日期完整覆盖 |
| 天天盈球 | 免费赛前列表的诊断 | 未核实的列表内容不会生成预测信号 |
| Forebet、FootyMetrics、Tactix、GolSinyali、FotMob、Singbet、IBC 等 | 能力或授权缺口说明 | 尚未接通的来源不会生成盘口或预测 |

球探的三家公司合计只算一个独立采集组。PredictZ 和 WinDrawWin 的注册表独立性组相同；本版没有它们的自动解析器。只有内置自动数据时缺少第二个独立亚洲盘来源及初盘证据，结果保持 `source_insufficient` 是预期行为。

人工证据导入需要结构化 JSON（顶层 `quotes`、`signals` 数组），且明确提供 `--accept-reviewed-evidence`。应先核实公开证据 URL、来源、比赛身份快照、观测及失效时间、盘口方向、双边报价、来源更新时间与初盘轨迹。程序仍进行格式与策略校验；提供 `verified: true` 或人工确认标志不能证明外部内容真实。字段契约以 `collector/policy.mjs` 中 `validEvidence`、`validQuote`、`evaluateFixture` 为准，不能仅为让筛选通过而填造第二来源。

每场输出候选、回避或数据不足及原因。通过代码门槛仍带 `requiresReview: true`；1X2 概率不会冒充亚洲盘赢盘概率，未实现的比分与总进球预测不补值。

## GitHub Actions 上线与切换

1. 把项目文件推送到仓库默认分支，启用 GitHub Actions。
2. 添加仓库 Secret `FOOTBALL_DATA_API_KEY`；或添加 Variable `FIXTURES_FILE` 指向已纳入仓库且会持续更新的真实赛程 JSON。
3. 手动运行工作流，先选择 `demo: true`，检查 artifact 中报告确实标记模拟；再用 `demo: false` 确认真实数据源覆盖、错误及缺失项。
4. 确认新任务输出可以接受后，停用旧云端长期采集计划，避免两边继续重复采集。不要因此停用既有自动发布计划，除非另行决定。
5. 将仓库 Variable `VANTIS_COLLECTION_ENABLED` 设为字符串 `true` 开启每小时调度。删除它或设为其他值会跳过计划运行；手动运行不受此开关限制。

调度配置为 `0 * * * *`，没有指定 `timezone`，因此按 UTC 每小时整点触发，对应北京时间每小时整点。GitHub 官方说明定时任务只运行默认分支，整点高负载时可能延迟甚至丢弃排队任务，公开仓库长期无活动还可能停用定时任务；参见 [schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。它不承诺在整点立即完成。

工作流使用 Node.js 24，内部预算 20 分钟，作业上限 25 分钟。`contents: read` 配合 `persist-credentials: false`，不向仓库回写报告或提交。`concurrency` 使同组只有一轮执行，且不取消正在运行的一轮；默认最多保留一个待执行运行，积压时较新的待执行运行可能替换旧的，符合 [GitHub concurrency 行为](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

每轮报告在 Actions 的该次运行页面中以 `collection-production-…` 或 `collection-demo-…` artifact 下载，保留 30 天（仍受仓库或组织策略约束）。采集失败后也尝试上传已经生成的报告；如果入口校验阶段尚未生成报告，artifact 步骤会给出找不到文件的提示。

## 检查点和持久部署

生产与模拟使用独立目录及 cache 前缀。工作流运行前恢复最近的检查点，每次运行用 run ID 与 attempt 生成新 cache key；采集失败也尝试保存已经写入的检查点。这样避开 [GitHub cache 不可修改已有条目](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching) 的限制。

**GitHub Actions cache 不是永久状态存储。** 缓存可能被淘汰、清理、超额或保存失败；runner 被强制终止时，`always()` 也不能保证完成保存和上传。cache 未命中时从当前赛程全池重新筛选。本版不发送消息，因此重新筛选不会造成重复发布。报告 artifact 用于查看结果，不会自动代替下一轮的状态。

需要可靠长期续跑时，推荐部署到有持久磁盘的服务器：由系统调度器每小时执行上述命令，确保同一时刻只有一个进程，给 `--state` 与 `--out` 指定固定持久目录并定期备份；密钥由服务器的凭据管理或受限环境配置注入。单纯更换为 self-hosted runner 并不自动获得持久状态，仍需把检查点放在不会随清理或检出消失的持久目录。

检查点中的每场记录会保留最后一次有效报价与辅助信号（`lastEvidence`），即使该场因缺第二来源而未通过，也能审阅实际取得的观测；它不是完整历史行情库，也不会将首个观测冒充初盘。来源/身份/时效不合法的输入不保存在该证据字段。

正常终止会释放运行锁。遇到断电、强制结束留下锁文件时，先停止系统调度并确认没有采集进程，再执行：

```sh
node collector/recover-lock.mjs --state /srv/dimension-football/state/state.json
```

恢复命令只清除本机已不存在的进程留下的锁；仍在运行、来自其他主机或格式损坏的锁会明确拒绝。完成后可恢复调度并从检查点继续。

不要把整个工作目录打包进 artifact 或 cache。此工作流只缓存专用的 `state.json`（不缓存运行锁），只上传报告目录，密钥不进入这些文件。
