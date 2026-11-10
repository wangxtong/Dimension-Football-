# 维度足球

用公开赛程和历史比分算胜平负概率，冻结后再记赛果。这是研究记录，不是投注建议，也不能当成已经打赢收盘价。

商业发布门禁是 `BLOCKED`。研究日报可以看，不能当成付费推荐。

## 怎么读一张预测

| 词 | 意思 |
| --- | --- |
| 盘口 | 让球线。`-1.5` 是主队让一球半，`+0.5` 是受让半球，`大2.5` 是总进球至少 3 球 |
| 水位 | 这一边的欧洲赔率。`1.465` 表示押 1，赢了共拿回 1.465，净赚 0.465 |
| 打平线 | `1 ÷ 水位`。水位 1.465 要求胜率至少 68%，低于这个数就是负期望 |
| 去水 | 把庄家抽成拿掉之后的隐含概率。三项赔率倒数之和大于 100%，多出来的是水钱 |
| 把握 | 模型给这一边的概率。表上如果做过和去水的加权，就不再是模型原值 |
| 1 单位 | 研究注码，用来记盈亏。不是下单金额 |

判断一注值不值得留，看两件事，不是只看它比去水高出几个点：

1. 模型概率要高过 `1 ÷ 水位`。只比去水高，水钱仍然可以把期望吃掉。
2. 两队都要有够样本。见过的场次不够，输出 `SKIP`，不填一个默认概率。

让球倾向是从胜平负映过来的启发式，不是校准过的亚盘概率。代码在 `collector/daily-picks.mjs`，输出必须标成研究参考。

## 模型

现在的模型是 `venue-poisson-v2`：主客场分开的泊松进球，加时间衰减和收缩。不调用第三方预测接口，也不使用伤停和阵容。概率未校准，`calibrated` 为 `false`。

| 参数 | 值 | 作用 |
| --- | --- | --- |
| `lookbackDays` | 540 | 历史回看窗口 |
| `halfLifeDays` | 180 | 时间衰减半衰期 |
| `priorMatches` | 6 | 收缩强度 |
| `minimumLeagueMatches` | 40 | 联赛样本下限 |
| `minimumTeamMatches` | 6 | 单队样本下限 |
| `minimumVenueMatches` | 2 | 主场或客场样本下限 |
| `maximumTeamAgeDays` | 120 | 记录太旧就不用 |

样本不够的原因码包括 `LEAGUE_HISTORY_INSUFFICIENT`。不足就跳过这场，不用模糊队名或默认概率补上。

## 三条铁律

| 铁律 | 含义 |
| --- | --- |
| 不补场 | 样本不够就输出 `SKIP` 并写明原因 |
| 不改预测 | 冻结进账本之后，赛后只能追加比分，不能改概率 |
| 不冒充校准 | 未校准的概率不能写成已经打过市场 |

每份预测写成 `{record, sha256}`，放在 `reports/forecast-ledger/<hash>/`。`reportId` 是记录去掉自身之后的哈希，改一个字节就对不上。

## 数据怎么走

```text
赛程 / 历史比分 / 盘口
        ↓
球队别名对齐，对不上就停
        ↓
主客场泊松 → 胜平负概率
        ↓
冻结进账本
        ↓
研究日报 → Telegram、站点只读
```

来源只用授权接口：football-data.org、API-Football、Sportmonks。登录墙和验证页不算数据。采集失败、冷却和预算耗尽都要留痕，不静默跳过。收盘价不进决策。

统计只覆盖五个联赛：英超 `PL`、西甲 `PD`、意甲 `SA`、德甲 `BL1`、法甲 `FL1`。窗口按北京时间切：当天、7 天、30 天，不合并样本。待定、改期、核不上的场次不进命中率。

## 已经量过的结果

截止 2026-11-04，已评分的前瞻样本只有 4 场。这个数没有统计意义，写在这里是为了不把小样本说成优势。

| 项 | 值 |
| --- | --- |
| 账本记录 | 825 条 JSON |
| 已评分前瞻样本 | 4 场 |
| 方向命中率 | 0 |
| Brier | 0.827（三分类盲猜约 0.667，当时差于盲猜） |
| LogLoss | 1.321 |
| 商业发布 | `BLOCKED` |

## 本地跑

需要 Node.js 24+。环境变量不会从 `.env` 自动读入。

```sh
npm test
npm run collect -- --demo
npm run fixtures:public
npm run collect:public
```

正式采集要配一家赛程服务：`FOOTBALL_DATA_API_TOKEN`、`API_FOOTBALL_KEY` 或 `SPORTMONKS_API_TOKEN`。

```sh
node --env-file=.env.local collector/run.mjs
```

每日链路是 `scripts/push-daily-research.sh`：赛程、赛果、研究日报、Telegram、站点。同一天按北京日期、代码版本和已接受状态去重，不重复推送。

## 目录

```text
collector/     采集、预测、账本、评分、日报
config/        来源、预算、限速
website/       只读看板
scripts/       每日链路
ops/site/      站点部署
docs/          方法、来源、运维
```

| 想看 | 文件 |
| --- | --- |
| 概率怎么算 | [docs/FORECASTING.md](docs/FORECASTING.md) |
| 日报口径 | [docs/RESEARCH_DAILY_1X2.md](docs/RESEARCH_DAILY_1X2.md) |
| 来源与冷却 | [docs/SOURCE_MANAGEMENT.md](docs/SOURCE_MANAGEMENT.md) |
| 发布门禁 | [docs/RELEASE_GATE_FORECAST.md](docs/RELEASE_GATE_FORECAST.md) |
| 每日推送 | [docs/DAILY_RESEARCH_PUSH.md](docs/DAILY_RESEARCH_PUSH.md) |
| 部署 | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
