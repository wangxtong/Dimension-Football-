# 赛前冻结预测核账进度 — 2026-11-02

A4 模型评估负责。代码基线为 PR #55 的生产源码树（远端 `b6dd5153ef341ad69019ce0b91324d4d8279f3ae`）；以下是隔离本地实测，不是生产部署验收。

## 修复前后

| 环节 | 修复前 | 修复后 |
| --- | --- | --- |
| 核账文案 | 所有 prospective-ledger 评分都称为“已发布预测前瞻”，私有研究也如此 | 统一为“赛前冻结预测核账”；私有研究明确不是已发布成绩，其余必须另验发布回执 |
| 进度诊断 | 固定窗口评估为 0 时，无法直接区分未开赛、缺结果及窗口以外已有赛果 | 新只读 CLI 按同源赛事、精确模型配置列出未来、待结果、可核账、延期、作废及冲突；固定窗口数量独立列出 |
| 昨日 e541 报告 | 原封存账本 8 场预测，没有结果记录 | 隔离副本用新真实历史输入核账 2 场，剩余 6 场未开赛；8 个原始预测文件摘要全部保持一致；重复重放不重复写入 |

没有修改概率、选赛规则、门禁或采集发布入口。只读诊断从保留预测和赛果重新计算状态，不证明评分文件已持久化或消息已送达。

## 真实输入核验

- 原预测 reportId：`e541ec0487829321212c9c95d84a4790888baa7c0f0f284a6e72745e728902c6`。
- 真实赛果取自 [run 41362841369](https://github.com/wangxtong/Dimension-Football-/actions/runs/41362841369) 的 `run-inputs.json`，artifact `13106175978`。
- 下载 ZIP 的 SHA-256：`21d77412cc120a93ff9e3a7bfb23576b5213f09b1784a29c37b6053195c3ab4a`。
- 本地核账实际写入时间：`2026-11-02T01:04:50.336Z`。没有回填旧 observedAt 为 recordedAt。
- 来源、赛事 ID、联赛、赛季、主客队 ID、开赛 UTC 逐项相符；来源记录均为 `FINISHED / full-time`。

| 比赛 | 同源 ID | 真实终场 | 原始冻结提前量 | 独立复算 Brier | 独立复算 Log loss |
| --- | --- | --- | ---: | ---: | ---: |
| 联合柏林 — 科隆 | oldb-83223 | 1–1 | 6.9704 小时 | 0.900486 | 1.438239 |
| 法兰克福 — 汉堡 | oldb-83221 | 3–1 | 8.9704 小时 | 0.372120 | 0.688542 |

最新公开制品自带的账本有 13 个赛事目录、9 条本轮预测、0 条赛果，未包含 e541 冻结记录。这只说明该制品没有跨轮结算证据，不代表另存的生产持久状态一定缺失；生产状态仍须单独回读验证。

两场都不在原定 1/24/72/168 小时（各 +1 小时容差）窗口，四组标准前瞻评估仍为 0。单场误差仅证明算分一致，不能证明模型达到准确率、校准或商业验收要求。

## 使用与检查

```sh
node collector/settlement-readiness.mjs --ledger /path/to/forecast-ledger
node --test --test-isolation=none collector/test/settlement-readiness.test.mjs collector/test/forecast-report-provenance.test.mjs collector/test/forecast-report-size.test.mjs collector/test/prediction-ledger.test.mjs collector/test/private-research.test.mjs collector/test/model-readiness.test.mjs
```

新增诊断始终返回 `releaseGate: BLOCKED`、`canRelease: false` 和 `publicationVerified: false`。CLI 退出 0 仅表示只读检查完成，不能作为发布准入；完整性或参数失败返回 1，并隐藏原始错误路径。既有 `model-readiness.mjs` 的门禁退出约定保持不变。

相关回归覆盖结果修订、延期、取消、改期、同刻冲突、评分中断重放、录入时间可见性、模型配置隔离、重复冻结去重、固定窗口不扩张及私有结果无发布路径。

实测详细证据保存在执行工作区 `/workspace/dimension-nov2-model-evidence/settlement-verification.json`，复算脚本为同目录 `verify-settlement.mjs`；这两份本地证据不会由本次代码改动自动发布。

## 下一阶段

1. A1/A7 核验生产持久状态中是否保留上述冻结记录；按真实当前时间补录已有赛果，取得重启恢复后的同一核账证据。
2. 保持结果任务优先，安排固定提前量的赛前冻结，积累可重复且时间可见的前瞻样本。不得将本轮窗口外记录改名为固定窗口样本。
3. A1 评估结果任务对无冻结赛事写入全部历史赛果造成的状态容量增长；本次没有修改该共享入口。
4. 五联赛历史来源、校准、冻结基准对照与独立验证继续补齐。`RELEASE_GATE=BLOCKED` 保持不变。
