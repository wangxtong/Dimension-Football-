# ECS 独立签名代码发布门禁（A7，待 A1 验收）

**状态：BLOCKED；未部署。** GitHub CI GREEN、main 更新、归档或离线包 SHA-256 均不是 ECS 部署授权。此门禁只允许经独立审批的代码版本切换，不批准足球预测、Telegram 发布或任何服务器变更。

## 权限与信任边界

- A7 不持有 ECS/SSH/RAM/Workbench 身份，没有读取或创建生产凭据。以下操作仅由有权限的管理员及独立批准人执行；不得在 Issue/PR/聊天中披露任何私钥或 token。
- 离线包先在受信任渠道核对 CI 完整提交 SHA 与 SHA-256；不要信任不明附件附带的 SHA256SUMS。独立审核 CI run、旧版本无回归、上线授权，签名声明中的成功状态不等于程序实时验证了 GitHub。签名另须绑定完整 `manifest.files` 的规范化摘要 `filesDigest`：**单独签署归档摘要字符串并不能阻止已经解包的目录修改文件清单后冒用旧 SHA**；`bundle.py verify-directory` 必须继续逐文件验证。
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
  "filesDigest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "ciRunUrl": "https://github.com/wangxtong/Dimension-Football-/actions/runs/123",
  "ciCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "ciEvent": "push",
  "ciBranch": "main",
  "targetInstanceId": "i-j6c4g9s2y6b5irl5gcr9",
  "ciConclusion": "success",
  "previousVersionRegressionPassed": true,
  "ecsAuthorizationGranted": true,
  "approvedBy": "AUTHORIZED_DEPLOY_APPROVER",
  "reviewedBy": "INDEPENDENT_REVIEWER",
  "approvedAt": "2026-10-31T10:00:00Z",
  "expiresAt": "2026-11-01T10:00:00Z"
}
```

**不得把 PR CI 的绿色检查或附件当作可签署生产制品**：pull_request 的 GITHUB_SHA 通常是临时 merge commit（与 PR head 不同）。必须审核独立 **main push** CI，验证 event=push、branch=main、真实 main SHA 与来源归档一致；GitHub artifact ZIP 的 digest 不是内层 release.tar 的摘要。

sourceCommit、archiveSha256、toolingDigest 必须与已验证解包的 vantis-manifest.json 完全相同；filesDigest 必须由**同一已验证解包目录**的 `manifest.files` 算出。签名验证器对全部条目的排序、SHA 与字节长度计算固定摘要；本身不读取未校验文件内容，部署调用方必须先完成 `bundle.py verify-directory`。审批人和复核人必须不同。批准期最长 7 天；不能为未知 CI、未知回归或未授权的部署将字段设为 true。

在独立签署环境、确认离线归档 SHA 和解包目录校验均通过后，按以下定义计算 `filesDigest`（规范 UTF-8 JSON：按路径 UTF-8 字节序排序的 `[path, sha256, size]` 数组，无多余空白）。只输出公开摘要，不处理密钥：

```bash
python3 - /secure/verified-source/vantis-manifest.json <<'PY'
import hashlib, json, sys
with open(sys.argv[1], encoding='utf-8') as stream:
    manifest = json.load(stream)
entries = [[name, item['sha256'], item['size']]
           for name, item in sorted(manifest['files'].items(),
                                    key=lambda pair: pair[0].encode('utf-8'))]
canonical = json.dumps(entries, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
print(hashlib.sha256(canonical).hexdigest())
PY
```

将该结果填入审批 JSON 的 `filesDigest`，**再**生成 detached 签名；不接受缺失该字段的旧批准。此处示例摘要均为占位符。

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
2. 实际 CI run URL、完整 commit、归档 SHA256、已核验文件清单的 filesDigest、toolingDigest、公钥指纹、审批 JSON 摘要和已安装 .source-commit/release.json 的一致性。增加负例：保留签名审批的旧 commit/archiveSha256 字段却篡改解包后单一文件及其 manifest.files 摘要时，安装与同步必须拒绝；不上传密钥/token。
3. 只读 diagnose.sh 的 systemd/健康结果、/var/lib/vantis 权限、备份校验、restore-drill、回滚兼容性及重启后 state/outbox；不能用 oneshot inactive/dead 判断失败，也不能用 GREEN 单测当成生产验收。
4. HTTPS /dimension-football/ 未授权拒绝、正确授权时 reportId 与摘要一致、旧 Gunicorn 和 /weidu-bridge/ 无回归；不修改原站 TLS/Nginx/安全组来伪造结果。
5. 正式预测继续 BLOCKED：五大联赛冻结前瞻回测、独立盘口源、批准与实际 ECS smoke 全部需要 A1 门禁，不可向网站或 Telegram 放行正式预测。

此 PR 只是候选实现；不得自动合并或自动生产部署。

### 首次安装的可信引导边界（2026-10-31 A7 修复，Draft）

**不能从待安装归档里执行用于认证该归档的校验器。** 新版 bootstrap 在运行来源包中的任何 Python/Node/shell 代码、Node 下载或服务安装前，先使用 Python 标准库只读验证完整 tar SHA-256、单一 manifest，再由 ECS 管理员独立预置且 root 独占的 `/opt/vantis/deployment/release-authorization.mjs` 校验独立签署批准。归档实际解包使用同样独立预置的 root 可信 `/opt/vantis/deployment/bundle.py`；直接调用 install.sh 也必须调用这些可信工具，不再回退到候选包里的同名脚本。预先存在的 Node（可解析到 root 拥有、无组/其他写权限的真实文件和父目录）必须足以运行 Ed25519 签名验证；之后才可以受控使用已批准包中的 `install-node.sh` 补齐 24.14+。无 Node、无独立安装的可信校验器或可信 bundle 解析器时，一律 BLOCKED，**不允许为了方便使用未验签来源脚本自举安装**。

有权限的 Workbench 管理员需在可信渠道独立审核工具来源及摘要、确认旧版可能存在的直推入口已停用，并预置上述只读可信工具与必要的可信 Node；这**不是**由 GitHub 工作流自动安装或 A7 远程执行。首次预置不能通过刚接收的未经认证的发行包直接拷贝校验器来冒充信任。安装后在 Issue #14 回填不含秘密的 verifier/bundle 文件 SHA-256、所有权及权限、公钥指纹、批准文件摘要、精确 main CI run 与 ECS 实际 SHA；不得提交私钥或机密 env。维护期间若候选版本缺少此前已信任的工具，先阻断，由 A1 复核可信工具升级策略。
