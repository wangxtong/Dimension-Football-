# 维度足球 · 长期采集任务

把原来的云端定时采集整理为可审阅、可部署的 Node.js 24 项目。入口为 `npm run collect`，GitHub Actions 支持手动运行与每小时运行。项目没有 npm 第三方依赖。

本版负责取得赛程和已实现的数据源证据、按规则逐场筛选、保存进度并输出报告。它不调用 OpenAI API，不发送 Telegram 消息，也不下注。`candidate` 表示证据门槛通过后仍需人工复核的候选，不代表已经发布的推荐。

## 先在本机验证

在仓库根目录使用 Node.js 24：

```sh
npm test
npm run collect -- --demo
```

`--demo` 完全离线，使用虚构比赛；报告醒目标记“模拟”，正式候选与模拟结果分开，默认检查点存入 `.collection-state-demo/state.json`。不要把模拟报告作为实际比赛建议。

正式采集需要通过环境变量注入 football-data.org 的 `FOOTBALL_DATA_API_KEY`，随后执行：

```sh
npm run collect -- --state .collection-state/state.json --out reports --budget-minutes 20
```

也可以提供自行维护的真实赛程 JSON：

```sh
npm run collect -- --input /path/to/fixtures.json --state .collection-state/state.json --out reports
```

`FIXTURES_FILE` 环境变量与 `--input` 对应。默认正式入口缺少 API key、又没有赛程文件时会明确失败，不会用演示数据补齐。真实赛程文件的字段与人工证据导入方式见[迁移与部署说明](docs/CLOUD_TASK_MIGRATION.md)。

## 部署到 GitHub Actions

1. 将项目文件上传到仓库默认分支，确认 **Actions** 中出现“维度足球长期采集”。
2. 在 **Settings → Secrets and variables → Actions → Secrets** 添加 `FOOTBALL_DATA_API_KEY`。如果使用仓库中的真实赛程文件，可在 **Variables** 添加 `FIXTURES_FILE`，值为该文件的仓库内路径。
3. 先用 **Run workflow**，勾选 `demo` 做一次离线验证，再取消 `demo` 验证真实数据源。
4. 原云端长期采集计划目前仍启用；确认新任务可用后，先停用旧采集计划，再把仓库变量 `VANTIS_COLLECTION_ENABLED` 设为字符串 `true`，开启新计划。这个项目不会修改原计划或自动发布任务。

工作流为 UTC 每小时第 0 分钟触发，对应北京时间每小时整点；GitHub 的排队与高负载可能造成延迟，不能当作准点服务。定时工作流只从默认分支触发，详见 [GitHub schedule 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。

每轮内部预算最多 20 分钟，整个作业最多 25 分钟；相同工作流不会同时运行。检查点通过 cache 在多轮间恢复，失败时也尝试保存；报告作为 Actions artifact 保留 30 天。**cache 会失效或被清理，不是永久数据库。** 需要可靠长期续跑时，把同一命令部署在持久服务器上，并为状态文件与报告配置持久目录及备份。

## 当前数据覆盖

| 数据 | 已实现的能力 | 限制 |
| --- | --- | --- |
| 赛程 | football-data.org 官方 API，英超、西甲、意甲、德甲、法甲，默认未来 7 天 | 需要 API key；账号权限与上游可用性影响覆盖 |
| 亚洲盘 | 球探公开快照中的 M88、12Bet、SBOBET | 三家公司共享一个网站采集渠道，统一只算 **一个独立来源组**；排除皇冠；不具备第二个自动亚洲盘来源与完整初盘轨迹 |
| 辅助预测 | Statarea 已发布页面的 1X2 概率 | 仅覆盖已发布的当日至未来 3 天页面；不是亚洲盘赢盘概率 |
| 其他来源 | 记录来源能力及具体缺失原因 | 天天盈球只监测免费赛前列表，不生成预测票；未实现或需要授权的来源不生成证据 |

因此，只有内置自动来源时通常会得到 `source_insufficient`，而不会强行拼凑成符合双来源要求的候选。站点能访问、博彩公司的数量、相同内容的多个页面都不会自动变成独立预测共识。已确认的原任务规则见 [config/cloud-task.md](config/cloud-task.md)。

## 输出和目录

每轮在 `reports/` 生成带 UTC 时间戳的 JSON、简报与消息草稿，以及 `latest.json`、`latest-brief.md`、`latest-message.md`。消息草稿只是文件，不会发送到外部服务。

```text
.github/workflows/collection.yml  手动及每小时调度
collector/                        数据源、筛选、进度、报告与测试
config/collection.json            运行预算、时效与筛选阈值
config/cloud-task.md              从可读取记录整理的原任务规则
docs/CLOUD_TASK_MIGRATION.md       输入契约、迁移步骤和已知限制
```

原有 `pitchsignal/` 网页目录独立保留；本次长期采集的运行入口在仓库根目录。

可直接下载 `artifacts/Dimension-Football-collection.zip` 获取独立源码包。需要重新打包时运行 `python scripts/package.py`；它只打包明确列出的源码目录，排除密钥、数据库、检查点和报告。
