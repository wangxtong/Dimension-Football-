# 维度足球 · 1X2 研究预测

一个**可复核**的足球胜平负研究与预测项目：把公开赛程、历史比分与盘口证据，走同一条确定性链路算成概率，冻结进不可变账本，再生成每日研究日报并分发。目标不是"猜得准"，而是**每一个数字都能追回到它的输入、代码版本和冻结时刻**。

## 三条铁律

| 铁律 | 含义 | 代码里的体现 |
| --- | --- | --- |
| 不补场 | 样本不足就输出 `SKIP` 并写明原因，绝不用模糊匹配或默认概率填坑 | `LEAGUE_HISTORY_INSUFFICIENT` 等逐场原因码 |
| 不改预测 | 预测一旦冻结进账本，赛后只能追加结果，不能回改概率 | `reports/forecast-ledger/<hash>` 不可变记录 |
| 不冒充校准 | 模型 `calibrated:false`，商业发布门禁 `BLOCKED`，研究不等于投注建议 | `commercialReleaseGate: BLOCKED` |

## 预测整体框架

```
 数据源                身份与历史              模型                账本                报告                分发
┌──────────┐      ┌──────────────┐      ┌───────────┐      ┌──────────┐      ┌──────────┐      ┌──────────┐
│ 赛程 API  │ ───▶ │ 球队/赛事身份 │ ───▶ │ 泊松基线   │ ───▶ │ 冻结预测  │ ───▶ │ 研究日报  │ ───▶ │ Telegram │
│ 历史比分  │      │ 主客场切分    │      │ 时间衰减   │      │ 逐场结果  │      │ 命中/误差 │      │ 站点看板  │
│ 盘口证据  │      │ 覆盖与新鲜度  │      │ 收缩平滑   │      │ 评分回执  │      │ reportId │      │ 每日归档  │
└──────────┘      └──────────────┘      └───────────┘      └──────────┘      └──────────┘      └──────────┘
      ▲                                                          │
      └──────────────── 采集失败/冷却/预算耗尽都记录，不静默跳过 ──┘
```

### 1. 数据层：只采授权来源，失败要留痕

官方赛程（football-data.org / API-Football / Sportmonks 任一可用即采）、五联赛历史比分、球探公开快照盘口、香港赛马会第一方让球报价。每次请求受 `config/sources.json` 的来源顺序、连续失败阈值、指数退避与 `Retry-After` 冷却约束；登录墙与验证页被识别为破坏页，**不会当成数据**。

### 2. 身份与历史层：先对齐，再计算

跨供应商球队名必须命中精确别名表，未识别的名字保留"来源不足"，不做模糊匹配。历史按主客场切分，并逐项检查样本量、联赛样本与记录新鲜度——任何一项不足直接产生原因码，不降级成默认值。

### 3. 模型层：`venue-poisson-v2`

主客场分离的泊松进球基线，带时间衰减与收缩平滑。

| 参数 | 值 | 作用 |
| --- | --- | --- |
| `lookbackDays` | 540 | 历史回看窗口 |
| `halfLifeDays` | 180 | 时间衰减半衰期 |
| `priorMatches` | 6 | 收缩先验强度 |
| `minimumLeagueMatches` | 40 | 联赛样本下限 |
| `minimumTeamMatches` | 6 | 单队样本下限 |
| `minimumVenueMatches` | 2 | 主/客场样本下限 |
| `maximumTeamAgeDays` | 120 | 记录陈旧阈值 |
| `calibrated` | `false` | **概率未校准** |

模型不经第三方预测 API 代算，也不使用伤停与阵容数据（免费源不提供）。

### 4. 账本层：`reportId` 是唯一身份

每份预测写成 `{record, sha256}` 存进 `reports/forecast-ledger/<hash>/`，分 `predictions` / `results` / `scores` 三类。`reportId = sha256(记录去掉 reportId 后规范化)`——改一个字节就对不上，因此"事后美化"在结构上不可能。

### 5. 报告层：四个统计窗口，样本不合并

`prospective` 按北京时间的开赛日切窗口：`oneDay`（仅当天）、`sevenDays`、`thirtyDays`。待 FT、改期、无法核验的比赛不计入命中率。指标定义：`hitRate`（最高概率方向命中比例）、`brier`（三分类平方误差和）、`logLoss`（自然对数损失）。统计联赛固定五个：英超 `PL`、西甲 `PD`、意甲 `SA`、德甲 `BL1`、法甲 `FL1`。

### 6. 分发层：一次生成，多处只读

`scripts/push-daily-research.sh` 五步编排：赛程 lane → 赛果 lane → 生成研究日报 → Telegram 推送 → 站点页面同步。推送按 `beijingDay + codeSha + status=accepted` 幂等，同一天不会重复发。站点只读日报，不参与计算。

### 7. 门禁层：研究可以发，商业必须拦

研究日报允许对外展示，但正式预测、付费与投注推荐受 `RELEASE_GATE` 拦截。门禁拦的是"研究→商业发布"，不是采集。

## 当前实测状态（2026-11-04）

| 项 | 实际值 |
| --- | --- |
| 账本记录 | 825 条 JSON，9 份运行时状态 |
| 已评分前瞻样本 | **4 场** |
| 方向命中率 | `0` |
| Brier | `0.8265282518511182`（三分类盲猜约 0.667，**当前劣于盲猜**）|
| LogLoss | `1.3214` |
| 最近日报 | `c23a698f823c…`，`beijingDay 2026-11-03`，赛前冻结 0 场 |
| 商业发布门禁 | `BLOCKED` |
| 自动推送 | 每日 10:10 北京时间，10:20 兜底补发 |

4 场样本没有任何统计意义；上表如实记录，不用它证明模型好坏。

## 本地跑一遍

```sh
npm test                        # 982 个用例，离线
npm run collect -- --demo      # 完全离线的模拟赛程，报告醒目标注"模拟"
npm run fixtures:public         # 官方公开源，有限赛程样本
npm run collect:public          # 公开源采集 + 基础预测
```

正式采集需配置一家赛程服务（`FOOTBALL_DATA_API_TOKEN` / `API_FOOTBALL_KEY` / `SPORTMONKS_API_TOKEN`）。环境变量不会从 `.env` 自动加载，本地用 `node --env-file=.env.local collector/run.mjs`。需要 Node.js **24+**。

## 目录

```text
collector/          采集、身份核验、预测、账本、评分、报告
collector/forecast.mjs          venue-poisson-v2 模型与原因码
collector/model-readiness.mjs   五联赛统计口径
config/             来源优先级、预算、时效、爬虫限速
website/            看板 Worker（登录、研究日报页、账本读数）
scripts/            每日链路编排、站点登录验收、运行时快照
ops/site/           独立站点部署包（不绑定任何云厂商）
deploy/             ECS 制品构建与运维工具
docs/               预测方法、来源、运维、协作与轮次记录
```

## 文档索引

| 想知道 | 看 |
| --- | --- |
| 预测怎么算的 | [docs/FORECASTING.md](docs/FORECASTING.md) |
| 研究日报口径 | [docs/RESEARCH_DAILY_1X2.md](docs/RESEARCH_DAILY_1X2.md) |
| 来源准入与冷却 | [docs/SOURCE_MANAGEMENT.md](docs/SOURCE_MANAGEMENT.md) |
| 商业门禁 | [docs/RELEASE_GATE_FORECAST.md](docs/RELEASE_GATE_FORECAST.md) |
| 每日推送链路 | [docs/DAILY_RESEARCH_PUSH.md](docs/DAILY_RESEARCH_PUSH.md) |
| 站点与 Telegram | [docs/DELIVERY.md](docs/DELIVERY.md) |
| 部署与运维 | [docs/OPERATIONS.md](docs/OPERATIONS.md)、[ops/site/README.md](ops/site/README.md) |
| 双 agent 协作 | [docs/COLLAB.md](docs/COLLAB.md) |
