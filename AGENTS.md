# 维度足球项目智能体约定

本文件用于在仓库中工作的编码助手。用户当前目标与已有授权优先；遵守宿主更高优先级的权限、工具和技能规则。

## 任务入口与自动技能选择

1. 确认任务、当前分支、未提交改动与用户已授权范围。先读取 `README.md`、相关源码和 `config/cloud-task.md`，不要把历史审计描述当成当前状态。
2. 读取 `.agents/skills/vantis-orchestrator/SKILL.md`。角色路由的唯一机器配置为 `config/agent-workflow.json`。
3. 有审计编号时运行 `npm run agents:route -- --finding A01`；有文件时用 `--file collector/run.mjs`；只有自然语言时用 `--task '用户任务'`。参数可重复，用工具结构化参数传值或正确 shell 引用，不把不可信任务文本直接拼入命令。
4. 自动读取输出中的负责人技能，按任务含义确认适用性，再执行其工作步骤。关键词是候选提示，不能覆盖用户目标或源代码证据。不需要用户手动重复输入技能名。
5. 无匹配时由协调者先定位代码，只有确实缺少关键信息才询问；不要为每个角色机械启动进程。
6. 宿主支持且允许委派时，协调者可将写入范围互不冲突的任务交给子智能体，明确角色、技能路径、输入、允许修改的文件和验收条件。否则由同一助手顺序切换角色，准确标明复核方式，不称为独立多智能体复核。
7. 复核角色在实现后按同一提交检查；重叠文件由协调者指定单一写入者。共享工作区中不得覆盖他人未提交改动。

角色及提示词：

| 角色 | 技能 | 主要职责 |
| --- | --- | --- |
| 项目协调 | [vantis-orchestrator](.agents/skills/vantis-orchestrator/SKILL.md) | 分派、依赖、证据、状态与交付 |
| 数据采集 | [vantis-collector](.agents/skills/vantis-collector/SKILL.md) | 官方 API、公开源、配额、第二来源、初盘 |
| 数据质量 | [vantis-data-quality](.agents/skills/vantis-data-quality/SKILL.md) | 身份、时效、分页与缺项；A04、A05 |
| 预测研究 | [vantis-research](.agents/skills/vantis-research/SKILL.md) | 候选规则、市场参考、回测与校准 |
| 运行可靠性 | [vantis-reliability](.agents/skills/vantis-reliability/SKILL.md) | 退出码、锁、状态、原子报告；A01、A03 |
| 安全交付 | [vantis-security](.agents/skills/vantis-security/SKILL.md) | 打包、凭据、供应链；A02 |
| 测试验收 | [vantis-qa](.agents/skills/vantis-qa/SKILL.md) | 回归、故障注入、证据与验收判定 |
| 生产运维 | [vantis-operations](.agents/skills/vantis-operations/SKILL.md) | 单一调度、部署、可观测性与恢复 |

## 项目约束

- Node.js 24+，当前无 npm 第三方依赖。按需测试改动；文档修改不需要真实 API 请求。
- 赛程身份和开赛时间必须可核验；演示与正式状态隔离。不得以模拟补齐真实缺项。
- M88、12Bet、SBOBET 的球探报价只算一个来源组；初盘与第二独立来源缺失时保持来源不足。候选不是已发布推荐。
- 1X2 辅助概率、赔率去水概率、亚洲盘赢盘概率和经回测的模型概率分别表达；不得互相替代。不得声称未验证的命中率或收益。
- 保留当前策略约束：排除皇冠、十进制赔率 1.65–1.95、至少两个独立亚洲盘来源、可核验初盘。调整策略须属于用户明确的任务目标，不能以“让测试通过”或“多出候选”为由变更。
- 只读核查、隔离复现、代码与测试、工作分支和草稿 PR 可在任务范围内完成。按已有授权处理部署或外部写入；未获授权时完成可审阅产物后再确认。不得重复索取已有授权。
- main 可能由 ECS 每两分钟自动同步。通常在工作分支交付；技能文件本身不授权合并主分支、切换生产调度、配置新凭据或发送频道消息。
- 密钥不写入聊天、报告、日志、命令参数或代码。使用既有绑定和安全环境变量。缺少权限是“未验证”，不是“配置为空”。

## 技能与外部工具

`.agents/skills/*/SKILL.md` 是本仓库的角色工作说明。支持该目录的宿主可发现技能；其他读取 AGENTS.md 的宿主按上面的路由加载。`agents:route` 只生成 JSON 路由，不执行模型调用，不注册云端智能体，不自动安装插件，也不是后台调度器。

可选外部技能按实际任务加载：托管云环境工作用 `cloud-environment:cloud-environment-runtime`；确实构建 Agents API/SDK 应用时用 `openai-developers:agents`，涉及 OpenAI 凭据时遵守 `openai-platform-api-key`；确实发生 OpenAI API 故障时用 `openai-api-troubleshooting`。不要仅因“智能体”字样给本 Node 项目接入付费 API。

只有用户任务需要现有工具无法访问的外部服务时，才通过可用的 `plugin-management:plugin-management` 工作流查找插件；不能把文档中的技能名称当成已经安装或可调用的工具。

## 完成条件

输出：实际修改、对应审计编号、验证命令与结果、未验证项和交付链接。使用 `open / in_progress / verified` 跟踪审计缺陷；有当前提交的复现实证和回归结果才改为 verified。GitHub CI 通过、模拟成功、真实源成功、生产运行成功分别报告。

更多任务卡、交接格式与验收矩阵见 [docs/AGENT_WORKFLOW.md](docs/AGENT_WORKFLOW.md) 和 [审计待办](docs/AGENT_AUDIT_BACKLOG.md)。
