# ECS / 轻量服务器部署文件

适用于使用 systemd 的 Linux 主机。`bootstrap.sh` 从官方安装系统级 Node.js 24，并获取指定的完整 Git 提交；已有 Node.js 24+ 时可以复用。`install.sh` 要求预先安装 Node.js、Bash、Git 和 curl。脚本不创建云资源，不接收密钥参数。首次安装和后续发布需要 root 权限；采集和下载源码的测试进程使用独立的 `vantis` 账号。

首次在源码目录执行：

```sh
sudo bash deploy/install.sh "$PWD"
```

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

安装后，`vantis-sync.timer` 每 2 分钟通过公开 Git HTTPS 检查固定仓库 `wangxtong/Dimension-Football-` 的 `main` 分支。发现新提交后下载该完整 SHA 的 codeload 源码，在 `vantis` 用户和干净环境中运行全部测试；通过后原子发布。网络、源码检查或测试失败均保留现有版本。无需 GitHub API、访问令牌或开放入站端口。

```sh
sudo systemctl start vantis-sync.service
sudo journalctl -u vantis-sync.service -n 100 --no-pager
sudo systemctl list-timers vantis-sync.timer
cat /opt/vantis/current/.source-commit
```

使用 `bootstrap.sh FULL_40_CHARACTER_COMMIT_SHA` 安装时，初始提交会自动写入发布元数据。手工调用安装或发布脚本时，可用 `sudo env VANTIS_COMMIT=FULL_40_CHARACTER_COMMIT_SHA ...` 记录相同元数据；未提供元数据时，同步器会在首次检查时对 `main` 执行一次测试和发布。同步与采集使用不同定时器，部署失败不会停止采集。

部署工具可由控制台单独上传，再引导已发布的程序提交。例如，解压工具包后运行：

```sh
sudo bash /absolute/uploaded/deploy/bootstrap.sh FULL_40_CHARACTER_COMMIT_SHA --deployment-dir /absolute/uploaded/deploy
```

`--deployment-dir` 仅接受实际绝对目录，按固定名单读取 5 个脚本和 4 个 systemd 单元，拒绝符号链接；仅覆盖临时源码中的这些部署文件。程序的 `collector/` 与配置仍来自指定提交，`.source-commit` 准确记录该提交。部署工具另以 `/opt/vantis/deployment/.tool-version` 的 SHA256 指纹记录，自动 Git 同步不会覆盖它们。

云效主机部署获取并解压新源码后，执行以下命令，将占位路径替换为该次解压目录。构建阶段应先运行 `npm test`。

```sh
sudo bash /opt/vantis/deployment/release.sh /path/to/source
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
| `/var/lib/vantis/state.json` | 持久检查点，vantis 用户可写 |
| `/var/lib/vantis/reports/` | 持久报告，vantis 用户可写 |
| `/var/lib/vantis-sync/` | root 所有的同步临时目录，不包含凭据 |
| systemd journal | 运行日志，使用上面的 journalctl 命令查看 |

定时器每小时整点执行，开机后补一次停机期间错过的任务。systemd 不会同时启动两个相同服务实例；采集程序也使用检查点锁。系统日志的跨重启保留策略沿用服务器现有 journald 配置。

不要给云效配置输出凭据的命令或 shell 跟踪模式。修改服务器配置无需重新发布代码。若更新部署工具或 systemd 单元，使用新工具包重新执行引导或安装脚本；普通 Git 同步只更新程序源码。需要停用定时采集时执行：

```sh
sudo systemctl disable --now vantis-collector.timer
```

需要停用 Git 自动同步时执行：

```sh
sudo systemctl disable --now vantis-sync.timer
```
