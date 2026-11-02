import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FORECAST_MODEL} from './forecast.mjs';
import {readPredictionLedger,frozenPredictionIssues} from './prediction-ledger.mjs';
import {digest} from './policy.mjs';
import {validProbabilities} from './forecast-evaluation.mjs';

const SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const fail=s=>{throw Error('AUTO_'+s);};
const sha=s=>createHash('sha256').update(s).digest('hex');
const hash=o=>sha(JSON.stringify(o));
const clean=s=>typeof s==='string'&&s.length>0&&s.length<=200&&!/[\x00-\x1f\x7f]/.test(s);
const html=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct=n=>(100*n).toFixed(1)+'%';

export function buildAutomaticReadback({document,ledger,nowISO,codeSha}){
  const now=Date.parse(nowISO),reportId=document?.publication?.reportId;
  if(!Number.isFinite(now)||!COMMIT.test(codeSha||'')||document?.simulated!==false
    ||document.kind!=='prematch-forecast-report'||!SHA.test(reportId||'')
    ||Date.parse(document.generatedAt)>now||!Array.isArray(document.fixtures)
    ||document.model?.id!==FORECAST_MODEL.id||document.model.version!==FORECAST_MODEL.version
    ||document.model.calibrated===true||!ledger?.exists||!Array.isArray(ledger.events))
    fail('INPUT_INVALID');
  const modelHash=digest(document.model),frozen=new Map(),fixtures=[],rejected=[];
  for(const event of ledger.events)for(const row of event.predictions){
    if(row.reportId!==reportId)continue;
    if(frozenPredictionIssues(row).length||row.modelHash!==modelHash||row.model.id!==FORECAST_MODEL.id)continue;
    const key=row.source+':'+row.fixtureId;
    if(frozen.has(key))fail('DUPLICATE_LEDGER');
    frozen.set(key,row);
  }
  for(const row of document.fixtures){
    const f=row.fixture,p=row.forecast;
    if(!f||!p||![f.id,f.source,f.home,f.away].every(clean)||!Number.isFinite(Date.parse(f.kickoff))){
      rejected.push('MALFORMED_FIXTURE');continue;
    }
    if(p.status!=='forecast'){rejected.push('NOT_TRAINED');continue;}
    const record=frozen.get(f.source+':'+f.id);
    if(!record||record.kickoff!==f.kickoff||record.homeTeamId!==f.homeTeamId
      ||record.awayTeamId!==f.awayTeamId||record.generatedAt!==p.generatedAt
      ||record.trainingHash!==p.trainingHash||!validProbabilities(p.probabilities)
      ||!['home','draw','away'].every(k=>Math.abs(record.probabilities[k]-p.probabilities[k])<1e-10)
      ||Date.parse(record.recordedAt)>now||Date.parse(record.recordedAt)>=Date.parse(f.kickoff))
      fail('LEDGER_SOURCE_MISMATCH');
    const lead=Date.parse(f.kickoff)-now;
    if(lead<=0||lead>7*86400000){rejected.push('NOT_UPCOMING');continue;}
    const ranked=Object.entries(record.probabilities).sort((a,b)=>b[1]-a[1]);
    fixtures.push({fixtureId:f.id,source:f.source,league:f.league,home:f.home,away:f.away,
      kickoff:f.kickoff,predictionId:record.predictionId,generatedAt:record.generatedAt,
      recordedAt:record.recordedAt,modelId:record.model.id,modelVersion:record.model.version,
      modelHash:record.modelHash,trainingHash:record.trainingHash,probabilities:record.probabilities,
      selection:ranked[0][1]-ranked[1][1]<1e-9?null:ranked[0][0],
      leadHours:Math.round(lead/36000)/100});
  }
  fixtures.sort((a,b)=>a.kickoff.localeCompare(b.kickoff)||a.fixtureId.localeCompare(b.fixtureId));
  const base={version:1,kind:'venue-poisson-v2-auto-readback',generatedAt:nowISO,codeSha,
    sourceReportId:reportId,sourceReportHash:hash(document),modelId:FORECAST_MODEL.id,
    fixtures,eligible:fixtures.length,within36h:fixtures.filter(f=>f.leadHours<=36).length,
    excluded:rejected.length,commercialRelease:'BLOCKED',webStatus:'LOCAL_ONLY',telegramStatus:'NOT_SENT'};
  return {...base,readbackId:hash(base)};
}
export function webView(r){
  const rows=r.fixtures.map(f=>'<tr><td>'+html(f.league)+'</td><td>'+html(f.home)+' vs '+html(f.away)
    +'</td><td>'+html(f.kickoff)+'</td><td>'+pct(f.probabilities.home)
    +'</td><td>'+pct(f.probabilities.draw)+'</td><td>'+pct(f.probabilities.away)
    +'</td><td>'+html(f.selection||'接近')+'</td></tr>').join('');
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow">'
    +'<meta name="viewport" content="width=device-width,initial-scale=1"><title>维度足球自动预测</title>'
    +'<body style="background:#101f18;color:#efe8d4;font:16px/1.7 sans-serif;max-width:1000px;margin:auto;padding:20px">'
    +'<h1>维度足球 · 自动预测读回</h1><p>真实采集 → venue-poisson-v2 → 冻结账本 → 跨进程读回</p>'
    +'<p>研究参考，非投注建议；未来7天 '+r.eligible+' 场，36小时内 '+r.within36h+' 场。</p>'
    +'<table border="1" cellpadding="7"><tr><th>联赛</th><th>比赛</th><th>UTC开球</th><th>主胜</th><th>平局</th><th>客胜</th><th>方向</th></tr>'
    +rows+'</table><p style="overflow-wrap:anywhere">reportId: '+r.readbackId+'</p>'
    +'<p>此页面是机器验证工件，不代表真实网站已部署；Telegram尚未发送。</p></body></html>\n';
}
export function telegramDraft(r){
  const rows=r.fixtures.slice(0,3).map(f=>html(f.home)+' vs '+html(f.away)
    +' ('+html(f.kickoff)+')\n主 '+pct(f.probabilities.home)+' 平 '+pct(f.probabilities.draw)
    +' 客 '+pct(f.probabilities.away)).join('\n\n');
  const text='<b>维度足球 venue-poisson-v2 自动预测</b>\n研究参考，非投注建议\n'
    +'未来7天 '+r.eligible+' 场，36小时内 '+r.within36h+' 场\n\n'+rows
    +'\n\n<code>'+r.readbackId+'</code>';
  if(text.length>4096)fail('TG_TOO_LONG');
  return {kind:'telegram-research-draft',status:'NOT_SENT',parse_mode:'HTML',reportId:r.readbackId,text};
}
export async function makeReadback(root,nowISO=new Date().toISOString(),codeSha=process.env.GITHUB_SHA||process.env.COLLECTOR_COMMIT){
  const base=resolve(root,'reports'),document=JSON.parse(await readFile(join(base,'predictions.json'),'utf8'));
  const ledger=await readPredictionLedger({directory:join(base,'forecast-ledger')});
  const report=buildAutomaticReadback({document,ledger,nowISO,codeSha}),out=join(base,'auto-readback');
  await mkdir(out,{recursive:true});
  const files={'readback.json':JSON.stringify(report)+'\n','web.html':webView(report),
    'telegram-draft.json':JSON.stringify(telegramDraft(report))+'\n'};
  const receipt={kind:'auto-readback-receipt',readbackId:report.readbackId,codeSha,
    sourceReportId:report.sourceReportId,files:Object.entries(files).map(([name,value])=>({name,sha256:sha(value)})),
    siteDelivered:false,telegramSent:false};
  for(const [name,value] of Object.entries({...files,'receipt.json':JSON.stringify(receipt)+'\n'}))
    await writeFile(join(out,name),value,{flag:'wx',mode:0o600});
  return report;
}
export async function verifyReadback(root){
  const base=resolve(root,'reports'),out=join(base,'auto-readback');
  const receipt=JSON.parse(await readFile(join(out,'receipt.json'),'utf8'));
  if(receipt.kind!=='auto-readback-receipt'||receipt.siteDelivered!==false||receipt.telegramSent!==false)fail('RECEIPT_INVALID');
  for(const file of receipt.files){
    if(!['readback.json','web.html','telegram-draft.json'].includes(file.name))fail('RECEIPT_FILE_INVALID');
    if(sha(await readFile(join(out,file.name),'utf8'))!==file.sha256)fail('TAMPERED');
  }
  const r=JSON.parse(await readFile(join(out,'readback.json'),'utf8'));
  const doc=JSON.parse(await readFile(join(base,'predictions.json'),'utf8'));
  const ledger=await readPredictionLedger({directory:join(base,'forecast-ledger')});
  if(r.readbackId!==receipt.readbackId||r.sourceReportId!==receipt.sourceReportId
    ||r.sourceReportHash!==hash(doc)||hash(buildAutomaticReadback({document:doc,ledger,nowISO:r.generatedAt,codeSha:receipt.codeSha}))!==hash(r))
    fail('CROSS_PROCESS_MISMATCH');
  if(webView(r)!==await readFile(join(out,'web.html'),'utf8')
    ||JSON.stringify(telegramDraft(r))+'\n'!==await readFile(join(out,'telegram-draft.json'),'utf8'))
    fail('PRESENTATION_MISMATCH');
  return {status:'VERIFIED_MACHINE_READBACK',codeSha:r.codeSha,readbackId:r.readbackId,
    sourceReportId:r.sourceReportId,upcoming:r.eligible,within36h:r.within36h,
    first:r.fixtures[0]||null,siteDelivered:false,telegramSent:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const a=process.argv.slice(2);
    if(a.length!==2||!['--produce','--verify'].includes(a[0]))fail('ARGS_INVALID');
    const result=a[0]==='--produce'?await makeReadback(a[1]):await verifyReadback(a[1]);
    console.log(JSON.stringify(a[0]==='--produce'?{status:'WRITTEN_FROM_MODEL_LEDGER',count:result.eligible,
      readbackId:result.readbackId,sourceReportId:result.sourceReportId}:result));
  }catch(error){
    console.error(/^AUTO_|^LEDGER_/.test(error?.message||'')?error.message:'AUTO_PIPELINE_FAILED');
    process.exitCode=1;
  }
}
