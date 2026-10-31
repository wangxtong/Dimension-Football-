# A9：R1架构与部署说明核对

审查基线：`afb2345f36c6822037b3037e1730e52de1a0d630`，2026-10-31。范围：#27/#28/#29；PR #30 已合并，PR #21/#26仍为Draft。只列本次读取证据，生产实际状态需另取现场材料。

## 当前路径

| 路径 | 源码事实 | 交接责任 |
| --- | --- | --- |
| 当前过渡采集 | main AGENTS.md允许Actions短期OIDC向原Site私有R2发布脱敏观测；live-publication.yml默认observations | A6/A8提供实际运行、状态恢复和同投影报告回读；A1判定 |
| ECS目标 | 部署包与服务脚本仍保留；没有已验证ECS命令身份 | A7提供精确制品和实际安装证据，不能把hosted成功叫ECS成功 |
| 正式预测 | R1对外预测入口拒绝；默认观测不追加预测账本/回放、不发通知 | A4/A5提供商业模型/数据证据，A10独立验收，A1归并 |

live-publication.yml调度目标为5分钟，公开赛程请求受15分钟采集周期和预算约束；这些是配置目标，不是已测SLA。public-sources.yml保留独立过渡归档。README仍主要描述先前“Actions只归档、ECS唯一发布”的目标，需要A1协调更新，不能依旧文字关闭已授权观测路径。

## 已确认的文档冲突

| 文件 | 当前内容 | 应采用的准确说明 |
| --- | --- | --- |
| README.md ECS步骤1 | “新版bootstrap不在线下载安装Node” | 默认不安装；显式--install-node且系统Node不可用时可下载固定官方运行时 |
| deploy/bootstrap.sh | 接受可选--install-node；验证系统Node24.14+能力，不合格且无选项则失败 | 应用源码包是离线制品，Node运行时的可选联网安装是另一条路径 |
| docs/WORKBENCH-HANDOFF.md | 示例带--install-node | 不是必选参数，也不证明当前已执行；Node已满足时不会下载 |
| deploy/install-node.sh | 固定v24.19.0，官方HTTPS源及SHA-256检查，独立/opt/vantis-node目录 | 不修改系统Node；不等于独立签名验证，不应写成“完全不联网” |

本变更仅在A9文件域内给出准确契约；README和运维交接正文的协调修订交A1/A7，避免覆盖其在途变更。不得执行bootstrap来“验证文档”，本轮只做静态核对和离线契约回归。正式预测仍为RELEASE_GATE=BLOCKED。

## 交接待办

1. A1/A7：统一README/Workbench与当前R1路径、默认/可选Node安装描述；确认构建与安装使用同一精确版本。
2. A1：角色PR #26的A1只读权限与共享集成职责有冲突；A9/A10的角色扩展和五阶段路由尚未在main生效。后续合并必须保留R1 AGENTS生产边界。
3. A10：QA子目录如新增测试，须确认进入默认CI；独立复核来源和模型为首要商用门槛。测试可用通知不等于商业验收。
4. A3/A4：保留旧账本，不补造modelHash/recordedAt；缺元信息的历史记录应排除或标记局限，不能追认成真实前瞻样本。
5. A6/A8：观测投影使用新的reportId，通过originReportId绑定；不得套用“原始报告ID必须与脱敏报告ID相等”的旧假设。
6. A6/A10：本地loadReportBundle对current校验保存摘要，历史reportId读取缺同等持久摘要比对；与hosted每次校验的实现不同。评估历史档案完整性边界并补有针对性的测试，不把现有65项通过扩展为历史篡改全覆盖。

## 本轮验证边界

在Node.js 24.22.1对上述精确main源码执行7个既有测试文件，65项通过、0失败：prediction-ledger、market-evidence、publication、report-store、outbox、hosted-release、hosted-publications。覆盖实际登记提前量、赛果回填、混cohort拒绝、初盘冲突、摘要篡改、状态CAS、未知通知不重发、投影ID及正式发布拒绝。

这是离线行为回归，使用仓库测试fixture/协议替身；不是正式比赛回测、实时来源可用率、真实R2/Telegram或ECS验收。本轮没有修改业务代码或发布策略，没有签发放行材料。
