import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const SHA=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const fail=s=>{throw new Error('HEARTBEAT_'+s)};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DAY=86400000;

export function buildHeartbeat({sourceManifest,predictionDocument,siteReceipt=null,nowISO,codeSha}){
  if(!stamp(nowISO)||!COMMIT.test(codeSha||'')||sourceManifest?.simulated!==false
    ||!Array.isArray(sourceManifest?.diagnostics)||!stamp(sourceManifest.checkedAt)
    ||predictionDocument?.simulated!==false
    ||predictionDocument?.kind!=='prematch-forecast-report'
    ||!SHA.test(predictionDocument?.publication?.reportId||'')
    ||!stamp(predictionDocument.generatedAt)
    ||!Array.isArray(predictionDocument.fixtures))
    fail('INPUT_INVALID');
  const now=Date.parse(nowISO),sampleAt=Date.parse(sourceManifest.checkedAt),generatedAt=Date.parse(predictionDocument.generatedAt);
  if(sampleAt>now+60000||generatedAt>now+60000)fail('FUTURE_INPUT');
  const seen=new Set();let success=0,failure=0,unknown=0,cache=0;
  for(const d of sourceManifest.diagnostics){
    if(!d||typeof d.endpoint!=='string'||!d.endpoint.startsWith('https://')){unknown++;continue;}
    const marker=(d.endpoint||'')+'|'+(d.fetchedAt||d.checkedAt||'')+'|'+(d.httpStatus??'none');
    if(seen.has(marker))continue;
    seen.add(marker);
    if(d.httpStatus===200&&['available','partial','complete'].includes(d.status)){success++;continue;}
    if(d.status==='unavailable'||d.status==='failed'||d.status==='blocked'){failure++;continue;}
    if(d.cacheHit===true){cache++;continue;}
    unknown++;
  }
  const predicted=predictionDocument.fixtures.filter(row=>row?.forecast?.status==='forecast');
  const count=predicted.length;
  if(!Number.isSafeInteger(predictionDocument.summary?.forecasts)
    ||predictionDocument.summary.forecasts!==count)fail('FORECAST_COUNT_MISMATCH');
  if(predicted.some(row=>!stamp(row.forecast.generatedAt)
    ||Date.parse(row.forecast.generatedAt)>generatedAt
    ||row.fixture?.id===undefined||!stamp(row.fixture.kickoff)
    ||Date.parse(row.forecast.generatedAt)>=Date.parse(row.fixture.kickoff)))fail('FORECAST_CLOCK_INVALID');
  if(predictionDocument.model?.id!=='venue-poisson-v2'
    &&count>0)fail('MODEL_IDENTITY_INVALID');
  const modelComputedAt=count
    ?predicted.map(row=>row.forecast.generatedAt).sort().at(-1):null;
  const siteVerified=siteReceipt?.verified===true&&siteReceipt?.status==='published'
    &&siteReceipt?.servedVerified===true&&siteReceipt?.reportId===predictionDocument.publication.reportId
    &&siteReceipt?.deployedSha===codeSha&&stamp(siteReceipt.checkedAt)
    &&Date.parse(siteReceipt.checkedAt)<=now&&now-Date.parse(siteReceipt.checkedAt)<=15*60000;
  const fresh=now-sampleAt<=90*60000 &&now-generatedAt<=90*60000;
  const manual=siteReceipt?.manualBackfill===true||sourceManifest.manualBackfill===true;
  const reasons=[
    ...(!fresh?['COLLECTION_OR_MODEL_STALE']:[]),
    ...(unknown?['UNCLASSIFIED_SOURCE_PROBES']:[]),
    ...(count===0?['NO_VERIFIED_PREDICTION']:[]),
    ...(!siteVerified?['SITE_DEPLOYMENT_UNVERIFIED']:[]),
    ...(manual?['MANUAL_BACKFILL_DETECTED']:[])
  ];
  const base={version:1,kind:'dimension-football-daily-system-heartbeat',
    checkedAt:nowISO,beijingDay:new Date(now+8*3600000).toISOString().slice(0,10),
    codeSha,sourceCheckedAt:sourceManifest.checkedAt,reportId:predictionDocument.publication.reportId,
    probes:{successful:success,failed:failure,unknown,cached:cache,total:success+failure+unknown+cache},
    model:{id:'venue-poisson-v2',computedAt:modelComputedAt,timeBasis:'actual-prediction-forecast.generatedAt'},
    forecastsGenerated:count,deployment:{status:!reasons.length?'Healthy':'Unhealthy',
      siteVerified,checkedAt:siteVerified?siteReceipt.checkedAt:null},
    manualBackfill:manual,blockers:reasons,telegram:{status:'NOT_SENT',messageId:null}};
  return {...base,heartbeatId:hash(base)};
}
export function formatHeartbeatHTML(report){
  if(report?.kind!=='dimension-football-daily-system-heartbeat'||!SHA.test(report.heartbeatId||''))fail('REPORT_INVALID');
  return '<b>维度足球 · 每日系统心跳</b>\n'
    +'北京时间 '+esc(report.beijingDay)+'\n'
    +'采集成功数 / 失败数：'+report.probes.successful+' / '+report.probes.failed+'\n'
    +'未知 / 缓存：'+report.probes.unknown+' / '+report.probes.cached+'\n'
    +'模型训练与计算时间戳：'+esc(report.model.computedAt||'UNKNOWN')+'\n'
    +'预测生成数量：'+report.forecastsGenerated+'\n'
    +'部署环境状态：<b>'+report.deployment.status+'</b>\n'
    +(report.blockers.length?'异常：'+esc(report.blockers.join(', '))+'\n':'')
    +'报告ID：<code>'+report.heartbeatId+'</code>';
}
export async function produceHeartbeat(root,{nowISO=new Date().toISOString(),codeSha=process.env.GITHUB_SHA||process.env.COLLECTOR_COMMIT}={}){
  const reports=resolve(root,'reports'),read=async path=>JSON.parse(await readFile(join(reports,path),'utf8'));
  const sourceManifest=await read('public-fixtures.json'),predictionDocument=await read('predictions.json');
  let siteReceipt=null;try{siteReceipt=await read('site-deployment-receipt.json')}catch(e){if(e?.code!=='ENOENT')throw e}
  const heartbeat=buildHeartbeat({sourceManifest,predictionDocument,siteReceipt,nowISO,codeSha});
  const output=join(reports,'heartbeat');
  await mkdir(output,{recursive:true});
  const files={'heartbeat.json':JSON.stringify(heartbeat)+'\n','telegram-payload.html':formatHeartbeatHTML(heartbeat)};
  const receipt={version:1,kind:'heartbeat-immutable-receipt',
    heartbeatId:heartbeat.heartbeatId,reportId:heartbeat.reportId,
    files:Object.entries(files).map(([name,content])=>({name,sha256:createHash('sha256').update(content).digest('hex')})),
    telegramSent:false,messageId:null};
  for(const [name,content] of Object.entries({...files,'receipt.json':JSON.stringify(receipt)+'\n'}))
    await writeFile(join(output,name),content,{flag:'wx',mode:0o600});
  return heartbeat;
}
export async function verifyHeartbeat(root){
  const reports=resolve(root,'reports'),out=join(reports,'heartbeat');
  const receipt=JSON.parse(await readFile(join(out,'receipt.json'),'utf8'));
  if(receipt?.kind!=='heartbeat-immutable-receipt'||receipt.telegramSent!==false
    ||receipt.messageId!==null||receipt.files.length!==2)fail('RECEIPT_INVALID');
  for(const f of receipt.files){
    if(!['heartbeat.json','telegram-payload.html'].includes(f.name)
      ||createHash('sha256').update(await readFile(join(out,f.name),'utf8')).digest('hex')!==f.sha256)
      fail('TAMPERED');
  }
  const hb=JSON.parse(await readFile(join(out,'heartbeat.json'),'utf8'));
  if(hb.heartbeatId!==receipt.heartbeatId||hb.reportId!==receipt.reportId||hash((({heartbeatId,...rest})=>rest)(hb))!==hb.heartbeatId
    ||formatHeartbeatHTML(hb)!==await readFile(join(out,'telegram-payload.html'),'utf8'))
    fail('REPLAY_MISMATCH');
  return {status:'MACHINE_HEARTBEAT_VERIFIED',heartbeatId:hb.heartbeatId,environment:hb.deployment.status,
    telegramSent:false,messageId:null,sourceSuccess:hb.probes.successful,sourceFailure:hb.probes.failed};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,root]=process.argv.slice(2);
  try{
    if(process.argv.length!==4||!['--produce','--verify'].includes(mode))fail('ARGS');
    console.log(JSON.stringify(mode==='--produce'?await produceHeartbeat(root):await verifyHeartbeat(root)));
  }catch(error){console.error(/^HEARTBEAT_/.test(error.message)?error.message:'HEARTBEAT_FAILED');process.exitCode=1}
}
