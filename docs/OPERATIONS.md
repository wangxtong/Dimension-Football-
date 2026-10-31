# 阿里云持续运行与总控运维

此实现复用现有 ECS；没有执行远端登录、安装、采集、通知、域名绑定或安全组修改。服务器身份及实时状态必须由运维检查确认。Sites 保留原域名和访客登录；ECS 保存状态、生成报告并执行交付。没有新增 AI API 或付费服务。

## 入口与运行契约

生产入口由总控维护：

```text
node collector/orchestrate.mjs --lane fixtures|markets|delivery|results --state /var/lib/vantis/state/state.json --out /var/lib/vantis/reports --budget-minutes N
```

`--help` 必须无网络、无写入。运维层不会在入口缺失时回退到其它采集命令或把一次空跑记作成功。安装要求同时存在 `collector/report-server.mjs`。

`deploy/operations.json` 是初始模板；部署后从 `/etc/vantis/operations.json` 读取，升级保留现有配置。`stateRelativePath` 将所有 lane、兼容检查、回滚与锁恢复固定到同一状态文件：新安装为 `state/state.json`；已有根 `state.json` 的旧安装保留旧路径且不搬动状态。两份状态同时存在且未明确选择时拒绝猜测。旧配置缺少此字段时，单纯代码更新仍保持根路径，安装器再明确记录选择。

| lane | 目标周期 | 内部预算 | 进程上限 |
| --- | --- | --- | --- |
| fixtures | 15 分钟 | 2 分钟 | 150 秒 |
| markets | 2 分钟 | 1 分钟 | 90 秒 |
| delivery | 1 分钟 | 30 秒 | 45 秒 |
| results | 1 小时 | 2 分钟 | 150 秒 |

一分钟 systemd tick 选择最早到期的一条 lane。所有生产及手动执行均通过 `/opt/vantis/deployment/run.sh`，共享 `operations/run.lock` 的内核 flock；子进程继承锁文件描述符。运行超时先 SIGTERM，15 秒后 SIGKILL，systemd 使用 `KillMode=control-group`。忙碌或排队会导致执行延迟，不把配置周期宣称为实时 SLA。赛果大历史快照的 6 小时缓存由数据层管理。

每次执行从已校验 release 的 `.source-commit` 读取完整 40 位 SHA，强制设置子进程 `COLLECTOR_COMMIT`，不信任外部环境覆盖；缺失或非法版本会阻止执行。

单轮返回 0 仅表示入口成功完成；报告新鲜度、来源覆盖、网站发布及通知成功分别检查。初盘必须来自可验证供应商记录，持续观察不会变成真实初盘。

## 无秘密的只读检查

已安装时，在 Workbench 执行一条命令：

```sh
bash /opt/vantis/deployment/diagnose.sh
```

首次安装前可以直接执行以下命令，它不需要部署工具已存在：

```sh
python3 -c 'import json,subprocess,shutil; from pathlib import Path; names=["vantis-collector.service","vantis-collector.timer","vantis-health.timer","vantis-sync.service","vantis-report.service"]; result={"node":subprocess.run(["sh","-c","command -v node >/dev/null && node --version"],capture_output=True,text=True).stdout.strip(),"diskFreeBytes":shutil.disk_usage("/").free,"statePresent":Path("/var/lib/vantis/state/state.json").is_file(),"legacyStatePresent":Path("/var/lib/vantis/state.json").is_file(),"units":{n:subprocess.run(["systemctl","show",n,"--property=LoadState,ActiveState,SubState,Result,ExecMainStatus"],capture_output=True,text=True).stdout.strip() for n in names},"secretsRead":False}; print(json.dumps(result,indent=2))'
```

这不测试 SSH 或网络连接，不读取 `/etc/vantis/*.env`、私钥或 token，也不输出进程环境。成功的 oneshot 在运行后显示 `inactive/dead` 正常；结合 `Result`、`ExecMainStatus`、timer 状态和最新报告判断。

## 离线制品、安装及私库同步

**新增 fail-closed 签名审查（待 A1 验收，未安装）**：见 [ECS-SIGNED-RELEASE](ECS-SIGNED-RELEASE.md)。除受信任 CI 精确 SHA 与包 SHA-256 外，需要独立审批人离线 Ed25519 签署精确源 SHA、archive SHA-256、工具摘要、CI 结论和有时限的授权 JSON。install.sh、release.sh、可选 sync.sh 在切换前验证固定公钥、独立签署及权限；即使 Git 拉到了 main 且单测 GREEN 也不能切换。已有 ECS 若仍运行旧版工具，须由有权限的 Workbench 管理员先停用自动更新，受控升级并回读工具摘要。代码 PR 不等于部署证据。该门禁只用于代码版本切换，正式预测发布由 A1/PR #21 单独批准，始终 BLOCKED。


系统需要 Python 3、Git、OpenSSH client、Bash、flock 和 systemd，以及系统级 Node.js **24.x、至少 24.14**。bootstrap 可显式追加 `--install-node`：仅在现有 Node 不符合能力要求时，从 `nodejs.org/dist/v24.19.0/` 下载固定 x64/arm64 发行与 SHASUMS256，校验后安装独立 runtime 到 `/opt/vantis-node/`。只提取 Node 可执行文件和许可证，不执行 npm、不使用 sudo npm、不修改系统默认 Node。自检验证版本和实际代理/AbortSignal 能力。浏览器是显式可选能力：设置 `browserRequired:true` 后，发布自检必须成功启动固定版本的浏览器运行时。依赖可放在独立的 `VANTIS_CRAWLER_RUNTIME_DIR`；安装失败不能被标成浏览器可用。

CI/已批准工作站从完整提交构建制品；未提交文件不进入包：

```sh
python3 deploy/bundle.py build /path/to/checkout FULL_40_CHARACTER_SHA /path/to/release.tar
python3 deploy/bundle.py verify /path/to/release.tar --sha256 EXPECTED_64_CHARACTER_SHA256
```

CI 至少执行 `npm test`、`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest deploy/test_bundle.py deploy/test_handoff.py`、`bash -n deploy/*.sh`，并运行总控提供的网站及数据契约检查。`bundle.py` 包含逐文件 SHA-256 清单、源 SHA、状态兼容版本与部署工具摘要。它拒绝路径穿越、链接、重复条目、超大归档、缺失或变化文件。运行制品排除所有 test/tests/__tests__/__mocks__/helpers 目录、`.test.` 文件及 `test_` 脚本，包括 collector/test、collector/sources/test、collector/browser-runtime/test、website/test 和门禁 mock；开发源码 ZIP 继续保留完整测试。验证归档、验证解包目录和安装复制均执行同一白名单，不能把文件加入清单并填入正确哈希来绕过排除。SHA-256 本身不是签名；预期摘要必须来自已认证、已批准的 CI/传输结果，不能信任与未知包同时收到的任意文本。

通过既有 Workbench/云效上传批准制品和部署 helper。服务器执行：

```sh
sudo bash /absolute/approved/deploy/bootstrap.sh /absolute/release.tar EXPECTED_64_CHARACTER_SHA256 --install-node
```

helper 自身必须通过同一受信任交付过程获得。也可先用 `bundle.py extract ... --sha256 ...` 解包，再执行 `sudo bash SOURCE/deploy/install.sh SOURCE`。安装器验证清单，并使用独立的 `vantis-check` 账号检查运行模块语法和无副作用 `--help` 入口；该账号不能读取 `root:vantis` 的生产秘密。完整测试必须先在相同 SHA 的 CI 源码上完成，运行包不再携带测试代码。校验输出不写生产日志，失败时保留现有代码版本。安装通过受限文件锁和原子替换补齐 `report.env` 的 `REPORTS_READ_TOKEN` 与 `collector.env` 的 `REPORTS_PROBE_TOKEN`，两者独立随机生成；合法旧值及其它配置保留，空值补齐，重复或非法旧值明确拒绝。两个文件为 root:vantis、0640；日志只显示键名和创建/保留状态，不显示值。

已有安装的制品更新使用已安装、root 所有的 `release.sh`；代码同步不会替换部署工具。部署工具及单元升级需显式执行安装器，记录独立摘要。

默认 `/etc/vantis/source-mode` 为 `artifact`，不启用源码轮询。若使用只读 deploy key：

- GitHub key 仅授权 `wangxtong/Dimension-Football-` 读取；无需写权限。
- `/etc/vantis/github_deploy_key` 为 root 所有，权限 0600 或 0400。
- `/etc/vantis/github_known_hosts` 必须由已核验的 GitHub 官方 SSH 主机公钥建立。禁止自动接受首次连接、禁止关闭主机校验。
- 将非秘密文件 `source-mode` 改为 `deploy-key`，再启用 `vantis-sync.timer`。同步固定仓库 main 到本地 bare 库，构建并校验不可变包；另建相同提交的临时 detached worktree，在无生产环境变量的受限账号下运行完整源码测试，成功后切换，退出时移除测试 worktree。测试源码不进入运行包或 `/opt/vantis/releases`；不走匿名 codeload。
- ECS 不使用 GitHub Actions OIDC。Actions 的 CI 身份与 ECS 机器身份分开；deploy key 不会自动授予任何阿里云权限。

普通代码发布保留报告、状态和秘密。`release.sh` 通过 `bundle.py copy-runtime` 仅复制清单中允许的 `collector/`、`config/`、`website/` 和 package.json 文件，保留报告存储所需的 `website/report-schema.mjs` 等共享契约；不再递归复制整个源码目录。`operations/release.json` 记录源 SHA、制品摘要、源工具摘要、实际安装工具摘要和状态兼容版本；不把源内的新工具版本误称为服务器已升级工具。

打包分离不改变 manifest version 1、state schema 1 或支持的持久状态路径。`toolingDigest` 仍按实际纳入的 deploy 文件名及字节排序计算，因此排除部署测试或修改工具会产生新摘要；archive 摘要也必须重新获取。新校验器拒绝含测试/辅助代码的旧包，需要从批准 SHA 重新构建。应用代码更新不自动更新已安装工具，必须先显式升级 bundle.py/release.sh/install.sh/sync.sh；否则不能声称服务器已执行新白名单。既有服务器权限、可写源码、旧 release 和 Node preload 权限仍需实际核验；本地打包测试不代表这些权限已加固，预测发布继续保持 BLOCKED。

## Sites 数据服务与发布验收

`vantis-report.service` 从 `/etc/vantis/report.env` 加载 `REPORTS_READ_TOKEN`、`REPORTS_DIRECTORY`、`REPORTS_PORT`，默认监听 `127.0.0.1:8787`；它不加载 provider/Telegram 秘密。`GET /api/report` 与 `/health` 都需要服务 Bearer。`REPORTS_READ_TOKEN` 保存在独立 report.env，`REPORTS_PROBE_TOKEN` 供采集端向 Sites 做实际回读；后者还需要通过受控配置渠道写入 Sites，不能把二者混用。不要把 token 放在 URL、浏览器、日志、归档或操作命令参数中。

已从部署交接确认现有域名 `football.fotpredict.xyz` 与 Nginx 配置路径 `/etc/nginx/sites-available/football-prediction`；既有 Gunicorn 8000 和 `/weidu-bridge/` 8091 必须保留。本轮未访问 ECS 文件或修改远端配置。默认报告 base 为 `https://football.fotpredict.xyz/dimension-football/`；升级仅补齐旧配置中的 null，不覆盖其它已有地址。自检分别输出 `installation.ready/blocked` 与 `externalDelivery.blocked`，没有真实 TLS 回读时不宣称验收通过，也不让首次未验收阻断能力满足的安装。

安装完成后，由 Workbench/总控执行：

```sh
sudo python3 /opt/vantis/deployment/nginx-namespace.py --apply
```

不带 `--apply` 时仅解析计划。脚本必须找到唯一显式匹配 server_name 与 443 监听的 server 块；仅插入有标记的 `/dimension-football/` 独立 location，剥掉此前缀后转发到 `127.0.0.1:8787/`。原站、bridge、TLS 证书和其它配置保持原样。已有冲突路径、多义 server 或损坏标记均拒绝。变更前创建 0600 备份；`nginx -t` 通过才 reload，验证/reload 失败恢复原文件。普通源码同步不自动修改 Nginx。不得使用公网 HTTP/IP 或关闭 TLS 验证；本模块不创建域名/证书，也不修改安全组。

根报告目录为 `/var/lib/vantis/reports`，包括 `predictions.json`、`publication.json`、`forecast-ledger/` 和 `.delivery/`。同一 `reportId` 绑定内容、摘要、网站实际回读及通知 outbox。发布顺序与未知发送处理由 A6/总控编排实现；健康层不自行重发、修补报告或假造发布成功。

## 每分钟总控

`vantis-health.timer` 独立于采集每分钟运行，读取状态及 systemd 状态，原子写入 `/var/lib/vantis/operations/health.json`。它不加载秘密、不采集、不通知、不调用 AI，也不自行部署。

- P0：无报告、报告/回执错配、网站交付失败、磁盘不足、报告服务未运行。
- P1：报告陈旧、scheduler 心跳过期、lane 超时/失败/积压、timer 停止、通知结果未知、缺少 HTTPS origin。
- P2：机器状态不可读取、修复任务被依赖阻塞。

规则给出固定修复方向。先处理 P0，再处理上游依赖、持久化/调度、发布与通知，最后处理优化；不自动清除未知锁或重发不确定通知。

`operations/tasks.json` 初始包含 A1–A8 的 pending 任务。可通过 `collector/control.mjs` 更新本地进度，例如：

```sh
node /opt/vantis/current/collector/control.mjs --root /var/lib/vantis --id operations --role A7 --status review --commit FULL_40_CHARACTER_SHA
```

状态为 pending/active/review/verified/blocked。verified 只能从 review 进入，并要求 `operations/evidence/FILE.json` 中有同一 commit 的验收文档：`kind:"acceptance"`、`passed:true`、24 小时内的 `checkedAt` 与非空 `checks`；命令追加 `--evidence-file FILE.json`，记录证据 SHA-256。blocked 需 `--dependency CODE`。事件保留最近 200 条。证据必须由实际验收产生；文件存在和任务 active 都不是服务器已上线的证据。

## 状态、备份、恢复与回滚

运行状态在 `/var/lib/vantis`，源码版本目录只读。备份包含顶层 `state.json` 及同伴 JSON、`state/`、`reports/`（含 forecast-ledger、replays 和 delivery outbox）、`operations/`；排除锁、环境文件、浏览器会话和依赖。所有写状态的手动任务也必须使用统一 OS 锁。

```sh
sudo bash /opt/vantis/deployment/backup.sh /absolute/outside-state/backup.tar
bash /opt/vantis/deployment/restore-drill.sh /absolute/backup.tar EXPECTED_SHA256
```

备份取得同一运行锁，等待正在进行的一轮结束；输出文件必须在状态目录外。独立健康检查可能更新诊断快照，但不会修改报告/outbox。恢复演练只解包到临时目录，验证全部摘要、JSON、报告 ID 和 receipt 文件摘要，结束即清理，不覆盖生产、不启动采集、不发送通知。生产灾难恢复须先停止写入服务，保留现场，按演练验证过的快照恢复；本脚本不会擅自覆盖生产目录。

断电或 SIGKILL 可能留下旧版 JSON 锁。先停止采集 timer、确认采集服务不活跃，再执行 `recover-state-locks.sh`；脚本取得 OS 锁后，仅删除本机已不存在 PID 的锁，拒绝活跃进程、其它主机、损坏或已变化的锁。控制任务 ledger 锁由管理员按同一原则单独核验。

```sh
sudo bash /opt/vantis/deployment/rollback.sh EXISTING_RELEASE_ID
```

回滚要求已有版本含 `.release-contract.json`，并验证其支持当前 state schema；等待同一运行锁后原子切换，保留状态，重新加载报告服务。旧版没有兼容元数据时明确拒绝，不能猜测兼容。跨 schema 回滚须恢复相配备份并重新验收。回滚成功仍需检查最新 health、实际 Sites 回读及通知 outbox；不能以 symlink 切换成功替代产品验收。
