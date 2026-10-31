# 开源爬虫接入与验证

本项目采用 Crawlee + Playwright 作为浏览器采集工具，外层保留足球业务所需的来源白名单、robots、时效、身份核验、缓存、冷却和报告。两者各自的职责可以检查，不把“页面抓到了”当作“预测有效”。

## 工具选择依据

核查日期：2026-10-31。选择依据为许可证、持续维护、官方文档、现有语言栈和实际运行测试；GitHub 热度不是所有用户一致好评的证明。

| 工具 | 核查结果与用途 | 当前接入 |
| --- | --- | --- |
| [Crawlee](https://github.com/apify/crawlee) | Apify 维护，Apache-2.0，支持浏览器池、资源调度与浏览器指纹配置；与 Node 项目一致 | `@crawlee/playwright` 固定 3.18.2；使用 PlaywrightCrawler，按来源外层策略限制重试 |
| [Playwright](https://github.com/microsoft/playwright) | Microsoft 维护，Apache-2.0，提供 Chromium 自动化、页面 JavaScript 与隔离会话 | 固定 1.64.1；实际 Chromium 动态页面、Cookie/localStorage 恢复测试通过 |
| [Scrapling](https://github.com/D4Vinci/Scrapling) | 活跃的 Python 项目，BSD-3-Clause；官方提供自适应选择器、会话与浏览器抓取能力 | 已评估，未安装或接入；本版避免同时维护第二套语言运行链路 |

官方能力参考：[Crawlee 介绍](https://crawlee.dev/js/docs/introduction)、[PlaywrightCrawler](https://crawlee.dev/js/api/playwright-crawler/class/PlaywrightCrawler)、[Playwright 授权状态复用](https://playwright.dev/docs/auth)、[Scrapling 文档](https://scrapling.readthedocs.io/en/latest/)。站点验证机制会变化，任何工具的功能介绍都不能替代针对该来源的实测。

依赖安装在 `collector/browser-runtime`，保留 package-lock；`minimatch` 固定到 11.0.1 以处理本次依赖检查发现的 GHSA-g3hv-75wg-m249。更新依赖后必须重跑浏览器测试和依赖检查，不自动拉取 `latest` 或下载任意 GitHub 脚本。

## 当前采集链路

```text
官方赛程 API → 来源健康/备用切换 → 标准赛事池
                                    ↓
robots 检查 → 域名队列/预算 → HTTP 或 Crawlee + Playwright
                                    ↓
挑战/登录/限流判断 → 内容格式及源时间校验 → 严格赛事匹配
                                    ↓
盘口/辅助预测证据 → 原有筛选与分析 → 报告、缺项、下轮复查
```

球探四个 XML/JS 快照和天天盈球的一个免费列表接口走 HTTP。浏览器就绪时，Statarea 当日至未来三天的已发布页面使用 Crawlee 执行 JavaScript 后交给原解析器。其他受限站点没有因安装工具而启用，第二独立亚洲盘源仍需真实接入。DOM 结构变化会报告格式问题，不自动猜测球队、盘口、概率字段。

HTTP 请求和浏览器使用现有环境代理，保持 TLS 校验。Node.js 24.14+ 可在入口使用原生 `setGlobalProxyFromEnv` 初始化已有代理；较早 Node 需启用其支持的 `NODE_USE_ENV_PROXY=1` 或升级。程序不修改代理地址或关闭证书验证。浏览器的页面跳转和子资源限定在 Statarea 同源，不读取账户写接口，不自动扩展到外部域名。

## 安装与自动环境检测

```sh
# 本机：安装锁定依赖，探测现有 Chromium；没有浏览器时下载匹配版本
npm run crawler:install
npm run crawler:doctor
npm run test:browser

# 不需要足球 API key，只验证固定公开抓取入口
npm run crawl:check -- --source all --budget-seconds 30
```

`crawler:doctor` 实际启动 Chromium 并验证 JavaScript。结果只包含版本、平台、可用性及代理/会话是否配置，不输出代理凭据或登录内容。当前托管环境已验证 Linux x64、Node 24.19.0、系统 Chromium；其他平台尚未实测。

运行模式由 `VANTIS_CRAWLER_ENGINE` 控制：

- `auto`（默认）：检测锁定依赖、浏览器与启动能力；环境不具备时返回 HTTP 路径并记录原因。
- `http`：只使用公开 HTTP 采集。
- `crawlee`：必须具备浏览器环境，否则明确失败。

安装器按已锁定的 Playwright 版本选择平台浏览器，不自动修改系统包。若主机缺少 Linux 动态库，可由运维用发行版包管理器或 Playwright 的 `install --with-deps chromium` 安装；未通过 doctor 不能宣称浏览器就绪。`VANTIS_BROWSER_EXECUTABLE` 可指定已有 Chromium；否则先检查 Playwright 自带浏览器，再检查常见系统路径。

生产自动发布会排除 `node_modules`。因此将依赖安装到发布目录之外，使用服务运行账号可读写的位置，例如：

```sh
# 在检出的项目中，以服务运行账号执行；目录需由运维预先准备
npm run crawler:install -- --runtime /var/lib/vantis/browser-runtime
```

在服务器已有 `/etc/vantis/collector.env` 中配置：

```dotenv
VANTIS_CRAWLER_ENGINE=auto
VANTIS_CRAWLER_RUNTIME_DIR=/var/lib/vantis/browser-runtime
# 只有安装器下载浏览器并提示该路径时才需要设置：
# PLAYWRIGHT_BROWSERS_PATH=/var/lib/vantis/browser-runtime/browsers
```

源代码仍从当前发布版本加载，固定目录仅供依赖解析。运行时检查 Crawlee/Playwright 版本与代码锁定值一致；更新锁定版本时，先在固定目录重新安装并验证，再发布。现有 ECS 的部署工具不会因 Git 同步自动更新，生产配置与发布需单独执行。GitHub 定时采集默认使用轻量 HTTP，独立 browser CI 作业安装并测试浏览器路径。

## 登录与访问验证

已实现的是正常浏览器环境、JavaScript 执行、浏览器指纹一致性和获授权登录状态复用。使用账号持有人正常登录后导出的 Playwright `storageState`，无须每轮重新输入密码。示例：

```sh
umask 077
node collector/browser-runtime/node_modules/playwright/cli.js codegen --save-storage /secure/statarea.auth.json https://www.statarea.com/predictions
```

在对应服务环境配置 `VANTIS_STATAREA_STORAGE_STATE=/secure/statarea.auth.json`，文件须限定为运行账号可读（如 0600），放在代码、报告、Actions artifact 之外。只接受 Statarea 域的 Cookie 与同源 localStorage；跨站会话、宽松文件权限、缺失依赖或过期会话明确报错。配置了会话时不会静默改成匿名抓取。该功能测试使用合成会话；尚未验证用户真实账号。

浏览器上下文按请求隔离，会话内容不进入 Crawlee 持久存储；使用授权会话取得的 HTML 强制 `no-store`。本版不自动写回更新后的登录状态，令牌过期后需重新正常登录导出。普通 JavaScript 验证能否自动完成取决于具体站点；仍出现验证码或登录页时记录 `access_challenge` / `authorization_required` 并冷却。没有账号不能获得账号权限，也不承诺通过所有验证码。

## 频率、缓存与失败处理

`config/crawler.json`（或 `--crawler-config FILE`）默认：同域最少 300ms 且串行，HTTP 单请求 3 秒，每轮最多 24 个顶层请求（包括 robots 和重试），GET 暂时性网络/502/503/504 错误最多重试一次。天天盈球的已知只读 POST 不自动重放。429 不在本轮立即重试；有界 `Retry-After` 最长 24 小时，其他访问挑战默认冷却 1 小时。普通故障重试耗尽后冷却 1 分钟。

robots 规则缓存 6 小时，支持特定 User-agent、最长路径匹配、Allow 优先的相同长度规则以及 Crawl-delay。404/410 表示未提供 robots；403、失败、验证页面或无法确认规则时不抓内容。站点要求的访问间隔超出本次等待预算时返回缺项。

公开 GET 页面可在 15 秒内复用原响应；超过该时间必须重新访问，以 ETag/Last-Modified 条件请求获得 304 后才能复用正文。保留原 Last-Modified，304 缺少新鲜 HTTP Date、原缓存或验证条件时拒绝。HTTP 与浏览器缓存分开标记，切换引擎不会直接复用另一种正文。旧盘口即使被 304 复验，仍会因原更新时间过期而被排除。

每个浏览器页面最多允许 20 次同源 GET 资源请求，阻止图片、媒体、字体、跨站资源及不允许的页面跳转；25 秒上限仍服从整轮预算。浏览器子请求单独计入 `crawler.runtime.browserRequests`，不把 24 次顶层预算误称为总网络请求数。Crawlee 不再叠加自主重试，避免两层重试放大访问量。

状态位于 `<--state路径>.crawl.json`，包含域名冷却、robots 与有限公开缓存；最多 12 个页面、缓存序列化总量 16 MB，每页 1.5 MB。独占锁和原子写入保护多轮更新。损坏状态明确失败；恢复遗留锁使用原恢复工具并先核实没有活跃进程。

报告增加 `crawler`：引擎、请求计数、缓存使用、失败代码与解析异常。仅记录允许的元数据，不复制验证页或异常堆栈。Actions 缓存前缀为 `collection-v3`，只缓存三份业务状态，不缓存登录会话和锁。

## 验收证据与实盘边界

- 核心回归包含 robots、域名队列、取消、限流持久化、坏响应、预算、缓存复验和旧盘口时效；市场独立组仍为 Titan007 一组。
- 真实 Chromium 测试在本地拦截的合成 HTML 上执行动态脚本、读取测试 Cookie/localStorage，不访问真实账户或远端网站。
- 打包回归确认依赖、浏览器二进制、会话、嵌套环境文件不进入源码包；不以此代替完整历史审计。
- 公开源的网络检查结果需单独评估。环境中请求失败或 robots 无法取得时，保留具体结果，不以更换爬虫工具推导来源已经打通。正式 API 密钥、真实登录账号与 ECS 上线尚未验证。

2026-10-31 01:43 UTC 的本次程序实测：6 个固定端点中，天天盈球列表返回 HTTP 200；球探四个目标被取得的 robots 规则禁止；Statarea 的 robots 请求超时。因此没有声称已取得有效球探盘口或 Statarea 预测。另一次网络诊断观察到部分 robots 请求为 HTTP 503，响应差异说明需要继续按实际运行环境记录，不能认定站点永久故障。此结果来自本任务环境，不代表生产 ECS。
