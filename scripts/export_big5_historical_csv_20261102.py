#!/usr/bin/env python3
"""Export 40 CC0 historical football league-season CSV files without fabricating scores."""
import csv
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED

SHA = "e6744429ee395bc86f247348c6184bb08d4eb361"
SEASONS = [f"{n}-{(n+1)%100:02d}" for n in range(2018, 2026)]
LEAGUES = [
    ("EPL","英超","Premier League","en.1.json"),
    ("LaLiga","西甲","La Liga","es.1.json"),
    ("SerieA","意甲","Serie A","it.1.json"),
    ("Bundesliga","德甲","Bundesliga","de.1.json"),
    ("Ligue1","法甲","Ligue 1","fr.1.json"),
]
FIELDS = ["Season","League","LeagueZH","Date","TimeAsPublished","Round",
          "HomeTeam","AwayTeam","FTHG","FTAG","FTR","HTHG","HTAG","HTR",
          "SourceStatus","FTRecordStatus","SourceRowNumber","DerivedFixtureKey",
          "SourceFile","SourceCommit"]
QFIELDS = ["League","LeagueZH","Season","Fixtures","FTRecorded","FTMissing",
           "CancelledOrPostponed","FTZeroZeroReported","InvalidDates",
           "DuplicateDerivedKeys","UniqueTeams","RowsWithTime","SourceJSONSHA256",
           "SourceURL","GeneratedCSVPath","GeneratedCSVSHA256"]

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def pair(x):
    if isinstance(x,list) and len(x)==2 and all(type(n) is int and 0<=n<=99 for n in x):
        return tuple(x)
    return None

def result(ft):
    return "H" if ft[0]>ft[1] else "A" if ft[0]<ft[1] else "D"

def valid_date(s):
    try: return isinstance(s,str) and dt.date.fromisoformat(s).isoformat()==s
    except ValueError: return False

def encode_csv(cols, rows):
    s=io.StringIO(newline="")
    w=csv.DictWriter(s, fieldnames=cols, lineterminator="\n")
    w.writeheader()
    for row in rows:
        w.writerow(row)
    return s.getvalue().encode("utf-8-sig")

def build(source, output):
    saved={}
    combined=[]
    quality=[]
    for code, zh, name, fname in LEAGUES:
        for season in SEASONS:
            path=f"{season}/{fname}"
            original=(source/path).read_bytes()
            matches=json.loads(original.decode("utf-8-sig")).get("matches", [])
            if not isinstance(matches,list) or len(matches)<200:
                raise ValueError(f"Missing or abnormal source dataset: {path}")
            rows=[]
            seen=set()
            ft_count=missing=cancelled=zero_zero=invalid=duplicate=times=0
            teams=set()
            for pos, m in enumerate(matches,1):
                if not isinstance(m,dict):
                    raise ValueError(f"Not a match object at {path}:{pos}")
                date=m.get("date") or ""
                home=str(m.get("team1") or "")
                away=str(m.get("team2") or "")
                if not home or not away or home==away:
                    raise ValueError(f"Invalid team names: {path}:{pos}")
                teams.update([home,away])
                if not valid_date(date):
                    invalid+=1
                fid=sha256(f"{code}|{season}|{date}|{home}|{away}".encode())[:20]
                if fid in seen:
                    duplicate+=1
                seen.add(fid)
                status=str(m.get("status") or "")
                cancelled_flag=status.lower() in ("cancelled","canceled","postponed","abandoned","not_played")
                scores=m.get("score") or {}
                ft=pair(scores.get("ft"))
                ht=pair(scores.get("ht"))
                if cancelled_flag:
                    cancelled+=1
                if ft is not None and not cancelled_flag:
                    ft_count+=1
                    zero_zero+=int(ft==(0,0))
                    state="FT_REPORTED_BY_SOURCE"
                else:
                    missing+=1
                    state="CANCELLED_OR_POSTPONED" if cancelled_flag else "FT_MISSING"
                    ft=None
                time=str(m.get("time") or "")
                times+=int(bool(time))
                row=dict(
                    Season=season,League=name,LeagueZH=zh,Date=date,
                    TimeAsPublished=time,Round=str(m.get("round") or ""),
                    HomeTeam=home,AwayTeam=away,
                    FTHG=ft[0] if ft else "",FTAG=ft[1] if ft else "",
                    FTR=result(ft) if ft else "",
                    HTHG=ht[0] if ht else "",HTAG=ht[1] if ht else "",
                    HTR=result(ht) if ht else "",
                    SourceStatus=status,FTRecordStatus=state,
                    SourceRowNumber=pos,DerivedFixtureKey=fid,
                    SourceFile=path,SourceCommit=SHA,
                )
                rows.append(row)
            destination=f"csv/{code}/{season}.csv"
            blob=encode_csv(FIELDS,rows)
            saved[destination]=blob
            combined.extend(rows)
            quality.append(dict(League=name,LeagueZH=zh,Season=season,
                Fixtures=len(rows),FTRecorded=ft_count,FTMissing=missing,
                CancelledOrPostponed=cancelled,FTZeroZeroReported=zero_zero,
                InvalidDates=invalid,DuplicateDerivedKeys=duplicate,
                UniqueTeams=len(teams),RowsWithTime=times,
                SourceJSONSHA256=sha256(original),
                SourceURL=f"https://raw.githubusercontent.com/openfootball/football.json/{SHA}/{path}",
                GeneratedCSVPath=destination,GeneratedCSVSHA256=sha256(blob)))
    assert len(quality)==40, "Expected 40 league-season CSVs"
    assert all(not q["InvalidDates"] and not q["DuplicateDerivedKeys"] for q in quality), "Bad date or identity"
    saved["ALL_MATCHES_2018-19_to_2025-26.csv"]=encode_csv(FIELDS,combined)
    saved["DATA_QUALITY_40_LEAGUE_SEASONS.csv"]=encode_csv(QFIELDS,quality)
    saved["OPENFOOTBALL_CC0_LICENSE.md"]=(source/"LICENSE.md").read_bytes()
    stats=dict(total_rows=len(combined),ft_scored=sum(q["FTRecorded"] for q in quality),
               ft_missing=sum(q["FTMissing"] for q in quality),csv_count=40)
    saved["MANIFEST.json"]=json.dumps(dict(
        source="https://github.com/openfootball/football.json",
        snapshot_commit=SHA,license="CC0-1.0",seasons=SEASONS,
        leagues=[x[2] for x in LEAGUES],statistics=stats,
        source_coverage=quality),ensure_ascii=False,indent=2).encode("utf-8")
    incomplete=[q for q in quality if q["FTMissing"]]
    missing_table="\n".join(
        f"| {x['LeagueZH']} | {x['Season']} | {x['Fixtures']} | {x['FTRecorded']} | {x['FTMissing']} |"
        for x in incomplete)
    per_league="\n".join(
        f"- {zh}（{name}）: {sum(q['Fixtures'] for q in quality if q['League']==name)}条记录；"
        f"有FT {sum(q['FTRecorded'] for q in quality if q['League']==name)}条"
        for _,zh,name,_ in LEAGUES)
    readme=f"""# 五大联赛最近8个已结束赛季（2018–19至2025–26）CSV

**40份分赛季CSV + 1份全部赛季合并CSV；保留所有来源记录，绝不补造FT。**

**来源及版本**：OpenFootball / football.json，CC0 1.0 公共领域。
仓库：https://github.com/openfootball/football.json
快照版本：{SHA} （所有CSV都固定来源于该Git提交）。

总计 {stats['total_rows']} 条赛事记录；{stats['ft_scored']} 条有来源终场比分；
{stats['ft_missing']} 条无FT或标取消/延期。40份CSV分别在 csv/ 子文件夹中。
合并文件：ALL_MATCHES_2018-19_to_2025-26.csv。

## 联赛覆盖
{per_league}

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
{missing_table}

## 校验和来源清单
- DATA_QUALITY_40_LEAGUE_SEASONS.csv：40个赛季完整性及0:0数量。
- MANIFEST.json：原始40份JSON的SHA256、逐CSV的SHA256、固定来源URL。
- SHA256SUMS.txt：归档内部文件的SHA256；解压后执行 sha256sum -c SHA256SUMS.txt。
- OPENFOOTBALL_CC0_LICENSE.md：原上游许可证全文。

以上是准确保留的公开来源赛程/赛果CSV，尚不代表经过两家独立来源逐场复核。
"""
    saved["README_zh-CN.md"]=readme.encode("utf-8")
    saved["SHA256SUMS.txt"]=("\n".join(
        f"{sha256(payload)}  {path}" for path,payload in sorted(saved.items()))+"\n").encode("ascii")
    output.parent.mkdir(parents=True,exist_ok=True)
    with ZipFile(output,"w",ZIP_DEFLATED,compresslevel=9) as z:
        for path,payload in sorted(saved.items()):
            z.writestr(path,payload)
    with ZipFile(output) as z:
        assert z.testzip() is None and len(z.namelist())==len(saved)
    print(json.dumps(dict(status="OK",source_sha=SHA,
        files_in_zip=len(saved),csv_by_season=40,summary=stats,
        incomplete=[dict(league=x["LeagueZH"],season=x["Season"],missing=x["FTMissing"]) for x in incomplete],
        zip_size=output.stat().st_size,zip_sha256=sha256(output.read_bytes())),
        ensure_ascii=False))
if __name__=="__main__":
    build(Path(sys.argv[1]),Path(sys.argv[2]))
