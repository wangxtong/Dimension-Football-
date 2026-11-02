# 维度足球 · 2026-11-02 历史决策与核验状态

> 这是 2026-11-02 的冻结历史证据索引，不是实时状态。**每次执行先从真实 main、Actions、Issues、Sites 读取当轮事实**；本文件不授予账号凭据、远程命令会话或生产发布权。

## 最终确认范围
- 仅六技术系统：基础架构/代码；实时源与采集；历史数据/模型；中文Web；Telegram；部署运维/监控/独立QA。
- 剔除商业运营模块及作为产品里程碑的“逐源法律条款研究”；**实际来源访问控制、秘密保密、模型与发布安全不删**。
- 五大联赛，模型仅1X2+大小球；亚盘、独立真实开盘与水位供筛选事实，缺源不伪造方向。质量目标曾提出测试≥62%、期望≈70%，现无真实赛前证据证明。
- 受控历史研究继续独立推进；正式推荐及预测输出一直 `RELEASE_GATE=BLOCKED`，`BACKTEST_ALL_GREEN_ONLY=BACKTEST_INSUFFICIENT`。

## GitHub与真实代码锚
- 私有仓库：https://github.com/wangxtong/Dimension-Football-
- 最新已核主线：`f39893d88174b595c62a657e2e86dced51ffee36`（2026-11-02 01:54:47 UTC），具体当轮必须再查。
- PR #55 双源研究观察+中文看板、#56澳门映射与过期重采、#57机器人状态日报/原生分类已合并；#54隔离runner仍Draft HEAD `a3573367b19ee91077a64fcb62aff768a73740d0`。
- 主线CI https://github.com/wangxtong/Dimension-Football-/actions/runs/41374918276：Node 920/920、网站Chromium 17/17、采集器Chromium 3/3，无关键跳过；发布制品 `provenanceVerified=false`，不是实机E3。
- Sites v14和站点登录/两种屏宽有历史现场回执，资料见 https://github.com/wangxtong/Dimension-Football-/pull/57；不能由Sites部署推断ECS运行 SHA。

## 四件实物的真实边界
1. **历史RAW**：固定OpenFootball历史赛后结果15份、5,330场；4,910可评分/420弃评。A10独立V20新随机样本1,070/5,330(20.075%)、10,644次指标核算0差异，原文持久读回PASS_E2_PARTIAL。详情 https://github.com/wangxtong/Dimension-Football-/issues/29#issuecomment-6568154627。不是实时赛前赔率。
2. **模型回测**：历史留出1,732场，1X2 Brier 0.606383 对照0.652835；A4 V20开发者clean replay exit0，但A10的独立完整递归回放遇160秒环境执行超时，结论UNKNOWN_TIMEOUT。模型真实前瞻合格样本0、真实初盘0；不得称预测成熟。
3. **持续采集**：真实Hosted run 41374918278(01:55 UTC)与41376319351(02:11 UTC)间隔954.739s，而非600s；最新scheduled长期采集 https://github.com/wangxtong/Dimension-Football-/actions/runs/41376675746 = skipped。无合格4连续600秒槽、独立60秒心跳、+300秒告警、完整24h分母或真实T−50现场E3。
4. **ECS**：历史实例 `i-j6c4g9s2y6b5irl5gcr9`/地址`8.218.6.246`，Workbench `ecs-user`。#54 `docs/evidence/research-runner-ecs-20261101.json` 自报2026-11-01T08:00Z一槽、11次心跳/5个T−50 timer；当前独立实际 bootId、runningSHA、journal、Smoke与真正独立持续runner身份均UNKNOWN。不得将本会话本地容器当作ECS。

## 当前最紧急P0（既有真实证据）
- A10核查真实Hosted主线 https://github.com/wangxtong/Dimension-Football-/actions/runs/41374918278 和 https://github.com/wangxtong/Dimension-Football-/actions/runs/41376319351：未获允许的Macauslot当前源码仍能HTTP GET并在聚合中贡献4场8条引用、2场双源对齐，而真初盘0。旧缓存同样可能重建污染计数。来源未准入，不能以浏览器HTTP200代替可用供数。
- A2/A3必须在源GET之前阻断，聚合缓存/R2/网站/TG及现存派生计数全链隔离，不删除真实审计原件；A9审源血缘，A6/A8改健康摘要与UI读时拒绝，A10同SHA审真/伪数据、零不允许请求与历史回执。
- 2026-11-02北京09:55真实Telegram状态日报 API accepted，messageId=181，且原始payload含由上述来源派生的双源对齐统计；虽然**没有正式预测方向/概率外发**，健康摘要本身须完成数据来源审查。A6证据：https://github.com/wangxtong/Dimension-Football-/issues/24#issuecomment-6568194750。
- 私有GitHub Actions Summary旧入口对预测正文漏正式门禁，未集成候选；修复必须同步源码与两个workflow，包含marker+anchor伪装负例，最终CI/E3再放行。

## 用户Telegram操作实测
- 用户已在原群 `绿茵足球`点击4个斜杠命令及所有7种分类按钮，回调均正常（用户反馈、7张实际截图），不应再次要求重复相同操作。A6台账：https://github.com/wangxtong/Dimension-Football-/issues/24#issuecomment-6568183721。
- 2026-11-02北京11:10–11:11页面同一报告短ID `355a7de3d14e`、生成10:11、报价10:15到期；共13场赛程、4场报价受检、2场观察双源对齐、真实原生初盘0，用户看到的是过期研究信息，不是当下合格预测。
- `TELEGRAM_USER_FUNCTIONAL_SMOKE=PASS_USER_REPORTED`；真实Webhook逐次update_id、跨页/编辑回执和A8/A10独立E3未证。09:55状态日报已接收≠用户已读，更不等于预测日报已发布。

## 历史授权/连接复用
- 用户已允许历史Work操作、GitHub仓库管理、API-Football付费隔离测试、ECS只读诊断和独立隔离研究。**不再向用户要求已知IP、订阅购买、新明文Key或重复同一许可**。
- `AUTHORIZATION_RECORDED`不等于可用Work云浏览器/SSH/Workbench。当前聊天没有已附着的Work远程浏览器控制接口、也没有阿里云命令接口；真实ECS状态不可核验时应返回 `SESSION_NOT_ATTACHED`，不称用户未授权。
- `modouxin-dev` 需要在主仓库 Private 下以Write权限邀请；现有GitHub connector的协作者邀请写接口不可用，前次直接核验permission=`none`、邀请未发送。仅真正Work页面或可用写接口实际回执后改状态，不能以Issue指派替代。
- 老消息桥仓库 `wangxtong/weidu-football-bridge` 曾在2026-10-30完成双端真实消息测试，属独立系统，不能挪用其机器人/密钥或当作主预测发布证据。

## 近期Owner执行顺序
1. A1 + A2/A3 + A6/A8先关闭未准入源请求、旧缓存派生、Web/Bot与健康日报出站的真实P0；不丢失原始归档。工单 #22 #23 #24 #25 #53。
2. A2现有API-Football安全会话有界核实fixtures/赔率完整页/供应商原生时间，独立可复核RAW；缺安全执行器时转用已存在公开历史源做研究，不用付费接口名称冒充实采。
3. A3/A7在真正获准持久非生产环境上产生4连续600s槽+心跳+延迟报警+跨重启真实hash；独立T−50逐场计时、修订和漏槽证据。
4. A4提供可限资源分阶段重放的独立完整V20，A5核赔率初盘事实；A8/A10对终版SHA独立至少20%复核，A1核真实CI/CLI及放行门禁。
5. A6/A8在保留已通过Web/TG交互的前提下仅接入新鲜并有资格的数据；未满足任何硬门禁时展示明确'没有可发布预测'，不能编造今日3–5场推荐。

## 用户配合最低化
- 4命令7按钮用户实测已完成，今日**不再要求重复**。
- GitHub `modouxin-dev`邀请还未发送，必须由已附着的受权实际浏览器/管理写操作执行；无需再问要授什么权限（Write）或改公开仓库。
- ECS验证优先现有连接身份，当前缺的是可执行会话而非权限文本；若需恢复技术通道，只说明当前缺哪种连接。
- 正式预测发布在CI/前瞻/安全/恢复与独验全绿后再交A1决策；本基线不能授权生产外发。
