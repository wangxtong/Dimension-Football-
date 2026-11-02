import { validateBundle } from './report-schema.mjs';
import { assertMarketObservationFreshness } from './market-observation-schema.mjs';
import { leagueName, teamName } from './locale-zh.mjs';
import { VERIFIED_TARGET_FINGERPRINT, VERIFIED_DASHBOARD_ORIGIN } from './hosted-notifications.mjs';

export const DAILY_OBSERVATION_KIND = 'daily-observation-delivery';
export const VERIFIED_DAILY_BOT_ID = '8858788137';
const prefix = 'daily-observation-notifications/';
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fingerprint = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const stamp = now => new Date(now).toISOString();
const beijing = now => new Date(now + 8 * 3600000).toISOString();
const day = now => beijing(now).slice(0,10);
const due = now => Number(beijing(now).slice(11,13)) >= 9;
const failure = (code,status=409) => Object.assign(Error(code),{code,status});
async function digest(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join(''); }
const label = value => Array.from(String(value).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,' ')).slice(0,60).join('')
  .replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const displayTime = value => beijing(typeof value==='number'?value:Date.parse(value)).slice(0,16).replace('T',' ')+'（北京时间）';
const knownCodes = new Set(['DAILY_NOT_DUE','DAILY_NOT_ATTEMPTED','DAILY_CLAIM_UNRESOLVED_NO_RETRY','DAILY_STORAGE_UNCERTAIN_NO_RETRY',
  'DAILY_TELEGRAM_ACCEPTED','DAILY_TELEGRAM_REJECTED','DAILY_TELEGRAM_RATE_LIMITED','DAILY_TELEGRAM_UNKNOWN_NO_RETRY',
  'DAILY_OUTCOME_NOT_PERSISTED_NO_RETRY','DAILY_REPORT_CHANGED_BEFORE_SEND','DAILY_REPORT_EXPIRED_BEFORE_SEND','DAILY_DATE_CHANGED_BEFORE_SEND']);
const statuses = new Set(['accepted','failed','unknown','skipped','not_attempted']);
const storedCodes = Object.freeze({accepted:['DAILY_TELEGRAM_ACCEPTED'],failed:['DAILY_TELEGRAM_REJECTED','DAILY_TELEGRAM_RATE_LIMITED'],
  unknown:['DAILY_CLAIM_UNRESOLVED_NO_RETRY','DAILY_STORAGE_UNCERTAIN_NO_RETRY','DAILY_TELEGRAM_UNKNOWN_NO_RETRY','DAILY_OUTCOME_NOT_PERSISTED_NO_RETRY'],
  skipped:['DAILY_REPORT_CHANGED_BEFORE_SEND','DAILY_REPORT_EXPIRED_BEFORE_SEND','DAILY_DATE_CHANGED_BEFORE_SEND']});

function receipt(base,status,code,extra={}) { return {version:1,kind:DAILY_OBSERVATION_KIND,...base,status,code,sentNow:false,...extra}; }
function response(receipt,requestedReportId=null) { return {version:1,kind:DAILY_OBSERVATION_KIND,requestedReportId,sentNow:receipt.sentNow,receipt}; }
function safeReceipt(value) {
  if(!object(value)||value.version!==1||value.kind!==DAILY_OBSERVATION_KIND||!/^\d{4}-\d{2}-\d{2}$/.test(value.date||'')
    ||!id(value.reportId)||!id(value.reportHash)||!fingerprint(value.destinationFingerprint)||!Number.isFinite(Date.parse(value.checkedAt))
    ||!statuses.has(value.status)||!knownCodes.has(value.code)||!storedCodes[value.status]?.includes(value.code)||typeof value.sentNow!=='boolean'
    ||value.status==='accepted'&&(!Number.isSafeInteger(value.messageId)||value.messageId<1||!id(value.payloadSha256)
      ||value.meaning!=='telegram-api-accepted-not-user-read')
    ||value.status!=='accepted'&&['messageId','payloadSha256','meaning'].some(key=>Object.hasOwn(value,key)))
    throw failure('DAILY_STORAGE_INVALID',503);
  // A storage corruption must never reflect unknown fields, credentials or arbitrary text.
  return {version:1,kind:DAILY_OBSERVATION_KIND,date:value.date,reportId:value.reportId,reportHash:value.reportHash,
    destinationFingerprint:value.destinationFingerprint,checkedAt:value.checkedAt,status:value.status,code:value.code,sentNow:false,
    ...(value.status==='accepted'?{messageId:value.messageId,payloadSha256:value.payloadSha256,meaning:'telegram-api-accepted-not-user-read'}:{})};
}
async function readClaim(bucket,key,date,target) {
  const stored=await bucket.get(key);if(!stored)return null;
  if(!Number.isSafeInteger(stored.size)||stored.size<0||stored.size>12000||typeof stored.etag!=='string'||stored.etag.length>512)throw failure('DAILY_STORAGE_INVALID',503);
  let value;try {value=JSON.parse(await stored.text());}catch{throw failure('DAILY_STORAGE_INVALID',503);}
  if(!exact(value,['version','date','destinationFingerprint','reportId','reportHash','createdAt','state','outcome'])||value.version!==1
    ||value.date!==date||value.destinationFingerprint!==target||!id(value.reportId)||!id(value.reportHash)
    ||!Number.isFinite(Date.parse(value.createdAt))||day(Date.parse(value.createdAt))!==date||!due(Date.parse(value.createdAt))
    ||!['prepared','complete'].includes(value.state))throw failure('DAILY_STORAGE_INVALID',503);
  if(value.state==='prepared'&&value.outcome!==null)throw failure('DAILY_STORAGE_INVALID',503);
  if(value.state==='complete') {
    const outcome=safeReceipt(value.outcome);
    const created=Date.parse(value.createdAt),checked=Date.parse(outcome.checkedAt),nextDate=day(created+86400000);
    if(outcome.date!==date||outcome.destinationFingerprint!==target||outcome.reportId!==value.reportId||outcome.reportHash!==value.reportHash)
      throw failure('DAILY_STORAGE_INVALID',503);
    // An acknowledgement may arrive just after midnight for a request begun
    // before midnight. Preserve its original daily lock and actual receipt time.
    if(day(created)!==date||!due(created)||checked<created||checked-created>1200000||![date,nextDate].includes(day(checked))
      ||outcome.code==='DAILY_DATE_CHANGED_BEFORE_SEND'&&day(checked)!==nextDate)throw failure('DAILY_STORAGE_INVALID',503);
    value.outcome=outcome;
  }
  return {etag:stored.etag,value};
}
function previous(claim,now) {
  return claim.value.state==='complete'?safeReceipt(claim.value.outcome):receipt({date:claim.value.date,reportId:claim.value.reportId,
    reportHash:claim.value.reportHash,destinationFingerprint:claim.value.destinationFingerprint,checkedAt:stamp(now)},'unknown','DAILY_CLAIM_UNRESOLVED_NO_RETRY');
}
function checkStorage(env) {if(!env.BUCKET?.get||!env.BUCKET?.put)throw failure('DAILY_STORAGE_UNAVAILABLE',503);}
function checkRequest(value) {
  if(!exact(value,['reportId'])||!id(value.reportId))throw failure('DAILY_REQUEST_INVALID',400);
}
function credentials(env) {
  const botToken=env.TELEGRAM_BOT_TOKEN,chatId=env.TELEGRAM_CHAT_ID;
  if(!botToken||!chatId)throw failure('DAILY_CREDENTIALS_REQUIRED',400);
  if(typeof botToken!=='string'||!/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(botToken)
    ||typeof chatId!=='string'||!/^(-)?\d{5,20}$/.test(chatId))throw failure('DAILY_CONFIGURATION_INVALID',400);
  return {botToken,chatId};
}
async function verifiedBundle(env,reportId,loadBundle,now) {
  let bundle;try {bundle=await loadBundle(env);validateBundle(bundle);}catch{throw failure('DAILY_REPORT_INVALID');}
  const report=bundle.report,web=bundle.receipt?.channels.externalWebsite;
  if(bundle.reportId!==reportId)throw failure('DAILY_REPORT_NOT_CURRENT');
  if(bundle.freshness?.mode!=='hosted'||bundle.health?.status!=='available'||report.publicationKind!=='observations'
    ||report.publication?.forecastPublished!==false||report.forecastPublished!==false||report.releaseGate?.status!=='BLOCKED'||report.simulated!==false
    ||report.model!==null||report.backtests.length!==0||report.summary.forecasts!==0||report.summary.strictCandidates!==0
    ||report.fixtures.some(row=>!exact(row.forecast,['status','reasons'])||row.forecast.status!=='unavailable'
      ||row.forecast.reasons.length!==1||row.forecast.reasons[0]!=='RELEASE_GATE_BLOCKED'||row.marketCandidate.candidate!==null
      ||row.marketCandidate.status==='candidate'))throw failure('DAILY_OBSERVATION_REQUIRED');
  if(!id(bundle.reportHash)||await digest(JSON.stringify(report))!==bundle.reportHash||web?.status!=='published'||web.servedVerified!==true
    ||web.reportId!==reportId||web.reportHash!==bundle.reportHash||web.mode!=='hosted'||web.forecastPublished!==false
    ||web.publicationKind!=='observations')throw failure('DAILY_REPORT_READBACK_REQUIRED');
  fresh(report,now);return bundle;
}
function fresh(report,now) {
  const scheduleAt=report.acquisition?.checkedAt||report.generatedAt,age=now-Date.parse(scheduleAt),generatedAge=now-Date.parse(report.generatedAt);
  if(!Number.isFinite(age)||age<0||age>1200000||!Number.isFinite(generatedAge)||generatedAge<0||generatedAge>1200000)throw failure('DAILY_REPORT_EXPIRED');
  try {assertMarketObservationFreshness(report,now);}catch{throw failure('DAILY_REPORT_EXPIRED');}
}

// Only fixed observation fields are rendered. No caller-supplied text, forecasts,
// probability, direction, odds, candidates or mutable historical metrics appear.
export function formatDailyObservation(report,now) {
  const rows=report.fixtures.filter(row=>['SCHEDULED','TIMED'].includes(row.fixture.status)
    &&Date.parse(row.fixture.kickoff)>now&&Date.parse(row.fixture.kickoff)<=now+86400000)
    .sort((a,b)=>Date.parse(a.fixture.kickoff)-Date.parse(b.fixture.kickoff));
  const heading=['⚽ <b>维度足球 · 每日赛事与数据状态</b>',`📅 ${day(now)}｜北京时间每日 09:00 后首个有效采集轮次`,
    '🔒 正式预测与今日优选尚未开放；本消息不含预测概率或投注方向。','',
    `🗓 <b>未来 24 小时赛程</b>｜${rows.length} 场`];
  const eventBlocks=rows.slice(0,7).map(row=>`• ${label(leagueName(row.fixture.league))}｜${label(teamName(row.fixture.home))} 对阵 ${label(teamName(row.fixture.away))}\n  ${displayTime(row.fixture.kickoff)}`);
  const lines=['',`📥 <b>采集覆盖</b>｜当前报告 ${report.fixtures.length} 场（公开来源样本，非完整联赛覆盖）`,
    `📎 来源：${report.attribution.slice(0,5).map(row=>label(row.name)).join('、')||'详见看板来源记录'}`,
    `🕒 赛程取得：${displayTime(report.acquisition?.checkedAt||report.generatedAt)}`];
  if(report.marketObservation)lines.push(`📡 报价来源检查：${displayTime(report.marketObservation.checkedAt)}`,
    `受检 ${report.marketObservation.fixtureCount} 场｜双源对齐 ${report.marketObservation.alignedEligibleFixtureCount} 场｜真实初盘 ${report.marketObservation.trueOpeningFixtureCount} 场`,
    `该次报价观察有效至：${displayTime(report.marketObservation.expiresAt)}`);
  lines.push('','🧩 <b>当前阻断</b>｜模型前瞻与校准待验收；严格候选仍需逐场初盘及来源证据。',
    '📚 历史回测和模型实验请在看板查看；不代表今日预测表现。',
    `🧾 报告 <code>${report.publication.reportId}</code>`,'⚠️ 报价和比赛状态会变化，请以看板所示时间为准。',
    `<a href="${VERIFIED_DASHBOARD_ORIGIN}/?view=schedule#schedule">打开完整中文看板</a>`);
  const visible=[],more='更多赛程可点击下方赛事按钮，或打开完整看板。';
  for(const block of eventBlocks) {
    if([...heading,...visible,block,more,...lines].join('\n').length>4096)break;
    visible.push(block);
  }
  const text=[...heading,...visible,...(visible.length<rows.length?[more]:rows.length?[]:['当前采集样本中没有未来 24 小时赛程。']),...lines].join('\n');
  if(text.length>4096)throw failure('DAILY_PRESENTATION_INVALID',503);
  const button=(text,section)=>({text,callback_data:`df1:${section}:0`});
  return {text,parse_mode:'HTML',link_preview_options:{is_disabled:true},reply_markup:{inline_keyboard:[
    [button('⚽ 今日赛事','schedule'),button('⭐ 优选门槛','picks')],
    [button('📚 历史回测','backtest'),button('📊 模型状态','model')],
    [button('🧾 赛后核账','settlement'),button('📡 来源诊断','sources')],
    [button('🔎 发布排查','status')]]}};
}
async function telegram({botToken,chatId,presentation,fetchImpl,base}) {
  const controller=new AbortController();let timer;
  try {return await Promise.race([(async()=>{
    const reply=await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`,{method:'POST',redirect:'manual',signal:controller.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,...presentation})});
    const reader=reply.body?.getReader();if(!reader)throw Error();let text='',size=0;const decoder=new TextDecoder();
    try {for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>16000)throw Error();text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
    finally {await reader.cancel().catch(()=>{});}
    const value=JSON.parse(text);
    if(reply.ok&&value.ok===true&&Number.isSafeInteger(value.result?.message_id)&&value.result.message_id>0&&String(value.result?.chat?.id)===chatId)
      return receipt(base,'accepted','DAILY_TELEGRAM_ACCEPTED',{messageId:value.result.message_id,payloadSha256:await digest(JSON.stringify(presentation)),meaning:'telegram-api-accepted-not-user-read'});
    if(reply.status>=400&&reply.status<500&&value.ok===false)return receipt(base,'failed',reply.status===429?'DAILY_TELEGRAM_RATE_LIMITED':'DAILY_TELEGRAM_REJECTED');
    return receipt(base,'unknown','DAILY_TELEGRAM_UNKNOWN_NO_RETRY');
  })(),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(receipt(base,'unknown','DAILY_TELEGRAM_UNKNOWN_NO_RETRY'));},10000);})]);}
  catch{return receipt(base,'unknown','DAILY_TELEGRAM_UNKNOWN_NO_RETRY');}finally{clearTimeout(timer);controller.abort();}
}

/** Synthetic identity override is for offline tests; the production exports stay pinned. */
export function createDailyObservationChannel({verifiedTargetFingerprint=VERIFIED_TARGET_FINGERPRINT,verifiedBotId=VERIFIED_DAILY_BOT_ID}={}) {
  if(!fingerprint(verifiedTargetFingerprint)||!/^\d{5,20}$/.test(verifiedBotId))throw failure('DAILY_CONFIGURATION_INVALID',400);
  const target=verifiedTargetFingerprint;
  return {
    async readStatus(env,{now=Date.now()}={}) {
      checkStorage(env);if(!Number.isFinite(now))throw failure('DAILY_REQUEST_INVALID',400);
      const date=day(now),claim=await readClaim(env.BUCKET,`${prefix}${date}-${target}.json`,date,target);
      return response(claim?previous(claim,now):receipt({date,reportId:null,destinationFingerprint:target,checkedAt:stamp(now)},'not_attempted','DAILY_NOT_ATTEMPTED'));
    },
    async notify(env,{body,fetchImpl=fetch,now=Date.now(),loadBundle}={}) {
      checkRequest(body);checkStorage(env);
      if(!Number.isFinite(now)||typeof loadBundle!=='function')throw failure('DAILY_REQUEST_INVALID',400);
      if(env.DASHBOARD_ORIGIN!==VERIFIED_DASHBOARD_ORIGIN)throw failure('DAILY_ORIGIN_INVALID',400);
      const started=Date.now(),clock=()=>now+Math.max(0,Date.now()-started),requested=body.reportId;
      let {botToken,chatId}=credentials(env);
      try {
        if(botToken.split(':',1)[0]!==verifiedBotId)throw failure('DAILY_CONFIGURATION_INVALID',400);
        if((await digest(chatId)).slice(0,16)!==target) {
          if(/^100\d+$/.test(chatId)&&(await digest('-'+chatId)).slice(0,16)===target)chatId='-'+chatId;
          else throw failure('DAILY_DESTINATION_MISMATCH',400);
        }
        const evaluatedAt=clock(),date=day(evaluatedAt),base={date,reportId:requested,destinationFingerprint:target,checkedAt:stamp(evaluatedAt)};
        if(!due(evaluatedAt))return response(receipt(base,'skipped','DAILY_NOT_DUE'),requested);
        const key=`${prefix}${date}-${target}.json`;
        let prior;try{prior=await readClaim(env.BUCKET,key,date,target);}catch{throw failure('DAILY_STORAGE_INVALID',503);}
        if(prior)return response(previous(prior,clock()),requested);
        const bundle=await verifiedBundle(env,requested,loadBundle,clock());base.reportHash=bundle.reportHash;
        fresh(bundle.report,clock());
        if(day(clock())!==date)return response(receipt({...base,checkedAt:stamp(clock())},'skipped','DAILY_DATE_CHANGED_BEFORE_SEND'),requested);
        // A predictable formatting failure must not consume the daily claim.
        formatDailyObservation(bundle.report,clock());
        const row={version:1,date,destinationFingerprint:target,reportId:requested,reportHash:bundle.reportHash,createdAt:stamp(clock()),state:'prepared',outcome:null};
        let saved;
        try {saved=await env.BUCKET.put(key,JSON.stringify(row),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});}
        catch{return response(receipt(base,'unknown','DAILY_STORAGE_UNCERTAIN_NO_RETRY'),requested);}
        if(!saved) {
          try {prior=await readClaim(env.BUCKET,key,date,target);}catch{}
          return response(prior?previous(prior,clock()):receipt(base,'unknown','DAILY_STORAGE_UNCERTAIN_NO_RETRY'),requested);
        }
        if(typeof saved.etag!=='string')return response(receipt(base,'unknown','DAILY_STORAGE_UNCERTAIN_NO_RETRY'),requested);
        let outcome;
        if(day(clock())!==date)outcome=receipt(base,'skipped','DAILY_DATE_CHANGED_BEFORE_SEND');
        else {
          let current;
          try {current=await verifiedBundle(env,requested,loadBundle,clock());}
          catch(error){outcome=receipt(base,'skipped',error.code==='DAILY_REPORT_NOT_CURRENT'?'DAILY_REPORT_CHANGED_BEFORE_SEND':'DAILY_REPORT_EXPIRED_BEFORE_SEND');}
          if(current&&current.reportHash!==bundle.reportHash)outcome=receipt(base,'skipped','DAILY_REPORT_CHANGED_BEFORE_SEND');
          else if(current&&day(clock())!==date)outcome=receipt(base,'skipped','DAILY_DATE_CHANGED_BEFORE_SEND');
          else if(current) {
            try {fresh(current.report,clock());}catch{outcome=receipt(base,'skipped','DAILY_REPORT_EXPIRED_BEFORE_SEND');}
            if(!outcome)outcome=await telegram({botToken,chatId,presentation:formatDailyObservation(current.report,clock()),fetchImpl,base});
          }
        }
        outcome={...outcome,checkedAt:stamp(clock())};
        try {const completed=await env.BUCKET.put(key,JSON.stringify({...row,state:'complete',outcome}),{onlyIf:{etagMatches:saved.etag},httpMetadata:{contentType:'application/json'}});
          if(!completed||typeof completed.etag!=='string')throw Error();}
        catch{return response(receipt({...base,checkedAt:stamp(clock())},'unknown','DAILY_OUTCOME_NOT_PERSISTED_NO_RETRY'),requested);}
        return response({...safeReceipt(outcome),sentNow:outcome.status==='accepted'},requested);
      } finally {botToken='';chatId='';}
    },
  };
}
const production=createDailyObservationChannel();
export const notifyDailyObservation=production.notify;
export const readDailyObservationStatus=production.readStatus;
