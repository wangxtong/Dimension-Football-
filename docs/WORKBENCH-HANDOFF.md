# 现有阿里云服务器部署交接

目标：`i-j6c4g9s2y6b5irl5gcr9` / `8.218.6.246` / `football.fotpredict.xyz`。历史部署记录使用 `ecs-user` 和 sudo。当前插件没有可执行 ECS 命令的身份；不能从公网健康接口执行部署，也不能从 GitHub 读出 Actions Secrets 的值。

GitHub 和 Sites 已连接的能力继续由总控执行。唯一需要服务器端执行的步骤如下，不需要在聊天中提供 SSH 私钥、阿里云密码或新的机器人令牌。

## 发布前置：独立签名、审批与旧版保护

**A7 签名保护为 Draft，尚无 ECS 安装证据。** 正式安装前按 [ECS-SIGNED-RELEASE](ECS-SIGNED-RELEASE.md) 完成独立 CI/SHA 核对、源目录逐文件校验与 filesDigest 绑定、旧版回归、离线 Ed25519 签名，并由授权管理员在 Workbench 根目录固定公钥及精确 commit 的签名 JSON/二进制签名。缺失即 BLOCKED。核对服务器已装 release.sh/sync.sh 的工具版本：旧版可能仍直接跟随 main 更新，须先由管理员暂停其自动切换、受控升级。签名只授权代码切换，不批准正式预测或 TG 消息。不得用 GitHub 权限替代 ECS 身份。

**首次安装额外前置（当前只是代码候选）**：在使用 `bootstrap.sh --install-node` 之前，已授权 ECS 管理员须独立审核并在服务器 root 保护目录预置 `/opt/vantis/deployment/release-authorization.mjs`、`/opt/vantis/deployment/bundle.py` 及可运行签名校验的可信 Node；缺任意项则 bootstrap 提前拒绝，绝不能执行未批准来源自带的 bundle.py / install-node.sh 进行自举。需记录三个工具的非秘密摘要、root 权限及来源证明至 Issue #14。流程和首次信任边界见 [ECS-SIGNED-RELEASE](ECS-SIGNED-RELEASE.md)。此处不授权安装、不表示 ECS 已完成预置。

## 获取准确部署包

在本仓库 Actions 的“采集项目验证”成功运行中，下载 `dimension-ecs-<完整提交SHA>` 附件。附件只有已测试提交的源快照、文件摘要及 bootstrap 工具，不含秘密。将附件解压后的文件上传到 Workbench 所在服务器的一个独立目录。使用本次验收给出的 SHA256，而不是不明下载链接中的校验值。

在这个目录执行以下命令，其中 `EXPECTED_SHA256` 替换为本次发布记录中的实际摘要：

```bash
sudo bash ./bootstrap.sh "$PWD/dimension-ecs-release.tar" EXPECTED_SHA256 --install-node
sudo python3 /opt/vantis/deployment/nginx-namespace.py --apply
```

第一步校验包、运行不带秘密的测试并安装独立服务；缺少合适 Node 时仅安装固定版本到 `/opt/vantis-node`。第二步只在已知 HTTPS server 中增加 `/dimension-football/`，保留旧站和 `/weidu-bridge/`；配置有歧义就停止，验证失败会恢复备份。不需要开放 8787 或修改 SSH 安全组。

## 将站点连接信息交给总控

安装器自动生成缺失的两份独立机器令牌；已有合法值不覆盖。下面的公钥只用于本次会话，公开公钥不包含登录秘密。命令输出 `VANTIS_LINK1.` 开头的加密回执，把该回执返回总控即可由 Sites 插件完成配置。不要输出整个 env 文件。

```bash
sudo bash <<'LINK'
set -euo pipefail
IFS= read -r dimension_node < /etc/vantis/node-path
"$dimension_node" /opt/vantis/deployment/link-site.mjs \
  --recipient 'MCowBQYDK2VuAyEA4vANM9dCslIK/EUaU5wJs8Jg6zF5u0rzp9hEXa13l3M=' \
  --origin 'https://football.fotpredict.xyz/dimension-football/'
LINK
```

接收私钥保留于当前总控会话，不在仓库或部署包中。若原会话不可恢复，应生成新的接收公钥再导出，不能把加密输出当作可直接填入 Sites 的令牌。

## 验收与剩余配置

总控配置站点后，应检查同报告 ID/摘要的 HTTPS 回读、手机页面、重启后的持久状态及通知 outbox；不能仅凭 `INSTALL_COMPLETED` 宣称生产接通。可以用 `sudo bash /opt/vantis/deployment/diagnose.sh` 获取不含秘密的诊断，健康记录在 `/var/lib/vantis/operations/health.json`。

安装不会猜测或复制其他项目的 Telegram 配置。如果本实例尚无当前项目的 `TELEGRAM_BOT_TOKEN` 和正确 `TELEGRAM_CHAT_ID`，通知会明确保持未配置；保留用户既有机器人及已核对目标，不把旧 bridge 机器人当成同一渠道。此前已提供的凭据应由已授权的安全通道复用，不要求用户重复发明文。

持续验收完成后才将仓库变量 `VANTIS_ECS_PRIMARY` 设为 `true`，关闭过渡小时归档。部署回滚、锁恢复及备份操作见 [OPERATIONS.md](OPERATIONS.md)。
