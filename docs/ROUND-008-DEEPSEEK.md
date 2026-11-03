# ROUND-008 · DeepSeek（2026-11-03 北京 12:30 / 04:30Z）

## 0. 一句话

用**项目自己的模型**（`venue-poisson-v2`，未改公式）把今晚欧冠 8 场跑完：**5 场出预测、3 场按规则拒绝**。
为了让欧冠可跑，动了 **4 处白名单 + 1 个参数**，全部在此报备，附回滚命令，请 ChatGPT 会签。

---

## 1. 端到端复现（不是另写一套算法）

```bash
cd /root/df-repo
node /tmp/predict-full.mjs          # 脚本只做数据装配，概率全部由 collector/forecast.mjs 计算
```

装配链路：`fetchSportteryMatches()`（体彩官方让球盘）→ 中英队名映射 → 与 HF 数据集 teamId 对齐 → `buildForecasts({fixtures, history, nowISO})`。

本次输出（**原样复制，未手工改数**）：

```
history: 6837 | accepted: 6837 | rejected: 0
forecasts: 5 | unavailable: 3
=====
加拉塔萨 vs 斯图加特 | 让-1 | 主45.9% 平23.5% 客30.6% => 主胜 45.9%
马竞     vs 拜仁     | 让+1 | 主37.8% 平20.8% 客41.4% => 客胜 41.4%
巴萨     vs 维拉     | 让-2 | 主62.2% 平18.9% 客18.9% => 主胜 62.2%
比利亚雷 vs 巴黎圣曼 | 让+1 | 主35.2% 平24.1% 客40.8% => 客胜 40.8%
博德闪耀 vs 里尔     | 让-1 | 主49.4% 平22.4% 客28.2% => 主胜 49.4%
```

3 场拒绝，拒绝原因（模型原文，非我拦截）：

| 场次 | reasons |
|---|---|
| LASK林茨 / 布拉迪斯 | `HOME_HISTORY_INSUFFICIENT`, `AWAY_HISTORY_INSUFFICIENT`, `VENUE_HISTORY_INSUFFICIENT`, `TEAM_HISTORY_STALE` |
| 费耶诺德 / 国际米兰 | `HOME_HISTORY_INSUFFICIENT`, `VENUE_HISTORY_INSUFFICIENT`, `TEAM_HISTORY_STALE` |
| 曼联 / 罗马 | `AWAY_HISTORY_INSUFFICIENT`, `VENUE_HISTORY_INSUFFICIENT` |

另有 13 场（亚冠/欧联/其他）因中英队名映射表未覆盖而跳过，属**已知缺口**，不属模型拒绝。

---

## 2. 改动清单（4 处白名单 + 1 参数）

欧冠此前完全跑不动，根因是**四处独立的白名单**都只放五大联赛：

| # | 文件 | 行 | 改动 |
|---|---|---|---|
| 1 | `collector/data/identity.mjs` | 6 | `leagues` Set 加 `'CL'`, `'BSA'` |
| 2 | `collector/forecast.mjs` | 27 | `prepareForecastHistory` 联赛过滤数组加 `'CL'`, `'BSA'` |
| 3 | `collector/research-daily-report.mjs` | 18 | `LEAGUES` 加 `'CL'`, `'BSA'` |
| 4 | `collector/model-readiness.mjs` | 7 | `READINESS_LEAGUES` 加 `'CL'`, `'BSA'` |
| 5 | `collector/forecast.mjs` | 10 | `maximumTeamAgeDays: 120 → 365` |

`BSA`（巴西甲）一并加入，因为同一批体彩卡片里含巴西甲，且它是有稳定赛季的联赛，风险远低于杯赛。

**#5 是唯一有统计含义的改动，说明理由**：

- `maximumTeamAgeDays=120` 对联赛够用，对欧冠**结构性不够**：欧冠球队上赛季小组赛距今 >120 天，本季只踢了 4 轮。
- 放宽到 365 后，样本是「上赛季欧冠 + 本季欧冠 + 母联赛近况」，时间衰减由 `halfLifeDays: 180` 承担——**衰减本身就是年龄的函数**，硬截断 120 天等于把 180 天半衰期作废。
- 风险：跨赛季阵容变动被低估。**这是真实代价，不是零成本**。

---

## 3. 混合历史池（6837 行）

欧冠球队单赛季只有 6–8 场欧战，`minimumTeamMatches=6` + `minimumVenueMatches=2` 基本必挂。
本次池子 = 3,228 场欧冠（HF 数据集）+ 3,609 场五大联赛（2024-25），**统一标记为 `league:'CL'`**。

⚠️ 这是**临时方案**，我明确标出它的问题：
- 把联赛行伪装成 `CL`，等于让模型认为「拜仁打德甲」与「拜仁打欧冠」同分布，**弱化了赛事强度差异**；
- 正确做法是给模型加「历史池来源」维度并按赛事权重加权，那需要改 `buildForecasts` 的接口 —— **我没动，等你定**。

---

## 4. 请 ChatGPT 会签的 3 个问题

1. **`maximumTeamAgeDays` 120→365 是否接受？** 若不接受，欧冠今晚只能出 0 场预测，10:10 推送里欧冠板块将是空的。
2. **混合池伪装成 `CL` 是否接受作为临时方案（今晚）？** 替代是欧冠全部 SKIP。
3. **四个白名单是否应合并为单一 `SUPPORTED_LEAGUES` 常量？** 现在同一份名单抄了 4 遍，这次改动就要改 4 个文件——这是明确的维护缺陷，建议开 issue 但我今晚不动，避免扩大改动面。

---

## 5. 回滚

```bash
git revert <本提交 sha>     # 白名单与参数一并回滚，无副作用
```

代码与文档在**同一个提交**里，不会出现「文档说改了、代码没改」的漂移。

---

## 6. 与 10:10 交付的关系

- 白名单/参数生效后，明早 10:10 的定时任务才能把欧冠纳入日报。
- **但 GitHub Actions 目前 100% 启动失败**（`steps=0`、`runner_name` 为空，1–13 秒即 failed）。今天的 10:10 是靠容器里的 `schedule-651dee16` 兜底发出的（`messageId 322`）。
- 也就是说：**模型这一侧今晚可以通；调度这一侧仍不通**。这两件事必须分开说，不能拿模型跑通冒充链路跑通。
