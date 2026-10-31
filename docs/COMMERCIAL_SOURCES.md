# 商业信息源接入与公开爬虫补充

本版把商业接口接入 `npm run collect` 的真实采集流程，输出到同一轮 JSON / 消息版报告。接口适配已实现不代表生产账号已开通；没有真实凭据时，状态为 `not_configured`，不会请求接口、构造数据或显示已连接。

## 已实现的能力

| 来源 | 变量 | 本版采集内容 | 限制 |
| --- | --- | --- | --- |
| Sportmonks | `SPORTMONKS_API_TOKEN` | 五大联赛日期窗口赛程；赛前全场胜平负模型 | 赛程可作为第三个备用；预测需 Predictions 附加权益，仅解析 `FULLTIME_RESULT_PROBABILITY`；不接滚球预测或 Premium Odds |
| The Odds API | `THE_ODDS_API_KEY` | 五大联赛赛前胜平负、让分、大小球市场参考 | 默认 EU 区域；保留博彩公司、源更新时间、双方完整价格；未核实让分结算细节，不能直接当成正式亚洲盘证据 |
| iSports API | `ISPORTS_API_KEY` | UTC 当日未开赛五大联赛的全场亚洲盘；Bet365、M88、12Bet、SBOBET | 需要 Live Data + Odds / Odds Pro；本版只匹配当日赛程，未接未来七日赛程或增量流；香港盘转十进制，明确换算让球方向 |
| 纳米、Opta、Sportradar、LSports、TXODDS | 暂无 | 能力目录、商务入口、接入所需材料 | `contract_required`，尚未实现数据请求；取得具体产品协议、主机、授权及真实样本后再开发，不把登记当成已接通 |

Sportmonks 的赛程与模型使用同一个 token，但赛程授权和预测权益不同。采集赛程只请求 `participants`，避免未购买预测影响赛程备用。分析阶段单独请求 `participants;predictions.type`。

模型概率、市场隐含概率、初盘参考是不同的数据：

- Sportmonks 概率作为 **1X2 辅助信号**进入原有分析，保留每日赛前模型说明。源未提供生成时间时存为 `null`；采集时间不冒充模型生成时间。
- The Odds API 的倒数赔率归一化仅表示市场隐含概率，不是模型胜率。让分结果保留为 `handicap`，不猜测亚洲盘结算规则。
- iSports 的正盘口表示主队让球，因此主队规范化盘口取负值。`initial*` 字段只能作为供应商声明的初盘参考；没有初盘时间，不构造 `opening.observedAt`，也不把第一次抓到的报价称为真正初盘。
- 新商业盘口保留 `formalEligible=false`，不增加正式独立来源票。上游关系未核验前，多家公司、多条商业交付链路不能自动算成多路独立证据。原有排除皇冠、1.65–1.95、双独立亚盘与初盘轨迹门槛不降低。

## 配置与运行

在本地未提交的 `.env.local` 或服务器 `/etc/vantis/collector.env` 中加入实际凭据，变量模板见仓库 `.env.example`。不要将值写进配置 JSON、网页或日志。程序不会自动读取 `.env`。

```sh
# 离线检查：只显示变量是否已配置、能力、开通入口与历史健康；不打印密钥。
node --env-file=.env.local collector/run.mjs --provider-status

# 真实采集：至少一个赛程接口有效，或显式提供真实赛程文件。
node --env-file=.env.local collector/run.mjs --state .collection-state/state.json --out reports

# The Odds API 或 iSports 单独配置时，可配合已有真实赛程输入。
node --env-file=.env.local collector/run.mjs --input /path/to/fixtures.json --out reports
```

GitHub Actions 已配置对三个同名 Secrets 的引用；是否实际存在、授权是否有效，需要应用验收确认。demo 不注入生产凭据。现有服务器配置不会被安装脚本覆盖；升级已有机器时自行向环境文件追加所需变量。纳米等合同型产品应取得具体字段文档、授权样本、访问主机、更新与历史范围，再进入适配验证。

主分支采集代码或配置更新后，Actions 自动执行一次 `npm run sources:activate`。有已启用赛程源的凭据或 `FIXTURES_FILE` 时，执行最多 5 分钟的常规采集（`--basic` 关闭隐式深度分析）；缺少赛程配置时只生成 `configuration_required` 报告，不发起采集。设置了文件路径并不代表文件有效，采集时仍会校验。结果写入 `reports/activation.json`、`reports/activation.md`、Actions Summary 和 artifact。

验收逐源区分 `not_configured`、`not_attempted`、`no_matching_data`、`data_received`、授权错误和冷却状态。工作流成功仅表示验收程序完成，不能当成所有供应商已经接通；`data_received` 也不代表正式预测候选。每小时持续采集仍由仓库变量 `VANTIS_COLLECTION_ENABLED=true` 启用，或手动运行“维度足球长期采集”。GitHub 上的验收不代表 ECS 已部署，服务器需另行核对版本与运行报告。

`config/providers.json` 控制分析材料采集，`--providers-config FILE` 可指定配置；`config/sources.json` 单独控制赛程备用。关闭某源分析材料不会自动关闭其赛程备用，两处可按用途分别配置。

| 配置 | 默认值 | 含义 |
| --- | --- | --- |
| `enabled` | 三个已实现来源 | 无对应 key 时仍不请求；可设空数组关闭商业分析材料 |
| `maxRequestsPerProvider` | 30 | 每轮每个商业分析来源请求上限，允许 1–100 |
| `maxPages` | 10 | Sportmonks 每联赛分页上限，允许 1–20；未读完不能作为完整结果 |
| `oddsRegions` | `eu` | 单个赔率区域，可选 `eu` / `uk` / `us` / `au` |
| `failureCooldownMs` | 300000 | 普通失败首次冷却 5 分钟，后续指数增加 |
| `maxCooldownMs` | 3600000 | 普通失败冷却上限 1 小时 |
| `authCooldownMs` | 21600000 | 401、402、403、凭据格式错误冷却 6 小时 |

配置拒绝未知字段、自定义主机、未实现来源和无限预算。健康记录在 `${statePath}.providers.json`；它只包含枚举状态和时间，不保存凭据或原始响应。损坏记录明确失败，不自动清空冷却。锁异常按既有 `collector/recover-lock.mjs --state PATH` 流程处理。

默认仍每小时运行，没有启动秒级轮询或增加付费后台任务。常见一轮：Sportmonks 分析每个有比赛的联赛至少一次，The Odds API 每个有比赛的联赛一次，iSports 最多一次当日赛程加一次全量盘口。Sportmonks 赛程备用另有最多 50 次请求上限。The Odds API 一次请求的 credits 消耗与市场、区域有关，不能按 HTTP 次数估算费用。

## 容错、爬虫与数据边界

1. 商业 API 和公开爬虫并行采集，分别使用固定主机、凭据、状态和预算；API 密钥不会传给浏览器或公开网站。
2. 接口拒绝授权、要求订阅或限流时，保留原因并冷却；`Retry-After` 被有界解析。其他已配置供应商和现有公开源继续工作。一个商业来源未完成本轮时，不发布其部分分析材料；不宣称该来源完整覆盖。
3. 不跟随 HTTP 重定向或接口返回的 `next_page` URL；Sportmonks 只在官方主机递增页码。每个响应限 2 MB，每次请求超时 6 秒，同时受整轮预算和取消信号限制。
4. 比赛关联使用联赛、主客队精确别名、开赛时间（最多 5 分钟差）；反向队伍、重复身份、未知联赛、缺少字段或不唯一匹配不生成材料。
5. 赔率缺源时间、超过 5 分钟、停盘、滚球、盘口不成对、重复报价或皇冠均不采用。报告生成时再次标记材料是否已过有效期。
6. 公开采集仍使用现有 Crawlee/Playwright、robots、限速、有限重试、缓存复验及已授权会话。没有将注册、登录、验证码、付费墙或 API 鉴权绕过作为故障恢复机制。

未开通商业服务时，可以继续使用已有可用的赛程接口、真实输入文件和允许采集的公开证据；缺少同能力替代源时保留缺项。API 故障不会触发搜索陌生接口、盗用其他账号、自动注册试用或充值。

## 输出与验证

`reports/latest.json` 的 `providers` 包含逐源尝试、配置状态目录和逐场标准化 observations；消息版增加相同材料。编号报告保留每轮快照，`latest` 只表示最近一轮。快照不是完整逐笔历史，Actions artifact 默认 30 天也不是永久数据库。

测试使用按官方文档构造的合成响应，覆盖鉴权/套餐限制、冷却恢复、限流、超时、取消、分页缺失、重定向、错配、过期、停盘、盘口符号、密钥不落盘及完整 CLI 报告。**合成测试不能替代带真实授权账号的联调、国内服务器延迟测试、供应商独立性审查和预测回测。**

实现依据：

- [Sportmonks 认证](https://docs.sportmonks.com/v3/welcome/authentication)、[日期窗口赛程](https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/fixtures/get-fixtures-by-date-range)、[预测产品](https://www.sportmonks.com/football-api/football-predictions-api/)。
- [The Odds API v4](https://the-odds-api.com/liveapi/guides/v4/)、[更新频率](https://the-odds-api.com/sports-odds-data/update-intervals.html)。
- [iSports 当日赛程](https://www.isportsapi.com/docs.html?id=20)、[主盘口字段与格式](https://www.isportsapi.com/docs.html?id=24)。
