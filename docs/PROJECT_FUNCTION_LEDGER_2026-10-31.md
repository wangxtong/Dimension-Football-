# 维度足球项目功能台账与修复路线（2026-10-31）

> **性质：只读核验后形成的技术台账；不是发布批准、部署回执或模型胜率承诺。**
> 基线：主仓库 `wangxtong/Dimension-Football-` 的 `main@028f43cdf63dff0b470e5288c9866f1463d14b29`；消息桥仓库 `wangxtong/weidu-football-bridge` 的 `main@b5a518794ae0a25928b28d01b0984c6c9d82cf16`。证据的记录时间与现场复核时间区分展示。

## 1. 版本、PR 与流水线

| 范围 | 证据 | 判定 |
| --- | --- | --- |
| 预测与采集主仓库 | [主分支提交](https://github.com/wangxtong/Dimension-Football-/commit/028f43cdf63dff0b470e5288c9866f1463d14b29)，仓库目前 Private | 已有真实 Git 提交 |
| 主项目 PR | [PR #1、#3～#10 已合并](https://github.com/wangxtong/Dimension-Football-/pulls?q=is%3Apr+is%3Aclosed)；[PR #2](https://github.com/wangxtong/Dimension-Football-/pull/2) 仍为 Draft（智能体/技能路由，未修复业务缺陷） | 不以 Draft 作为交付 |
| 主项目 CI | [采集项目验证](https://github.com/wangxtong/Dimension-Football-/actions/runs/41177508649) 的 test 与 browser job 均成功 | **代码检查 GREEN，不等于回测门禁 GREEN** |
| 主项目数据发布 | [公开预测任务](https://github.com/wangxtong/Dimension-Football-/actions/runs/41177508692) 成功；[published-reports/publication.json](https://github.com/wangxtong/Dimension-Football-/blob/published-reports/publication.json) 记录数据提交并回读与 Telegram API accepted | 已有发布回执，不等于网页/生产端到端验收 |
| 消息桥仓库 | [仓库](https://github.com/wangxtong/weidu-football-bridge)，[最新 Bridge tests](https://github.com/wangxtong/weidu-football-bridge/actions/runs/41175878442) Python 3.10、3.13 成功；[PR #1](https://github.com/wangxtong/weidu-football-bridge/pull/1) 已合并 | 消息桥代码验证通过，不能代替模型发布 |
| 分支保护 | 两个 main 分支的 GitHub branch API 均显示 `protected=false` | **阻断：发布流程存在绕过风险** |

## 2. 现有功能台账

状态定义：**代码已实现**＝代码/CI证据，**有运行回执**＝具体执行或数据记录，**待验证**＝没有充足的生产或授权证据，**未完成**＝明确缺口。

| 模块 | 代码中已具备的能力 | 当前边界/验收状态 |
| --- | --- | --- |
| 五大联赛赛程 | football-data.org、API-Football、Sportmonks 的赛程适配及故障切换；公开模式 OpenLigaDB、TheSportsDB | 接口密钥、联赛覆盖、时效需逐源验收；公开免费源只覆盖有限样本 |
| 数据源健康维护 | 来源限速、401/402/403/429 冷却、有限重试、状态文件与审计诊断 | 实际数据质量和商业权限不因代码存在而自动通过 |
| 浏览器采集 | Crawlee/Playwright、robots 尊重、挑战页面识别、浏览器自检 | Browser CI 通过；受限和付费页面不可绕权，真实逐源证据待确认 |
| 盘口证据 | Titan007 一组多公司快照、HKJC 第一方 HDC、时效/身份/双边报价校验 | **第二独立组、供应商真实初盘及完整走势必须同场有效**；不能把两个公司当两路独立来源 |
| 商业 API | Sportmonks 模型、The Odds API 市场参考、iSports 亚洲盘适配器 | 账号授权/套餐/真实返回未整体验收；不将参考报价冒充模型胜率 |
| 预测算法 | `venue-poisson-v1`：时间衰减、主客场统计、独立泊松、胜平负/比分参考 | 未校准；不纳入伤停、首发、盘口及大小球的独立概率模型 |
| 回测 | 同源同联赛时间序列 walk-forward、Brier/Log loss/命中率与频率基线 | **当前历史修订快照并非真实历史当时可见数据；不是前瞻验证** |
| 严格盘口候选 | 报价 1.65–1.95、双独立来源、成对报价、真实初盘、独立辅助信号及人工复核门槛 | 2026-10-31 最近公开报告 **0 个严格候选**；不放宽门槛补量 |
| 报告与审计 | HTML/Markdown/JSON、普通预测/严格候选/不可评估分类、发布 SHA 和回执 | 报告完成不等于结果已通过生产回归或真实盈利测试 |
| 预测网站 | 服务器端密码登录、报表代理、中文展示、每 5 分钟刷新、过期下架 | **当前 Worker 仍以无认证 raw GitHub 读取私有仓库**，生产读取必须重新验证 |
| TG 通知 | 摘要推送、回执脱敏、失败分类、身份修正；回执只记录平台接受 | 最后一次记录 `messageId=57`，不是用户已读或完整双端验收 |
| TG 双向桥 | 独立 Python 服务、Bearer API、Telegram Webhook、SQLite、消息状态/幂等；保留旧工作流 | 部署交接记录 10/30 双向消息实测，当前 ECS SHA、重启持久化和在线回归仍需复验 |
| ECS 部署 | systemd 定时器、版本目录、原子切换、旧版留存 | 当前同步脚本只验证离线测试；未见强制完整发布门禁，也未获取现场运行 SHA |

## 3. 最近可核验的数据质量

- [公开预测报告](https://github.com/wangxtong/Dimension-Football-/blob/published-reports/predictions.json) 在 **2026-10-31 06:39:43 UTC** 生成：13 场输入、9 场基础预测、4 场不可评估、0 场严格盘口候选；有效历史 370 场。
- 德甲回测评估 63 场、跳过 17 场，方向命中约 57.14%，Brier 约 0.5490；英超、西甲、意甲、法甲有效回测数均为 0。模型 `calibrated=false`，尚无跨赛季前瞻与投注结果校验。
- 独立私有 Site 最近一次采集完成于 **2026-10-31 05:52:59 UTC**：赛程记录 1785、未来 67、皇冠可匹配 7、有效市场报价 0、有效辅助信号 0、来源失败 5；状态 `partial`，信号阶段 `SOURCE_REFRESH_FAILED`。**这是不同于主仓库公开预测工作流的另一条数据管道，不可互相替代数值。**
- 外部采集导入的最近两条记录仍为未核验失败记录，没有形成可信预测信号。
- [发布回执](https://github.com/wangxtong/Dimension-Football-/blob/published-reports/publication.json) 标记了数据提交/回读成功和 Telegram API `accepted`，但没有证明最终网站有登录用户可读取，更不能证明 ECS 已切换至该版本。

## 4. 修复路线（先阻断生产风险，再补质量）

| 优先级 | 问题/证据 | 修复任务 | 验收定义 |
| --- | --- | --- | --- |
| **P0-1** | 主仓库为 Private，但 [deploy/sync.sh](../deploy/sync.sh) 使用清空认证配置的 `git ls-remote` 和无凭据 `codeload.github.com` | 改用最小权限 GitHub App/只读凭据的安全同步，或由受控 CI 发布制品；凭据不入参数/日志 | 在 ECS 上真实读取私有 SHA、部署至暂存目录、验证签名/散列、保留旧版回滚 |
| **P0-2** | [website/worker.mjs](../website/worker.mjs) 无授权读取 `raw.githubusercontent.com/.../published-reports`；主仓库现已 Private | 使用服务端授权的报告数据代理或受控独立发布存储；绝不将令牌暴露浏览器；不为修复而公开整个仓库 | 未登录为 401/跳登录；登录后 `/api/predictions.json` 与 `/api/publication.json` 返回同一最新 reportId，浏览器刷新通过 |
| **P0-3** | 两主分支保护未启用；[test.yml](../.github/workflows/test.yml) 只验证单测、模拟、浏览器；[deploy/sync.sh](../deploy/sync.sh) 仍以这些测试作为部署资格 | 将 **BACKTEST_ALL_GREEN_ONLY 全部必测项** 与 `RELEASE_GATE=GREEN` 设为机器可核对、不可由单元测试伪造的部署前置条件；在平台可用条件下启用保护/必需检查，否则临时停止自动生产同步 | 对 `FAIL`、`WARN_BLOCKING`、`UNKNOWN`、`BACKTEST_INSUFFICIENT` 和缺报告等全部 fail closed；不得自动合并/部署 |
| **P0-4** | 旧 TG 工作流可提交队列数据，发布和回归责任与新桥接服务不统一 | 把旧消息队列和新服务的所有权、发送目标、重发策略分离，限制直接 main 修改 | 不重复投递、不串频道、旧功能端到端无回归；业务数据和代码变更可审计 |
| **P1-1** | 四个联赛缺历史回测，德甲仅 63 场；统计模型未校准 | 补充有时间戳的跨赛季历史，建立按比赛开赛时可见数据的冻结前瞻集；区分 1X2 与 O/U 的基线 | 逐联赛报告样本量、校准、Brier/Log loss、置信区间、弃赛率、赔率净收益；标准事先固定，无法达标则不放行 |
| **P1-2** | 私有采集 `PARTIAL`、0 辅助信号；双源与初盘均缺 | 在合法授权下补第二路独立亚洲盘、可核对的供应商原始开盘时间和当日实盘；改进球队中文别名和联赛映射 | 每场价格、盘口、初盘/最新、水位、来源组与原始时间能同时核对；不使用历史快照冒充实时 |
| **P1-3** | 数据发布回执 ≠ 生产最终验收 | 保留生产旧版 SHA，记录本次候选 SHA； staging → 生产；灰度、回滚与页面/API/Telegram 烟雾测试 | 真实 ECS SHA、健康检查、授权读写、Telegram 双向、重启后记录保留、关键结果与旧版基准无回归 |
| **P2** | 预测仅为基础泊松，复盘/CLV 与校准仍不完整 | 补充模型校准、失误归因、赛前封盘记录、正式回测报表和中文交互 | 不泄漏未来数据；仅在数据来源充分且门禁全绿后进入正式发布 |

## 5. 执行顺序与约束

1. **先处理 P0-1/P0-2**：私有仓库读取与生产看板权限的设计冲突；先验证是否已经影响线上读取，不直接覆盖现网。
2. **再处理 P0-3**：把完整预测回测/回归/版本证据做成实际部署阻断器；冻结主分支无门禁自动上线。
3. **再处理 P1-1/P1-2**：补历史和合法数据源，分别评估普通预测与严格盘口；不能以局部 CI 成功代替它们。
4. **最后 P1-3/P2**：完整生产烟雾测试、旧版无回归对比、回滚演练，之后才允许宣布最终上线。

## 6. 最终发布门禁（当前 NOT GREEN）

```text
BACKTEST_ALL_GREEN_ONLY = NOT_VERIFIED
RELEASE_GATE           = BLOCKED / NOT_VERIFIED_GREEN
GIT_COMMIT_PR           = exists (不代表全部目标 PR 已完成)
CI                      = GREEN for existing code tests only
PRODUCTION_SHA          = UNKNOWN
PRODUCTION_SMOKE        = UNKNOWN
OLD_VERSION_NO_REGRESSION = UNKNOWN
COMMERCIAL_API_AUTH     = NOT_VERIFIED
FINAL_DEPLOYMENT_CLAIM  = FORBIDDEN
```

任一必测项为 `FAIL/WARN_BLOCKING/UNKNOWN/BACKTEST_INSUFFICIENT` 或缺少商业 API 授权、真实 Git/PR/CI、部署烟雾/旧版无回归证据，必须阻断并保留旧生产状态。**台账文档的合并本身也不代表发布。**

本文件不记录任何密钥、真实用户聊天内容或未经授权的商业 API 数据；后续整改应使用独立功能 PR、CI、分阶段生产验收，并绑定真实完整提交 SHA。
