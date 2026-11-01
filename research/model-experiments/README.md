# Poisson 温度缩放探索实验

这里保存独立的历史研究协议与结果，不属于网站正式预测或推荐资产。Poisson v2 生产基线和发布门槛没有改变。

唯一候选为 `q(k) = p(k)^α / Σ p(j)^α`，α限制在[0.5, 2]。只在校准段最小化三分类Log loss，通过固定60轮二分求解一维凸问题；不测试多个候选、提前量或切分再挑最好结果。正温度不改变方向排序，因此不能提高argmax方向命中率。

先按开赛时间确定40%热身、40%校准、20%最终walk-forward留出；同一开赛时刻整批分段。固定提前量24小时，校准赛果必须早于第一场留出预测的截止时刻，边界附近标签会剔除。Poisson参数固定，每场按过去至少4小时已结束比赛重新估计主客强度，包括协议预先允许的更早留出比赛结果；这是prequential比较，不是只用初始训练段的静态模型。至少100场有效校准、30场有效留出，不足时明确失败，不能降低下限或用基线概率冒充候选。

当前历史快照的首次观察时间来自本次抓取，晚于历史预测截止。实验同时给出：

- `snapshot`：以开赛后4小时作为假定标签可用时刻的修订快照研究，不能证明历史实际可见性。
- `asObserved`：额外要求真实观察时间不晚于预测/拟合截止；没有足够记录时保持不可拟合。

这批历史及其末段已在此前分析中被查看。协议仅在本次候选拟合前固定，不是外部预注册，也不是未接触的独立测试。实际运行结果无论好坏均完整保留，`independentEvidence:false`、`calibrated:false`、`releaseGate:BLOCKED`。不据此承诺未来命中率、模型晋升或投注价值。

运行分两步，协议和结果均只允许首次创建，不能覆盖。标准输入可为history数组或含history字段的对象；沿用现有严格身份、90分钟赛果和真实观察时间合同。

```sh
node collector/model-experiment.mjs prepare \
  --history /tmp/dimension-r3-history/openligadb-normalized.json \
  --source openligadb --league BL1 --as-of 2026-10-31T10:05:56.989Z \
  --protocol research/model-experiments/openligadb-temperature-v1-982.protocol.json
node collector/model-experiment.mjs run \
  --history /tmp/dimension-r3-history/openligadb-normalized.json \
  --protocol research/model-experiments/openligadb-temperature-v1-982.protocol.json \
  --output research/model-experiments/openligadb-temperature-v1-982.result.json
```

协议冻结原文件字节哈希、标准化历史哈希、实验及依赖文件哈希、Poisson配置、各段赛事ID哈希与明确边界。输入、算法或协议变化会拒绝运行。复现应使用绑定的源码和输入，在另一个全新结果路径运行；比较指标而不是执行时间。

结果包含校准参数、同场Poisson/历史频率基准/候选的历史留出概率和评分、coverage与逐场排除原因，以及固定周分块的配对差区间和可靠性指标。周分块仅近似处理相关性，不能替代未来独立验证。

本次982场输入来自OpenLigaDB的2023、2024、2025、2026赛季，分别306、306、306、64场，遵循其ODbL归属。原始来源URL、抓取时刻与原文件SHA保存在输入对象的`sources`元信息，原文件字节哈希由协议绑定；不把本次获取时间冒充过去的供应商发布时间。

数据归属：[OpenLigaDB](https://www.openligadb.de/)；[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)。来源为`https://api.openligadb.de/getmatchdata/bl1/{2023,2024,2025,2026}`，实际获取于2026-10-31 10:04 UTC。

## 固定协议的首次结果

协议在提交`6a0f5a43e3331cdf47f511518692d08fba400da4`中保存后，才于2026-10-31 10:11:44 UTC执行首次候选拟合。协议哈希为`811c5722663d39fbca163f82fdf7a962a3e3bc8c9582535205b0cc39c8e84595`。全体按时间分为392场热身、391场校准、199场留出；校准383场有效，留出182场有效、17场跳过，覆盖23个实际比赛周。拟合α=0.9093523，T=1.0996838，没有触及参数边界。

| 留出指标 | 原Poisson v2 | 温度候选 | 候选减Poisson |
| --- | ---: | ---: | ---: |
| Log loss | 0.9870742 | 0.9890218 | +0.0019477 |
| Brier | 0.5870966 | 0.5885163 | +0.0014197 |
| 方向命中比例 | 53.2967% | 53.2967% | 0 |
| 固定分箱macroECE | 0.0396504 | 0.0384217 | −0.0012287 |

Log loss与Brier越低越好，本次候选的点估计略差。同周配对bootstrap的近似95%区间：Log loss差为[−0.0036995, 0.0068323]，Brier差为[−0.0022387, 0.0047366]，均包含零。ECE小幅下降不能抵消适当概率评分未改善，也不能证明已校准。因此保留Poisson v2；不根据这一结果改边界、改切分、重选候选或声称改进。

严格`asObserved`回放中，校准和留出有效样本均为0：此次首次取得数据的时间晚于历史预测截止。候选没有获得可用于正式发布的独立证据，仍为`BLOCKED`。研究结果文件保存全部历史留出概率、评分及排除理由，其字节SHA-256为`71c9ec6268b44ff3a977384c7396146ea0e1b2a6b1c13407c27082e26989e08f`。
