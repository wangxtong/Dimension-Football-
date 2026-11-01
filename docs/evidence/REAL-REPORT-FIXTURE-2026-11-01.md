# 真实报告固定基线与旧展示资产退役

负责人：A3；独立复核：A8；集成和发布裁决：A1。实现基线 `4eae4d8133167ecc28db9c90709ace78267c8a5e`。本记录只涉及本地归档恢复和离线验证，不证明已同步仓库、部署网站或通过商业模型验收。

## 来源与不可混用的两份报告

新固定报告来自已完成的 [Actions 运行 41285125481](https://github.com/wangxtong/Dimension-Football-/actions/runs/41285125481)，没有重新采集后冒充旧快照。

| 字段 | 实际值 |
| --- | --- |
| Artifact | `13074039427` / `public-archive-report-41285125481-1` |
| 上游 ZIP SHA256 | `47abd070cbb520cf581a17c6706c5271d097ec034d986c9a1d44c4923ccff38e` |
| Artifact 到期 | `2026-12-01T07:31:47Z`；仓库固定 fixture 不依赖此链接长期存活 |
| Report ID | `e541ec0487829321212c9c95d84a4790888baa7c0f0f284a6e72745e728902c6` |
| 输入源码版本 | `17931a231f6f11ccbf191fff855eae7930ad3466` |
| 原始生成时间 | `2026-11-01T07:31:46.322Z` |
| 展示资产导出时间 | `2026-11-01T07:44:12.312Z`；复现时使用相同时间 |
| 数据 | 非模拟；12 场赛程、376 条历史输入；25 个回顾评估分组 |
| 固定包 | 30 个原始 JSON，原字节合计 4,081,268；包装 JSON 5,449,119 字节；gzip 789,879 字节 |
| 固定 gzip SHA256 | `18ee97ef2cc8ceb3aa5fbdd49d5989c574d164b56b76b1e8982cf3e49798345a` |

旧资产 `d9d61ff8969b662a1a82b9ead07dcfa83e200104d2eb4484c8bff84866dc804c` 绑定源码 `5611605dcdf02636e0c8338f5978ac8d68b65508`，生成于 `2026-10-31T07:50:21.243Z`。其原始目录 `/tmp/dimension-upgrade-final/reports` 已不可用，本轮没有恢复匹配的 `latest.json`、完整回放输入及清单。另一个可下载的 06:39 制品属于 `ca8badaa…`，不能替代它。

旧展示 JSON 原字节保存为 `retired-evaluation-d9.json`，SHA256 仍是 `6216912148bd1af0178157c3aedc662fb3bb9cdd11ee1b2e228310c5a3190f7e`。这是保留退役摘要，不是恢复旧输入。它不再作为网站当前展示资产，也不进入站点打包的静态资源列表。新的 `website/evaluation-evidence.json` 用现有导出器从 e541 原报告生成，不修改旧绑定、不放宽验收条件。

## 恢复契约

`collector/test/fixtures/real-report-e541…json.gz` 包含版本、完整 reportId、源码 SHA、来源运行和制品编号、原 ZIP 摘要、固定导出时间及 `{path, sha256, bytes, content}` 文件列表；`content` 是原 UTF-8 JSON 字节的 base64。gzip 的时间头固定为 0，文件顺序固定。

仅收录当前报告、赛程/历史快照、发布回执、输入/清单及本轮实际预测账本 JSON。没有环境文件、凭据、通知 outbox、脚本或部署执行器。恢复器先校验固定 gzip 摘要，再检查容量、白名单路径、重复项、base64、每文件字节摘要和报告/回放绑定。只接受父目录存在、无符号链接的全新绝对目标路径；已有目录即使为空也拒绝，避免覆盖工作成果。

上游制品未保存隐藏 `.delivery`。恢复器在核验原 JSON 后，按现有 report-store 格式派生本地 `current/content/receipt` 三个 JSON，并用 `loadReportBundle()`复验。这三个文件是**本地测试存储重建**；不是原始历史隐藏文件，也不代表网站发布、Telegram 发送或接收回执。回执仍保留网站和通知未配置的原状态。原回执所列 MD/HTML 未收入本 JSON fixture，不将重建过程称为对完整原发布包的复验。

复现命令（目标路径须尚不存在）：

```bash
node scripts/restore-report-fixture.mjs --out /tmp/dimension-fixed-e541
EVALUATION_TEST_REPORT_DIRECTORY=/tmp/dimension-fixed-e541 \
HOSTED_TEST_REPORT_DIRECTORY=/tmp/dimension-fixed-e541 \
node --test --test-isolation=none \
  collector/test/restore-report-fixture.test.mjs \
  collector/test/export-evaluation.test.mjs \
  website/test/evaluation-asset.test.mjs \
  website/test/hosted-worker.test.mjs
node collector/export-evaluation.mjs \
  --reports /tmp/dimension-fixed-e541 \
  --output /tmp/dimension-e541-evaluation.json \
  --now 2026-11-01T07:44:12.312Z
cmp website/evaluation-evidence.json /tmp/dimension-e541-evaluation.json
```

## 实际效果与验收边界

修复前：当前 CI 缺原报告目录，两项依赖真实文件的检查被条件跳过。修复后：新的固定输入可离线恢复，同时给出两项检查所需目录；摘要导出必须与当前展示资产逐字节相同。旧输入缺失仍如实保留，未重标为已恢复。

本轮已运行 fixture 安全、导出复现、真实摘要、Worker 投影及相关 UI/TG 测试，**42 通过、0 失败、0 跳过**。真实输入条件检查已执行。负例覆盖损坏、超大解压、路径逃逸、重复项、伪造摘要、脚本/凭据路径、符号链接和覆盖；预期 `RELEASE_GATE_BLOCKED` 日志予以保留。浏览器断言中的历史数值已随真实资产更新；本岗位尚未运行新的 Chromium 验收，由总控/A8执行。

新 24 小时回顾：德甲 63 场、跳过 17 场，方向命中 49.2063%，Brier 0.5899886，同场基准 0.6295544；配对 Brier 差值的近似 95% 区间为 [-0.09124, 0.01210]，跨越零。1 小时回顾命中同为 49.2063%，Brier 0.5901114。五联赛前瞻结算均为 0。

新旧快照的输入及评估集不同，不能把这次资产更换当作算法升级对照。比旧展示更低的命中率如实展示，不保留旧较好数值掩盖新样本结果。当前仅确认归档可复现和上述测试通过；未证明模型改进、概率校准或商业推荐资格。

下一阶段：A8独立恢复并核验两项条件检查；A1将恢复步骤纳入完整必测流程并核对浏览器/精确提交 CI。模型前瞻采样和正式晋升另行验收，`RELEASE_GATE=BLOCKED`。
