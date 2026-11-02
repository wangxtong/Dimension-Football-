# 零预算数据源实测备忘（2026-11-02）

本文件记录一次**真实请求级**的零预算数据源核查，用于避免重复试错。与 [PUBLIC_SOURCES.md](PUBLIC_SOURCES.md)、[COMMERCIAL_SOURCES.md](COMMERCIAL_SOURCES.md)、[SOURCE_MANAGEMENT.md](SOURCE_MANAGEMENT.md) 并列：那三份写"接入形态与边界"，本文件只写"实测发生了什么"。

口径：所有结论都来自 2026-11-02 北京时间的真实 HTTP 请求，未启用任何商业凭据、未绕过登录或订阅、未遍历接口。接口未接通不等于接口不存在；接口存在也不等于本项目可用。

## 结论速览

| 数据能力 | 零预算可否取得 | 依据 |
| --- | --- | --- |
| 赛程、积分（五大联赛） | 可以 | football-data.org 免费档（已使用） |
| 德甲赛程（社区） | 可以 | OpenLigaDB（已使用） |
| 赛程样本（共享免费 Key） | 可以，覆盖有限 | TheSportsDB `123`（已使用） |
| **开球时段天气** | **可以** | **Open-Meteo forecast（本轮已接入，见 PR #73）** |
| 天气历史复盘 | 本环境不可用 | Open-Meteo archive 连续 5 次 429 |
| **伤停、首发、替补、阵型** | **不可（当期赛季）** | API-Football 免费档赛季锁定 2022–2024 |
| 欧洲赔率全轨迹（opening→closing） | 不可 | 免费档均无；OddsPapi 为 B2B 不可自助 |
| 亚洲盘真实初盘与双源独立验真 | 不可 | 需供应商原生初盘时间戳，免费源均不提供 |

## 逐源实测记录

### 1. API-Football（`v3.football.api-sports.io`）

免费账号实测三次请求，配额头正常但数据为空：

```text
GET /status
→ {"errors":{"access":"Your account is suspended, check on https://dashboard.api-football.com."}}
   响应头：x-ratelimit-limit: 10 · x-ratelimit-requests-limit: 100 · requests-remaining: 99

GET /fixtures?league=39&season=2026
GET /injuries?league=39&season=2026
→ {"errors":{"plan":"Free plans do not have access to this season, try from 2022 to 2024."},"results":0}
```

- 免费档真实限制是 **赛季锁定在 2022–2024**，不是"次数够就能拿当期"。100 次/日、10 次/分钟只是频率上限。
- 该账号同时处于 `suspended`，需账号所有者本人到控制台处理；本项目不能代为解除。
- 影响：**当期伤停、首发、替补、阵型这四类数据在免费档无法取得**，即使某第三方文档称"全端点可用"。要当期数据只能升级付费档，与"不接收费 Key"的约束冲突，因此不接入。
- 重测触发：免费档开放当期赛季，或所有者升级为付费档后重新实测 `/fixtures?league=39&season=<当季>` 是否返回非空。

### 2. OddsPapi（`oddspapi.io`）

服务真实存在，但**不是可自助注册的免费源**：

```text
oddspapi.io        → 301
api.oddspapi.io    → 405（端点存在）
docs.oddspapi.io   → 200
oddspapi.com       → 200
```

官方文档原文：

> OddsPapi is a business-to-business data service for licensed operators, trading firms, and enterprise platforms. **Contact contact@55-tech.com for API access.**

首页确实出现 `Free Tier`、`250 requests`、`Pinnacle` 等字样，但访问路径是商务洽谈，不是自助注册。对个人零预算项目不可用，**不把它计入方案**。重测触发：官方开放自助注册的免费档，且明确覆盖足球与当期赛季。

### 3. Open-Meteo（`api.open-meteo.com`）

这是本轮唯一真正可用的新增源，已接入代码：

```text
GET /v1/forecast?latitude=51.5085&longitude=-0.1257&hourly=temperature_2m,precipitation_probability,wind_speed_10m
→ 200，逐小时序列，无需 Key、无需注册

GET geocoding-api.open-meteo.com/v1/search?name=<城市>&countryCode=<国家>
→ 200，本轮解析 168 支五大联赛球队城市坐标，0 失败
```

- 实现：`collector/sources/weather.mjs`、`collector/sources/venue-coordinates.mjs`；研究日报新增「天气(开球时段)」列。
- 边界：只取开球整点那一格，不插值、不借用相邻小时；同日同城只请求一次；单日报预算上限 40 次；任何失败降级为 `unavailable`，绝不阻断日报；天气**不参与**任何概率、预期进球、大小球或比分计算，也不写入冻结账本。
- 许可：数据源自各国气象机构（CC-BY-4.0），仅作研究展示。

**历史归档不可用**（这条与"带历史回测"的常见说法相反）：

```text
GET archive-api.open-meteo.com/v1/archive?...&start_date=2026-10-25&end_date=2026-10-25
→ 连续 5 次（间隔 6 秒）均为 429
  {"reason":"Too many concurrent requests","error":true}

GET historical-forecast-api.open-meteo.com/v1/forecast?...
→ 429，同上
```

结论：预报可用，**赛后 archive 复盘在当前网络环境下不可用**，不承诺历史回测能力。若将来 429 消失可重新评估。

### 4. The Odds API（`the-odds-api.com`）

- 免费档公开的覆盖列表不含足球；本轮不把它计入零预算方案。
- 本仓库已有付费适配（`THE_ODDS_API_KEY`，见 [COMMERCIAL_SOURCES.md](COMMERCIAL_SOURCES.md)），不因免费档缺失而改动既有实现。
- 影响：免费路径拿不到欧洲赔率轨迹，因此 `strictMarkets.releasedCandidates` 维持 0 场，商业 `RELEASE_GATE` 维持 `BLOCKED`。

## 复现方式

不把密钥写进命令或日志，用头部文件传递：

```bash
# API-Football（密钥只存在本地 600 权限的头部文件里）
printf 'x-apisports-key: <KEY>\n' > /tmp/afh && chmod 600 /tmp/afh
curl -s -H @/tmp/afh "https://v3.football.api-sports.io/status"

# Open-Meteo（无需任何凭据）
curl -s "https://api.open-meteo.com/v1/forecast?latitude=51.5085&longitude=-0.1257&hourly=temperature_2m&timezone=UTC"
```

## 复测触发条件

1. API-Football 免费档赛季限制变化，或所有者升级付费档；
2. Open-Meteo archive 不再返回 429；
3. OddsPapi 开放自助注册且覆盖当期足球；
4. 出现新的免费亚洲盘源，且能提供供应商原生初盘时间戳——只有满足这一条才可能改变 `releasedCandidates` 恒为 0 的结论。

## 不变式

本文件只记录实测，不改变任何生产判定：研究日报仍是"研究参考，非投注建议"；商业正式发布 `RELEASE_GATE` 仍为 `BLOCKED`；严格盘口对外候选仍为 0 场；不因为某个源"看起来免费"就降低双源独立验真与真实初盘的要求。
