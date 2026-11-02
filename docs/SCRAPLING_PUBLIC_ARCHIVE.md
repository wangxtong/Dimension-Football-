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
