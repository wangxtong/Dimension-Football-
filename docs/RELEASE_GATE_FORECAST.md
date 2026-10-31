# 维度足球对外发布门禁（P0，待合并/待实机验收）

本 PR 为 **未完成前瞻回测时拒绝对外发布** 的代码门禁，不是 GREEN 回测或生产部署凭证。当前主项目仅德甲存在有限回顾性评估，其他四大联赛不足，模型尚未完成概率校准；截至本 PR 不能生成生产批准文件。

## 生效入口

- ECS `collector/orchestrate.mjs` 正式分层调度使用的默认发布函数执行前，必须通过 `collector/publication-release-gate.mjs`。
- 手动 CLI `node collector/publish.mjs website|website-receipt|telegram|all <报告目录>` 同样先进行门禁校验。
- Actions `public-sources.yml` 是内部归档/灾备，可继续保存 Summary 与 artifacts，不是网站或 Telegram 发布。现有消息桥独立服务不属于此模型发布门禁，不影响人工网站↔Telegram 消息。

没有真实完整批准时门禁错误固定为 `RELEASE_GATE_BLOCKED`。失败不得重试发送，不得创建假回执，不得声称新模型正式上线。

## 真实审批及权限

只有服务器管理员在验明真实商业数据授权、冻结赛前历史、同一 SHA 的模型/回归/CI 和 staging 后，才能通过专用安全流程在 ECS 上创建审批：

- 目录 `/etc/vantis/publish-approvals/`：由 root 拥有，非 root 不可写。
- 文件 `<真实 reportId>.json`：root 所有、vantis 组可读、其他用户不可读；建议 `0640`。
- `schemaVersion: 1`、`commitSha` 必须匹配生产 `/opt/vantis/current/.source-commit`，`reportId` 匹配原始报告，`reportSha256` 匹配原始 JSON 数据的 SHA-256。
- `BACKTEST_ALL_GREEN_ONLY`、`RELEASE_GATE` 及所有 `checks` 必须是精确字符串 `GREEN`。检查包括商业权益、五联赛足量前瞻回测、无未来泄漏、概率校准、双独立亚洲盘与真实初盘、全套回归、已合并 PR 和精确提交 CI、staging smoke、旧版无回归和回滚就绪。
- `evidence` 保存真实 `backtestSha256`、`stagingSmokeSha256`、`regressionSha256`、同仓库 `mergedPrUrl`、`ciRunUrl` 和不同于本次 SHA 的 `oldProductionSha`。
- 以上文件必须在同一报告生成后的 1 小时内由独立授权人员审核。超过 1 小时、字段缺失、未知或阻断状态均拒绝；文件的合法结构 **不代表** 其外部证据真实，审核员还须核对证据本身。

报告也必须在过去 1 小时内生成、非模拟、概率模型已校准，并为 PL/PD/SA/BL1/FL1 各包含至少 200 场带 `provenance=prospective-ledger`、`status=verified-prospective` 的独立可评估历史与 Brier、Log loss 指标。现有回顾性快照与 63 场德甲不能冒充未来已知截止时刻数据。此阈值是初始最低验收门槛，不构成胜率或盈利保证；后续应按预先注册的统计设计加严，不能为放行而降门槛。

## 当前残余风险

本 PR 不创建任何 GREEN 审批，也不配置 ECS 凭据或操纵现网。生产运行时将由 root 保护的审批文件向独立非 root 服务只读提供。其它自定义程序直接调用 `collector/delivery.mjs` 的低层接口、遗留消息渠道仍需另行纳入生产权限隔离；由于 main 分支目前未启用保护，新提交安全审查及部署权限也尚未构成完整强制保证。

**生产部署和最终上线通知仍需额外完成：** 登录 ECS 并核验运行版本/HTTPS、重启持久化、真实网站同一 reportId 回读、Telegram 状态、相同数据集的新旧版本关键结果与回滚，并在 PR 合并后重新 CI 全绿。任何一项缺证据均保持 BLOCKED。
