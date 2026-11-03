# 运行状态快照（ops/runtime）

这个目录存在的唯一理由：**容器重启后，10:10 的自动链路不能从头再来一次。**

链路所需的运行状态原本只活在 `/tmp`（编排脚本、凭证、3MB 采集状态、825 个账本文件）。
`/tmp` 一清，定时器还在、脚本没了，到点只会空跑失败。所以把**不可重建的部分**固化到这里。

## 里面有什么

| 成员 | 作用 | 丢了会怎样 |
| --- | --- | --- |
| `state/state.json` | 采集/结算主状态，含已观测比赛与赛果 | 重复采集、重复结算 |
| `state/state.json.lanes.json` | 车道进度 | 车道回退、重复拉取 |
| `state/state.json.sources.json` | 来源冷却与请求预算 | 违反 Retry-After、被对方封 |
| `reports/forecast-ledger/**` | 825 个预测/赛果/评分记录（sha256 绑定） | **命中率/Brier/LogLoss 累计全部归零** |
| `reports/research-daily/` | 最近一期日报与 Telegram 回执 | 重复推送同一期 |

凭证**不在**这里，也不应进仓库：始终由 `DF_ENV_FILE`（默认 `~/df/.env.local`，600）提供。

## 用法

```bash
scripts/df-runtime-snapshot.sh save      # 运行时 -> 本目录快照
scripts/df-runtime-snapshot.sh verify    # 校验成员齐全（save 后自动执行）
scripts/df-runtime-snapshot.sh restore   # 重启后恢复到 ~/.df-runtime，不覆盖较新文件
```

恢复用 `cp -n`（不覆盖运行时里更新的文件），所以重复执行安全。

## 每天要做的事

链路成功后重新 `save` 并提交，让快照跟着账本一起往前推。这是**唯一**需要人工兜底的环节；
只要定时器在、快照在、凭证在，10:10 不需要任何人介入。
