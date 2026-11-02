# 每日研究日报：自动推送链路与已知边界

记录 2026-11-02 夜间打通后的真实链路，供后续排查。所有结论都来自实际运行日志，不是设计意图。

## 链路

```
GitHub Actions schedule '10 2 * * *' (UTC) = 北京 10:10
  └─ HOSTED_MODE 判定: github.event.schedule == '10 2 * * *' → research
     ├─ ① hosted.mjs --mode research
     │    ├─ results lane（每小时一次）: 取已完赛结果 → 写 ledger results/scores
     │    └─ fixtures lane（15 分钟一次）: 抓赛程 + 补同源历史
     ├─ ② research-daily-report.mjs  → reports/research-daily/latest.{json,md}
     ├─ ③ publish-research-daily.mjs → Web（需新版 Worker）
     └─ ④ publish-research-telegram.mjs → Telegram（富文本表格）
```

## 关键配置

| 项 | 值 | 说明 |
| --- | --- | --- |
| cron | `10 2 * * *` | UTC，对应北京 10:10 |
| `HOSTED_MODE` | 由 `github.event.schedule` 判定 | `*/5` → observations，`10 2 * * *` → research |
| `VANTIS_RESEARCH_TELEGRAM_ENABLED` | `true`（repo variable） | 总开关 |
| `VANTIS_RESEARCH_WEB_ENABLED` | `true`（repo variable） | 总开关 |
| `TELEGRAM_CHAT_ID` | **repo variable**，优先于 Secrets | 群 ID 不是凭据；Secrets 里的旧值曾导致 `chat not found` |
| `TELEGRAM_BOT_TOKEN` | Secrets | 真正的凭据 |
| `FOOTBALL_DATA_API_TOKEN` | Secrets | 赛程 + 历史 + 同源结果 |

## 2026-11-02 实测记录

| 检查项 | 结果 |
| --- | --- |
| research 模式跑通 | ✅ `frozen` 记录写入 ledger |
| Web 同步 | ❌ `HOSTED_HTTP_405`（线上 Worker 旧版，`POST /internal/research-daily` 返回中文「不支持此请求方式。」） |
| Telegram 送达 | ✅ `status:accepted, channel:rich`（messageId 258） |
| 失败可见性 | ✅ `failed` 时 CLI exit 1 + 打印 Telegram `description` |

### 曾经的静默故障（已修）

`publisher` 早期在 Telegram 返回 400 时仍然 `exit 0`，CI 全绿但每天零消息；且丢弃了 `description`，无法定位。现在：

- 4xx 也解析 JSON body，`description` 写进 receipt（不含凭据）；
- `status` 非 `accepted`/`skipped` 时 exit 1；
- 实测踩到过 `Bad Request: chat not found` → 根因是 Secrets 的 chat_id 与真实群不一致。

## 结算口径

- 每场只计一次：同 `source:fixtureId` 取最早 `recordedAt` 的冻结记录。
- 结果必须与预测同源：`scorePredictionRecord` 要求 `source` 与 `fixtureId` 都一致。
  **这是 2026-11-02 的致命断点**：冻结预测全是 `football-data.org`，而 `fetchPublicResults` 只产 `openligadb`，
  导致永不结算；已由 results lane 补同源结果修复。
- `resultObservedAt` 必须晚于 `kickoff`（`INVALID_RESULT_VERSION`）。
- 模拟数据不写入：`appendReportPredictions` 对 `simulated` 直接返回 0。
- 样本 < 30 场只作描述性统计（`sampleStatus: insufficient-prospective-sample`）。

## 已知边界

1. **线上 Worker 是旧版本**：`/internal/research-daily` 与 `/api/research-daily` 未部署，Web 看板与 bot 按钮读不到研究数据。仓库无 wrangler/部署 CI，只能 `npm run site:build` 后在 Sites 平台发布（project `appgprj_6ae57c8f64c881918f199924bd702cc1`）。
2. **GitHub schedule 不可靠**：官方文档明确 schedule 可延迟、高峰可丢弃。该 workflow 在 2026-10-31~11-02 期间只运行约 10 次（`*/5` 期望 288 次/天）。10:10 那轮被丢弃时不会自动补跑。
3. **国际比赛日空档**：2026-11-04 ~ 11-06 五大联赛无赛程，日报窗口内会是 0 场；这是正常结果，不是故障（`state: zero-qualified-forecasts` 仍会生成报告并推送）。
4. **Web 失败不阻断推送**：Telegram 步骤用 `always()`，只要日报生成成功就会推送。

## 排查手册

| 现象 | 先看 | 常见原因 |
| --- | --- | --- |
| 群里没消息，CI 绿 | receipt 的 `status` | 旧版静默失败（已修，现在会红灯） |
| `TELEGRAM_API_REJECTED 400` | `description` | `chat not found` = chat_id 错；`Unauthorized` = token 错 |
| `RESEARCH_DELIVERY_FAILED` | 是否 `HOSTED_HTTP_405` | 线上 Worker 旧版 |
| 日报 `frozen: 0` 但赛程很多 | `state` 与 `skipped` | 36h 窗口外，或历史样本不足 |
| 命中率一直是 0 | `awaitingResultsBySource` | 结果源与冻结源不同 |