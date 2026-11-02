# 双 Agent 协作协议（人类 + DeepSeek Harness + ChatGPT）

目标：让两个 AI 在同一项目的**真实状态**上协作，而不是各自基于过时信息推演。

## 一、能力边界（决定分工）

| 能力 | DSH（本 agent） | ChatGPT |
| --- | --- | --- |
| 读写仓库文件 | ✅ 直连 | ❌（除非接 GitHub 连接器） |
| 跑命令/测试 | ✅ 容器内 | ❌ |
| 看 CI 日志 | ✅ API | ❌ |
| 改 GitHub（PR/issue/vars） | ✅ | ❌ |
| 部署 Sites/ECS | ❌（无凭据） | ❌ |
| 广度审查/找逻辑漏洞 | 一般 | ✅ 强 |

**分工**：ChatGPT 做审查者与架构评审，DSH 做执行者与验证者。ChatGPT 不直接改代码，所有写入由 DSH 完成并留证据。

## 二、共享事实源（唯一真相）

1. 仓库 `main` 的实际 SHA
2. GitHub Actions 的运行链接与日志
3. 本文件 `docs/COLLAB.md` 的状态快照
4. 产物 artifact（`latest.json` / ledger / receipt）

**任何结论必须附上述四类证据之一**，否则视为未验证。`docs/` 里的描述不等于事实。

## 三、三个沟通通道

| 通道 | 用法 | 适用 |
| --- | --- | --- |
| **GitHub Issue** | 双方都读写同一条 issue 线程 | 长期、需要留存 |
| **`docs/COLLAB.md`** | DSH 每次变动后更新；ChatGPT 读最新版 | 状态同步 |
| **人类转述** | 用户把 DSH 输出贴给 ChatGPT，再把回复贴回 | 即时、临时 |

如果 ChatGPT 侧接了 GitHub 连接器，可直接读 issue 与 main；否则走通道 2/3。

## 四、交接模板（必须包含）

```markdown
### 任务：<一句话>
- 候选 SHA：<40 位>
- 改动文件：<列表>
- 验收标准：<可判定的条件>
- 已知证据：<命令输出 / 日志片段 / artifact 路径>
- 未解决：<明确列出>
```

## 五、防幻觉三条硬规则

1. **SHA 必须真实**：任何关于「已修复」的说法，必须能对上 `main` 的某次提交。
2. **状态必须带时间**：artifact、日志、CI 结论都要标采集时刻，不被当成实时状态。
3. **「测试全绿」≠「功能可用」**：端到端必须看产物与送达回执，不能拿 CI 绿当验收。

## 六、当前状态快照（2026-11-03 02:40 北京）

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 自动推送链路 | ✅ 通 | CI 步骤 5/7/8/9/10 全绿；messageId 258-268 |
| 4 场冻结 | ✅ | ledger `fd-558541/558545/559641/560622` |
| 同源结算 | ✅ 机制验证 | 真实英超闭环 accuracy=1 brier=0.3078 |
| 明日自动结算 | ⏳ | results lane due=True，等 10:10 |
| Web 看板 | ⛔ | `POST /internal/research-daily` → 405；需 Sites 开关 |
| Macau 准入 | ❌ 未修 | `collector/sources/index.mjs:96` 硬编码 `includeMacauslot: true` |
| 新数据源 | ✅ | 体彩官方让球盘（14 场/秒级时间戳）；HF 3 万场 + 1.8 万条 Pinnacle 赔率 |

## 七、当前待办（按优先级）

1. **P0** 修 Macau 准入（硬编码 `true` → 走准入判断）
2. **P0** Sites 设 `HOSTED_PUBLICATION_ENABLED=true`（人类操作）
3. **P1** 用 HF 3 万场 + Pinnacle 赔率建历史回测（CLV / 软盘偏差）
4. **P1** 体彩让球盘接入盘口证据链，替换争议源
