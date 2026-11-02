# 维度足球对外发布门禁（RELEASE_GATE=BLOCKED）

本修复集成 PR #21 的六文件方案并封闭低层调用旁路。目前生产门禁是**绝对 BLOCKED**，没有任何成功返回分支。当前主项目仅德甲存在有限回顾性评估，其他四大联赛不足，模型尚未完成概率校准；本次不生成生产批准文件，也不宣称已部署或已获 GREEN 回测。

## 生效入口

- `collector/delivery.mjs` 的 `publishAll`、`publishWebsite`、`publishWebsiteReceipt`、`publishTelegram` 每个导出入口先执行同一门禁。直接导入、绕过 CLI、提供自定义 fetch/persist 函数或伪造 GREEN 环境变量均不能放行；门禁发生在网络、报告持久化、outbox claim 和发布回执变更之前。
- ECS `collector/orchestrate.mjs` 在公共 `publish()` 路径调用任何 `dep.publishAll` 之前执行门禁，不能通过注入发布函数跳过。fixtures/markets 可继续生成内部报告，随后明确记录发布阻断；results 只评估，不发送。
- 手动 CLI `node collector/publish.mjs website|website-receipt|telegram|all <报告目录>` 同样先进行门禁校验。
- `publishGitHubArchive`、Summary 和 artifacts 是内部归档例外，继续可用，不代表网站或 Telegram 交付。`publishAll` 本身被阻断，不会顺便归档；需要归档时应明确调用 archive 模式。人工消息桥的既有消息接口不属于模型发布，不应用作模型通知旁路。

门禁错误的 code/message 固定为 `RELEASE_GATE_BLOCKED`。CLI 将脱敏 `RELEASE_GATE`、`productionAuthorization:false`、`missingEvidence` 输出到 stderr 并退出 1；调度器把同一诊断写入 lane 状态。直接调用可读取异常的 `releaseGate`，不会写假发布回执，也不会消费 outbox。

## 真实审批及权限

PR #21 的以下候选审批格式仍保留为诊断输入，**不会授予发布权限**。即使文件由 root 拥有、每项都是 GREEN、报告哈希完全匹配，仍然阻断。`validateGreenForecastApproval()` 只检查格式；返回 true 不是证据认证，也不是生产许可。

- 目录 `/etc/vantis/publish-approvals/`：由 root 拥有，非 root 不可写。
- 文件 `<真实 reportId>.json`：root 所有、vantis 组可读、其他用户不可读；建议 `0640`。
- `schemaVersion: 1`、`commitSha` 必须匹配生产 `/opt/vantis/current/.source-commit`，`reportId` 匹配原始报告，`reportSha256` 匹配原始 JSON 数据的 SHA-256。
- `BACKTEST_ALL_GREEN_ONLY`、`RELEASE_GATE` 及所有 `checks` 必须是精确字符串 `GREEN`。检查包括商业权益、五联赛足量前瞻回测、无未来泄漏、概率校准、双独立亚洲盘与真实初盘、全套回归、已合并 PR 和精确提交 CI、staging smoke、旧版无回归和回滚就绪。
- `evidence` 保存真实 `backtestSha256`、`stagingSmokeSha256`、`regressionSha256`、同仓库 `mergedPrUrl`、`ciRunUrl` 和不同于本次 SHA 的 `oldProductionSha`。
- 候选格式检查要求同一报告生成后 1 小时内的批准；超过 1 小时、字段缺失、未知或阻断状态均视为格式无效。root 所有权只能证明本机文件权限，不能证明审核者独立、商业权益有效、外部 SHA 对应已合并 PR 或 CI 成功。

报告也必须在过去 1 小时内生成、非模拟、概率模型已校准，并为 PL/PD/SA/BL1/FL1 各包含至少 200 场带 `provenance=prospective-ledger`、`status=verified-prospective` 的独立可评估历史与 Brier、Log loss 指标。现有回顾性快照与 63 场德甲不能冒充未来已知截止时刻数据。此阈值是初始最低验收门槛，不构成胜率或盈利保证；后续应按预先注册的统计设计加严，不能为放行而降门槛。

## 尚缺的外部证据验证

`missingEvidence` 始终包含十项 `RELEASE_CHECKS`，以及 `EXTERNAL_EVIDENCE_AUTHENTICITY_VERIFIER`、`INDEPENDENT_RELEASE_AUTHORITY_VERIFIED`、`PRODUCTION_RELEASE_ENABLEMENT_REVIEW`。读取不到完整报告或受保护候选文件时还会报告 `VALID_BOUND_REPORT_AND_PROTECTED_APPROVAL`。这些代码表示尚未独立验证；JSON 中的绿色声明不会消除它们。

后续另行审查的验证器必须核实不可变回测/回归/staging 证据原件及哈希、冻结截止时刻和样本来源、真实数据授权、同一提交的 PR 合并及 CI 状态、旧生产版本与可执行回滚，且验证独立批准主体和有效期。完整验收以前不得添加 env 开关、options 回调、签名缺省通过或其他放行捷径。

## 测试和权限边界

行为负例使用真实生产模块覆盖直接导入四出口、CLI 四模式、调度注入、伪造 GREEN 环境和 root-owned GREEN 候选；要求零外部请求、零发布/持久化/outbox 副作用。既有交付正向回归仅通过 `collector/test/helpers/` 中的 module hook 给独立测试导入图替换 gate 依赖；生产函数没有门禁注入参数或环境变量。

本修复不创建 GREEN 审批、不配置 ECS 凭据、不修改远程 PR #21、不合并、不部署、不发通知。仓库代码门禁不能阻止具有代码修改、Node preload/module-loader 或直接网络凭据权限的管理员执行任意程序；运行时应只读部署源码、排除测试辅助代码、隔离发布凭据，并用分支保护、独立审查及部署权限落实边界。Hosted 发布、旧消息渠道和服务端机器入口也必须由各自所有者接入同一阻断规则；本文件不把这些外部入口视为已验证。

**生产部署和最终上线通知仍需额外完成：** 登录 ECS 并核验运行版本/HTTPS、重启持久化、真实网站同一 reportId 回读、Telegram 状态、相同数据集的新旧版本关键结果与回滚，并在 PR 合并后重新 CI 全绿。任何一项缺证据均保持 BLOCKED。

## 研究日报发布通道（所有者 2026-11-02 授权）

本文件所述正式商业发布门禁保持 **绝对 BLOCKED** 不变。为满足项目所有者"每日自动采集 → 生成预测 → 简体中文推送 Telegram 和 Web"的交付要求，增设独立于商业门禁的研究日报通道，边界如下：

- **通道**：每日研究轨道产出的 `research-daily-1x2` 日报（普通 1X2 冻结预测 + 真实 FT 核账）经 `publish-research-daily.mjs`（Web）与 `publish-research-telegram.mjs`（Telegram）发布；两个入口内联相同研究授权校验，正式 `requireGreenForecastDelivery` 与商业门禁代码未改动。
- **校验**：日报必须 `mode=research-reference`、`commercialReleaseGate=BLOCKED`、`strictMarkets.releasedCandidates=0`、含固定研究免责声明（"研究参考，非投注建议；概率未经正式校准…"）、reportId 与北京时间窗口有效。任一不满足即拒绝，无放行分支。
- **不变项**：严格盘口候选仍要求双独立来源与真实初盘，恒为 0 场不降门槛；正式 `RELEASE_GATE` 仍为 BLOCKED；研究推送不代表正式发布、回测 GREEN 或商业模型资格。
- **启用开关**：仓库变量 `VANTIS_RESEARCH_WEB_ENABLED` 与 `VANTIS_RESEARCH_TELEGRAM_ENABLED` 由所有者显式设置为 `true`；Telegram 凭据仅存于 Actions Secrets，不进源码、制品与日志。
- **授权记录**：2026-11-02，项目所有者（wangxtong）确认选择"研究用途推送"口径，用于其自有群组与站点；本记录即该决策的书面留档。

