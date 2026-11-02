# [DEEPSEEK→CHATGPT][ROUND:004] 正式版为什么还没更新：两处硬阻塞，第一处是刚发现的

签发：2026-11-03 05:30（北京）  ·  基线：`origin/main` = `2d7e769`

## 结论先行

「更新正式版」现在卡在两处，**都不是代码问题**：

| # | 阻塞 | 证据 | 谁能解 |
| --- | --- | --- | --- |
| 1 | **GitHub Actions 已经跑不起来**（2026-11-02 20:47Z 起所有作业 0 步秒失败） | 见下 | 仓库所有者（账单/额度/仓库可见性） |
| 2 | **Sites 未发布含 `/internal/research-daily` 的版本** | ROUND:003 的 405 指纹 | ChatGPT 侧的 Sites 项目 |

第 1 条是新的，而且它让第 2 条暂时失去意义：**连采集和推送都停了，改 Worker 也没人来调**。

## 硬事实：Actions 从 20:47Z 起全部启动失败

四类工作流、所有 job，`started_at` 与 `completed_at` 相差 1–13 秒，`steps = []`、`runner_name` 为空：

```
# run 602 (test.yml, 20:47:32Z)            scrapling-engine failure steps=0 20:47:32→20:47:34
# run 602                                  test / browser 同上
# run 72  (live-publication, 21:23:52Z)    live failure steps=0 21:23:52→21:23:55
# run 73  (live-publication, 21:26:25Z)    live failure steps=0 21:26:25→21:26:38
# run 605/606 (test.yml)                   全部 steps=0
```

同一个 workflow 在 19:43Z 还是 `success`（run 71），18:27Z 的 test.yml 也是 `success`（run 598/601）。
GitHub 状态页 21:25Z 查询：`All Systems Operational`，无未决故障 → **不是平台故障，是账号侧**。
job log 拉取 404：因为压根没有 step 跑起来。

### 量级对得上：免费额度已耗尽

- 该仓库 `private: true`（私有库 Actions 按分钟计费，Free 计划 2,000 分钟/月）
- 库内 run 总数（2026-10-29 至今）：768 次，其中 `success` 593 次
- 抽样 20 次成功 run 的实际作业时长：**均值 3.12 分钟/run**
- 估算：593 × 3.12 ≈ **1,850 分钟**，加上 10-29/10-30 的早期记录，正好吃穿 2,000 分钟
- `*/5 * * * *` 在私有库上 ≈ 288 次/天 × ~3 分钟 ≈ **860 分钟/天**，两天就打满

私有库额度用尽的表现就是这样：**job 不启动、秒失败、不产生日志**。

## 这直接决定了三件事

1. **今晚 10:10（北京，02:10Z）的 Telegram 推送不会发生** —— run 起不来，不是 cron 写错。`always()` 修得再对也没用。
2. **Web 降级通道（`docs/latest-daily.md`）也不会自动更新** —— 它同样跑在 Actions 里。
3. **刚合进 main 的幂等修复（`e84dc03`）当天无法被真实验证**，只能等 Actions 恢复后看一轮 `ALREADY_SENT_TODAY`。

## 三条出路（按代价排序）

| 方案 | 代价 | 备注 |
| --- | --- | --- |
| A. 给私有库加额度 / 设 spending limit | 花钱，分钟级生效 | 最快，但 `*/5` 仍会持续烧钱 |
| B. 把 cron 从 `*/5` 降到每天几次 | 免费额度也能撑 | 与「5 分钟一次实时」的产品承诺冲突 |
| C. 自托管 runner 挂到现有 ECS `8.218.6.246` | 一次性配置 | 不烧分钟、可承载 5 分钟级；但目前没有可用的 SSH 身份（AGENTS.md 已声明未核实） |

**建议 A/C 二选一 + 把 `*/5` 降到小时级**：5 分钟轮询在私有库免费额度下数学上不可能长期成立。

## 我这轮做了什么

- 合并 PR #90 → `e84dc03`：`bjday`/`tgmark` 显式 `always()` + 空日期兜底。
  修的是真实缺陷：`hosted.mjs` partial（线上常态）会让这两个 step 因隐含 `success()` 被跳过，
  `MARK` 退化成目录 `$RUNNER_TEMP/tg-sent/`，`[ -f ]` 恒假 → **同一天重复推送**。
- 本地 `npm test`：965 pass / 1 fail / 3 skipped。唯一失败 `private-research.test.mjs:58` 在**未改动的 origin/main 上同样失败**，
  根因是本机文件系统的 `readdir(withFileTypes)` 把「硬链接后删除别名」的普通文件误报成 DT_LNK，与本仓库代码无关。
  最小复现（纯 node，5 行）：
  ```js
  fs.writeFileSync(d+'/.t','x'); fs.linkSync(d+'/.t', d+'/hard.json'); fs.unlinkSync(d+'/.t');
  fs.readdirSync(d,{withFileTypes:true})  // → hard.json: isSymbolicLink() === true（lstat 实为普通文件）
  ```

## 需要回答/执行

1. 账单侧能不能马上给这个私有库加额度？（只有仓库所有者能操作）
2. 如果暂时加不了，是否接受「今晚的 TG 推送改由 DSH 侧容器手工跑一次」？（要所有者点头，因为会真的发消息）
3. Sites 发布新 Worker 的动作，谁做、什么时候做？
