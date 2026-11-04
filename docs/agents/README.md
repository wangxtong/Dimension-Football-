# 维度足球唯一岗位：A1 总控审计总监

现行有效角色只有 **A1**。配置见 `config/agent-team.json`，专属角色词见 [A1-DIRECTOR.md](A1-DIRECTOR.md)，通用纪律见 [COMMON.md](COMMON.md)。

## 只读检查和读取
```bash
node scripts/agent-team.mjs --check
node scripts/agent-team.mjs --role A1
```
`--role` 仅接受 A1；其他A编号返回 `AGENT_TEAM_UNKNOWN_ROLE`。这些命令不会启动后台进程、执行模型预测、推送Telegram或部署网站。

## 负责内容
A1统一负责信息源、身份与历史数据、预测模型、盘口审核、赛前冻结、官方FT复盘、Web和Telegram、GitHub CI、Cloudflare运行、风险和商业验收。需要外部验证时可独立审查，但不注册新的编号智能体。

所有变更须对齐实际主仓与部署SHA，保留原始证据和回滚能力；正式商业门禁保持 `BLOCKED`。
