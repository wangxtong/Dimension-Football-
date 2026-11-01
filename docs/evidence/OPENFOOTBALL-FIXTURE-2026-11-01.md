# Openfootball 固定测试快照交接

状态：A3 本地实现和专项实测完成，等待 A8 独立复核、A1 集成；未修改远端或部署。

## 修复前后

原测试 `ten actual pinned snapshots: five leagues, two seasons, exact hashes and honest coverage` 依赖临时目录 `OPENFOOTBALL_SNAPSHOT_DIRECTORY`；目录遗失会跳过完整十快照检查。现加入有摘要固定、可离线恢复的数据资产，恢复后同一原测试实际运行通过。未删除测试、改变模型阈值、替换成模拟比赛或提高数据资格。

## 来源与时间

- 来源：[openfootball/football.json 固定提交 e6744429ee395bc86f247348c6184bb08d4eb361](https://github.com/openfootball/football.json/tree/e6744429ee395bc86f247348c6184bb08d4eb361)。五联赛 × 两赛季 `2025-26`、`2026-27`，十个原始 JSON、十个相邻 `.meta.json` 与原始 `LICENSE.md`，共 21 文件、740,214 字节。
- A1 于本轮重新下载固定提交文件到 `/workspace/dimension-openfootball-fixed`，十个原始 JSON 摘要与既有测试固定摘要全部一致。A3 只读取该目录并封装，没有独立重新采集。
- 十个下载记录的真实时间为 **2026-11-01T07:56:05.550Z 至 2026-11-01T07:56:06.312Z**。各 `.meta.json` 的原始字节保留；没有把本次取得时间回填为 2026-10-31，也不声称恢复了遗失的旧观察记录。
- [原始许可证](https://raw.githubusercontent.com/openfootball/football.json/e6744429ee395bc86f247348c6184bb08d4eb361/LICENSE.md) 为 CC0 1.0 Universal；保留其不保证准确性及第三方权益等限制。本资产用于可重复代码验证，不代表商业数据授权或可用于预测的完整身份、UTC 时间与历史可见性已经补齐。
- 包 `collector/sources/test/fixtures/openfootball-e674442.json.gz` 为排序文件列表、原字节 Base64、固定 `mtime=0` 的 gzip；大小 **64,335** 字节，SHA-256 **`2c9ee9cc911518fe7e8930b227b92628ffd2ce5861ff390dbb01f6a8846369a9`**。相邻 `.metadata.json` 记录每个文件的路径、字节数与 SHA-256。

## 离线恢复契约

```sh
node scripts/restore-openfootball-fixture.mjs --out /absolute/new/snapshot-directory
OPENFOOTBALL_SNAPSHOT_DIRECTORY=/absolute/new/snapshot-directory node --test --test-isolation=none collector/sources/test/restore-openfootball-fixture.test.mjs collector/sources/test/historical-openfootball.test.mjs
```

父目录须真实存在，输出目录必须不存在；拒绝相对路径、已存在路径和经过符号链接的父目录。先核对压缩包和全部原字节的摘要、白名单、文件数与大小上限，再写入私有目录。不执行包内脚本，不联网，不发布报告或通知。失败只清理本次创建的目录。既有 `restore-report-fixture.mjs` 接口未改变。

## 实测与限制

专项命令实际 **13 项通过、0 失败、0 跳过**，包含十快照原测试及离线恢复、精确时间保持、路径逃逸、重复路径、篡改来源、损坏字节、解压上限、已有文件和符号链接拒绝检查。复核输入目录：`/workspace/dimension-artifact-recovery/fixed-openfootball-check`；本地日志：`/workspace/dimension-artifact-recovery/fixed-openfootball-tests.log`。

重新导入仍为 **3,504 条收到、1,871 条保留终场结果、130 条隔离、modelReady 0、RELEASE_GATE=BLOCKED**。这是代码与固定输入验证通过，不是模型回测全部合格、数据源实时性合格或生产验收通过。

下一阶段由 A1 将恢复步骤及环境变量接入完整 CI，由 A8 在同一提交独立重跑；五大联赛身份、UTC 时间与前瞻证据缺口继续按原门禁处理。
