# 维度足球｜GitHub 专业智能体角色

八个专业角色定义位于此目录，采用 GitHub Copilot 的 `.agent.md` YAML frontmatter 格式。**文件本身是角色定义，不意味着 8 个 AI 实例已经运行**。只有本 PR 合并到默认分支且仓库/账户启用 Copilot cloud agent 后，GitHub 才可能在 Agent picker 中发现这些角色。

## 任务协作协议
1. **A1 总控**先验真实 main SHA 与 Issue/PR，分配接口契约；不得假设 Draft PR 已合并。
2. **A2/A3 数据**整理合法权限、身份、原始时间和冻结赛前历史；可以独立编写修复 PR，不能宣称数据源已开通。
3. **A4/A5 模型与盘口**分别负责预测概率评价、双源及真实初盘证据，结论必须独立验证。
4. **A6/A7/A8 交付、ECS、网站**各自维护代码域和负例测试；任何外部推送或部署须有全绿发布门禁和现场证据。
5. 每项工作以 GitHub Issue 为任务单位，使用独立分支和 **Draft PR**；修改共享入口（如 workflow、AGENTS.md、package.json、collector/orchestrate.mjs）前由 A1 协调。
6. Reviewer 复核原始报告时间、来源、Git SHA、CI 运行链接、负例、测试覆盖与受影响模块；`review` 不等于 `verified`。
7. 回测/权限/商业 API/生产身份缺失时保持 `BLOCKED` 或 `UNKNOWN`。不得“写 GREEN 文件”模拟验收；禁止未审批自动合并、生产部署或对外预测通知。

## 当前工作单与验收
| 角色 | GitHub Issue | 专长 | 复核 |
| --- | --- | --- | --- |
| A1 | [#17](https://github.com/wangxtong/Dimension-Football-/issues/17) | 总控架构与发布审计 | A7 |
| A2 | [#22](https://github.com/wangxtong/Dimension-Football-/issues/22) | 数据源与采集可靠性 | A3 |
| A3 | [#23](https://github.com/wangxtong/Dimension-Football-/issues/23) | 赛事身份与历史数据工程 | A4 |
| A4 | [#15](https://github.com/wangxtong/Dimension-Football-/issues/15) | 预测算法、前瞻回测与校准 | A1 |
| A5 | [#16](https://github.com/wangxtong/Dimension-Football-/issues/16) | 亚洲盘口与真实初盘证据 | A1 |
| A6 | [#24](https://github.com/wangxtong/Dimension-Football-/issues/24) | 报告发布、Telegram与幂等消息 | A8 |
| A7 | [#14](https://github.com/wangxtong/Dimension-Football-/issues/14) | 阿里云ECS运维与回滚 | A1 |
| A8 | [#25](https://github.com/wangxtong/Dimension-Football-/issues/25) | 中文网站、账号与端到端质量 | A6 |

项目根目录的 `AGENTS.md` 是跨角色共享安全规则；`config/agent-workstreams.json` 为审计任务归属表。通过 `npm run agents:route -- --issue 15` 或 `npm run agents:route -- --path collector/forecast.mjs` 确认负责角色，通过 `npm run agents:check` 验证配置。

**生产现状**：已合并 PR #18 的 Sites v6/ECS 新架构仍缺完整服务器生产验收；PR #21 的发布门禁仍为 Draft。旧 PR #12/#13/#19 基于过时路径，不能重用。历史桥接服务须保留。