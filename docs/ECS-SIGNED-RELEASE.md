# ECS 独立签名代码发布门禁（A7，待 A1 验收）

**状态：BLOCKED；未部署。** GitHub CI GREEN、main 更新、归档或离线包 SHA-256 均不是 ECS 部署授权。此门禁只允许经独立审批的代码版本切换，不批准足球预测、Telegram 发布或任何服务器变更。

## 权限与信任边界

- A7 不持有 ECS/SSH/RAM/Workbench 身份，没有读取或创建生产凭据。以下操作仅由有权限的管理员及独立批准人执行；不得在 Issue/PR/聊天中披露任何私钥或 token。
- 离线包先在受信任渠道核对 CI 完整提交 SHA 与 SHA-256；不要信任不明附件附带的 SHA256SUMS。独立审核 CI run、旧版本无回归、上线授权，签名声明中的成功状态不等于程序实时验证了 GitHub。
- 专用离线 Ed25519 私钥必须留在安全签名环境，不能放在 ECS、仓库、ChatGPT 或网站。ECS 上仅安装 root 固定的公钥 /etc/vantis/release-authorization.pub.pem。
- /etc/vantis 和 /etc/vantis/release-approvals/ 必须 root 所有、不可组/其他人写，建议审批目录 0700。每次批准须有 <sourceCommit>.json 与对应 <sourceCommit>.json.sig 原始二进制签名。缺失、过期、摘要不一致、签名损坏或目录权限不安全均拒绝。
- install.sh 在任何安装变更前验签；release.sh 在取得部署锁及采集运行锁后验签；deploy-key 模式的 sync.sh 即使拉到 main 且测试 GREEN 仍须事先验签。升级时 install.sh 优先调用已安装的 verifier，而不是让新来源替换旧检查。
- 已有 ECS 若装的是旧工具，新的 GitHub 改动无法证明服务器已执行新门禁。管理员必须先暂停旧版自动切换、审查并受控升级工具，回读真实部署 SHA。绝不因 PR/CI 通过自动更新生产。

## 审批 JSON 示例（所有值只是占位符，禁止直接用于生产）

```json
{
  "version": 1,
  "scope": "ecs-code-release",
  "sourceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "archiveSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "toolingDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "ciRunUrl": "https://github.com/wangxtong/Dimension-Football-/actions/runs/123",
  "ciCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "ciConclusion": "success",
  "previousVersionRegressionPassed": true,
  "ecsAuthorizationGranted": true,
  "approvedBy": "AUTHORIZED_DEPLOY_APPROVER",
  "reviewedBy": "INDEPENDENT_REVIEWER",
  "approvedAt": "2026-10-31T10:00:00Z",
  "expiresAt": "2026-11-01T10:00:00Z"
}
```

sourceCommit、archiveSha256、toolingDigest 必须与已验证解包的 vantis-manifest.json 完全相同。审批人和复核人必须不同。批准期最长 7 天；不能为未知 CI、未知回归或未授权的部署将字段设为 true。

## 离线生成及校验 detached Ed25519 签名（OpenSSL 3）

```bash
# 首次仅在独立安全工作站创建，绝不上传私钥到 ECS
openssl genpkey -algorithm ED25519 -out /secure/offline-ecs-signing-private.pem
openssl pkey -in /secure/offline-ecs-signing-private.pem -pubout -out /secure/release-authorization.pub.pem
openssl pkeyutl -sign -rawin -inkey /secure/offline-ecs-signing-private.pem -in /secure/FULL_SHA.json -out /secure/FULL_SHA.json.sig
openssl pkeyutl -verify -rawin -pubin -inkey /secure/release-authorization.pub.pem -in /secure/FULL_SHA.json -sigfile /secure/FULL_SHA.json.sig
```

有 ECS 管理权限的人经过独立批准后通过受控渠道安装**公钥**、批准文件及签名；在运行 bootstrap.sh 或 release.sh 之前就要具备签名证据。私钥不应出现在服务器上。

## Issue #14 必需的无秘密 Workbench 证据

1. 当前 ECS 实装的 /opt/vantis/deployment 工具摘要、release source SHA、source-mode、timer 状态，核对旧版是否仍可绕过验签自动更新。
2. 实际 CI run URL、完整 commit、发布包 SHA256、公钥指纹、审批 JSON 摘要和已安装 .source-commit/release.json 的一致性，不上传密钥/token。
3. 只读 diagnose.sh 的 systemd/健康结果、/var/lib/vantis 权限、备份校验、restore-drill、回滚兼容性及重启后 state/outbox；不能用 oneshot inactive/dead 判断失败，也不能用 GREEN 单测当成生产验收。
4. HTTPS /dimension-football/ 未授权拒绝、正确授权时 reportId 与摘要一致、旧 Gunicorn 和 /weidu-bridge/ 无回归；不修改原站 TLS/Nginx/安全组来伪造结果。
5. 正式预测继续 BLOCKED：五大联赛冻结前瞻回测、独立盘口源、批准与实际 ECS smoke 全部需要 A1 门禁，不可向网站或 Telegram 放行正式预测。

此 PR 只是候选实现；不得自动合并或自动生产部署。
