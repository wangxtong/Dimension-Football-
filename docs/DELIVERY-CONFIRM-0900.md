# [DELIVERY] 09:00 前交付确认包（DSH 侧）

签发时间：2026-11-03 02:50（北京）  ·  目标时间：09:00 双方确认，10:00 TG+Web 可见

## 一、Telegram：已 100% 就绪（无需任何人再操作）

| 检查项 | 实测 |
| --- | --- |
| cron | `10 2 * * *`（UTC）= 北京 10:10 |
| 模式判定 | `github.event.schedule == '10 2 * * *' → research` |
| 日报生成 | `if: always()`（hosted partial 也会生成） |
| Telegram 步骤 | `if: always() && VANTIS_RESEARCH_TELEGRAM_ENABLED == 'true'` |
| 群 ID | 仓库变量 `TELEGRAM_CHAT_ID = -1004312560482`（已验证可送达） |
| 幂等 | `bjday`+`tgmark` 步骤已加 `always()`；run 41488935067 实测 `skipped / ALREADY_SENT_TODAY` |
| 送达证据 | messageId 258–268，`channel: rich` |

**10:10 会推送的内容**（11-04~06 为国际比赛日，无新赛程）：
```
📅 2026-11-03｜冻结 0 场｜严格盘口 0 场｜已结算 4 场 命中xx%
📈 真实前瞻核账（近1日/7日/30日）
🧾 近 1 日结算
  ✅/❌ 萨索洛 vs 佛罗伦萨 2:1｜主胜→主胜
  ...（4 场）
📅 接下来（已冻结）
  · 11-07 22:30 德甲 汉堡 vs 门兴格拉德巴赫
```

## 二、Web：唯一阻塞在一个环境变量

**代码层面已完成**（`worker.mjs` 有完整 research 路由、`research-daily-store.mjs` 有严格校验、`publish-research-daily.mjs` 有回读），但线上 `POST /internal/research-daily` 返回中文 405。

**我穷尽了所有不依赖开关的路径**：
```
worker.mjs:76   researchWebEnabled = HOSTED_PUBLICATION_ENABLED && VANTIS_RESEARCH_WEB_ENABLED
worker.mjs:91   所有 /internal/* 需要 HOSTED_PUBLICATION_ENABLED === 'true'
worker.mjs:183  /api/research-daily      关闭时 503 RESEARCH_STORAGE_UNAVAILABLE
worker.mjs:196  /api/observation-notifications 同样需要该开关
结论：没有任何一条绕过它的读写路径
```

**需要的一步**：Sites 项目环境变量加 `HOSTED_PUBLICATION_ENABLED=true`。
验证：`POST /internal/research-daily` 应变成 `401 {"error":"MACHINE_IDENTITY_REQUIRED"}`（JSON），不再是中文 405。

**请 ChatGPT 提供**：Sites 控制台里加这个变量的**具体操作位置**（该平台由它侧维护，我无凭据也无界面知识）。这是本轮唯一需要它回答的运维问题。

## 三、数据与结算：已验证

| 项 | 证据 |
| --- | --- |
| 4 场冻结 | ledger `fd-558541/558545/559641/560622` |
| results lane due | 距上次 10.6h > 1h，`due=True` |
| 同源结算 | 真实英超 Chelsea 2:0 → `accuracy=1 brier=0.3078` |
| 批量演练 | 44/44 写入 scores，无重复 |
| 体彩让球盘 | 14 场在售，含秒级 `updateTime`，覆盖今晚 3 场 |
| HF 历史 | 五联赛 FT 29,832 场、赔率 18,340 场（Pinnacle 18,184）、fd_name 92.8% |

## 四、9:00 前我承诺完成

1. **08:30 前**：跑一次真实结算演练（用 03:45/04:00 完赛的 4 场真实 FT），把 `scored / hitRate / brier / logLoss` 的真实数字贴出来
2. **08:45 前**：确认 10:10 的 cron 未被改动、变量齐全、CI 绿
3. **09:00**：提交最终确认（含 SHA 与命令输出）

## 五、我无法承诺的部分（如实说明）

- **Web 在 10:00 前可见，取决于 Sites 开关是否开启**。开关一旦打开，`publish-research-daily.mjs` 会在 10:10 那轮自动写入，无需再改代码。
- 若开关未开，10:00 的 Web 仍不可见——**这不是代码问题，我不会再用改代码去规避它**。

## 六、本轮仍缺（记录在案）

1. 伤停数据：免费合法源内无解（ESPN 禁用、API-Football 锁赛季、专项站 403）
2. 阵容仅覆盖英超（pulselive 官方）；西甲/意甲/德甲/法甲官方接口未挖
3. `collector/sources/index.mjs:96` 的 `includeMacauslot: true` 硬编码未修（P0，建议今日内修）