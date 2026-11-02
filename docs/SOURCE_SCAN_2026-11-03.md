# 信息源深层扫描（2026-11-03）

对五大联赛相关的公开站点/接口做了一轮请求级扫描，重点是「有没有暴露接口」与「能不能合法复用」。结论按**授权**分档，技术可达不等于可用。

## 一、可直接复用（已接入或已验证）

| 源 | 接口 | 授权 | 限流 | 能提供 |
| --- | --- | --- | --- | --- |
| football-data.org | `/v4/competitions/{code}/matches` | 官方 API，免费档 | 10 请求/分钟 | 赛程、历史 FT、积分榜 |
| OpenLigaDB | `/getmatchdata/bl1/2026` | ODbL-1.0 | 无明确限制 | 德甲赛程与历史 |
| TheSportsDB | `/api/v1/json/123/eventsnextleague.php` | 官方文档公开共享 key | 免费档每联赛最多 1 场 | 赛程样本 |
| Open-Meteo | `/v1/forecast` | 免费非商业，CC-BY-4.0 数据源 | 10,000 次/日 | 逐小时天气（预报） |
| HKJC | GraphQL HDC | 公开页面接口 | 30s 缓存 | 香港赛马会盘口 |
| Macau SLOT | `/soccer/json/realtime/threeinone_odds_cn_fb.json` | 公开 JSON | — | 澳门盘口（**准入问题见下**） |

## 二、本轮新发现：openfootball（可作为历史样本补充）

GitHub 上的开放足球数据仓库，**无 Cloudflare、无 key、无 robots 限制**：

```
https://raw.githubusercontent.com/openfootball/football.json/master/{season}/{league}.json
leagues: en.1 de.1 es.1 it.1 fr.1
seasons: 2023-24 / 2024-25 / 2025-26 / 2026-27   全部 5/5 可用
```

结构：`{name, matches:[{date,time,round,team1,team2,score:{ft:[h,a],ht:[h,a]}}]}`，每联赛 380 场。

**价值**：4 赛季 × 5 联赛 ≈ 7600 场历史，可扩充模型训练样本。
**阻塞**：它只有队名、没有稳定 teamId，而 `prepareForecastHistory` 强制要求 `homeTeamId/awayTeamId`；要用必须先建「队名 → canonical id」映射层（可复用 `team-names.mjs` 的别名表扩展）。

## 三、技术可达但不许用（授权禁止）

| 源 | 状态 | 依据 |
| --- | --- | --- |
| **ESPN** | `site.api.espn.com` 返回 200，summary 含 `odds`/`pickcenter`/`rosters`/`boxscore`/`standings` | **robots.txt `Disallow: /`**，且显式禁止 GPTBot / ChatGPT-User / CCBot。数据再全也不能采集 |
| FotMob | 可达 | robots `Disallow: /api/*` |
| titan007 | 可达 | robots `Disallow: /vbsxml/` |
| Transfermarkt | 可达 | 无自动化授权 |

ESPN 是最可惜的一条：`summary?event=<id>` 返回 186KB，`rosters`（阵容）+ `odds`（DraftKings 让球/大小球）+ `boxscore` 全都有，正好补我们缺的两块。**但 robots 明确禁止，不能用。**

## 四、Cloudflare / 反爬拦截（无法稳定采集）

| 源 | 表现 |
| --- | --- |
| SofaScore | 403 |
| FBref | Cloudflare challenge（`Just a moment...`） |
| Understat | 连接失败 |
| ClubElo | 502 / 301 重定向 |
| football-data.co.uk | 302 重定向 |

这些都试过换 UA/走 https，均被拦。不做绕过。

## 五、商业源（需合同）

Sportmonks、API-Football（免费档赛季锁 2022-2024）、The Odds API（免费档不含足球）、iSports、OddsPapi（B2B 需商务开通）、Opta、Sportradar、TXODDS。

## 六、结论

1. **能免费合法复用的就那 6 个**，今晚已全部接入或验证。
2. **ESPN 有全套数据但 robots 禁止** —— 这是「接口能访问 ≠ 有授权」的典型，不要因为技术可行就去接。
3. **openfootball 是唯一新增可用源**，瓶颈在 teamId 映射，不在数据本身。
4. 阵容/伤停/真初盘/欧赔轨迹这四类，公开可复用源里**确实没有**，只能付费或放弃。
5. 下一轮值得做的：① openfootball + teamId 映射扩充历史样本；② 修 Macau 准入（`collectIndex.mjs` 硬编码 `includeMacauslot: true`）。