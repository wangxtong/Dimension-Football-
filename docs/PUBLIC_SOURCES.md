# 官方公开信息源试接入

没有私有 API 凭据时，可使用供应商明确发布的免认证或共享免费入口取得有限赛程样本。不会寻找泄露密钥、遍历私有接口、绕过登录或订阅。HTTP 200、取得赛程、取得盘口、形成预测候选分别记录。

## 已实现的入口

| 来源 | 官方入口 | 本版用途与限制 |
| --- | --- | --- |
| OpenLigaDB | https://api.openligadb.de/getmatchdata/bl1/2026 | 赛季年份按当前时间计算，读取社区德甲赛程，仅保留未来 7 日未完赛且无比分记录的场次。社区公布的开赛时间不等于已经独立确认。 |
| TheSportsDB | https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=4328 | `123` 是官方文档公开的共享免费 Key。英超、西甲、意甲、法甲各请求一次，免费档各最多一场；不遍历队伍或日期规避免费上限，不调用 Premium / v2。 |

来源依据：[OpenLigaDB 说明](https://www.openligadb.de/)、[接口示例](https://github.com/OpenLigaDB/OpenLigaDB-Samples)、[ODbL 许可](https://www.openligadb.de/lizenz)、[TheSportsDB 免费文档和限制](https://www.thesportsdb.com/docs_api_guide.php)。这不是对五大联赛完整实时覆盖或企业 SLA 的承诺。

两家的联赛分工不重叠，赛事 ID 分别使用 `oldb-`、`tsdb-` 命名空间。只读取官方固定主机和已公开 GET 路径，不接收自定义 URL 或私有密钥。仅赛程模式一轮 5 次请求，跨 7 月边界最多 6 次；`collect:public` 增加一次上一赛季请求，分别为 6 / 7 次。单请求最多 6 秒、响应最多 2 MB，不自动重试。429 保留 `Retry-After`，401 / 403、重定向、HTML、陈旧 HTTP 响应、错误身份和无效日期不会转为赛程。

TheSportsDB 使用官方定义的 `dateEvent + strTime` UTC 时间，与提供的 `strTimestamp` 再次比较；缺时间、零点占位、延期、未知状态或已有比分均不采用。OpenLigaDB 仅使用显式 UTC 字段；无时区的 `lastUpdateDateTime` 不推断为 UTC。两源的 `sourceUpdatedAt` 保留未知，采集时间不冒充供应商更新时间。

## 使用方式

```sh
# 只取得并核验真实赛程样本
npm run fixtures:public

# 将样本送入原有证据采集与筛选，默认整轮预算 5 分钟
npm run collect:public

# 自定义独立状态和报告目录
npm run collect:public -- --state .collection-state/public/state.json --out reports/public --budget-minutes 2
```

`collect:public` 显式使用 `--basic`，不启用 API-Football 隐式深度分析。已有商业来源只有配置其合法凭据时才会参与原有证据采集。普通 `collect`、每小时调度与主分支上线验收逻辑不变。

GitHub Actions 的“公开赛程预测与报告”可手动触发；相关模块合入主分支或后续更新时也自动跑一轮。单轮最多 2 分钟，无新增定时重复任务；公开赛程请求不携带私钥。配置商业来源 Secrets 后，仅将对应密钥传给其既有官方适配器；未配置时跳过。结果和归属写入 Summary，数据及分析报告保存在 artifact 30 天；最终发布状态单独保存在 publication-receipt 附件。该任务的 `success` 只表示采集程序完成，实际预测数、缺项和盘口候选分别查看报告。

输出在 `reports/public/`：

- `public-fixtures.json`：归一化赛程、实际请求状态、覆盖限制和来源说明；始终 `poolComplete=false`。
- `openligadb-fixtures.json`：单独提供本轮 OpenLigaDB 归一化赛程、完赛历史与 ODbL 归属，便于按许可要求处理数据共享；不下载队徽等独立版权素材。
- `public-sources.md`：公开来源实测结果。
- `latest.json`、`latest-brief.md`、`latest-message.md`：现有分析输出，包含公开来源归属。无有效赛程时仅生成来源报告并以非零状态退出，不覆盖已有分析报告。
- `predictions.json`、`predictions.md`、`predictions.html`：独立赛前概率、预期进球、比分参考、逐场缺项与滚动回测；历史来自当前和上一赛季中有唯一全场比分的完赛记录。详见 [预测实现说明](FORECASTING.md)。

ODbL 适用于 OpenLigaDB 数据，使用、公开派生数据库或再分发时需遵守其归属和共享要求；它不授权其他来源的数据。TheSportsDB 使用其官方免费档规则。部署方需保留数据来源、许可链接和覆盖限制。

## 2026-10-31 实测

在本次云环境于 04:03 UTC 完成一轮真实网络采集：

| 来源 | 实际结果 | 是否形成预测证据 |
| --- | --- | --- |
| OpenLigaDB | HTTP 200；赛季 306 条，筛得未来窗口 9 场德甲赛程 | 仅赛程 |
| TheSportsDB Free | 四个联赛均 HTTP 200，各返回并采纳 1 场，共 4 场 | 仅赛程 |
| 天天盈球 | 公开页面 HTTP 200，解析到 3 条列表记录 | 预测字段格式尚未核验，未采纳 |
| Titan007 球探 | 爬虫读取 robots 后返回 `robots_denied` | 未请求受禁数据路径，未取得盘口 |
| Statarea | `crawler_timeout`；随后同源请求进入冷却 | 未取得模型信号 |

该次为加入统计预测前的实测：13 场真实赛程进入盘口筛选，13 场均为 `source_insufficient`，严格盘口候选 0 场，原因为 `NO_FRESH_COMPLETE_ASIAN_MARKET`。新增预测后的实测已独立产出 9 场德甲基础预测，其余 4 场缺历史；严格盘口仍是 0 场。抓取成功不等于取得双独立亚洲盘或可靠预测。以上只是一次环境与时间点的观察，不能保证源持续可用。

Football-Data.co.uk 未加入自动任务：其[当前使用说明](https://football-data.co.uk/contact.php)将免费 CSV 限于个人 / 学术用途，轻量自动下载最多每周两次，不适合作为本项目的企业实时采集入口；本次文档访问也出现 429，未继续请求数据文件。

## 验证

新增测试覆盖公开请求不携带私钥、固定主机、赛事身份、联赛、UTC 时间冲突、延期与完赛排除、免费条数限制、失败隔离、429、重定向、过期响应、体积限制、HTML、异常脱敏、超时、取消、预算、跨赛季和实际 CLI 到报告流程。合成测试不能替代持续覆盖、时效和预测质量评估。
