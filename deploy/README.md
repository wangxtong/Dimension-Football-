# ECS / 轻量服务器部署文件

适用于使用 systemd 的 Linux 主机。`bootstrap.sh` 从官方安装系统级 Node.js 24，并获取指定的完整 Git 提交；已有 Node.js 24+ 时可以复用。`install.sh` 要求预先安装 Node.js、Bash、Git 和 curl。脚本不创建云资源，不接收密钥参数。首次安装和后续发布需要 root 权限；采集和下载源码的测试进程使用独立的 `vantis` 账号。

首次安装改为通过经过审查的私有仓库引导工具进行，仅当已备齐 root-only Git 读取凭据、同 SHA 的真实审核证据并通过 staging 验收时才运行：

```sh
sudo bash /absolute/uploaded/deploy/bootstrap.sh FULL_40_CHARACTER_COMMIT_SHA --deployment-dir /absolute/uploaded/deploy
```

直接从普通源码目录运行 `install.sh`，如果缺少 root-only `.vantis-verified-commit` 标记及审批，将被拒绝（预期行为）。

如 Node.js 不在默认 PATH，明确指定其系统级绝对路径：

```sh
sudo env NODE_BIN=/usr/local/bin/node bash deploy/install.sh "$PWD"
```

安装脚本仅在配置文件不存在时创建空模板，不覆盖已有凭据。用服务器上的编辑器填写 `/etc/vantis/collector.env` 中的一种凭据，然后验证一次：

```sh
sudoedit /etc/vantis/collector.env
sudo systemctl start vantis-collector.service
sudo journalctl -u vantis-collector.service -n 100 --no-pager
sudo systemctl list-timers vantis-collector.timer
```

安装后，`vantis-sync.timer` 每 2 分钟通过 root-only Git 凭据读取 **Private** 仓库的 `main`。只有经独立核验并由 root 专用文件授权的完整提交 SHA，才执行下载、测试及原子切换。缺令牌/发布审批/CI 证据、SHA 不符或测试失败，一律保留旧版本。

```sh
sudo systemctl start vantis-sync.service
sudo journalctl -u vantis-sync.service -n 100 --no-pager
sudo systemctl list-timers vantis-sync.timer
cat /opt/vantis/current/.source-commit
```

初装须附已审阅的 `--deployment-dir` 工具包，并提供 root-only Git 只读凭据与对同一 SHA 的根目录外批准文件。所有人工 `release.sh` 也须传入完整 `VANTIS_COMMIT`，源文件带经过 Git 验证后创建的 `.vantis-verified-commit` 标记。缺任一前置条件禁止发布。

部署工具可由控制台单独上传，再引导已发布的程序提交。例如，解压工具包后运行：

```sh
sudo bash /absolute/uploaded/deploy/bootstrap.sh FULL_40_CHARACTER_COMMIT_SHA --deployment-dir /absolute/uploaded/deploy
```

`--deployment-dir` 仅接受实际绝对目录，按固定名单读取 5 个 Shell 脚本、`release-gate.mjs`、`private-git-askpass.sh` 和 4 个 systemd 单元，拒绝符号链接；仅覆盖临时源码中的这些部署文件。程序的 `collector/` 与配置仍来自指定提交，`.source-commit` 准确记录该提交。部署工具另以 `/opt/vantis/deployment/.tool-version` 的 SHA256 指纹记录，自动 Git 同步不会覆盖它们。

云效主机部署同样要先取得 root 维护的完整回测/回归审批、认证来源完整 SHA 及源码标记；仅运行 `npm test` 不能授权生产发布。

```sh
sudo env VANTIS_COMMIT=APPROVED_FULL_SHA bash /opt/vantis/deployment/release.sh /path/to/verified-source
```

每次发布复制运行源码到新目录，完成 CLI 离线加载检查后原子切换 `current`。正在运行的采集继续使用旧版本，下一轮使用新版本。发布不会立即发起采集，也不会覆盖配置或持久状态。旧版本保留用于人工检查和回退，不自动清理。

| 路径 | 内容 / 权限 |
| --- | --- |
| `/opt/vantis/releases/<时间和进程号>/` | root 所有的只读运行源码 |
| `/opt/vantis/deployment/` | 独立安装的 root 部署脚本和单元副本，Git 程序同步不修改此目录 |
| `/opt/vantis/current` | 指向当前发布的原子切换链接 |
| `/opt/vantis/current/.source-commit` | 当前发布对应的完整 Git 提交 SHA |
| `/etc/vantis/collector.env` | 仓库外凭据；root 所有，vantis 组只读，权限 0640 |
| `/etc/vantis/node-path` | 固定的 Node.js 可执行文件路径 |
| `/etc/vantis/github-read-token` | 只读私有仓库凭据，仅 root 可读的普通文件，权限 0600 |
| `/etc/vantis/release-approvals/<SHA>.json` | 生产前独立审批，root 0600，完整 SHA 匹配且 48 小时内有效 |
| `/var/lib/vantis/state.json` | 持久检查点，vantis 用户可写 |
| `/var/lib/vantis/state.json.sources.json` | 官方赛程来源健康状态、失败冷却及最近切换记录；备份时与检查点一同保留 |
| `/var/lib/vantis/state.json.crawl.json` | 公开爬虫域名冷却、robots 与页面缓存；不保存授权浏览器会话 |
| `/var/lib/vantis/state.json.providers.json` | 商业分析接口健康与冷却；不含凭据或原始响应 |
| `/var/lib/vantis/reports/` | 持久报告，vantis 用户可写 |
| `/var/lib/vantis-sync/` | root 所有的同步临时目录，不包含凭据 |
| systemd journal | 运行日志，使用上面的 journalctl 命令查看 |

定时器每小时整点执行，开机后补一次停机期间错过的任务。systemd 不会同时启动两个相同服务实例；采集程序也使用检查点锁。系统日志的跨重启保留策略沿用服务器现有 journald 配置。

`vantis-collector.service` 与 `vantis-sync.service` 都是一次性任务（oneshot）。成功结束后显示 `inactive/dead` 属于正常状态；请同时检查 `Result=success`、`ExecMainStatus=0` 和定时器的下次执行时间。可用 `systemctl show vantis-collector.service vantis-sync.service -p Result -p ExecMainStatus` 查看上轮结果，用 `systemctl list-timers --all vantis-collector.timer vantis-sync.timer` 查看自动运行计划。

不要给云效配置输出凭据的命令或 shell 跟踪模式。修改服务器配置无需重新发布代码。若更新部署工具或 systemd 单元，使用新工具包重新执行引导或安装脚本；普通 Git 同步只更新程序源码。需要停用定时采集时执行：

```sh
sudo systemctl disable --now vantis-collector.timer
```

需要停用 Git 自动同步时执行：

```sh
sudo systemctl disable --now vantis-sync.timer
```

## 安全上线门禁（未满足时完全拒绝）

私有仓库 Git 读取由 `deploy/private-git-askpass.sh` 处理：只允许固定 github.com 来源，凭据存于 `/etc/vantis/github-read-token`，要求 `root:root` 和 `0600`；不得写入命令行、URL、前端或仓库。文件须由运维人员通过安全通道准备，默认不会创建真实令牌。

每个允许上线的提交都需要根目录外 `/etc/vantis/release-approvals/<full lowercase SHA>.json`，目录 root 拥有且不可由非 root 写入，文件 root:root 0600、不得为符号链接。格式为 schemaVersion=1、commitSha、approvedAt（不超过 48 小时）、BACKTEST_ALL_GREEN_ONLY=GREEN、RELEASE_GATE=GREEN。
`checks` 内以下全部项目须为 GREEN：COMMERCIAL_API_AUTHORIZED、FIVE_LEAGUE_BACKTEST_SUFFICIENT、WALK_FORWARD_NO_LOOKAHEAD、PROBABILITY_CALIBRATION、ASIAN_ODDS_INDEPENDENCE_AND_OPENING、PREMATCH_DATA_FROZEN、ALL_REGRESSIONS、CI_ON_EXACT_COMMIT、MERGED_PR_ON_EXACT_COMMIT、STAGING_SMOKE、OLD_VERSION_NO_REGRESSION、ROLLBACK_READY。
`evidence` 必须包含与审批 SHA 一致的 candidateSha、不同的 baselineSha、backtestSha256、stagingSmokeSha256、regressionSha256、ciRunUrl、mergedPrUrl。审批只是独立操作员对证据的断言，并非代码自动从第三方核验真实性；只有逐项审计真实证据后才能安全签发。任何 FAIL、WARN_BLOCKING、UNKNOWN、BACKTEST_INSUFFICIENT、缺失或旧证据一律阻断。
所有入口在切换生产之前再次执行 root-owned release gate。部署完成后仍须单独执行真实生产烟雾、重启持久化和与旧版相同样本的无回归对照；上线审批不能自动宣称最终发布完成。

新门禁仅在脚本经审阅、合并且安全安装到目标 ECS 后生效；该仓库 PR 不会自行配置凭据、保护分支或修改服务器。
