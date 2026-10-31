# R1 证据契约：身份、时间、冻结输入与交付

文档版本：A9-R1-1；适用源码：`afb2345f36c6822037b3037e1730e52de1a0d630`（2026-10-31，PR #30 已合并）。这是已实现行为的契约快照及待验收边界，不新增运行时权限，也不表示正式预测可发布。A9设计、A1集成、A10独立复核；工作单 #27/#28/#29。

## 1. 三条独立路径

| 路径 | 当前实现 | 不得推导的结论 |
| --- | --- | --- |
| 采集观测 | `collector/hosted.mjs` 默认 observations；站点服务端只保留赛程、覆盖、归属和真实时间 | 不是模型预测，不是商业质量验收，不是ECS部署 |
| 内部研究 | research 与冻结账本/回放；原始输入留在私有存储 | 回放成功不证明当时数据已可见，也不自动授权外发 |
| 正式预测 | `website/release-policy.mjs` 当前直接拒绝；独立放行证据授权尚未配置 | 身份认证、环境变量或自报GREEN均不能开门 |

`BACKTEST_ALL_GREEN_ONLY` 和 `RELEASE_GATE` 的全部前置证据仍须成立。PR #21/#26 是未合并提案，不能覆盖本基线。普通1X2计算与亚洲盘候选资格独立；产品目标仍仅1X2和O/U。

## 2. 赛事身份

来源：[identity.mjs](../../collector/data/identity.mjs)、[policy.mjs](../../collector/policy.mjs)。

| 字段/标识 | 已实现含义 | 消费约束 |
| --- | --- | --- |
| source + sourceFixtureId | 供应商范围的原始事件键 | 不用球队显示名或跨供应商相同数字当同场 |
| canonicalMatchId | `evt_` + dataHash([source, sourceFixtureId])，identityScope=source | 名称虽为canonical，当前不代表全球跨源统一ID |
| identityRevision | 事件、联赛、赛季、主客队ID、开球时间的hash | 改期/换主客/修订隔离，不能继承旧盘口与评分 |
| revisionId / recordHash | 状态/赛果修订，以及含球队名称的记录版本 | 保留旧版本和冲突，不挑有利版本覆盖 |
| fixtureKey | policy中[id, league, home, away, kickoff, source]的digest | 与canonicalMatchId不是同一算法，不能互换 |

同逻辑事件有冲突时全部隔离；不得静默选一个供应商ID。跨源映射必须附独立映射证据，由A3维护，A9审契约。缺球队ID的旧记录可重放为不可评估，不补造已验证身份。

## 3. 时间与真正的赛前冻结

来源：[history-cache.mjs](../../collector/data/history-cache.mjs)、[run-manifest.mjs](../../collector/data/run-manifest.mjs)、[prediction-ledger.mjs](../../collector/prediction-ledger.mjs)。

- 时间须可验证且含时区，存储标准UTC，界面可显示北京时间。
- `observedAt` 是本系统实际观察证据；`sourceUpdatedAt` 是供应商更新时间，不能相互代填。`fetchedAt` 是抓取时间，读缓存不得刷新证据时间。
- 赛果版本的 `resultObservedAt` 与账本实际 `recordedAt` 分开；账本按截至时点评估不得纳入其后才入账的结果；这不表示所有manifest回放都验证了recordedAt。
- manifest要求 `cutoff <= generatedAt`；预测登记要求 `trainingCutoff <= generatedAt <= recordedAt < kickoff`，登记时还须未过期。当前实现另要求生成到登记少于一小时。
- 实际预测提前量按 `recordedAt` 计算；`generationHorizonHours` 只说明生成提前量。不能用回填生成时间替代真实赛前登记。
- 首次留存观察不能证明更早的历史可见性；`snapshot-only` 与 `observed-result-versions` 分开。历史缓存是当前快照，永久重放由独立manifest保存。

## 4. Hash作用域与序列化

| 名称 | 已实现算法/输入 | 不兼容风险 |
| --- | --- | --- |
| dataHash | identity.canonicalJSON递归排序对象键，再SHA-256 | 只用于该数据契约；数组顺序保留 |
| policy.digest | JSON.stringify(value)再SHA-256 | 对象字段顺序不可随意重排 |
| manifest inputsHash/policyHash/modelHash/manifestHash | dataHash对应对象；manifestHash排除自身 | 输入或模型变动必须生成新版本 |
| ledger trainingHash/modelHash | 训练输入标记；模型hash采用policy.digest | 与同名manifest modelHash不能默认视为同值 |
| reportId | publication.beginPublication对明确identity数组digest，含inputHash时纳入 | 不是整个报告文件的字节hash |
| reportHash / contentHash | report-store对report或{version,reportId,report,sourceData}的JSON.stringify做SHA-256 | 回执可更新，但不能改不可变报告内容 |
| receipt.files[].sha256 | 生成文件的原始字节SHA-256 | 与reportId分开验证 |

输入回放绑定 `dataSchemaVersion=2`、inputsHash、modelHash、policyHash及codeVersion。codeVersion为空只可标记inputs-only-code-version-unknown，不能声称精确代码复现。迁移不得把两种hash算法强行统一；必须保留版本标识、旧原件及校验器，并在新命名空间双读验证。

## 5. 观测投影的报告ID必须换域

来源：[hosted-publications.mjs](../../website/hosted-publications.mjs)、[hosted.mjs](../../collector/hosted.mjs)。

服务端将输入报告投影为 `publicationKind=observations`，去掉概率、模型、回测和盘口候选；`forecastPublished=false`。投影报告ID是SHA-256(JSON.stringify({version:1, publicationKind:'observations', originReportId:输入ID}))，与原始输入ID不同；保留originReportId/originReportHash用于追溯。

网站、投影回执和投影raw sourceData须共享新的reportId；只在同一投影作用域比较reportHash。验收还须核对originReportId绑定，不能要求投影ID等于原研究报告ID，也不能用原研究hash冒充脱敏内容摘要。

仅机器身份真实回读且mode=hosted、health=available、ID/hash与已发布投影一致，才能记录观测已展示；这仍不是访客已阅读、预测放行或ECS模式。延迟回执只更新自己的报告，不得把当前指针退回旧报告。

## 6. 回执、幂等与故障恢复

来源：[publication.mjs](../../collector/publication.mjs)、[outbox.mjs](../../collector/outbox.mjs)、[report-store.mjs](../../collector/report-store.mjs)。

- files、GitHub summary/artifact/archive、externalWebsite和notifications独立记录；归档成功不能置网站published。
- 当前不可变报告和receipt绑定同reportId；不允许相同ID覆盖不同内容。hosted读取会验证持久摘要；本地report-store只有读取current报告时比较指针中的contentHash/reportHash，读取历史reportId时仅检查身份并重算hash，没有与独立保存的历史摘要比较，不能宣称其历史读取同样完整验证。此差异交A6/A10补验。状态以revision/ETag比较更新，冲突时不空初始化。
- 本地通知claim键为reportId和destinationFingerprint；保存claimId和结果。pending/unresolved/corrupt归unknown，禁止自动重发；accepted只代表平台接受，不代表用户已读。
- hosted通知由站点共享claim/receipt账本负责，runner不能另发第二份。R1观察任务不发送预测通知。
- 备份覆盖state、来源健康、replays、forecast-ledger及完整delivery/outbox；恢复要验证旧回执优先级、版本/摘要和新旧指针顺序。

## 7. 商业级验收的两项首要输入

用户要求优先优化算法和采集。下表是必须形成证据的工作要求，不表示现已达标。

| 责任 | 商业验收材料 | 阻断规则 |
| --- | --- | --- |
| A2/A3 来源与数据 | 授权/展示及再分发权益清单；五联赛独立覆盖分母；时效分布；缺失/重复/冲突率；预算、429/鉴权失败和备用源演练；原始快照与版本可追溯 | 无权益、过期、身份歧义、来源伪独立一律拒绝正式候选；不能用旧快照补实时 |
| A4 模型 | 1X2/O/U分别评估，时间滚动验证与未参与调参的最终留出；真实冻结前瞻样本；Brier/LogLoss、校准、置信区间、基准、弃赛/覆盖、分联赛分赛季稳定性；赔率条件及虚拟模拟收益/回撤 | 样本不足/泄漏/无独立复算保持BLOCKED；达到数量底线不等于达到商业性能 |
| A5 证据 | 真正独立渠道、同场同市场的配对报价、真实供应商初盘和最新时间、1.65–1.95约束 | 首采不是开盘；多个公司共享渠道只算一组 |
| A10 独立验收 | 用冻结的阈值和准确SHA重新计算，并验证失败例及告警/回滚 | 不根据结果调整门槛，不保证70%胜率，不混模型cohort凑样本 |

A2/A4先提出可测的SLO、窗口、样本量/检验方法和基准非劣/改进规则，A1/A10在评估前冻结。未确定或未达到的项不得填GREEN；不可绕过既有最低样本和发布限制。现有prediction ledger的评分对象是home/draw/away，不能以它已通过测试宣称O/U已完成独立商业验证。
