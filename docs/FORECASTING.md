# 赛前预测与严格盘口候选

此前输出以严格亚洲盘候选为中心：没有盘口时所有比赛只显示“来源不足”。当前增加独立统计预测层，缺少盘口不会阻止有足够历史的比赛显示胜平负概率。盘口来源、独立性、价格、初盘与预测辅助门槛继续独立执行。

## 运行与输出

```sh
npm run collect:public
# 有自己维护的赛程和历史时：
npm run collect -- --input fixtures.json --history history.json
```

公开入口默认获取 OpenLigaDB 德甲本赛季与上一赛季数据，不要求私有 API Key；TheSportsDB 四个联赛的免费赛程目前没有配套完整历史，保持逐场缺项。只取显式 `After90Minutes` 的唯一全场比分，不把半场、加时、点球或未完赛比赛当成训练结果。抓取时间不冒充历史比分最初发布时间。

历史文件可为数组或 `{"history": [...]}`；赛程文件可同时包含 `fixtures` 与 `history`。每条历史需提供：

| 字段 | 要求 |
| --- | --- |
| `id`、`source`、`league` | 稳定赛事 ID、数据来源、五大联赛代码；只与同源同联赛赛程匹配 |
| `home`、`away` | 球队名称，用于显示 |
| `homeTeamId`、`awayTeamId` | 字符串球队 ID；赛程也必须提供这两个字段，不靠模糊队名关联 |
| `kickoff` | 有明确时区的 ISO 时间 |
| `status`、`period` | 必须为 `FINISHED`、`full-time` |
| `homeGoals`、`awayGoals` | 0–20 的整数全场进球 |

无效记录计入拒绝数，完全重复记录去重，冲突赛事 ID 明确失败；不保留输入中的任意原始响应或认证字段。模型每轮重新计算，更新历史不会因盘口缓存复用而沿用旧概率。

输出文件：

- `predictions.html`：可直接打开的静态预测页面，包含概率条、预期进球、比分参考、缺项及回测。
- `predictions.md` / `predictions.json`：可阅读与可解析的预测快照。
- `latest.json`：保留完整采集报告；`summary.forecasts`、`summary.forecastUnavailable` 与 `summary.candidates` 分开统计；逐场 `forecast` 与原有盘口 `result` 并存。
- 带时间的 `collection-*.json`：包含该轮预测、回测和训练数据哈希，保留历史审计依据。
- `openligadb-fixtures.json`：公开源模式下单独输出相应赛程、历史与 ODbL 归属。

GitHub“公开赛程预测与报告”将逐场概率和缺项写入 Summary，全部文件保存在 artifact 30 天。现已增加网站数据发布、每小时第 17 分钟采集及 Telegram 凭据入口；实际是否完成逐渠道记录，见 [网站和通知](DELIVERY.md)。

## 模型与边界

模型版本为 `venue-poisson-v2`（概率公式仍是未校准的主客场泊松基线），固定参数：

1. 只用预测截止时间前至少 4 小时的完赛记录，排除当前赛事 ID、其他来源、其他联赛；历史窗口 540 天，时间权重半衰期 180 天。
2. 至少 40 场联赛历史、双方各 6 场、相应主 / 客场各 2 场；双方最近一场历史不超过 120 天。条件不足时给出具体缺项，不填 50% 或联赛默认概率。
3. 对球队主客场进失球率加入相当于 6 场联赛均值的先验收缩，分别估计主客队进球均值；均值限制在 0.15–4.5。
4. 由两个独立泊松分布计算 0–20 球的比分组合，并将截断后的质量归一化，得到主胜、平局、客胜概率及前三个比分参考。
5. 滚动回测需完成且至少评估 30 场，样本不足或预算中断时暂不展示概率；这是最低验证条件，不代表经过可靠性校准。
6. 预测先于可能缓慢或失败的盘口网络请求生成。发布前再次检查开赛状态与赛程时效，已经开赛或生成超过 60 分钟的预测撤下；有效期同时受开赛时间和赛程有效期限制。模拟运行不生成真实预测。

模型不使用伤停、首发、旅途负荷或赔率，也没有做 Dixon–Coles 低比分修正与概率校准。显示的方向是最高概率结果，不等于有价值投注。模型预测不会自动作为第二盘口来源或增加严格盘口候选票。

同时修正盘口状态汇总：某一方向支持但缺初盘时，不再被相反方向的冲突检查整体误标为“回避”；仍保留“来源不足”，不会因此放行候选。

## 验证与实测

回测对最近最多 80 场已完赛记录逐场重新估计。训练截止为 `kickoff - horizonHours`，历史比赛还需在此截止前至少 4 小时开赛。默认参考组为 1、24、72、168 小时；每场当前预测另外按真实 `kickoff - generatedAt` 提前量精确回放，该组优先于参考组使用计算预算。`forecast.validation.horizonHours` 是实际匹配的提前量，不用临开赛指标代替提前多日指标。比较基准为同一训练集合中之前赛果的平滑频率。

输出三分类 Brier（平方误差之和，0–2）、自然对数 Log loss、方向命中率；`evaluations` 保留每场预测、实际赛果、基准、训练截止/哈希和样本，`exclusions` 保留跳过原因，`coverage` 包含评估/跳过/预算未处理数。`reliability` 为各赛果5个等宽概率区间，空区间保持null、少于20场标记不足。`uncertainty` 提供均值及模型相对基准差的近似95%区间，少于30场标记不足；这些区间假设样本独立，球队和比赛相关性可能使其过窄，不能当成投注收益置信区间。

回测是当前历史修订数据上的回顾评估，无法还原过去的实际可见性。样本不足比赛会跳过，因此指标只代表可预测子集；尚无前瞻验证和可靠性校准，不能据此承诺未来胜率或收益。参数不根据这一批回测自动优化。

`walkForwardBacktest` 的 `visibility: "snapshot"` 明确表示以上当前修订快照回测；`visibility: "as-observed"` 则要求训练记录的 `resultObservedAt / observedAt`（只有fetchedAt时采用它）不晚于该场预测截止，没有观测时间的训练记录排除。两种模式均排除本轮now之后才观察到的数据。只有当前快照而无过去版本时，严格模式可能没有可用验证数据；不能补写过去时间来通过验证。

历史可带 `season`、`observedAt`、`resultObservedAt`、`fetchedAt`、`sourceUpdatedAt`、来源事件ID及版本/内容哈希。`observedAt` 是该记录版本首次被本系统取得的时间，不是供应商最初发布时间；未知保留未知。相同来源/联赛/双方ID/开球时间对应多个冲突赛事ID时全部隔离。`sample` 继续仅包含整数场数；新增 `sampleQuality` 展示加权场数、Kish有效样本量、当季/未知赛季样本和冷启动说明。旧赛季只有时间衰减，未虚构转会、阵容或换帅影响。

### 不可覆盖预测与90分钟赛果核账接口

`collector/prediction-ledger.mjs` 提供以下本地接口，持久目录必须位于应用release之外：

`appendReportPredictions` 的 `report` 可传内部采集报告（`results / forecasts.model`），也可传 `predictionDocument` 生成的发布文档（`kind: "prematch-forecast-report"`、`fixtures / model`）。两种格式均须绑定 `publication.reportId`，返回 `{recorded, reused, opportunities}`；缺少赛事数组的非模拟文档明确失败，不静默返回0条。

```js
await appendReportPredictions({ directory: ledgerRoot, report, nowISO });
await appendResultAndScore({ directory: ledgerRoot, result, nowISO });
const evaluation = await evaluatePredictionLedger({
  directory: ledgerRoot, nowISO, horizonHours: 24, toleranceHours: 1,
  modelId: 'venue-poisson-v2', modelVersion: 2, source: 'openligadb', league: 'BL1',
});
```

总控应在reportId固定后、对外发布前调用第一步，传真实登记时间；只有仍在赛前、未超过预测有效期及生成后1小时、已有训练哈希的真实预测可登记。模拟报告跳过。v2预测记录与reportId绑定，冻结生成/登记时刻、训练哈希、完整模型配置摘要`modelHash`、`validUntil`及原概率，同一predictionId不同内容拒绝。`horizonHours`按开球减实际登记时刻计算，生成口径另存`generationHorizonHours`；登记延迟不能冒充更早的预测。回放不会在实际登记时刻之前看到该预测。完全写入并fsync的记录经原子no-replace发布，带内容摘要；读取损坏记录明确失败。该接口无任何网络或发送操作。评价接口可额外传`modelHash: digest(FORECAST_MODEL)`锁定完整配置；混合模型版本、配置、来源或联赛时返回`blocked-mixed-cohorts`且不输出混合质量指标。

结果需提供同源赛事/球队ID、联赛、开球时间、`FINISHED/full-time` 的90分钟比分以及真实 `resultObservedAt` 或 `observedAt`。加时/点球或未来观察结果拒绝。支持CANCELLED、POSTPONED、ABANDONED状态：取消/中止不计损失，延期等待，改期/身份变化使旧预测评分作废。结果另存实际`recordedAt`；较晚入账的历史比分在较早的回放时点不可见。重复结果保留首次存储观察时间和登记时间并幂等评分；比分修订保存新版本及新评分，不改变原预测。再次收到原比分会形成新的修订，不能恢复旧版本时间。评分过程中断后，重放同结果补齐缺失评分。

报告登记也保存赛前不可预测场次的 `opportunities` 与缺项。前瞻汇总按指定实际登记提前量窗口每场只选一次机会（距离目标提前量最近且不晚于目标），避免每小时预测被重复计入样本；该机会不可预测时计入skipped，不能挑选更早一次成功预测替代它。按 `nowISO` 选择当时已观察且已登记的最新结果；同观察时间存在不同结果版本时隔离，缺结果计pending。旧账本缺少模型配置/有效期/结果登记时间时保留原文件，不补写过去证据，不计入严格前瞻质量样本。内容摘要不能独立证明外部发布时间或训练输入当时已可见；对外交付仍以该reportId的渠道回执为准。新系统尚未积累真实前瞻结果，接口和离线测试完成不等于已有前瞻质量证明。

### 机器可读模型准备度

```sh
node collector/model-readiness.mjs --ledger /persistent/reports/forecast-ledger --horizon-hours 24 --tolerance-hours 1
```

只读接口`buildModelReadiness({directory, nowISO, model, horizonHours, toleranceHours, sourceByLeague})`与CLI输出`kind: "model-readiness"`。默认检查当前`FORECAST_MODEL`与1–2小时登记提前量；可分别检查1、24、72、168小时窗口，不能把多个窗口相加。CLI正常生成`BLOCKED`报告退出码为2，参数错误为1；不写账本、不联网。五大联赛分别报告当前配置、单一来源、固定提前量下已结算冻结样本及距200场下限的缺口，另列未结算及旧元数据记录。不同来源没有经过审核的跨源赛事映射时禁止合并；函数调用可显式选择各联赛来源。账本损坏时样本/缺口为null，不能把未知证据报成0场正常检查。

每联赛200场只是下限。当前`calibrated:false`明确阻止发布；即使样本达到下限或配置自称已校准，缺少严格过去拟合、后续独立评估、同场冻结基准比较和训练输入可见性证明，仍为`releaseGate: "BLOCKED"`、`canRelease:false`。此诊断器尚未实现这些发布证据的审核，不能自动晋升模型。370场历史训练、63场回顾评估或未结算预测都不算前瞻结果，不从中生成未来胜率承诺。

### 校准实验边界

`forecast-evaluation.mjs` 的 `temporalCalibrationExperiment(rows, {fitCutoff, fit, apply, cohort})` 只消费元数据完整的前瞻账本记录。`cohort`必须指定`modelId/modelVersion/modelHash/source/league/horizonHours/toleranceHours`；同场重复拒绝，回顾记录及不符配置/时效的记录排除。fit只能看在fitCutoff之前实际入账的结果，评估预测必须在fitCutoff之后实际登记；仅早期观察时间不能让后入账比分进入训练。apply只接收概率/生成及登记时间/实际提前量，不能读取留出赛果。默认至少100条拟合、30条评估是研究接口的最低条件，不能替代每联赛200场发布下限；缺证据返回 `insufficient-prospective-evidence`。接口不自动调参、选择校准器或晋升模型，始终 `calibrated:false`；未来要上线校准必须另行验证跨赛季、提前量、球队相关性和留出集表现。

2026-10-31 04:30 UTC 的v1临开赛口径历史实采记录：13 场未来赛程、370 场完赛历史，生成 9 场德甲预测，其他四联赛各 1 场因缺少历史未生成概率；严格盘口候选 0。滚动窗口中评估 63 场、跳过 17 场；模型 Brier 约 0.5490，赛果频率基准约 0.6129，模型 Log loss 约 0.9314，方向命中率 57.1%。这是单次小样本结果，不能作为v2各提前量或前瞻账本的验证结果。

回归测试覆盖归一化与主客互换、时间泄漏、同场排除、来源与球队 ID 隔离、缺样本/过期/模拟隔离、历史冲突、比分阶段、预算、盘口失败时仍产出预测、开赛后撤下、历史更新刷新以及 HTML 输出转义。


## 三类结果与逐场依据

HTML / Markdown 将普通赛前预测、严格盘口候选、暂不可评估分别展示；JSON 的 `categories` 提供赛事 ID 索引。普通预测与暂不可评估覆盖整个输入池；严格盘口候选是独立的市场视图，可与普通预测重叠，不把三项直接相加当比赛总数。模拟候选不进入严格候选视图。

逐场 `strength` 展示主客队的相应主客场进攻及防守失球率相对联赛均值的比例（均值为 1，防守失球越低越好）。`validation` 给出同源同联赛滚动回测数、跳过数及指标；`freshness` 给出采集时间、供应商更新时间和预测有效期，未知更新时间保持 null。`completeness` 是本模型要求的 8 项基础检查：球队身份、联赛历史、双方历史、主客场历史、球队近期记录、赛前时效和回测；不等于全球覆盖率。伤停、首发、赔率仍明确为缺失扩展维度。

## 严格盘口证据与初盘档案

普通预测不生成盘口票。`marketReadiness` 逐场列出有效完整报价、独立来源组数、真实初盘记录数和缺项。多个球探公司仍属于一个组；未知上游关系的商业观察仍是参考数据。即使补齐来源和初盘，也需通过原有价格、盘口、时效、预测冲突及独立预测辅助检查。

真实初盘必须同时提供：`basis: "provider-opening"`、`fixtureId`、`sourceId`、`bookmaker`、`selection`、`handicap`、`decimalOdds`、`observedAt`（供应商真实开盘时间）、`recordedAt`（实际取得该记录的时间）、`evidenceUrl`（同源、无凭据链接）。来源、公司、赛事和方向须与当前报价相符；开盘时间早于当前报价且不晚于源更新时间。仅有 initial 数值、只有采集时间、首次观察价格或五分钟历史快照均不满足此要求。

检查点中的 `openingRecords` 保存已核验初盘、身份哈希及首次入库时间；新鲜当前报价可以复用同场同源同公司同方向的初盘。初盘数值或真实开盘时间冲突会持续阻断该记录，须调查数据修订后处理；不可静默择优或用缓存恢复当前报价。`marketHistory` 保留最近 24 次观察摘要和报价哈希，完整当轮报价在时间归档报告中；观察历史明确不冒充供应商完整赔率历史。

已有授权并核对过独立来源的真实证据可通过原有 reviewed evidence 格式导入，公开入口现也支持：

```sh
npm run collect:public -- --evidence /absolute/path/reviewed-evidence.json --accept-reviewed-evidence
```

该显式参数仅表示所有者完成核验，不替代供应商授权或证明两个转售渠道独立。未传参数的导入材料不能产生候选；不允许自行填写独立票数改变来源分组。

2026-10-31 更新：已接通 HKJC 第一方公开 HDC 报价，与 Titan007 分组独立。实采 13 场匹配 12 场，但 Titan007 本轮不可用，仍未形成双源同时有效。详见 [接入证据和时效语义](DELIVERY.md)。现有 [iSports 主盘口文档](https://www.isportsapi.com/docs.html?id=24) 提供初盘数值但未给出可用的真实开盘时间字段；[The Odds API 历史接口](https://the-odds-api.com/historical-odds-data/) 返回按时间取近的历史快照，不能当作真正开盘。后续仍需保证两路独立源同时可用，并取得真实初盘样本，不能仅用接口连通替代这些条件。

## 发布链路和实际回执

每轮报告生成前创建 `publication.json`，只有全部文件写入并计算 SHA-256 后，`files` 才转为 `published`。写入中断记为 `failed`。每份报告绑定 `reportId`，发布前复核文件哈希与报告 ID，拒绝混入另一轮或被修改的内容。

两个 GitHub 采集工作流按以下顺序交付：上传本轮报告 → 根据 upload-artifact 实际 outcome、artifact ID、URL、摘要记录附件回执 → 写入三类结果和回执到 Summary → 保存最终 `publication-receipt` 附件。Summary 仅在写入成功后记为 published；失败可重试，同报告不会重复追加。上传失败、缺少 ID 或链接不匹配均不能记为成功。

主报告附件内的 `publication.json` 是上传前快照；最终回执以独立 `publication-receipt-运行ID-尝试次数` 附件为准。回执不声称能够自证承载自己的附件上传成功，最终回执附件上传结果另见 Actions 步骤。外部网站和通知分别保持 `not_configured`，不是 delivered。报告中的相对 JSON 链接供下载后打开；Actions 页面以完整 Summary 和附件链接查看。
