const $=id=>document.getElementById(id);
const formatPercent=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'—';
const formatScore=n=>Number.isFinite(n)?n.toFixed(4):'—';
const beijing=time=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(time));
const LEAGUES={PL:'英超',PD:'西甲',SA:'意甲',BL1:'德甲',FL1:'法甲'};
const OUTCOMES={home:'主胜',draw:'平局',away:'客胜'};
function cells(tr,contents){for(const content of contents){const td=document.createElement('td');td.textContent=String(content);tr.append(td);}return tr;}
function show(report){
  if(report.kind!=='research-daily-1x2'||report.commercialReleaseGate!=='BLOCKED'||report.mode!=='research-reference'
    ||report.externalTelegramSent!==false||report.strictMarkets?.releasedCandidates!==0||!report.disclaimer.includes('非投注建议'))
    throw Error('RESEARCH_DATA_INVALID');
  const localDay=new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
  const outdated=report.beijingDay!==localDay;
  $('status').textContent=(outdated?'历史日报（不是今天新预测） · ':'最近核验 · ')+beijing(report.generatedAt)+'（北京） · 报告 '+report.reportId.slice(0,12)+'… · '+report.state;
  $('meta').textContent='研究日：'+report.beijingDay+' · 赛前冻结 '+report.forecasts.total+' 场 · 严格盘口正式推荐 0 场 · 模型不校准';
  const table=$('forecast-rows');table.replaceChildren();
  for(const match of report.forecasts.candidates){
    const tr=document.createElement('tr');cells(tr,[String(LEAGUES[match.league]||match.league)+' · '+match.home+' vs '+match.away,
      beijing(match.kickoff),formatPercent(match.probabilities.home),formatPercent(match.probabilities.draw),
      formatPercent(match.probabilities.away),OUTCOMES[match.selection]||'未知']);table.append(tr);
  }
  if(!report.forecasts.total){const tr=document.createElement('tr');cells(tr,['本轮没有符合赛前冻结条件的研究预测，不补场','','','','','']);table.append(tr);}
  const rows=$('results-rows');rows.replaceChildren();
  for(const [label,value] of [['当日',report.prospective.oneDay],['7天',report.prospective.sevenDays],['30天',report.prospective.thirtyDays]]){
    const tr=document.createElement('tr');cells(tr,[label,value.eligibleFrozen,value.scored,value.pending,value.voided,
      formatPercent(value.hitRate),formatScore(value.brier),formatScore(value.logLoss)]);rows.append(tr);
  }
  $('metrics').replaceChildren();
  for(const [label,value] of [['冻结总数',report.prospective.thirtyDays.eligibleFrozen],['已完成评分',report.prospective.thirtyDays.scored],
    ['30天方向命中率',formatPercent(report.prospective.thirtyDays.hitRate)],['当日待FT',report.prospective.oneDay.pending]]){
    const div=document.createElement('div');div.className='metric';const name=document.createElement('span');
    name.textContent=label;const strong=document.createElement('b');strong.textContent=String(value);div.append(name,strong);$('metrics').append(div);
  }
}
async function load(){
  $('status').textContent='正在核验研究报告…';
  try{
    const response=await fetch('/api/research-daily',{cache:'no-store',credentials:'same-origin'});
    if(response.status===401){location.assign('/login');return;}
    if(response.status===404){$('status').textContent='尚未有通过验真的研究日报；实时自动同步仍待首轮研究验收。';return;}
    if(!response.ok)throw Error('RESEARCH_REPORT_UNAVAILABLE');
    show(await response.json());
  }catch{
    $('status').textContent='研究日报当前不可核验。旧页面数据不代表最新预测；保持正式预测未发布。';
  }
}
$('refresh').addEventListener('click',load);load();
