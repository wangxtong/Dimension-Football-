import { createHash } from 'node:crypto';

const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const LEAGUES = new Set(['PL','PD','BL1','SA','FL1']);
const LEAGUE_NAMES = { PL: '英超', PD: '西甲', BL1: '德甲', SA: '意甲', FL1: '法甲' };
const SIDE = { home:'主胜', draw:'平局', away:'客胜' };
const SYNC_KIND = 'dimension-football-private-dual-channel-preview';
const FAIL = code => { throw new Error('RESEARCH_SYNC_' + code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const safeName = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 120 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value);
const date = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,19) === value.slice(0,19);
const redactHTML = v => String(v).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function failUnless(expr, code) { if (!expr) FAIL(code); }
function checkRows(report, status) {
  const result=[];
  const seen=new Set();
  let forecastCount=0, unavailableCount=0;
  for (const entry of report.fixtures) {
    const f=entry?.fixture, p=entry?.forecast;
    failUnless(f && p && token(f.id) && token(f.source) && LEAGUES.has(f.league)
      && safeName(f.home) && safeName(f.away) && f.home!==f.away && date(f.kickoff)
      && date(f.fetchedAt || f.updatedAt) && ['forecast','unavailable'].includes(p.status)
      && p.fixtureId === f.id && date(p.generatedAt)
      && Date.parse(p.generatedAt) < Date.parse(f.kickoff)
      && Date.parse(p.generatedAt) <= Date.parse(report.generatedAt) + 60000
      && Date.parse(f.fetchedAt || f.updatedAt) <= Date.parse(p.generatedAt) + 60000,
      'FIXTURE_INVALID');
    const identity = f.source+':'+f.id;
    if (seen.has(identity)) FAIL('DUPLICATE_FIXTURE');
    seen.add(identity);
    const base={id:f.id,source:f.source,league:f.league,home:f.home,away:f.away,
      kickoffUTC:f.kickoff,forecastGeneratedAt:p.generatedAt,
      status:p.status};
    if (p.status === 'forecast') {
      const odds=p.probabilities;
      failUnless(odds && Object.keys(odds).length === 3
        && ['home','draw','away'].every(k=>typeof odds[k]==='number' && Number.isFinite(odds[k]) && odds[k]>=0 && odds[k]<=1)
        && Math.abs(odds.home+odds.draw+odds.away-1)<1e-6 && ['home','draw','away'].includes(p.selection)
        && date(p.trainingCutoff) && Date.parse(p.trainingCutoff)<=Date.parse(p.generatedAt)
        && date(p.freshness?.validUntil) && Date.parse(p.freshness.validUntil)>Date.parse(p.generatedAt),
        'FORECAST_INVALID');
      forecastCount++;
      result.push({...base, selection:p.selection,probabilities:{home:odds.home,draw:odds.draw,away:odds.away},
        trainingCutoff:p.trainingCutoff, validUntil:p.freshness.validUntil,calibrated:false,
        category:'UNRELEASED_RESEARCH_1X2',outcome:'NOT_SETTLED_OR_UNVERIFIED'});
    } else {
      failUnless(Array.isArray(p.reasons) && p.reasons.length>0 && p.reasons.length<=30
        && p.reasons.every(r=>token(r)), 'UNAVAILABLE_INVALID');
      unavailableCount++;
      result.push({...base,category:'NOT_EVALUABLE',reasons:p.reasons});
    }
  }
  failUnless(forecastCount === report.summary.forecasts && unavailableCount === report.summary.unavailable
    && report.summary.fixtures === result.length
    && status.dailyResearch.reportFixtures === result.length, 'TOTAL_MISMATCH');
  return result.sort((a,b)=>a.kickoffUTC.localeCompare(b.kickoffUTC)||a.source.localeCompare(b.source)||a.id.localeCompare(b.id));
}

export function buildResearchSync({report,publication,stage1,evaluation,reportBytes,publicationBytes}={}) {
  failUnless(report && publication && stage1 && evaluation
    && Buffer.isBuffer(reportBytes) && Buffer.isBuffer(publicationBytes), 'INPUT_REQUIRED');
  failUnless(report.version===1 && report.kind==='prematch-forecast-report'
    && report.simulated===false && date(report.generatedAt)
    && report.model?.calibrated===false && token(report.model?.id)
    && Number.isInteger(report.model?.version) && report.model.version>0
    && Array.isArray(report.fixtures) && report.fixtures.length<=1000
    && HASH.test(report.publication?.reportId||'')
    && publication.version===1 && publication.reportId===report.publication.reportId
    && publication.simulated===false && date(publication.generatedAt)
    && publication.generatedAt===report.generatedAt
    && publication.channels?.files?.status==='published'
    && ['not_configured','not_attempted','skipped',undefined].includes(publication.channels?.externalWebsite?.status)
    && ['not_configured','not_attempted','skipped',undefined].includes(publication.channels?.notifications?.status)
    && stage1.version===1 && stage1.kind==='dimension-football-stage1-private-research'
    && stage1.releaseGate==='BLOCKED' && stage1.forecastPublished===false
    && stage1.externalDeliveryAttempted===false
    && stage1.modelReadyForProspective===false && stage1.historicalPregameVisibility===false
    && SHA.test(stage1.codeSha||'') && stage1.dailyResearch?.reportId===report.publication.reportId
    && stage1.lanes?.fixtures?.reportId===report.publication.reportId
    && evaluation.scope==='private-research-freezes'
    && evaluation.releaseGate==='BLOCKED' && evaluation.forecastPublished===false
    && Number.isSafeInteger(evaluation.summary?.recordedScores)
    && evaluation.summary.recordedScores===stage1.dailyResearch.prospectiveScores,
    'PRIVATE_PROVENANCE_INVALID');
  const rows=checkRows(report,stage1);
  const projection={
    version:1,kind:SYNC_KIND, mode:'PRIVATE_RESEARCH_PREVIEW_ONLY',
    generatedAt:report.generatedAt, sourceReportId:report.publication.reportId,
    reportSha256:sha256(reportBytes),publicationSha256:sha256(publicationBytes),
    model:{id:report.model.id,version:report.model.version,calibrated:false},
    count:{fixtures:rows.length,researchForecasts:report.summary.forecasts,unavailable:report.summary.unavailable,
      settledProspective:stage1.dailyResearch.prospectiveScores},
    releaseGate:'BLOCKED',forecastPublished:false,telegramSent:false,webPublished:false,
    asOfUTC:stage1.capturedAt, sourceCodeSha:stage1.codeSha,
    sourcesApprovedForOfficialPicks:false,
    rows
  };
  failUnless(date(stage1.capturedAt),'STAGE1_TIME_INVALID');
  return {...projection,projectionSha256:sha256(JSON.stringify(projection))};
}
const percent=v=>(v*100).toFixed(1)+'%';
function renderedRow(row) {
  const game=LEAGUE_NAMES[row.league]+' · '+row.home+' vs '+row.away;
  return {game,summary:row.status==='forecast'
    ? '未校准1X2研究：主'+percent(row.probabilities.home)+'／平'+percent(row.probabilities.draw)+'／客'+percent(row.probabilities.away)
      +'；研究倾向'+SIDE[row.selection]
    : '无合格模型输入，暂不可评估'};
}
export function researchWebHTML(sync) {
  failUnless(sync?.kind===SYNC_KIND && sync.releaseGate==='BLOCKED'
    && sync.webPublished===false && sync.telegramSent===false
    && HASH.test(sync.projectionSha256||''),'WEB_SCOPE_INVALID');
  const body=sync.rows.map(row=>{
    const item=renderedRow(row);
    return '<tr><td>'+redactHTML(LEAGUE_NAMES[row.league])+'</td><td>'+redactHTML(row.home)+'<span class="vs">vs</span>'+redactHTML(row.away)
      +'</td><td>'+redactHTML(row.kickoffUTC)+'</td><td>'
      +redactHTML(item.summary)+'</td><td>'+redactHTML(row.status==='forecast'?'研究冻结':'不可评估')+'</td></tr>';
  }).join('');
  return '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">'
    +'<meta name="viewport" content="width=device-width,initial-scale=1">'
    +'<title>维度足球 · 私有研究预测双端同源预览</title>'
    +'<style>:root{color-scheme:dark}*{box-sizing:border-box}body{background:#06130e;color:#e8eee8;font:14px/1.7 system-ui,sans-serif;margin:0}'
    +'main{max-width:1180px;margin:auto;padding:40px 20px}h1{color:#dec37f;margin:0 0 8px}p{color:#adc1b5}'
    +'.notice{padding:14px 17px;border:1px solid #8e7648;border-radius:8px;margin:18px 0;color:#ead59e}'
    +'.metrics{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}.metric{flex:1;min-width:130px;background:#123026;border-radius:10px;padding:16px}'
    +'.metric strong{display:block;font-size:28px;color:#e4c785}.scroll{overflow:auto;border-radius:10px}'
    +'table{border-collapse:collapse;width:100%;min-width:810px;background:#10261d}th,td{padding:12px;border-bottom:1px solid #284a39;text-align:left}'
    +'th{background:#1a392b;color:#dfc78b}td{vertical-align:top}.vs{padding:0 6px;color:#91aa97}'
    +'code{word-break:break-all}small{color:#8ca595}@media(max-width:600px){main{padding:20px 12px}h1{font-size:23px}}</style></head><body><main>'
    +'<h1>维度足球 · 私有研究预测预览</h1><p>与Telegram草稿共享同一 reportId 与数据指纹。该页面只是私有Actions附件，不属于已部署Web网站。</p>'
    +'<div class="notice">⚠️ 研究基线未校准，缺少验证的市场赔率及正式放行。任何预测都不构成已发布推荐；过期研究概率不可当成当前行情。</div>'
    +'<div class="metrics"><div class="metric"><strong>'+sync.count.fixtures+'</strong>本轮赛程</div>'
    +'<div class="metric"><strong>'+sync.count.researchForecasts+'</strong>研究概率样本</div>'
    +'<div class="metric"><strong>'+sync.count.unavailable+'</strong>暂不可评估</div>'
    +'<div class="metric"><strong>'+sync.count.settledProspective+'</strong>真正赛后前瞻评分</div></div>'
    +'<p>模型：'+redactHTML(sync.model.id)+' v'+sync.model.version+'；生成时间：'+redactHTML(sync.generatedAt)+'</p>'
    +'<div class="scroll"><table><thead><tr><th>联赛</th><th>赛程</th><th>开球 UTC</th><th>研究分析</th><th>状态</th></tr></thead><tbody>'+body+'</tbody></table></div>'
    +'<p>同步报告：<code>'+sync.sourceReportId+'</code>；快照指纹：<code>'+sync.projectionSha256+'</code></p>'
    +'<small>正式发布门禁：BLOCKED · Telegram发送：未执行 · 此版本只保留研究快照；大小球/亚洲盘无合格输入，不生成方向。</small>'
    +'</main></body></html>';
}

export function researchTelegramDraft(sync) {
  failUnless(sync?.kind===SYNC_KIND && sync.releaseGate==='BLOCKED'
    && sync.forecastPublished===false && sync.telegramSent===false
    && sync.webPublished===false && HASH.test(sync.projectionSha256||''),'TELEGRAM_SCOPE_INVALID');
  const intro='<b>⚽ 维度足球 · 研究预测预览（未发送）</b>\n'
    +'⚠️ 未校准／无正式赔率资格。此为内部草稿，非今日正式推荐。\n'
    +'报告 <code>'+sync.sourceReportId.slice(0,12)+'</code> · 同源 <code>'+sync.projectionSha256.slice(0,12)+'</code>\n'
    +'模型 v'+sync.model.version+' · 赛程'+sync.count.fixtures+'／研究'+sync.count.researchForecasts+'／缺项'+sync.count.unavailable+'\n';
  const footer='\n<em>正式发布BLOCKED · 尚未调用Telegram Bot API · 大小球和真实盘口方向缺失</em>';
  const entries=sync.rows.map(row=>{
    const value=renderedRow(row);
    return '• '+redactHTML(value.game)+'\n  '+redactHTML(row.kickoffUTC.slice(5,16).replace('T',' '))+' UTC · '+redactHTML(value.summary);
  });
  const pages=[]; let buffer='';
  for(const entry of entries){
    if(intro.length+footer.length+entry.length+2>4096) FAIL('TELEGRAM_ENTRY_TOO_LARGE');
    const next=buffer?buffer+'\n'+entry:entry;
    if(intro.length+next.length+footer.length>4096){pages.push(buffer);buffer=entry;}
    else buffer=next;
  }
  if(buffer)pages.push(buffer);
  if(!pages.length)pages.push('暂无可评估赛程');
  return pages.map((body,i)=>intro+(pages.length>1?'第'+(i+1)+'/'+pages.length+'页\n':'')+body+footer);
}