# 五大联赛最近8个已结束赛季（2018–19至2025–26）CSV

**40份分赛季CSV + 1份全部赛季合并CSV；保留所有来源记录，绝不补造FT。**

**来源及版本**：OpenFootball / football.json，CC0 1.0 公共领域。
仓库：https://github.com/openfootball/football.json
快照版本：e6744429ee395bc86f247348c6184bb08d4eb361 （所有CSV都固定来源于该Git提交）。

总计 14386 条赛事记录；14151 条有来源终场比分；
235 条无FT或标取消/延期。40份CSV分别在 csv/ 子文件夹中。
合并文件：ALL_MATCHES_2018-19_to_2025-26.csv。

## 联赛覆盖
- 英超（Premier League）: 3040条记录；有FT 3013条
- 西甲（La Liga）: 3040条记录；有FT 3015条
- 意甲（Serie A）: 3040条记录；有FT 2994条
- 德甲（Bundesliga）: 2448条记录；有FT 2436条
- 法甲（Ligue 1）: 2818条记录；有FT 2693条

## 字段说明与风险
- Date是原始YYYY-MM-DD；TimeAsPublished是来源给出的时间，未猜测时区或UTC。
- FTHG、FTAG、FTR：全场主客进球及1X2（H/D/A）；空白=未报告。
- HTHG、HTAG、HTR：半场进球及1X2，有数据时记录。
- SourceStatus为原始状态；FTRecordStatus区分有比分、缺比分、取消延期。
- DerivedFixtureKey是本次生成的匹配键，不是源生fixtureId。
- SourceFile/SourceRowNumber/SourceCommit定位源JSON原始行。

**重要：数据没有原始盘口初赔、实时赔率、官方首发和真实赛前采集时间。**
不能把赛后历史数据当成预测冻结时可见的因果输入。
含有0:0的记录暂按来源原样保存，但不证明所有0:0都经第二来源核验；
可查询质量表 FTZeroZeroReported，训练前需单独核查异常。
法甲2019–20赛季因提前终止，未赛的比赛保留而终场比分为空。
原始来源本身可能未补足部分已结束赛季比分，切勿把缺失当0:0。
所有CSV使用UTF-8 BOM，Excel可直接识别中文联赛名称。

## FT缺失的赛季
| 联赛 | 赛季 | 全部赛事 | 有FT | 缺FT |
|---|---|---:|---:|---:|
| 英超 | 2025-26 | 380 | 353 | 27 |
| 西甲 | 2024-25 | 380 | 370 | 10 |
| 西甲 | 2025-26 | 380 | 365 | 15 |
| 意甲 | 2024-25 | 380 | 370 | 10 |
| 意甲 | 2025-26 | 380 | 344 | 36 |
| 德甲 | 2025-26 | 306 | 294 | 12 |
| 法甲 | 2019-20 | 380 | 279 | 101 |
| 法甲 | 2025-26 | 306 | 282 | 24 |

## 校验和来源清单
- DATA_QUALITY_40_LEAGUE_SEASONS.csv：40个赛季完整性及0:0数量。
- MANIFEST.json：原始40份JSON的SHA256、逐CSV的SHA256、固定来源URL。
- SHA256SUMS.txt：归档内部文件的SHA256；解压后执行 sha256sum -c SHA256SUMS.txt。
- OPENFOOTBALL_CC0_LICENSE.md：原上游许可证全文。

以上是准确保留的公开来源赛程/赛果CSV，尚不代表经过两家独立来源逐场复核。
