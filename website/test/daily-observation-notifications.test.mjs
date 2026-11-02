import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,pbkdf2Sync } from 'node:crypto';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDailyObservationChannel,notifyDailyObservation,formatDailyObservation } from '../daily-observation-notifications.mjs';
import { VERIFIED_DASHBOARD_ORIGIN,notifyHostedReport } from '../hosted-notifications.mjs';
import { handleHostedRequest,loadHostedBundle } from '../hosted-publications.mjs';
import { createDashboard } from '../worker.mjs';
import { MemoryBucket,fakeKeys,machineRequest,token } from './hosted-fixtures.mjs';
import { NOW,ORIGIN,sampleBundle,sampleReport } from './fixtures.mjs';

const CHAT='-1001234567890',TOKEN='123456:offline_daily_secret_token_abcdefghijklmnop';
const fingerprint=value=>createHash('sha256').update(value).digest('hex').slice(0,16);
const dailyKeys=bucket=>[...bucket.rows.keys()].filter(key=>key.startsWith('daily-observation-notifications/'));
async function setup({now=NOW}={}) {
  const env={BUCKET:new MemoryBucket(),DASHBOARD_ORIGIN:ORIGIN},keys=fakeKeys();
  const call=(path,body)=>handleHostedRequest(machineRequest(path,{method:body?'POST':'GET',body,
    bearer:token({iat:now/1000-1,nbf:now/1000-1,exp:now/1000+299})}),env,{fetchImpl:keys.fetchImpl,now});
  const input=sampleBundle(sampleReport('a',now-NOW));
  assert.equal((await call('/internal/observations',input)).status,200);
  assert.equal((await call('/internal/report-status')).status,200);
  const state={bundle:await loadHostedBundle(env),sends:[]};
  env.DASHBOARD_ORIGIN=VERIFIED_DASHBOARD_ORIGIN;env.TELEGRAM_BOT_TOKEN=TOKEN;env.TELEGRAM_CHAT_ID=CHAT;
  const channel=createDailyObservationChannel({verifiedTargetFingerprint:fingerprint(CHAT),verifiedBotId:'123456'});
  const body=()=>({reportId:state.bundle.reportId});
  const options=()=>({body:body(),now,loadBundle:async()=>structuredClone(state.bundle),fetchImpl:async(url,init)=>{
    state.sends.push({url,init});return Response.json({ok:true,result:{message_id:91,chat:{id:Number(CHAT)}}});}});
  const send=overrides=>channel.notify(env,{...options(),...overrides});
  return {env,state,channel,body,options,send,now};
}

test('daily observation sends only redacted fixed fields and preserves formal notification block',async()=>{
  const s=await setup(),old=s.state.bundle.receipt.channels.notifications;
  const result=await s.send();assert.equal(result.kind,'daily-observation-delivery');assert.equal(result.receipt.status,'accepted');
  assert.equal(result.sentNow,true);assert.equal(result.receipt.sentNow,true);assert.equal(result.receipt.messageId,91);
  assert.equal(result.receipt.reportId,s.state.bundle.reportId);assert.equal(result.receipt.reportHash,s.state.bundle.reportHash);
  assert.equal(result.receipt.meaning,'telegram-api-accepted-not-user-read');assert.equal(s.state.sends.length,1);
  const sent=s.state.sends[0];assert.equal(sent.url,`https://api.telegram.org/bot${TOKEN}/sendMessage`);assert.equal(sent.init.redirect,'manual');
  const payload=JSON.parse(sent.init.body);assert.equal(payload.chat_id,CHAT);assert.equal(payload.parse_mode,'HTML');
  assert.equal(payload.reply_markup.inline_keyboard.flat().length,7);
  assert.match(payload.text,/每日赛事与数据状态/);assert.match(payload.text,/正式预测与今日优选尚未开放/);assert.match(payload.text,/未来 24 小时赛程/);
  assert.doesNotMatch(payload.text,/50\.0%|decimalOdds|probabilities|1\.85/);assert.ok(payload.text.length<=4096);
  assert.deepEqual(payload.reply_markup.inline_keyboard.flat().map(b=>b.callback_data),['schedule','picks','backtest','model','settlement','sources','status'].map(section=>`df1:${section}:0`));
  assert.ok(payload.text.includes(VERIFIED_DASHBOARD_ORIGIN));
  assert.deepEqual(s.state.bundle.receipt.channels.notifications,old);
  assert.equal((await loadHostedBundle(s.env)).receipt.channels.notifications.code,'RELEASE_GATE_BLOCKED');
  for(const value of s.env.BUCKET.rows.values()){assert.ok(!value.text.includes(TOKEN));assert.ok(!value.text.includes(CHAT));}
  assert.ok(!JSON.stringify(result).includes(TOKEN));assert.ok(!JSON.stringify(result).includes(CHAT));
  assert.equal(dailyKeys(s.env.BUCKET).length,1);
});

test('before Beijing09 does not claim;09 starts a date-wide lock shared across report changes',async()=>{
  const s=await setup({now:Date.parse('2026-10-31T00:59:59Z')});
  assert.equal((await s.send()).receipt.code,'DAILY_NOT_DUE');assert.equal(dailyKeys(s.env.BUCKET).length,0);
  const first=await s.send({now:s.now+1000});assert.equal(first.receipt.status,'accepted');
  s.state.bundle.reportId='b'.repeat(64);
  const repeat=await s.send({now:s.now+6000});assert.equal(repeat.receipt.status,'accepted');assert.equal(repeat.sentNow,false);
  assert.notEqual(repeat.receipt.reportId,repeat.requestedReportId);assert.equal(repeat.receipt.reportId,first.receipt.reportId);assert.equal(s.state.sends.length,1);
  const status=await s.channel.readStatus(s.env,{now:s.now+5000});assert.equal(status.receipt.messageId,91);assert.equal(status.sentNow,false);
});

test('concurrent workers use one conditional daily claim and never double send',async()=>{
  const s=await setup();
  const results=await Promise.all(Array.from({length:8},()=>s.send()));
  assert.equal(s.state.sends.length,1);assert.equal(results.filter(r=>r.sentNow).length,1);assert.equal(dailyKeys(s.env.BUCKET).length,1);
});

test('configuration, fixed destination, request schema and origin fail before consuming a claim',async()=>{
  for(const mutate of [(b,e)=>e.TELEGRAM_BOT_TOKEN='',(b,e)=>e.TELEGRAM_CHAT_ID='',(b,e)=>e.TELEGRAM_CHAT_ID='-1009999999999',
    (b,e)=>e.TELEGRAM_BOT_TOKEN='not-token',b=>b.text='arbitrary text',b=>b.credentials={botToken:TOKEN,chatId:CHAT},b=>b.reportId='wrong']) {
    const s=await setup(),body=s.body();mutate(body,s.env);await assert.rejects(s.send({body}),error=>error.status===400);
    assert.equal(dailyKeys(s.env.BUCKET).length,0);assert.equal(s.state.sends.length,0);
  }
  const wrong=await setup();wrong.env.DASHBOARD_ORIGIN='https://evil.example';await assert.rejects(wrong.send(),{code:'DAILY_ORIGIN_INVALID'});
  const production=await setup();await assert.rejects(notifyDailyObservation(production.env,production.options()),{code:'DAILY_CONFIGURATION_INVALID'});
  const sign=await setup(),body=sign.body();sign.env.TELEGRAM_CHAT_ID=CHAT.slice(1);
  assert.equal((await sign.send({body})).receipt.status,'accepted');assert.equal(JSON.parse(sign.state.sends[0].init.body).chat_id,CHAT);
});

test('simulated, unredacted, stale, unserved and wrong-hash reports never consume a claim',async()=>{
  for(const mutate of [
    s=>s.state.bundle.report.simulated=true,
    s=>s.state.bundle.report.publicationKind='forecast',
    s=>s.state.bundle.report.forecastPublished=true,
    s=>s.state.bundle.report.fixtures[0].forecast.probabilities={home:.5,draw:.3,away:.2},
    s=>s.state.bundle.report.model={id:'unreleased'},
    s=>s.state.bundle.reportHash='b'.repeat(64),
    s=>s.state.bundle.receipt.channels.externalWebsite.servedVerified=false,
    s=>s.state.bundle.receipt.channels.externalWebsite.reportHash='b'.repeat(64),
    s=>s.state.bundle.freshness.mode='bootstrap',
  ]) {
    const s=await setup();mutate(s);await assert.rejects(s.send(),error=>error.status===409);
    assert.equal(dailyKeys(s.env.BUCKET).length,0);assert.equal(s.state.sends.length,0);
  }
  const expired=await setup();await assert.rejects(expired.send({now:NOW+1200001}),{code:'DAILY_REPORT_EXPIRED'});
  assert.equal(dailyKeys(expired.env.BUCKET).length,0);
});

test('current report changes after claim prevent sending and leave a durable skipped outcome',async()=>{
  const s=await setup();let loads=0;
  const result=await s.send({loadBundle:async()=>{const b=structuredClone(s.state.bundle);if(++loads>1){b.reportId='b'.repeat(64);b.report.publication.reportId=b.reportId;b.receipt.reportId=b.reportId;}return b;}});
  assert.equal(result.receipt.code,'DAILY_REPORT_CHANGED_BEFORE_SEND');assert.equal(s.state.sends.length,0);
  assert.equal((await s.send()).receipt.status,'skipped');assert.equal(s.state.sends.length,0);
});

test('transport errors, redirects, oversized and mismatched Telegram responses stay unknown and never retry',async()=>{
  for(const reply of [async()=>{throw Error(TOKEN);},async()=>Response.json({ok:false,description:TOKEN},{status:500}),
    async()=>new Response('x'.repeat(20000)),async()=>new Response('invalid'),
    async()=>Response.json({ok:true,result:{message_id:91,chat:{id:-1009999999999}}}),
    async()=>new Response('{}',{status:302,headers:{location:'https://evil.example'}})]) {
    const s=await setup();let sends=0;const opts={fetchImpl:async(...args)=>{sends++;return reply(...args);}};
    const first=await s.send(opts);assert.equal(first.receipt.status,'unknown');assert.equal(first.sentNow,false);
    assert.equal((await s.send(opts)).receipt.status,'unknown');assert.equal(sends,1);
    assert.ok(!JSON.stringify(first).includes(TOKEN));
    for(const value of s.env.BUCKET.rows.values())assert.ok(!value.text.includes(TOKEN));
  }
});

test('explicit rejection is recorded once and does not automatically retry that date',async()=>{
  for(const code of [403,429]) {
    const s=await setup();let sends=0;const opts={fetchImpl:async()=>{sends++;return Response.json({ok:false,description:TOKEN},{status:code});}};
    const result=await s.send(opts);assert.equal(result.receipt.status,'failed');assert.equal(result.receipt.code,code===429?'DAILY_TELEGRAM_RATE_LIMITED':'DAILY_TELEGRAM_REJECTED');
    assert.equal((await s.send(opts)).receipt.status,'failed');assert.equal(sends,1);
  }
});

test('uncertain preparation acknowledgement and failed outcome persistence never trigger resend',async()=>{
  for(const stage of ['prepared','complete']) {
    const s=await setup(),put=s.env.BUCKET.put.bind(s.env.BUCKET);let lost=false;
    s.env.BUCKET.put=async(key,text,options)=>{
      if(key.startsWith('daily-')&&JSON.parse(text).state===stage&&!lost){lost=true;if(stage==='prepared')await put(key,text,options);throw Error(TOKEN);}
      return put(key,text,options);
    };
    const result=await s.send();assert.equal(result.receipt.status,'unknown');assert.equal(s.state.sends.length,stage==='complete'?1:0);
    assert.equal((await s.send()).receipt.code,'DAILY_CLAIM_UNRESOLVED_NO_RETRY');assert.equal(s.state.sends.length,stage==='complete'?1:0);
  }
});

test('lost completion acknowledgement recovers a durable accepted receipt without repeating Telegram',async()=>{
  const s=await setup(),put=s.env.BUCKET.put.bind(s.env.BUCKET);let lost=false;
  s.env.BUCKET.put=async(key,text,options)=>{const result=await put(key,text,options);
    if(key.startsWith('daily-')&&JSON.parse(text).state==='complete'&&!lost){lost=true;throw Error(TOKEN);}return result;};
  assert.equal((await s.send()).receipt.status,'unknown');const recovered=await s.send();assert.equal(recovered.receipt.status,'accepted');
  assert.equal(recovered.sentNow,false);assert.equal(s.state.sends.length,1);
});

test('a claim cannot cross Beijing midnight during asynchronous report read and send yesterday after midnight',async t=>{
  const s=await setup({now:Date.parse('2026-10-31T15:59:59Z')});let elapsed=0,loads=0;t.mock.method(Date,'now',()=>elapsed);
  const result=await s.send({loadBundle:async()=>{if(++loads===2)elapsed=2000;return structuredClone(s.state.bundle);}});
  assert.equal(result.receipt.code,'DAILY_DATE_CHANGED_BEFORE_SEND');assert.equal(s.state.sends.length,0);
});

test('a new Beijing day can send only after09 and uses a distinct daily record',async()=>{
  const s=await setup();await s.send();
  const next=await setup({now:NOW+86400000});next.env.BUCKET=s.env.BUCKET;
  const result=await next.send();assert.equal(result.receipt.status,'accepted');assert.equal(result.receipt.date,'2026-11-01');
  assert.equal(dailyKeys(s.env.BUCKET).length,2);
});

test('fresh generation cannot renew stale acquisition or expired positive market observations',async()=>{
  for(const kind of ['schedule','market']) {
    const s=await setup(),report=s.state.bundle.report;
    report.acquisition={snapshotHash:'c'.repeat(64),commit:'d'.repeat(40),checkedAt:new Date(NOW-(kind==='schedule'?1200001:0)).toISOString()};
    const source=(id,group)=>({id,group,status:'unavailable',quoteCount:0,pairedFixtureCount:0,latestSourceUpdatedAt:null,openingCount:0});
    const sources=[source('hkjc','hkjc-first-party'),source('macauslot','macauslot-official'),source('titan007','titan007')];
    if(kind==='market')Object.assign(sources[0],{status:'available',quoteCount:2,pairedFixtureCount:1,latestSourceUpdatedAt:new Date(NOW).toISOString()});
    report.marketObservation={version:1,checkedAt:report.generatedAt,expiresAt:new Date(NOW+1000).toISOString(),fixtureCount:3,sources,
      dualSourceFixtureCount:0,alignedEligibleFixtureCount:0,trueOpeningFixtureCount:0,releaseGate:'BLOCKED'};
    for(const row of report.fixtures)row.fixture.fetchedAt=new Date(NOW).toISOString();
    s.state.bundle.reportHash=createHash('sha256').update(JSON.stringify(report)).digest('hex');
    s.state.bundle.receipt.channels.externalWebsite.reportHash=s.state.bundle.reportHash;
    await assert.rejects(s.send({now:NOW+2000}),{code:'DAILY_REPORT_EXPIRED'});
    assert.equal(dailyKeys(s.env.BUCKET).length,0);assert.equal(s.state.sends.length,0);
  }
});

test('a delayed second read rechecks freshness immediately before sending',async t=>{
  const s=await setup();let elapsed=0,loads=0;t.mock.method(Date,'now',()=>elapsed);
  const result=await s.send({loadBundle:async()=>{if(++loads===2)elapsed=1200001;return structuredClone(s.state.bundle);}});
  assert.equal(result.receipt.code,'DAILY_REPORT_EXPIRED_BEFORE_SEND');assert.equal(s.state.sends.length,0);
});

test('an expired or midnight-crossing first read does not consume a daily claim',async t=>{
  let elapsed=0;t.mock.method(Date,'now',()=>elapsed);
  const expired=await setup();
  await assert.rejects(expired.send({loadBundle:async()=>{elapsed+=1200001;return structuredClone(expired.state.bundle);}}),{code:'DAILY_REPORT_EXPIRED'});
  assert.equal(dailyKeys(expired.env.BUCKET).length,0);assert.equal(expired.state.sends.length,0);
  elapsed=0;const midnight=await setup({now:Date.parse('2026-10-31T15:59:59Z')});
  const result=await midnight.send({loadBundle:async()=>{elapsed+=2000;return structuredClone(midnight.state.bundle);}});
  assert.equal(result.receipt.code,'DAILY_DATE_CHANGED_BEFORE_SEND');assert.equal(result.receipt.checkedAt,'2026-10-31T16:00:01.000Z');
  assert.equal(dailyKeys(midnight.env.BUCKET).length,0);assert.equal(midnight.state.sends.length,0);
});

test('stored receipt corruption cannot echo unknown fields or clear a prepared send lock',async()=>{
  const s=await setup();await s.send();const key=dailyKeys(s.env.BUCKET)[0],row=s.env.BUCKET.json(key);
  row.outcome.credentials={botToken:TOKEN};await s.env.BUCKET.put(key,JSON.stringify(row));
  const status=await s.channel.readStatus(s.env,{now:NOW});assert.ok(!JSON.stringify(status).includes(TOKEN));
  row.outcome.code=TOKEN;await s.env.BUCKET.put(key,JSON.stringify(row));
  await assert.rejects(s.channel.readStatus(s.env,{now:NOW}),{code:'DAILY_STORAGE_INVALID'});
  await assert.rejects(s.send(),{code:'DAILY_STORAGE_INVALID'});assert.equal(s.state.sends.length,1);
});

test('stored status/code, accepted-only fields and receipt chronology must agree',async()=>{
  for(const corrupt of [
    r=>r.outcome.code='DAILY_NOT_DUE',r=>r.outcome.status='unknown',r=>r.outcome.meaning='user-read',
    r=>r.outcome.checkedAt=new Date(NOW-1000).toISOString(),r=>r.createdAt=new Date(NOW-86400000).toISOString(),
    r=>r.outcome.checkedAt=new Date(Date.parse(r.createdAt)+1200001).toISOString(),
  ]) {
    const s=await setup();await s.send();const key=dailyKeys(s.env.BUCKET)[0],row=s.env.BUCKET.json(key);corrupt(row);
    await s.env.BUCKET.put(key,JSON.stringify(row));await assert.rejects(s.channel.readStatus(s.env,{now:NOW}),{code:'DAILY_STORAGE_INVALID'});
    await assert.rejects(s.send(),{code:'DAILY_STORAGE_INVALID'});assert.equal(s.state.sends.length,1);
  }
});

test('a request started before midnight retains yesterday lock when its API acknowledgement arrives after midnight',async t=>{
  const s=await setup({now:Date.parse('2026-10-31T15:59:59Z')});let elapsed=0;t.mock.method(Date,'now',()=>elapsed);
  const sent=await s.send({fetchImpl:async()=>{elapsed=2000;return Response.json({ok:true,result:{message_id:91,chat:{id:Number(CHAT)}}});}});
  assert.equal(sent.receipt.status,'accepted');assert.equal(sent.receipt.date,'2026-10-31');assert.equal(sent.receipt.checkedAt,'2026-10-31T16:00:01.000Z');
  // Reading that day's persisted evidence does not erase the actual receipt time.
  const status=await s.channel.readStatus(s.env,{now:s.now});assert.equal(status.receipt.status,'accepted');assert.equal(status.receipt.checkedAt,sent.receipt.checkedAt);
});

test('daily formatter escapes source labels and shows empty future schedule without claiming recommendations',async()=>{
  const s=await setup(),report=s.state.bundle.report;report.fixtures[0].fixture.home='<b>evil & team</b>';
  const msg=formatDailyObservation(report,NOW);assert.ok(msg.text.includes('&lt;b&gt;evil &amp; team&lt;/b&gt;'));assert.ok(!msg.text.includes('<b>evil'));
  const empty=formatDailyObservation(report,NOW+86400000);assert.match(empty.text,/没有未来 24 小时赛程/);assert.match(empty.text,/正式预测与今日优选尚未开放/);
});

test('escaped long labels are bounded by complete event blocks rather than locking an unsendable digest',async()=>{
  const s=await setup(),report=s.state.bundle.report;
  report.fixtures=Array.from({length:7},(_,i)=>{const r=structuredClone(report.fixtures[0]);r.fixture.id='long-'+i;r.fixture.home='&'.repeat(60);r.fixture.away='&'.repeat(60);r.fixture.league='&'.repeat(60);return r;});
  report.summary={fixtures:7,forecasts:0,unavailable:7,strictCandidates:0};report.categories.unassessable=report.fixtures.map(r=>r.fixture.id);
  const presentation=formatDailyObservation(report,NOW);assert.ok(presentation.text.length<=4096);assert.match(presentation.text,/更多赛程/);
  assert.ok(presentation.text.includes('请以看板所示时间为准。'));assert.ok(presentation.text.endsWith('打开完整中文看板</a>'));assert.ok(!presentation.text.includes('&&'));
  s.state.bundle.reportHash=createHash('sha256').update(JSON.stringify(report)).digest('hex');s.state.bundle.receipt.channels.externalWebsite.reportHash=s.state.bundle.reportHash;
  assert.equal((await s.send()).receipt.status,'accepted');assert.equal(s.state.sends.length,1);
});

test('new daily channel does not make existing formal notification callable',async()=>{
  const s=await setup();s.env.RELEASE_GATE='GREEN';await assert.rejects(notifyHostedReport(s.env,s.options()),{code:'RELEASE_GATE_BLOCKED'});
  assert.equal(s.state.sends.length,0);assert.equal(dailyKeys(s.env.BUCKET).length,0);
});

test('built Worker requires OIDC for daily writes, login for status, and does not reflect credentials',async()=>{
  const out=await mkdtemp(join(tmpdir(),'daily-worker-'));
  try {
    await promisify(execFile)(process.execPath,['website/build.mjs',out]);
    const source=await readFile(join(out,'server/index.js'),'utf8');assert.ok(!/^import\s/m.test(source));
    const {createDashboard:built}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const password='offline-password',salt='ab'.repeat(16),auth={username:'viewer',salt,iterations:100000,
      hash:pbkdf2Sync(password,Buffer.from(salt,'hex'),100000,32,'sha256').toString('hex')};
    const env={DASHBOARD_AUTH:JSON.stringify(auth),DASHBOARD_SESSION_SECRET:'cd'.repeat(32),DASHBOARD_ORIGIN:ORIGIN,
      HOSTED_PUBLICATION_ENABLED:'true',BUCKET:new MemoryBucket()},keys=fakeKeys();
    const app=built({}, {clock:()=>NOW,fetchImpl:keys.fetchImpl});
    for(const path of ['/api/observation-notifications','/api/telegram-bot-status'])assert.equal((await app.fetch(new Request(ORIGIN+path),env)).status,401);
    const login=await app.fetch(new Request(ORIGIN+'/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:'viewer',password})}),env);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const status=await app.fetch(new Request(ORIGIN+'/api/observation-notifications',{headers:{cookie}}),env);assert.equal(status.status,200);
    assert.equal((await status.json()).receipt.status,'not_attempted');assert.match(status.headers.get('cache-control'),/no-store/);
    const botStatus=await app.fetch(new Request(ORIGIN+'/api/telegram-bot-status',{headers:{cookie}}),env);assert.equal(botStatus.status,200);
    assert.equal((await botStatus.json()).kind,'telegram-bot-status');assert.match(botStatus.headers.get('cache-control'),/no-store/);
    const callback=await app.fetch(new Request(ORIGIN+'/telegram/webhook',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'}),env);
    assert.notEqual(callback.status,200);assert.notEqual(callback.status,303,'Webhook is never redirected into browser login');
    const botEnv={...env,TELEGRAM_WEBHOOK_SECRET:'offline-webhook-secret-1234567890_abcdef',TELEGRAM_BOT_TOKEN:'8858788137:offline_synthetic_bot_token_abcdefghijklmnop'};
    const wrongSecret=await app.fetch(new Request(ORIGIN+'/telegram/webhook',{method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'}),botEnv);
    assert.equal(wrongSecret.status,401,'A visitor cookie is not Telegram webhook authorization');
    const otherTarget=await app.fetch(new Request(ORIGIN+'/telegram/webhook',{method:'POST',headers:{'content-type':'application/json',
      'X-Telegram-Bot-Api-Secret-Token':botEnv.TELEGRAM_WEBHOOK_SECRET},body:JSON.stringify({update_id:1,message:{message_id:2,date:NOW/1000,
      from:{id:123456789,is_bot:false},chat:{id:Number(CHAT),type:'supergroup'},text:'/start@LYZKYPbot'}})}),botEnv);
    assert.equal(otherTarget.status,200);assert.equal((await otherTarget.json()).code,'BOT_UPDATE_IGNORED');
    assert.equal(env.BUCKET.rows.size,0,'A valid secret with another target cannot read or write delivery state');
    const body={reportId:'a'.repeat(64)};
    const visitor=await app.fetch(machineRequest('/internal/observation-notifications',{method:'POST',body,bearer:'',headers:{cookie}}),env);
    assert.equal(visitor.status,401);
    const other=await app.fetch(machineRequest('/internal/observation-notifications',{method:'POST',body,bearer:token({workflow_ref:'other'})}),env);assert.equal(other.status,401);
    const valid=await app.fetch(machineRequest('/internal/observation-notifications',{method:'POST',body}),env);assert.equal(valid.status,400);
    assert.deepEqual(await valid.json(),{error:'DAILY_ORIGIN_INVALID'});
    const invalid=await app.fetch(machineRequest('/internal/observation-notifications',{method:'POST',body:{...body,text:TOKEN}}),env);
    assert.equal(invalid.status,400);assert.ok(!(await invalid.text()).includes(TOKEN));assert.equal(env.BUCKET.rows.size,0);
    const formal=await app.fetch(machineRequest('/internal/notifications',{method:'POST',body:{reportId:'a'.repeat(64)}}),env);assert.equal(formal.status,409);
  } finally {await rm(out,{recursive:true,force:true});}
});
