---
name: dimension-football-control-tower
description: 维度足球 Dimension-Football 私有仓库项目总控技能。用于汇总历史授权、恢复已有 GitHub/Work/ECS/Sites/Telegram 工作上下文，审计实际 SHA、CI、真实数据源与预测模型，协调 A1-A10 项目任务并生成六大技术系统证据看板。适用于项目进度、生产落盘、实时采集、T-50 赔率、模型回测、Telegram 测试、授权复用和故障交接；不会自行获得外部登录会话或绕过发布门禁。
---

# 维度足球 · 项目总控与生产落盘技能

## 用法与范围
- 这是**仓库级 Agent Skill**，不是已安装的 ChatGPT 全局插件，也不是服务器执行器。仅在该文件所在分支被获准合并、代理能发现该目录后，才可按支持的 Agent Skill 机制自动使用。
- 使用本技能前，读取本仓库最新 `AGENTS.md`、`config/agent-team.json`、`docs/agents/COMMON.md`、相关角色文件及 `references/PROJECT-BASELINE.md`；基线文件只提供历史索引，不可替代当轮读真实 main/PR/CI。
- 六大项目系统：①基础架构与代码管理；②实时数据源与自动采集；③历史数据与预测算法；④中文网站与用户界面；⑤Telegram 机器人与信息发布；⑥部署、运维、监控、独立验收。
- 商业运营系统（收费会员/订单/支付/营销裂变/佣金/微信QQ群营销）与逐源法律条款研究均**不作为独立产品工作项/里程碑**。实际接口的授权与安全控制、保密和数据准入仍必须遵守；不得把范围调整解释成许可绕过。

## 先恢复授权，不再反复提问
1. 优先从现有 GitHub 私有 Issue、仓库 docs、已连接应用和 Work 会话/历史操作记录找回既有授权、机器标识、目标环境、承诺过的限制，不再索要用户已经给出的 IP、订阅密钥、Bot Token 或同一动作批准。
2. 每条能力分别记录：`AUTHORIZATION_RECORDED`（已有用户许可）、`SESSION_ATTACHED`（本轮确实可调用的已认证动作）、`LIVE_VERIFIED`（本轮真实动作结果/回执）。不能从前者推导后两者。
3. GitHub 当前仓库 `wangxtong/Dimension-Football-` 必须保持 Private；用户明确要求邀请 `modouxin-dev` 为 Write 协作者。只有实际邀请接口/已登录 Work 浏览器操作成功且有 GitHub pending invitation 或有效权限回执才标邀请已发送。现有 GitHub connector 若无 collaborator-invite 写操作，只记 `NOT_SENT / EXECUTION_CHANNEL_UNAVAILABLE`；不能拿 Issue 指派或仓库 admin 属性冒充协作者邀请。
4. 阿里云已有 ECS 实例 `i-j6c4g9s2y6b5irl5gcr9`，公网地址 `8.218.6.246`；历史 Workbench 身份是 `ecs-user`。只读实机核验在历史授权范围内，但 SSH/Workbench/云命令会话会过期；本轮未附着时标 `SESSION_NOT_ATTACHED`，不得反复让用户提供 IP，更不得自称在线。
5. 已购买 API-Football，获准隔离 RESEARCH-ONLY 测试；优先现有安全注入与有效套餐，只能有限额读接口。安全通道缺失标 `CREDENTIAL_EXECUTION_CHANNEL_UNAVAILABLE`，并独立推进无需密钥的历史数据链，不索取聊天明文。
6. 主项目 Bot 为 `@LYZKYPbot`；旧 `weidu-football-bridge` / `@WDZQYCbot` 是独立服务。保留各自 Webhook、目标和回执，不能把一个机器人的状态/密钥映射到另一个。历史 Work 授权也不自动授予这个会话浏览器控制能力。

## 每轮最短证据链
1. 读当前主仓库 `main` 完整 40 位 SHA 和仓库私有状态；检查最新 PR HEAD/merged/draft、对应 Issues 真实增量及原始 GitHub Actions jobs/logs（通过/失败/跳过/异常）。需要时读取当前网站/Telegram 真实 reportId/hash/运行回执。
2. 固定 4 项生产落盘实物：历史 RAW ZIP/manifest/跨进程或跨运行 SHA；A4 可执行 1X2/O-U 回测和时间隔离留出指标；4 个真实连续 600 秒槽、60 秒独立心跳及 nextExpectedAt+300 秒告警/24 小时真实分母；ECS bootId、实例身份、运行 SHA、systemd/journal、网站 Smoke 与恢复证据。
3. 分开标记 `E2_DEV`（研发源码/脚本、合成 HTTP/离线回放）、`E2_REAL_SINGLE_RUN`（单轮实际 HTTP 和存储）、`E3_INDEPENDENT`（独立 QA 同 SHA、至少 20% 证据抽查、真实环境与必需门禁）。不得把一次 HTTP200、historical backfill、GitHub schedule/成功 job 或测试 Exit0写成持续生产运行。
4. 只有同功能真实测试且部署/运行回执可核才写 `√`；仅在研发、独验或线上连续性缺证时写 `（正在进行）`；缺技术输入写 UNKNOWN 并给 owner 和下次可执行动作。任何失败/critical skipped 均保持发布阻断。

## P0 安全、持续采集与预测核心
- **第一优先：数据源及已缓存派生事实不能混淆。** A10在真实 Hosted run `41374918278` 和 `41376319351` 发现 Macauslot 接口真实 HTTP200，而该源仍 `ACCESS_BLOCKED`。必须由 A2/A3 在发出网络请求前拒绝，并在 market-observation、R2旧快照、Web/Bot/健康日报任何出站摘要前去除该源派生计数；保留私有审计原文，不篡改历史证据。A9审核完整数据血缘，A10用相同精确版本做实机/Actions负例独验。
- **第二优先：真正运行的调度。** 固定 UTC 时间锚 `600s`，不得由完成时间往后推而漂移；独立 `60s` 心跳；只在 `nextExpectedAt+300s` 并核实缺席后报警。先交 4 个连续真实槽、跨重启持久 RAW SHA/读回，再累计完整 24 小时实际尝试分母评估≥95%；模拟/GitHub cron 延迟不能替代。
- **赛前 T−50 独立事件域。** `captureDueAtUTC=kickoffUTC-3000s`，按 fixtureId+kickoffRevision+due+sourceGroup 幂等；改期、取消、跨午夜、迟到、空赔率、429、分页缺页、错 bookmaker/market/selection/line 和开球后请求都必须明确 MISS/FAIL/LATE，禁止以后见值冒充赛前原生初盘。T−50 单次事件不得增加每600秒周期槽成功分母。
- **模型可再现性与放行分层。** A4只用历史研究时标进行 walk-forward、训练/验证/留出隔离；赛果现在回填不是历史赛前可见数据。正式1X2/O-U前瞻、真实初盘、基线对比、Brier/LogLoss/校准和回归需最终独立复验。所有欠缺不得拼凑每日3–5条发布。
- **正式预测仍阻断。** `BACKTEST_ALL_GREEN_ONLY=BACKTEST_INSUFFICIENT` 与 `RELEASE_GATE=BLOCKED` 直到完整模型+数据+CI+安全+运行SHA/回滚+独立QA通过。GitHub Summary、网站、Bot、日报都属于展示面，不能把受限赔率/预测利用健康摘要通道输出；生产代码/Secrets/ECS/定时变量、独立消息桥未经单独验证不得修改。

## 角色实际分工、交接
- 总控 A1：任务优先级、共享模块冲突、权限和证据台账、CI审核与最终发布裁决；只能宣布真实已核结果。
- A2：真实赛事/赔率/伤停/阵容源可用率、权限可调用性、冷却/限额、上游时间与独立性；提供可下载的失败/成功证据，不反复单列来源法律研究。
- A3：赛事ID、不可变 RAW/manifest、时间字段、跨进程/重启读回、两类调度和缓存隔离；A9如仍负责 schema，则冻结其领域契约。
- A4：1X2和大小球概率、时间隔离历史实验、赛前冻结与赛后核账；A5仅验证盘口的原生初盘/最新盘和独立来源事实，不能产出未经批准的预测。
- A6：中文 Web、Telegram 原生按钮、同 reportId/hash/过期说明、真正无预测/受限数据的健康消息与所有出站门禁；A7：实机身份、隔离 runner、持久存储/调度/备份恢复。
- 当前 main `config/agent-team.json` 定义 A1–A8，其中 A6 负责 Web/TG，A8 为独立QA；历史 Issue #28(A9契约)、#29(A10独验) 和对应自动任务仍在。不能假设十个常驻代理已同时启动，也不能把开发者自测重新署名为独立 A8/A10 签收。协调时在任务中明确 owner/reviewer，避免重复归属。
- 用户已在Telegram实测 4 条指令、全部7类按钮正常回调；`TELEGRAM_USER_FUNCTIONAL_SMOKE=PASS_USER_REPORTED`，不要再要求重复同一用户点击。后台逐事件Webhook/幂等仍需 A6/A8/A10复核。截图查询11:10–11:11 BJT时10:11数据已在10:15过期，不能认为刷新按钮会制造新真实行情。

## 汇报格式与复用
- 在 ChatGPT 项目会话给出六系统表（功能／`√`或`正在进行`／证据／责任人），附 4 件实物、最重要 P0、下阶段独立验收和**仅确需用户参与**的动作。用户已做的Telegram测试不要重提。
- 所有事实附精确 GitHub Issue/PR/CI URL；历史锚见 `references/PROJECT-BASELINE.md`。不要把连接器/API限制、长期记忆或用户授权当成远程调用权限。不可运行的操作给可复用实际技术缺口，不承诺后台异步交付，除非已调用现有自动任务。
- 更新状态时只增量登记新证据，避免重复 Issue 或反复争论封板。所有正式合并/部署继续要求同SHA完整必需CI/CLI及独立QA、A1审核；本技能本身不会改变生产行为。
