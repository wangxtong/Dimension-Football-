# 商业级数据源接入审计（A7，待 A2/A3/A5 实现）

本变更只登记官方文档和验收要求，不启用生产抓取，不表示供应商已授权。

| 供应商 | 用途 | 现状 |
| --- | --- | --- |
| OpticOdds v3 | SSE 实时赔率、历史盘口、伤停、阵容 | 待商业授权与适配器 |
| The Odds API | 赛前 1X2/大小球/让球赔率，约 60 秒刷新 | 仓库已有适配器，待验证许可与市场覆盖 |
| Sportmonks v3 | 赛事、阵容、赔率、伤停 | 仓库已有适配器，待核对订阅权益 |
| API-Football v3 | 比赛、伤停、首发、滚球赔率 | 待适配器，赛前赔率约 3 小时更新，不能当作 5 分钟实时源 |
| Sportradar / Opta / 纳米数据 | 企业级候选 | 商业合同、接口样本与授权待验证 |
| iSports | 亚洲盘辅助 | 已有适配器，需核对真实初盘与独立性 |

官方资料：
- https://developer.opticodds.com/docs/odds-api-getting-started-guide
- https://the-odds-api.com/sports-odds-data/update-intervals.html
- https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints
- https://www.api-football.com/documentation_v3
- https://developer.sportradar.com/soccer/reference/soccer-overview

## 生产升级门禁
- 合法商业使用、再分发范围与配额须核实；不得绕过付费或身份校验。
- 必须记录比赛ID、博彩公司、市场、盘口、水位、上游时间、采集时间、原始数据摘要、上游独立性。
- T-60分钟内赔率采集和上游报价均不超过5分钟，未知或冲突直接 BLOCKED，不使用缓存冒充实时。
- 自动轮换仅能在经过授权、实测、时间验证和身份映射的来源之间发生；任何来源不可用则弃赛，不降低门槛。
- A2/A3/A5 需独立实现适配器、负例测试与真实 CI；A1 才能审查合并。A7 不得擅自切换生产任务。
