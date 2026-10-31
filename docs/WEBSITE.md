# 网站数据契约与离线验收

网站保留现有 Sites 登录入口。页面每 5 分钟检查报告，每 30 秒重新计算预测和严格候选是否过期。轮询频率不代表上游完成采集的频率；页面显示报告的原始生成时间和有效期。

## 数据契约

首选 `GET /api/report`，响应为：

```json
{
  "version": 1,
  "reportId": "64 位小写十六进制报告 ID",
  "report": {},
  "receipt": null,
  "freshness": { "mode": "ecs" },
  "health": { "status": "available" }
}
```

`report` 必须是版本 1 的 `prematch-forecast-report`，且 `simulated` 为 `false`。顶层 `reportId` 必须等于 `report.publication.reportId`。非空回执必须与报告的 ID、生成时间一致，并包含有效交付渠道状态。

`website/report-schema.mjs` 由页面、Worker 和报告服务共享：

- `validateReport(report)` 成功返回原对象，失败抛出 `REPORT_SCHEMA_INVALID`。
- `validateReceipt(receipt, report)` 成功返回原对象，失败抛出 `RECEIPT_SCHEMA_INVALID`。
- `validateBundle(bundle)` 成功返回原对象，结构错误抛出 `SNAPSHOT_SCHEMA_INVALID`，报告或回执错误保留上述错误码。
- `validDate(value)` 返回布尔值；要求明确时区的 ISO 日期，并拒绝不存在的日期、24 点等归一化陷阱。

校验覆盖页面使用的嵌套数据、概率范围与总和、数值计数、日期、唯一赛事 ID、盘口报价与真实初盘的身份关联。未知附加字段被保留，允许生产者增加 horizon/assessment 等扩展。UI 不把未知字段解释成新的结论；模型与市场资格仍由生产者计算。

只有 `/api/report` 返回 404 或 405 时，页面才兼容读取 v1 的 `predictions.json` 和 `publication.json`。v1 回执不匹配、不可用或无效时仅显示回执待同步，并重置采集任务链接。401 要求重新登录；502、坏 JSON 或坏 bundle 不触发静默回退。

成功提交前完成全部校验；失败保留上一份正常报告，并继续更新其过期状态。并发刷新共享一个请求，旧生成时间和超过本地时间 5 分钟的报告不会覆盖当前快照。报告接收时刻不会改写预测有效期。

`freshness.mode=bootstrap` 显示启动快照提示。`health.status=upstream_unavailable` 显示上游不可用提示；这些提示可与预测过期提示同时出现。启动快照可用于恢复读取，但不表示已恢复实时采集。

## 交互与可访问性

卡片按赛事 ID 和内容复用，定时检查不移除未变化的节点。展开状态跨视图保留；内容更新后恢复依据摘要的焦点，赛事退出当前分类时把焦点移至结果面板。分类页签支持左右方向键、Home、End，以及 `aria-selected`、单一 Tab 停靠点和面板关联。

## 运行验收

Node 测试无需浏览器依赖：

```sh
node --test --test-isolation=none website/test/ui.test.mjs website/test/auth.test.mjs website/test/feed.test.mjs
```

浏览器验收复用 `collector/browser-runtime/package-lock.json` 锁定的 Playwright。依赖与 Chromium 安装属于现有 browser CI job，不新增服务或 npm 包。安装完成后运行：

```sh
node --test --test-isolation=none website/test/e2e.mjs
```

如使用已有依赖目录，可设置 `PLAYWRIGHT_MODULE` 为 Playwright 包目录或 `index.mjs` 路径；已有浏览器目录使用 Playwright 标准 `PLAYWRIGHT_BROWSERS_PATH`。不要在这些变量中放认证资料。

测试调用真实 `website/build.mjs`，读取其嵌入资产与 Worker 导出，启动仅绑定 `127.0.0.1` 的临时 HTTPS 服务。OpenSSL 生成一次性测试证书；只有这个测试浏览器上下文允许该自签证书。测试使用合成账号和合成 ECS/探针令牌，拦截所有非本机浏览器请求，ECS 请求通过 `fetchImpl` 返回固定假数据。临时构建、证书和浏览器上下文在结束时清理。

七项浏览器验收覆盖：

1. 登录 Secure/HttpOnly/SameSite Cookie、三类视图、键盘操作、展开与焦点、会话过期和退出。
2. 上游 404 转 502、坏 JSON、坏嵌套 schema、旧报告及恢复。
3. v1 跨报告回执、回执缺失和任务链接重置。
4. bundle 一致性、启动快照提示、自动过期和未认证跳转。
5. 手动刷新跨过定时器时只发出一次请求。
6. 真实 Worker 的 ECS Bearer 注入、机器探针与浏览器会话隔离；探针不返回预测正文。
7. 上游失败时读取压缩启动快照，保留报告原时间和预测有效期。

v1 兼容与畸形 bundle 场景在真实 Worker 认证后注入 HTTP 响应，以测试客户端边界。正常 ECS、上游失败、压缩启动快照与机器探针走构建产物的真实 Worker/feed 代码。这里的通过只证明本地集成，不证明生产部署、真实 ECS 可达性或持续更新。

## 保留的认证限制

登录失败计数仍是 Worker 单实例内存 Map，实例重启和其他实例不共享计数。它不能被描述为全站限速。共享限速能力需由入口平台集成并进行跨实例验收；本次前端修复和浏览器验收没有新增存储服务，也没有改变认证配置。
