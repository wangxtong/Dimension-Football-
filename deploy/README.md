# ECS 部署与运维

详细流程见 [OPERATIONS.md](../docs/OPERATIONS.md)。本目录只提供实现和离线验证工具，不代表服务器已安装。

- `bundle.py build REPO FULL_SHA OUTPUT.tar`：仅打包提交中的允许文件，生成摘要清单。
- `bootstrap.sh ARCHIVE EXPECTED_SHA256 [--install-node]`：离线校验、解包并安装；可选从官方固定发行和 SHASUMS 安装独立 Node runtime，不匿名下载私库、不更改系统默认 Node。
- `install.sh VERIFIED_SOURCE`：受限测试账号验收，更新独立部署工具、配置模板和 systemd 单元，保留已有秘密及状态。
- `release.sh VERIFIED_SOURCE`：校验源、状态兼容及运行能力，原子切换应用版本。
- `sync.sh` / `git-source.sh`：可选的固定私库只读 deploy key 同步，强制已核验 SSH 主机密钥；默认 artifact 模式不启用。
- `run.sh`：统一 OS 锁下的每分钟分层调度入口，不能绕过它执行生产手动采集。
- `persistent-config.py`：显式选择统一状态路径，保留旧状态；调度、发布兼容检查、回滚和锁恢复使用同一配置。
- `health.sh`：独立每分钟健康与修复任务进度 JSON，不读取秘密、不调用 AI。
- `report-server.sh`：启动需要服务授权的 loopback 报告服务，使用独立 `report.env`；HTTPS 反代另行核实。
- `diagnose.sh`：Workbench 可执行只读诊断，不测试网络、不读取秘密。
- `ensure-report-secrets.py`：安装时原子补齐缺失的机器 token，保留合法旧值，不输出秘密。
- `nginx-namespace.py`：默认计划；`--apply` 仅向已有匹配 HTTPS server 插入 `/dimension-football/`，备份、验证并加载；失败恢复，不覆盖原站或 bridge。
- `backup.sh` / `restore-drill.sh`：统一锁下备份与临时目录恢复演练，不自动覆盖生产。
- `recover-state-locks.sh`：停用调度后安全移除确认死亡进程的旧 JSON 锁。
- `rollback.sh RELEASE_ID`：检查状态兼容后切换已保留版本，不回滚秘密或盲目恢复旧状态。

发布后核对 `operations/release.json`、`operations/health.json`、真实网站报告及 outbox 回执。成功 oneshot 显示 inactive/dead 正常；生产验收不能只看服务是否持续 active。
