# 同机隔离的维度足球研究 runner

本目录用于用户已确认的**同一台生产 ECS 上按账号、目录、systemd 和 cgroup 隔离**的研究部署，目标实例固定为 `i-j6c4g9s2y6b5irl5gcr9`；它不是另一台虚拟机或独立内核。它不替换现有维度足球生产服务，不修改 `/opt/vantis`、`/etc/vantis`、`/var/lib/vantis`、Nginx、旧消息桥或 GitHub/Sites 配置，不开放端口，不发送 Telegram，也不解除正式预测 `RELEASE_GATE=BLOCKED`。

`runner.py` 只使用 Python 3 标准库。请求固定 API-Football 官方主机 `v3.football.api-sports.io`；源的授权和字段覆盖仍以实际响应为准。定时运行、HTTP 200、已有付费 key 或 RAW 文件存在，都不能单独证明实时赔率、供应商初盘、独立双源、完整五联赛覆盖或模型发布资格。

## 独立路径、身份与资源

| 项目 | 设置 |
| --- | --- |
| 运行账号 | 新建 `dimension-research` 系统账号、nologin，不加入旧生产组 |
| 源码 | `/opt/dimension-research`，root 所有，目录 0555，运行源码 0444 |
| 配置 | `/etc/dimension-research`，root 所有；独立 `api.env` 为 root:root 0600，由 systemd manager 注入采集服务环境 |
| 研究数据 | `/var/lib/dimension-research`，专用账号所有，0700 |
| 总资源边界 | `dimension-research.slice`：CPUQuota 20%、MemoryMax 256 MiB、禁 swap、TasksMax 32 |
| I/O 边界 | 研究 slice 读带宽 2 MiB/s、写带宽 1 MiB/s、IOWeight 10 |
| 单个采集进程 | MemoryMax 192 MiB、TasksMax 20、Nice 10、单文件最大 16 MiB |
| 独立心跳 | MemoryMax 32 MiB、TasksMax 4、无 API 环境文件、无网络 |
| root 调度协调器 | MemoryMax 32 MiB、TasksMax 4、无 key/网络；仅读取研究数据并管理固定 `dr-t50-<hex64>` 单元 |

slice 的 CPU 20% 指一个 CPU 核心时间的 20%，是所有研究进程共享的总上限，不能理解为每个进程各占 20%。安装器在启用定时器前读回实际 cgroup 的 `cpu.max`、`memory.max`、`memory.swap.max`、`pids.max`、`io.max`；不生效则拒绝启用。配置规则依据 [systemd resource-control 官方文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)。

数据总量门槛为 512 MiB，要求文件系统至少保留 1 GiB 可用空间，并限制单响应大小及请求数。**这是应用层拒写门槛，不是独立分区、文件系统硬配额或 WORM。** 采集账号不具备 root 或发布凭据，但仍拥有自己的研究目录；不可把应用层 append-only 视为能抵抗该账号任意恶意操作的不可篡改存储。达到容量门槛后停止写入，不自动删除历史来伪装连续运行。

## 两条独立调度链

1. **600 秒研究槽**：`dimension-research-collector.timer` 使用 `OnCalendar=*-*-* *:00/10:00 UTC`。以绝对 UTC 槽计算 `scheduledFor`，不从上一轮结束时间重新起算。当前保守请求预算下，每槽轮换一个联赛，至多选其中一场取得赔率；它不代表五个联赛每十分钟全量抓取。
2. **T−50 单场事件**：采集到真实赛程后建立含赛事身份、开球修订和来源组的持久计划；root `dimension-research-reconcile.timer` 每分钟只读这些计划，生成固定内容、绝对 UTC `OnCalendar` 的一次性 `dr-t50-<hex64>.timer/.service`。实际事件采集以专用账号运行，仍受同一个研究 slice 限制。

独立 `dimension-research-heartbeat.timer` 每分钟写入本地心跳，并在计划时间后 300 秒检查未完成或失败的槽；告警只写本地证据，不向外发送消息。它独立于上游 HTTP，但仍受同机、总资源与存储可用性影响；不能承诺在磁盘损坏、整机断电或 OOM 时仍能告警。

机器应持续同步 UTC 时间。`AccuracySec=1s` 和 `RandomizedDelaySec=0` 限制 systemd 合并窗口及随机延迟，不能保证硬实时；实际启动/结束时间和偏差必须留在回执。周期定时器的 `Persistent=true` 会在重新激活后触发补检查，补执行必须如实标记迟到或漏槽，不能冒充之前准时成功。参见 [systemd.timer](https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html) 与 [systemd.time](https://www.freedesktop.org/software/systemd/man/latest/systemd.time.html)。

T−50 单元文件持久保存在系统目录，协调器在重启后重新启动仍在未来的计划；这些单次 timer 使用 `Persistent=false`，不会补抓已经错过的时点，过期计划由心跳记录 `NOT_RUN`。T−50 对取消、改期、重启、重复触发、源失败和晚到分别记录；轮换赛程发现可能漏掉刚新增或刚改期的目标。只有取得真实事件计划与时钟回执后才能计算覆盖分母，不能用 GitHub cron、ChatGPT 整点监控、模拟时间或历史 RAW 代替真实 T−50 证据。

## 安装：先核验，再启用

安装要求 Linux/systemd 249+、统一 cgroup v2 的 cpu/memory/pids/io 控制器、Python 3.10+、NTP 已同步，至少 512 MiB `MemAvailable`、相关文件系统至少 2 GiB 可用。安装器不安装系统包、不修改系统默认 Python/Node、不修改旧服务。

从审查过的同一候选构建 `SHA256SUMS`，包括本目录全部交付文件，使用标准 `sha256sum` 两空格格式。通过受认证渠道另行固定该清单自身的 SHA-256；不要仅相信与未知文件同时收到的摘要。上传后，由已授权 root 执行身份把完整候选放入 root 所有、无组/其他写权限、无符号链接祖先的暂存目录，例如 `/root/dimension-research-staging`。安装器拒绝从 `/tmp` 或普通账号可修改目录直接运行。

```sh
# 无状态语法检查及清单检查，须在已核准候选目录执行。
bash -n install.sh
sha256sum --check --strict SHA256SUMS

# 默认只安装，不启用。FULL_SHA256 是清单本身的外部已核准摘要。
sudo bash install.sh \
  --target-instance-id i-j6c4g9s2y6b5irl5gcr9 \
  --manifest-sha256 FULL_SHA256
```

若本次已批准安装并启动，使用同一命令追加 `--enable`。由于安装器拒绝覆盖已有研究目录、账号、单元或 timer 痕迹，不能用第二次运行安装器完成启用；已安装但未启用时，管理员可在审查后仅启用这三个新定时器：

```sh
sudo systemctl enable --now dimension-research-heartbeat.timer \
  dimension-research-reconcile.timer dimension-research-collector.timer
```

安装器使用 [阿里云官方 IMDSv2](https://www.alibabacloud.com/help/en/doc-detail/49122.html) 只读取得实例 ID，必须与固定目标相同；不读取 RAM 凭据端点，不接受 IP/域名或命令参数自行声称的主机身份。校验器读取并严格解析现有 `/etc/vantis/collector.env` 中**唯一** `API_FOOTBALL_KEY`，仅将该键复制到 root 专属可读的独立 `api.env`，由 systemd manager 在切换运行账号前读取并注入采集进程。它不会 `source` 原文件、执行其内容、打印值或复制 Telegram/Sites token。

任何预存研究路径/账号/单元都使首次安装拒绝；不盲目覆盖或接管遗留部署。安装失败保留新文件供检查，不触碰旧服务；若本轮已经安装新单元，则错误处理尽量停用本轮的新周期定时器。失败后由管理员核实现场，不能将 `INSTALL_COMPLETED` 当成运行验收。

云助手上传较大包时，官方限制 **Run 的 Base64 编码后脚本不超过 24 KB，Run And Save 不超过 18 KB**。建议每条明文脚本控制在 12 KiB 内，在 root 专有临时目录按固定编号分块落盘，避免重试追加重复块；合并后核验完整归档 SHA-256，解包前检查路径与文件类型。源码传输包不应含 key。参见 [RunCommand API](https://www.alibabacloud.com/help/en/ecs/developer-reference/api-ecs-2014-05-26-runcommand) 和[控制台立即执行](https://www.alibabacloud.com/help/en/ecs/user-guide/use-the-immediate-execution-feature)。

## 无秘密验收与停止

```sh
sudo systemctl show dimension-research.slice \
  -p ControlGroup -p CPUQuotaPerSecUSec -p MemoryMax -p MemorySwapMax -p TasksMax \
  -p IOReadBandwidthMax -p IOWriteBandwidthMax
sudo systemctl list-timers --all 'dimension-research-*' 'dr-t50-*'
sudo systemctl show dimension-research-collector.service \
  dimension-research-heartbeat.service dimension-research-reconcile.service \
  -p User -p Slice -p Result -p ExecMainStatus -p ActiveState
sudo journalctl -u dimension-research-collector.service \
  -u dimension-research-heartbeat.service -u dimension-research-reconcile.service \
  --since '-1 hour' --no-pager
```

检查生产基线时只读记录原 `.source-commit`、既有单元状态、原站与消息桥健康，安装前后对照；旧服务若事先已经失败，不能把它说成本次新故障，更不能顺手修复或重启它。日志不得附 API key、完整 env 或受限 RAW 正文。

运行成功的 oneshot 可以显示 `inactive/dead`；结合退出状态、真实时钟与持久回执判断。至少保留四个相邻真实 600s 槽、独立 60s 心跳、真实漏/迟槽告警、RAW 跨进程同 SHA 读回和重启后相同对象验证；T−50 另看真实逐场事件，二者不可互代。少于 24 小时观测不计算 24h SLO，部分来源或晚到不能写成功。独立 QA 仍需对固定候选与真实事件抽查，正式预测发布继续阻断。

暂停时先停新协调器，再停新周期采集与心跳，最后逐个停用本项目生成的严格 `dr-t50-<hex64>.timer`；保留源码、数据与回执供核对。不要用宽泛 `vantis*`、`systemctl reset-failed` 或删除生产目录作为卸载方式，也不要在研究服务仍写入时删除数据。
