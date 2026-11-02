# 维度足球 · 预测结果 Web / Telegram 同源同步契约

## 已实际实现的阶段：隔离研究双端**预览**（不能对外发送）

- 在已有 Stage1 隔离研究链上增加：`website/research-dual-channel.mjs`、`scripts/export-research-web-tg.mjs`、`website/test/research-dual-channel.test.mjs`。
- 从**同一份**已签来源`reports/predictions.json`、`reports/publication.json`、`reports/prospective-evaluation.json`与`stage1-status.json`构建规范化Snapshot；明确绑定相同`publication.reportId`、模型版本、未校准研究性质和`BLOCKED`门禁。
- 每场预测保留源内fixtureId、UTC开球时间、球队、研究态1X2概率及方向（仅隔离环境），未取得有效盘口则明确缺项；`unavailable`场次同样展示。**研究概率不代表正式推荐、胜率达标或盘口价格**。
- 生成`dual-channel-private-preview/same-report-snapshot.json`、`web-research-preview.html`、`telegram-research-preview.json`和`readback-receipt.json`；两个展示面只能来自同一投影SHA256和同一reportId，单个消息不超过Telegram4096限制，安全转义球队名，不做任意HTML注入。
- Web产物是私有可下载HTML，不是已有正式Web站点的新路由；TG产物是与Bot API `parse_mode=HTML`兼容的**消息草稿**，`sendStatus=NOT_SENT`。两者都不会触发网络请求、不会发外部消息，也**不能绕过**正式预测发布门禁。
- `node scripts/export-research-web-tg.mjs export /abs/path/to/stage1-run` 与 `node scripts/export-research-web-tg.mjs verify /abs/path/to/stage1-run/dual-channel-private-preview` 可在两个进程中运行，对所有文件重新SHA256校验并确认展示内容逐字一致，篡改时必失败。
- 在现有CI `.github/workflows/test.yml`中的`stage1-private-research`真实数据作业末尾生成并回验，产物保存于私有GitHub Actions附件；Stage1已有冻结预测但无真实赛后评分时明确`0`，不能虚构历史命中率。失败阻断本PR同SHA测试验收。
- 这份代码处于独立PR草案分支，基于上游[Scrapling/Stage1 Draft #61](https://github.com/wangxtong/Dimension-Football-/pull/61)。需要先审#61再审本PR；任何生产站点/TG通知、定时上线、ECS访问与版本晋升都没有在这里执行。

## 实际同步上线前的必要下一步

1. A2/A3先在可持久的真正Runner采集**新鲜**赛程、真实合法赔率（1X2、大小球）并归档带原生timestamp的RAW；保持当次`reportId`固定且保存不可变历史。
2. A4在研究模式按当天赛前冻结模型版本/概率，A3在赛后将真实FT结果关联原先冻结记录；构建可验的日/周/月Brier、LogLoss、准确率和缺失分母，并完成独立校准验证。
3. A6在密码保护的测试Web提供受身份认证的只读研究历史路由，关联当次`reportId`与digest。A8核移动端、回滚、过期状态和同报告索引；**不要把隔离研究预测注入现有公共观察API**。
4. 正式发布前A10必须核准各项发布条件，复核相同SHA、来源时间/权限、独立亚洲盘口与真实初盘、持续采集与回滚，再经独立审批主体完成生产解除门禁。只在通过后可在正式发布流水线中将**同一份已放行的快照**投递到Web与目标TG，并分别记录`webReportId/reportHash`读回和Telegram API`accepted/messageId`（接受不代表用户已读）。
5. 若网站成功而TG失败、或相反，必须保留`PARTIAL/UNKNOWN`并按reportId去重；不可使用新预测覆盖原报告或在不确定发送状态下无限重发。

## 用户端测试与已知限制

- 用户已实测TG四条命令及七类按钮，不再要求重复验证菜单；后续只需要A10服务端真实Webhook/推送回执。
- 截至本开发轮，正式发布门禁在`collector/publication-release-gate.mjs`及`website/release-policy.mjs`仍为绝对`BLOCKED`。
- 历史2025–26德甲赛果的Scrapling首次实采/Node导入已通过独立研究CI，但它不是实时赔率或最新赛前概率的保证。
