const $=id=>document.getElementById(id);
const LEAGUES={PL:'英超',PD:'西甲',SA:'意甲',BL1:'德甲',FL1:'法甲',CL:'欧冠',BSA:'巴甲'};
const OUTCOMES={home:'主胜',draw:'平局',away:'客胜'};
const STATES={'frozen-research-forecasts':'已留存赛前冻结','no-today-source-report':'当日源报告缺失','ledger-not-restored':'冻结账本尚未恢复'};
const formatPercent=n=>Number.isFinite(n)?(n*100).toFixed(1)+'%':'—';
const formatScore=n=>Number.isFinite(n)?n.toFixed(4):'—';
const beijing=t=>Number.isFinite(Date.parse(t))?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',
  month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(t))+' 北京时间':'未提供';
const localDay=()=>new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const compactHash=s=>typeof s==='string'&&/^[a-f0-9]{40,64}$/i.test(s)?s.slice(0,16)+'…'+s.slice(-8):'未提供';
let currentReport=null, loading=false;

function setBadge(id,text,variant=''){
  const node=$(id);if(!node)return;node.textContent=text;node.className='pill'+(variant?' '+variant:'');
}
function cell(tr,text){
  const td=document.createElement('td');td.textContent=String(text);tr.append(td);return td;
}
function emptyRow(table,columns,message){
  const tr=document.createElement('tr');tr.className='empty';
  const td=cell(tr,message);td.colSpan=columns;table.append(tr);
}
function clearTables(message){
  for(const [id,n] of [['forecast-rows',6],['results-rows',8],['league-rows',7]]){
    const table=$(id);table.replaceChildren();emptyRow(table,n,message);
  }
  $('metrics').replaceChildren();
  $('meta').textContent='未取得可核验的赛前冻结报告。';
  $('forecast-count').textContent='暂无可显示的研究数据。';
  $('sample-note').textContent='没有真实评分输入时不显示命中率。';
  for(const id of ['report-id','report-sha','report-time','report-state'])$(id).textContent='未读取';
}
function validate(report){
  if(!report||report.kind!=='research-daily-1x2'||report.commercialReleaseGate!=='BLOCKED'
    ||report.mode!=='research-reference'||report.externalTelegramSent!==false
    ||report.strictMarkets?.releasedCandidates!==0
    ||typeof report.disclaimer!=='string'||!report.disclaimer.includes('非投注建议')
    ||!Array.isArray(report.forecasts?.candidates)
    ||!Number.isSafeInteger(report.forecasts.total)
    ||report.forecasts.total!==report.forecasts.candidates.length
    ||!report.prospective?.oneDay||!report.prospective?.sevenDays||!report.prospective?.thirtyDays)
    throw Error('RESEARCH_DATA_INVALID');
}
function probabilityCell(tr,value,chosen){
  const td=document.createElement('td');
  const wrap=document.createElement('div');wrap.className='prob'+(chosen?' chosen':'');
  const number=document.createElement('span');number.textContent=formatPercent(value);
  const track=document.createElement('i');track.setAttribute('aria-hidden','true');
  track.style.setProperty('--fill',Number.isFinite(value)?Math.max(0,Math.min(100,value*100))+'%':'0%');
  wrap.append(number,track);td.append(wrap);tr.append(td);
}
function forecastRows(report){
  const table=$('forecast-rows');table.replaceChildren();
  const filter=$('league-filter').value;
  const list=report.forecasts.candidates.filter(row=>filter==='all'||row.league===filter);
  for(const match of list){
    const tr=document.createElement('tr');tr.dataset.league=match.league;
    const who=document.createElement('td');
    const league=document.createElement('span');league.className='match-league';league.textContent=LEAGUES[match.league]||match.league;
    const names=document.createElement('span');names.className='match-name';
    names.textContent=String(match.home)+' · '+String(match.away);
    who.append(league,names);tr.append(who);
    cell(tr,beijing(match.kickoff));
    for(const key of ['home','draw','away'])probabilityCell(tr,match.probabilities?.[key],match.selection===key);
    const last=document.createElement('td'),pill=document.createElement('span');
    pill.className='selection';pill.textContent=OUTCOMES[match.selection]||'未知';last.append(pill);tr.append(last);table.append(tr);
  }
  if(!list.length)emptyRow(table,6,report.forecasts.total===0?'本轮没有符合赛前冻结条件的研究预测，不补场。':'该联赛暂无合格的冻结研究数据。');
  $('forecast-count').textContent='当前展示 '+list.length+' / '+report.forecasts.total+' 场 · 仅研究，不构成正式推荐。';
}
function windowRows(report){
  const table=$('results-rows');table.replaceChildren();
  for(const [label,value] of [['当日',report.prospective.oneDay],['7天',report.prospective.sevenDays],['30天',report.prospective.thirtyDays]]){
    const tr=document.createElement('tr');for(const value2 of [label,value.eligibleFrozen,value.scored,value.pending,value.voided,
      formatPercent(value.hitRate),formatScore(value.brier),formatScore(value.logLoss)])cell(tr,value2??'—');table.append(tr);
  }
  const leagues=$('league-rows');leagues.replaceChildren();
  const byLeague=report.prospective.byLeague30Days;
  if(Array.isArray(byLeague)&&byLeague.length){
    for(const value of byLeague){
      const tr=document.createElement('tr');for(const item of [LEAGUES[value.league]||value.league,
        value.eligibleFrozen,value.scored,value.pending,formatPercent(value.hitRate),formatScore(value.brier),
        formatScore(value.logLoss)])cell(tr,item??'—');leagues.append(tr);
    }
  }else emptyRow(leagues,7,'目前未提供可核验的分联赛前瞻评分。');
  const n=report.prospective.thirtyDays.scored;
  $('sample-note').textContent=n>=30?'30天样本已达到描述性统计最低数量；仍不足以单凭该值宣称商业可用。':
    '30天实际已评分 '+n+' 场，前瞻样本不足30场；指标只作描述，不作模型晋升结论。';
}
function metric(label,value,note){
  const card=document.createElement('article');card.className='metric';
  const name=document.createElement('span'),strong=document.createElement('b'),hint=document.createElement('small');
  name.textContent=label;strong.textContent=String(value);hint.textContent=note;card.append(name,strong,hint);return card;
}
function show(report){
  validate(report);currentReport=report;
  const outdated=report.beijingDay!==localDay();
  setBadge('state-pill',outdated?'历史日报':'最近已核验',outdated?'warning':'');
  $('status').textContent=(outdated?'此日报不是今天的新预测。':'服务器已读取研究报告。')+
    ' 报告日期 '+report.beijingDay+' · 最近生成 '+beijing(report.generatedAt)+
    ' · '+(STATES[report.state]||report.state);
  $('meta').textContent='研究日 '+report.beijingDay+' · 已冻结 '+report.forecasts.total+
    ' 场 · 严格盘口正式推荐 0 场 · 概率尚未校准';
  $('metrics').replaceChildren(
    metric('当日研究冻结',report.forecasts.total,'原始不可变赛前记录'),
    metric('30天已评分',report.prospective.thirtyDays.scored,'不含待FT或无效记录'),
    metric('30天方向命中率',formatPercent(report.prospective.thirtyDays.hitRate),'真实前瞻样本，非历史回测'),
    metric('当日待FT',report.prospective.oneDay.pending,'待官方结果并核账')
  );
  $('report-id').textContent=compactHash(report.reportId);
  $('report-sha').textContent=compactHash(report.codeSha);
  $('report-time').textContent=beijing(report.generatedAt);
  $('report-state').textContent=STATES[report.state]||String(report.state);
  setBadge('release-pill','正式推荐 0 场 · BLOCKED','warning');
  forecastRows(report);windowRows(report);
}
async function load(){
  if(loading)return;loading=true;const button=$('refresh');button.disabled=true;
  $('status').textContent='正在核验服务器研究报告…';setBadge('state-pill','核验中','warning');
  try{
    const response=await fetch('/api/research-daily',{cache:'no-store',credentials:'same-origin'});
    if(response.status===401){currentReport=null;location.assign('/login');return;}
    if(response.status===404){currentReport=null;clearTables('目前没有可核验的研究日报');setBadge('state-pill','尚无报告','warning');
      $('status').textContent='尚未有通过验真的研究日报；不是今天有零场合格预测的证明。';return;}
    if(!response.ok)throw Error('RESEARCH_REPORT_UNAVAILABLE');
    show(await response.json());
  }catch{
    currentReport=null;clearTables('当前数据不可核验，请稍后重试');
    setBadge('state-pill','核验失败','bad');
    $('status').textContent='研究日报当前不可核验，未展示任何旧数据作为本轮预测；正式推荐仍未发布。';
  }finally{loading=false;button.disabled=false;}
}
$('league-filter').addEventListener('change',()=>{if(currentReport)forecastRows(currentReport);});
$('refresh').addEventListener('click',load);
load();
