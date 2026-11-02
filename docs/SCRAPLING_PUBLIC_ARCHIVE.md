# Scrapling 公开足球信息采集（可选增强层）

**状态**：仅隔离分支/PR候选。现有 Node.js 采集器保留 `@crawlee/playwright 3.18.2` 和 `playwright 1.64.1`。不替换生产抓取器、ECS部署、Secrets、API-Football接口或机器人配置。

## 维护选型（2026-11-02 GitHub原始元数据读取）
- [Scrapling](https://github.com/D4Vinci/Scrapling)：约91,870 Stars、BSD-3-Clause、代码近日更新；官方2026-10-17发布v0.5，为本次可选HTTP抓取引擎。
- [Scrapy](https://github.com/scrapy/scrapy)：约65,167 Stars，长期维护；Python全栈爬虫，更适合大规模新爬虫体系。
- [Crawlee](https://github.com/apify/crawlee)：约26,312 Stars；本仓库已固定其Playwright整合版本，不重复引入第二套调度。
GitHub Stars是公众关注度，不等于成功率、安全性或来源授权。Scrapling v0.5有breaking changes；本适配器只使用官方`Fetcher.get`和响应`status/headers/body`，禁用StealthyFetcher、CAPTCHA解决、绕过鉴权和代理轮换。

## 本轮新增的实际来源和边界
| source ID | 固定官方公开路径 | 得到什么 | 不会得到什么 |
| --- | --- | --- | --- |
| `openligadb-bl1-history` | `https://api.openligadb.de/getmatchdata/bl1/{season}`，仅2010–2026起始赛季 | 德甲provider matchID、球队、UTC时间及经过After90Minutes判断的FT结果，原始JSON | 五大联赛完整数据、亚盘/欧赔、赛前初盘、当年赛前可见时间 |
| `bbc-football-rss` | `https://feeds.bbci.co.uk/sport/football/rss.xml` | 足球新闻标题、URL、发稿UTC时点，私有归档 | 经核验的伤停/首发/预测/赔率；不抓正文 |

**这是实际可调用来源的固定适配器，不是新增两家赔率商，也不自动解决实时赔率缺失。** 原有API-Football付费接口和真实原生市场报价仍按A2、A3独立验收。

## 安装（仅经批准的独立研究环境）
```sh
python3 -m venv .venv-scrapling
. .venv-scrapling/bin/activate
python -m pip install --disable-pip-version-check -r config/scrapling-requirements.txt
python -c "import importlib.metadata; from scrapling.fetchers import Fetcher; assert importlib.metadata.version('scrapling') == '0.5'"
python3 -m unittest discover -s collector/sources/test -p test_scrapling_archive.py -v
```
本功能没有自动安装第三方包或下载浏览器。不要在生产ECS上未经审批执行`scrapling install`，也不用它探测需要登录/付费的来源。

## 一次性获取与不可变持久化
```sh
# 只能读取明确列出的来源；一次CLI运行单个目标HTTP GET，先检查robots.txt。
# 根目录必须是已授权持久非生产目录；禁止将仓库内路径当长期状态库。
npm run archive:public:scrapling -- --source openligadb-bl1-history --season 2025 \
    --live --out-root /var/lib/dimension-research/sources
npm run archive:public:scrapling -- --source bbc-football-rss \
    --live --out-root /var/lib/dimension-research/sources

# 每次输出JSON内的directory用另一个进程重新校验。
python3 collector/sources/scrapling_archive.py --verify /var/lib/dimension-research/sources/<sourceId>/<UTC-date>/<receipt-hash>
```

每轮最多1次目标GET，外加1次robots检查；没有自动循环。外层A3负责统一限速/限流、定时和资源预算，不能以此CLI声称600秒连续SLO或赛前T−50已运行。403/401/429、跳转、robots拒绝/不可达、错误服务端时间、超大/不合规响应均显式失败，**不自动更换代理或破解限制**。

成功时写入`raw.bin`原始字节、`projection.json`字段投影、`receipt.json`元数据，均存入UTC日期和内容SHA定位的独立不可变目录；每文件600权限、fsync和原子目录交换，读取时重新计算SHA/字段，旧记录不覆盖。缺FT记录继续记null，BBC仅标题元数据。所有`modelReady=false`、`historicalPregameObserved=false`、`releaseGate=BLOCKED`，任何内容都不自动进入生产训练/今日推荐/Telegram发布。

## 测试与上线门禁
- 本地/CI单元合约使用合成网页/JSON与注入的模拟HTTP，必须0失败/0跳过。包含来源白名单、robots允许/禁止、响应拒绝、重复赛事、完整FT、RSS元数据、SHA篡改、跨新进程读回及重复写拒绝。
- GitHub Actions`scrapling-engine`作业在干净Python 3.12安装固定Scrapling 0.5、校验`Fetcher.get`真实导入，且二次跑离线套件；release必须等此作业通过。
- 真实公开来源HTTP+原始服务器Date+原始字节SHA应在获准的持续研究环境另取回，并交A10同SHA独立抽检；当前会话运行容器DNS不可达，不得将模拟HTTP称为真实抓取成功。
- 若要让其中的球队/比赛进入每日模型，必须补原生fixture身份/版本、当时赛前数据可见时间与可评估赔率等；历史赛果回填不能造赛前赔率。生产主线仍`BACKTEST_ALL_GREEN_ONLY=BACKTEST_INSUFFICIENT`/`RELEASE_GATE=BLOCKED`。

更多背景见 [CRAWLER_INTEGRATION.md](CRAWLER_INTEGRATION.md)、[SOURCE_MANAGEMENT.md](SOURCE_MANAGEMENT.md)和A2/A3 / #53 工单。

## 2026-11-02 实际 GitHub Runner 跨语言采集验证（研究态E2）

以下内容是已执行的真实运行收据，不是开发示例或ECS部署：

- 同一私有PR的真实 [Actions #41388436210](https://github.com/wangxtong/Dimension-Football-/actions/runs/41388436210) 中，`scrapling-live-public` 用锁定v0.5先做robots预检查，再以Scrapling官方普通`Fetcher.get`真实请求 `https://api.openligadb.de/getmatchdata/bl1/2025`，`HTTP 200`（2026-11-02 04:26:36 UTC）。
- Python`raw.bin`原文SHA256 `4c03c11d78955f72d747a31dbdc05c1c2b47ea1c56f9aff3268c63bdd2709050`，306个provider fixtureId，严格90分钟FT **306/306**；Python新进程`--verify`通过。
- 新增A3 Node`collector/data/scrapling-history-bridge.mjs`独立读取并核验Python原文/投影/收据，按源内fixtureId转换为已有`normalizeHistoryRecord`；本次转换**306/306**，产生归一化归档SHA256 `eb9dddb8f16e15e6ebd5f19b879df8b64699d413bbf16f7a9fa89396173656d3`，完整来源和记录时点保留为当期**赛后观察**，无赛前数据资格。
- [Actions 原生附件 #13116167124](https://github.com/wangxtong/Dimension-Football-/actions/runs/41388436210/artifacts/13116167124)含原始JSON、投影、Python回执、Node导入归档；ZIP SHA256 `a6d7ee534a06b0efb45934fbae07d768f9138c5d853694a9c9d936cd2da70386`。独立获取原件并核ZIP 7/7、原文及Node输出SHA均一致。
- 为避免Actions 14天留存过期造成研究数据丢失，已另存用户私有Library `/Dimension-Football/Research-Only-Evidence/SCRAPLING_REAL_OPENLIGADB_2025_RAW_NODE_E2_20261102.zip`（稳定文件ID `libfile_7e34a0b0e97081918ce83f0468457b25`），上传后第二次取回验证原ZIP SHA逐字节一致。此存储**不是自动运行仓库代码可读取的ECS持久卷**，A3仍需正式设计运行期R2/卷长久归档与恢复演练。
- 新Node导入带不可变输出文件、来源原始SHA绑定、无FT隔离、取回时钟绑定及删除/篡改负例；CI需要完整同SHA结果和A10独立审核，生产接入未完成。

此项真正打通的是**单公开来源历史赛果的Web外部HTTP→Scrapling→私有RAW→Node历史格式**。尚未打通五大联赛实时赛程/赔率、赛前真实初盘、600秒连续采集、ECS运行、模型正式前瞻及Web每日赛后自动回测。即使单轮跑绿，`modelReadyForProspective=false`、`RELEASE_GATE=BLOCKED`，严禁把2025赛季赛后赛果用于伪造当时预测。
