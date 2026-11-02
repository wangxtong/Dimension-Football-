import {VERIFIED_TARGET_FINGERPRINT,VERIFIED_DASHBOARD_ORIGIN} from './hosted-notifications.mjs';
import {VERIFIED_DAILY_BOT_ID} from './daily-observation-notifications.mjs';

const enc=new TextEncoder(),HEX=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const error=(code,status=400)=>Object.assign(new Error(code),{code,status});
const validTime=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const stamp=n=>new Date(n).toISOString();
const day=n=>new Date(n+8*3600_000).toISOString().slice(0,10);
const digest=async data=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(data)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const goodInt=v=>Number.isSafeInteger(v)&&v>=0;

export async function validateHeartbeat(h,now){
  if(!h||h.version!==1||h.kind!=='dimension-football-daily-system-heartbeat'
    ||!HEX.test(h.heartbeatId||'')||!HEX.test(h.reportId||'')||!COMMIT.test(h.codeSha||'')
    ||!validTime(h.checkedAt)||!validTime(h.sourceCheckedAt)
    ||day(Date.parse(h.checkedAt))!==h.beijingDay
    ||Date.parse(h.checkedAt)>now+60000||now-Date.parse(h.checkedAt)>20*60000
    ||!h.probes||![h.probes.successful,h.probes.failed,h.probes.unknown,h.probes.cached,h.probes.total].every(goodInt)
    ||h.probes.successful+h.probes.failed+h.probes.unknown+h.probes.cached!==h.probes.total
    ||h.model?.id!=='venue-poisson-v2'
    ||h.model.timeBasis!=='actual-prediction-forecast.generatedAt'
    ||h.model.computedAt!==null&&!validTime(h.model.computedAt)
    ||!goodInt(h.forecastsGenerated)
    ||!['Healthy','Unhealthy'].includes(h.deployment?.status)
    ||typeof h.deployment.siteVerified!=='boolean'
    ||typeof h.manualBackfill!=='boolean'
    ||!Array.isArray(h.blockers)||h.blockers.length>16||h.blockers.some(x=>typeof x!=='string'||x.length>120)
    ||h.telegram?.status!=='NOT_SENT'||h.telegram?.messageId!==null)
    throw error('HEARTBEAT_INPUT_INVALID');
  const {heartbeatId,...rest}=h;
  if(await digest(JSON.stringify(rest))!==heartbeatId)throw error('HEARTBEAT_HASH_MISMATCH',409);
  return h;
}
export function formatHeartbeat(h){
  const text='<b>维度足球 · 系统心跳</b>\n日期：'+escape(h.beijingDay)
    +'\n采集成功/失败：'+h.probes.successful+'/'+h.probes.failed
    +'\n未知/缓存：'+h.probes.unknown+'/'+h.probes.cached
    +'\n模型训练/计算UTC：'+escape(h.model.computedAt||'UNKNOWN')
    +'\n自动预测场数：'+h.forecastsGenerated
    +'\n部署环境：<b>'+escape(h.deployment.status)+'</b>'
    +(h.blockers.length?'\n失败原因：'+escape(h.blockers.join(', ')):'')
    +'\n报告：<code>'+h.heartbeatId+'</code>';
  if(text.length>4096)throw error('HEARTBEAT_PRESENTATION_TOO_LONG');
  return {chat_id:null,text,parse_mode:'HTML',link_preview_options:{is_disabled:true}};
}
async function stored(bucket,key){
  const old=await bucket.get(key);
  if(!old)return null;
  if(typeof old.etag!=='string'||old.size>25000)throw error('HEARTBEAT_STORAGE_CORRUPT',503);
  const data=JSON.parse(await old.text());
  if(!data||data.version!==1||!HEX.test(data.heartbeatId||'')
    ||!['prepared','complete'].includes(data.state))throw error('HEARTBEAT_STORAGE_CORRUPT',503);
  return {data,etag:old.etag};
}
async function telegram(token,chatId,presentation,fetchImpl){
  const ctrl=new AbortController();let timer;
  try{return await Promise.race([(async()=>{
    const reply=await fetchImpl('https://api.telegram.org/bot'+token+'/sendMessage',{
      method:'POST',redirect:'manual',signal:ctrl.signal,
      headers:{'content-type':'application/json'},body:JSON.stringify({...presentation,chat_id:chatId})});
    if(!reply?.body||!Number.isInteger(reply.status))throw Error();
    const reader=reply.body.getReader(),decoder=new TextDecoder(),parts=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>16000)throw Error();parts.push(decoder.decode(value,{stream:true}));}parts.push(decoder.decode());}
    finally{await reader.cancel().catch(()=>{})}
    const j=JSON.parse(parts.join(''));
    if(reply.ok&&j.ok===true&&goodInt(j.result?.message_id)&&j.result.message_id>0
      &&String(j.result?.chat?.id)===chatId)return {status:'accepted',code:'HEARTBEAT_TELEGRAM_ACCEPTED',messageId:j.result.message_id};
    if(reply.status>=400&&reply.status<500)return {status:'failed',code:'HEARTBEAT_TELEGRAM_REJECTED',messageId:null};
    return {status:'unknown',code:'HEARTBEAT_TELEGRAM_OUTCOME_UNKNOWN',messageId:null};
  })(),new Promise(resolve=>{timer=setTimeout(()=>{ctrl.abort();resolve({status:'unknown',code:'HEARTBEAT_TELEGRAM_OUTCOME_UNKNOWN',messageId:null});},10000)})]);}
  catch{return {status:'unknown',code:'HEARTBEAT_TELEGRAM_OUTCOME_UNKNOWN',messageId:null}}
  finally{clearTimeout(timer);ctrl.abort()}
}
export async function deliverHeartbeat(env,h,{now=Date.now(),fetchImpl=fetch,
  targetFingerprint=VERIFIED_TARGET_FINGERPRINT,verifiedBotId=VERIFIED_DAILY_BOT_ID}={}){
  if(!/^[a-f0-9]{16}$/.test(targetFingerprint)||!/^\d{5,20}$/.test(verifiedBotId)||!Number.isFinite(now))
    throw error('HEARTBEAT_CONFIG_INVALID');
  const startedAt=Date.now(),clock=()=>now+Math.max(0,Date.now()-startedAt);
  if(env.HOSTED_PUBLICATION_ENABLED!=='true'||env.VANTIS_SYSTEM_HEARTBEAT_ENABLED!=='true')
    throw error('HEARTBEAT_DISABLED',404);
  if(env.DASHBOARD_ORIGIN!==VERIFIED_DASHBOARD_ORIGIN
    ||typeof env.BUCKET?.put!=='function'||typeof env.BUCKET?.get!=='function')
    throw error('HEARTBEAT_ENV_INVALID',503);
  await validateHeartbeat(h,now);
  const token=env.TELEGRAM_BOT_TOKEN,provided=String(env.TELEGRAM_CHAT_ID||'');
  if(typeof token!=='string'||!token.startsWith(verifiedBotId+':')||token.length>256
    ||!/^-?\d{5,20}$/.test(provided))throw error('HEARTBEAT_CHANNEL_UNAVAILABLE',503);
  let chatId=provided;
  if((await digest(chatId)).slice(0,16)!==targetFingerprint){
    if(/^100\d+$/.test(chatId)&&(await digest('-'+chatId)).slice(0,16)===targetFingerprint)chatId='-'+chatId;
    else throw error('HEARTBEAT_DESTINATION_DENIED',403);
  }
  const key='system-heartbeat/'+h.beijingDay+'-'+targetFingerprint+'.json';
  let old=await stored(env.BUCKET,key);
  if(old)return old.data.state==='complete'?old.data.outcome
    :{status:'unknown',code:'HEARTBEAT_PENDING_NO_RETRY',messageId:null};
  const fresh=await validateHeartbeat(h,clock());
  if(day(clock())!==fresh.beijingDay)throw error('HEARTBEAT_DATE_CHANGED',409);
  const row={version:1,state:'prepared',heartbeatId:h.heartbeatId,reportId:h.reportId,
    destinationFingerprint:targetFingerprint,at:stamp(clock()),outcome:null};
  let claimed;
  try{claimed=await env.BUCKET.put(key,JSON.stringify(row),{
    onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});}
  catch{return {status:'unknown',code:'HEARTBEAT_CLAIM_UNVERIFIED',messageId:null}}
  if(!claimed||typeof claimed.etag!=='string'){
    old=await stored(env.BUCKET,key);
    return old?.data?.outcome||{status:'unknown',code:'HEARTBEAT_CLAIM_UNVERIFIED',messageId:null};
  }
  const presentation=formatHeartbeat(h);
  const result=await telegram(token,chatId,presentation,fetchImpl);
  const outcome={...result,heartbeatId:h.heartbeatId,reportId:h.reportId,
    payloadSha256:await digest(JSON.stringify({...presentation,chat_id:chatId})),sentAt:stamp(clock()),
    destinationFingerprint:targetFingerprint};
  try{const saved=await env.BUCKET.put(key,JSON.stringify({...row,state:'complete',outcome}),{
    onlyIf:{etagMatches:claimed.etag},httpMetadata:{contentType:'application/json'}});
    if(!saved?.etag)throw Error();
  }catch{return {status:'unknown',code:'HEARTBEAT_RECEIPT_UNPERSISTED_NO_RETRY',messageId:null}}
  return outcome;
}
export async function readHeartbeatReceipt(env,now=Date.now()){
  if(typeof env.BUCKET?.get!=='function')throw error('HEARTBEAT_STORAGE_UNAVAILABLE',503);
  const dayNow=day(now),key='system-heartbeat/'+dayNow+'-'+VERIFIED_TARGET_FINGERPRINT+'.json';
  const old=await stored(env.BUCKET,key);
  return old?.data?.outcome||{status:'not_attempted',code:'HEARTBEAT_NOT_ATTEMPTED',messageId:null};
}
