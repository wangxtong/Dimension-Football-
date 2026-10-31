import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCollection } from '../pipeline.mjs';
import { publishTelegram, publishWebsite, publishWebsiteReceipt, publishGitHubArchive, publishAll, commitReportFiles, deliveryConfig } from '../delivery.mjs';
import { loadReportBundle, reportHash, persistReportReceipt } from '../report-store.mjs';

const config = JSON.parse(await readFile(new URL('../../config/delivery.json', import.meta.url)));
delete config.telegram.destinationFingerprint;
const env = { TELEGRAM_BOT_TOKEN:'123456:abcdefghijklmnopqrstuv', TELEGRAM_CHAT_ID:'1234567', GITHUB_TOKEN:'test-token-must-never-persist' };
async function run(t, options={}) {
  const dir=await mkdtemp(join(tmpdir(),'dimension-external-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  await runCollection({fixtures:[],outDir:dir,statePath:join(dir,'state.json'),simulated:false,collectEvidence:async()=>({quotes:[],signals:[],diagnostics:[]}),...options});
  return {dir,receipt:async()=>JSON.parse(await readFile(join(dir,'publication.json'),'utf8'))};
}
test('missing Telegram credentials leave a reusable configuration and make no requests',async t=>{
  const r=await run(t); let calls=0;
  await publishTelegram(r.dir,{config,env:{},fetchImpl:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal((await r.receipt()).channels.notifications.status,'not_configured');
});
test('a missing minus sign is restored only for the already verified target fingerprint',async t=>{
  const target='-1009876543210', fingerprint=createHash('sha256').update(target).digest('hex').slice(0,16);
  const pinned={...config,telegram:{...config.telegram,destinationFingerprint:fingerprint}};
  const r=await run(t);let calls=0;
  const receipt=await publishTelegram(r.dir,{config:pinned,env:{...env,TELEGRAM_CHAT_ID:target.slice(1)},fetchImpl:async(url,init)=>{
    calls++;assert.equal(JSON.parse(init.body).chat_id,target);return Response.json({ok:true,result:{message_id:4,chat:{id:Number(target)}}});
  }});
  assert.equal(calls,1);assert.equal(receipt.channels.notifications.status,'accepted');assert.equal(receipt.channels.notifications.configurationAdjusted,'restored-verified-group-minus-sign');
  const other=await run(t);const rejected=await publishTelegram(other.dir,{config:pinned,env,fetchImpl:async()=>assert.fail('unapproved recipient')});
  assert.equal(rejected.channels.notifications.code,'TELEGRAM_DESTINATION_MISMATCH');
});
test('simulation never publishes website data or notifications',async t=>{
  const r=await run(t,{simulated:true});const fetchImpl=async()=>assert.fail('external request');
  await publishTelegram(r.dir,{config,env,fetchImpl});await publishWebsite(r.dir,{config,env,fetchImpl});
  const receipt=await r.receipt();assert.equal(receipt.channels.notifications.status,'skipped');assert.equal(receipt.channels.externalWebsite.status,'skipped');
});
test('Telegram acceptance is verified, redacted and idempotent, not marked read',async t=>{
  const r=await run(t);let calls=0;
  const fetchImpl=async(url,init)=>{calls++;assert.equal(new URL(url).origin,'https://api.telegram.org');assert.equal(init.redirect,'error');
    const body=JSON.parse(init.body);assert.equal(body.chat_id,env.TELEGRAM_CHAT_ID);assert.ok(!body.parse_mode);assert.ok(body.text.includes(config.website.url));
    return Response.json({ok:true,result:{message_id:42,chat:{id:1234567}}});};
  await publishTelegram(r.dir,{config,env,fetchImpl});await publishTelegram(r.dir,{config,env,fetchImpl});
  const receipt=await r.receipt(),text=JSON.stringify(receipt);assert.equal(calls,1);assert.equal(receipt.channels.notifications.status,'accepted');
  assert.ok(!text.includes(env.TELEGRAM_BOT_TOKEN));assert.ok(!text.includes(env.TELEGRAM_CHAT_ID));assert.ok(text.includes('not-a-user-read-receipt'));
});
test('unknown Telegram result stops automatic retries and never records exception secrets',async t=>{
  const r=await run(t);let calls=0;const fetchImpl=async()=>{calls++;throw Error(env.TELEGRAM_BOT_TOKEN);};
  await publishTelegram(r.dir,{config,env,fetchImpl});await publishTelegram(r.dir,{config,env,fetchImpl});
  assert.equal(calls,1);const receipt=await r.receipt();assert.equal(receipt.channels.notifications.status,'unknown');assert.ok(!JSON.stringify(receipt).includes(env.TELEGRAM_BOT_TOKEN));
});
test('API rejection, wrong chat acknowledgement and old reports cannot claim sent',async t=>{
  for(const [fetchImpl,status] of [[async()=>new Response('blocked',{status:403}),'failed'],[async()=>Response.json({ok:true,result:{message_id:1,chat:{id:99}}}),'unknown']]){
    const r=await run(t);await publishTelegram(r.dir,{config,env,fetchImpl});assert.equal((await r.receipt()).channels.notifications.status,status);
  }
  const r=await run(t,{clock:()=>new Date(Date.now()-7200000).toISOString()});
  await publishTelegram(r.dir,{config,env,fetchImpl:async()=>assert.fail('expired report sent')});assert.equal((await r.receipt()).channels.notifications.code,'REPORT_EXPIRED');
});
test('Telegram 400 diagnoses missing chat and bot identity without storing secret response text or retrying send',async t=>{
  const r=await run(t),calls=[];
  const fetchImpl=async(url,init)=>{calls.push({url,method:init.method});return url.endsWith('/getMe')
    ? Response.json({ok:true,result:{is_bot:true,username:'test_delivery_bot'}})
    : Response.json({ok:false,description:`Bad Request: chat not found ${env.TELEGRAM_BOT_TOKEN} ${env.TELEGRAM_CHAT_ID}`},{status:400});};
  const receipt=await publishTelegram(r.dir,{config,env,fetchImpl}),channel=receipt.channels.notifications;
  assert.equal(channel.status,'failed');assert.equal(channel.code,'TELEGRAM_CHAT_NOT_FOUND');assert.equal(channel.botUsername,'test_delivery_bot');
  assert.match(channel.destinationFingerprint,/^[a-f0-9]{16}$/);assert.equal(calls.filter(c=>c.url.endsWith('/sendMessage')).length,1);
  assert.equal(calls.filter(c=>c.url.endsWith('/getMe'))[0].method,'GET');
  assert.ok(!JSON.stringify(receipt).includes(env.TELEGRAM_BOT_TOKEN));assert.ok(!JSON.stringify(receipt).includes(env.TELEGRAM_CHAT_ID));
});
test('delivery CLI fails closed before any outbound request when no trusted release approval exists',async t=>{
  const r=await run(t),preload=join(r.dir,'network-never-used.mjs');
  await writeFile(preload,'globalThis.fetch=async()=>{throw Error("EXTERNAL_NETWORK_MUST_NOT_BE_CALLED")}');
  const childEnv={...process.env,...env};
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_OPTIONS'])delete childEnv[key];
  for(const mode of ['website','telegram','all']){
    await assert.rejects(promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../publish.mjs',import.meta.url)),mode,r.dir],{env:childEnv}),error=>{
      assert.equal(error.code,1);
      assert.ok(error.stderr.includes('PUBLICATION_FAILED'));
      assert.ok(!error.stdout.includes(env.TELEGRAM_BOT_TOKEN));
      return true;
    });
  }
  const receipt=await r.receipt();
  assert.equal(receipt.channels.notifications.status,'not_configured');
  assert.equal(receipt.channels.externalWebsite.status,'not_configured');
});
function githubMock({corrupt=false}={}) {
  const files={},calls=[];let exists=false;
  const fetchImpl=async(url,init)=>{const u=new URL(url),path=u.pathname.replace('/repos/wangxtong/Dimension-Football-','');
    assert.equal(u.origin,'https://api.github.com');assert.equal(init.headers.Authorization,`Bearer ${env.GITHUB_TOKEN}`);assert.equal(init.redirect,'error');
    const body=init.body?JSON.parse(init.body):null;calls.push({path,method:init.method,body});
    if(path==='/git/ref/heads/published-reports')return exists?Response.json({object:{sha:'a'.repeat(40)}}):new Response('',{status:404});
    if(path==='/git/commits/'+'a'.repeat(40))return Response.json({tree:{sha:'b'.repeat(40)}});
    if(path==='/git/trees'){for(const e of body.tree)files[e.path]=e.content;return Response.json({sha:'b'.repeat(40)});}
    if(path==='/git/commits')return Response.json({sha:'a'.repeat(40)});
    if(path.startsWith('/git/refs')){exists=true;return Response.json({});}
    if(path.startsWith('/contents/'))return Response.json({encoding:'base64',content:Buffer.from(corrupt?'{}':files[path.split('/').at(-1)]).toString('base64')});
    assert.fail(path);
  };return {fetchImpl,calls,files};
}
test('GitHub archive publishes a coherent data tree without claiming the website is available',async t=>{
  const r=await run(t),mock=githubMock();
  await publishGitHubArchive(r.dir,{config,env,...mock});const receipt=await r.receipt();assert.equal(receipt.channels.repositoryArchive.status,'published');
  assert.equal(receipt.channels.externalWebsite.status,'not_configured');
  assert.deepEqual(mock.calls.find(c=>c.path==='/git/commits').body.parents,[]);
  assert.equal(mock.calls.find(c=>c.path==='/git/refs').body.ref,'refs/heads/published-reports');
  const count=mock.calls.length;await publishGitHubArchive(r.dir,{config,env,...mock});assert.equal(mock.calls.length,count);
  assert.equal(JSON.parse(mock.files['publication.json']).reportId,receipt.reportId);assert.ok(!JSON.stringify(receipt).includes(env.GITHUB_TOKEN));
});
test('archive readback mismatch persists a separate failure',async t=>{
  const r=await run(t);await assert.rejects(publishGitHubArchive(r.dir,{config,env,...githubMock({corrupt:true})}),{message:'ARCHIVE_READBACK_MISMATCH'});
  assert.equal((await r.receipt()).channels.repositoryArchive.status,'failed');
  assert.equal((await r.receipt()).channels.externalWebsite.status,'not_configured');
});
test('delivery refuses arbitrary repositories, branches and workflow file injection',async()=>{
  assert.throws(()=>deliveryConfig({...config,website:{...config.website,repository:'someone/else'}}));
  assert.throws(()=>deliveryConfig({...config,website:{...config.website,branch:'main'}}));
  await assert.rejects(commitReportFiles(async()=>assert.fail('request'),{'.github/workflows/unsafe.yml':'x'},'a'.repeat(64)));
});

const probeEnv = { REPORTS_PROBE_TOKEN:'a'.repeat(64) };
async function probe(r, extra = {}) {
  const report = JSON.parse(await readFile(join(r.dir,'predictions.json'),'utf8'));
  return { version:1, reportId:report.publication.reportId, reportHash:reportHash(report), mode:'ecs', health:'available', ...extra };
}
test('only same-report ECS site readback can mark a persisted report served',async t=>{
  for (const [extra, code] of [[{},null],[{mode:'bootstrap'},'WEBSITE_LIVE_FEED_UNAVAILABLE'],[{health:'upstream_unavailable'},'WEBSITE_LIVE_FEED_UNAVAILABLE'],[{reportId:'b'.repeat(64)},'WEBSITE_REPORT_MISMATCH'],[{reportHash:'b'.repeat(64)},'WEBSITE_REPORT_MISMATCH']]) {
    const r=await run(t),data=await probe(r,extra);
    const result=await publishWebsite(r.dir,{config,env:probeEnv,fetchImpl:async(url,init)=>{
      assert.equal(url,config.website.url+'/internal/report-status');assert.equal(init.redirect,'error');
      assert.equal(init.headers.Authorization,'Bearer '+probeEnv.REPORTS_PROBE_TOKEN);return Response.json(data);
    }});
    const channel=result.channels.externalWebsite;assert.equal(channel.servedVerified,!code);assert.equal(channel.code,code||undefined);
    assert.equal(channel.status,code?'failed':'published');assert.equal((await loadReportBundle(r.dir)).reportId,result.reportId);
  }
  const r=await run(t),result=await publishWebsite(r.dir,{config,env,fetchImpl:async()=>assert.fail('GitHub credentials cannot probe a website')});
  assert.equal(result.channels.externalWebsite.status,'not_configured');assert.equal(result.channels.externalWebsite.servedVerified,false);
});
test('site rechecks do not trust a stale successful receipt and never expose probe secrets',async t=>{
  const r=await run(t),data=await probe(r);
  await publishWebsite(r.dir,{config,env:probeEnv,fetchImpl:async()=>Response.json(data)});
  const result=await publishWebsite(r.dir,{config,env:probeEnv,fetchImpl:async()=>{throw Error(probeEnv.REPORTS_PROBE_TOKEN);}});
  assert.equal(result.channels.externalWebsite.status,'failed');assert.equal(result.channels.externalWebsite.servedVerified,false);
  assert.ok(!JSON.stringify(result).includes(probeEnv.REPORTS_PROBE_TOKEN));
});
test('receipt synchronization records failure, recovers and persists the success event',async t=>{
  const r=await run(t);await publishWebsite(r.dir,{config,env:{}});
  const failed=await publishWebsiteReceipt(r.dir,{config,persistReceipt:async()=>{throw Error('secret');}});
  assert.equal(failed.channels.receiptSync.code,'RECEIPT_SYNC_FAILED');assert.ok(!JSON.stringify(failed).includes('secret'));
  const result=await publishWebsiteReceipt(r.dir,{config});assert.equal(result.channels.receiptSync.status,'published');
  const saved=await loadReportBundle(r.dir);assert.equal(saved.receipt.channels.receiptSync.status,'published');
  assert.ok(saved.receipt.events.some(event=>event.channel==='receiptSync'&&event.status==='failed'));
});
test('outbox restores accepted and unknown outcomes after a generation receipt is replayed',async t=>{
  for(const status of ['accepted','unknown']){
    const r=await run(t),initial=await r.receipt();let calls=0;
    const fetchImpl=async()=>{calls++;if(status==='unknown')throw Error('timeout');return Response.json({ok:true,result:{message_id:42,chat:{id:1234567}}});};
    await publishTelegram(r.dir,{config,env,fetchImpl});
    await writeFile(join(r.dir,'publication.json'),JSON.stringify(initial));
    const result=await publishTelegram(r.dir,{config,env,fetchImpl});assert.equal(calls,1);assert.equal(result.channels.notifications.status,status);
  }
});
test('a new report within the same hour is explicitly skipped and publishAll saves final channel outcomes',async t=>{
  const now=new Date().toISOString(),r=await run(t,{clock:()=>now});let sends=0;
  const options={config,env:{...probeEnv,TELEGRAM_BOT_TOKEN:env.TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID:env.TELEGRAM_CHAT_ID},clock:()=>now,
    fetchImpl:async url=>url.includes('/internal/report-status')?Response.json(await probe(r)):(sends++,Response.json({ok:true,result:{message_id:42,chat:{id:1234567}}}))};
  const first=await publishAll(r.dir,options);assert.equal(first.channels.notifications.status,'accepted');
  await runCollection({fixtures:[],outDir:r.dir,statePath:join(r.dir,'state.json'),simulated:false,clock:()=>new Date(Date.parse(now)+1000).toISOString(),collectEvidence:async()=>({quotes:[],signals:[],diagnostics:[]})});
  const second=await publishAll(r.dir,options);assert.equal(second.channels.notifications.code,'HOURLY_SUMMARY_ALREADY_CLAIMED');assert.equal(sends,1);
  const saved=await loadReportBundle(r.dir);assert.equal(saved.receipt.reportId,second.reportId);assert.equal(saved.receipt.channels.notifications.status,'skipped');
});
test('a mismatched publication identity cannot mutate the current report',async t=>{
  const r=await run(t),initial=await r.receipt();
  await assert.rejects(publishAll(r.dir,{config,expectedReportId:'b'.repeat(64),fetchImpl:async()=>assert.fail('request')}),/PUBLICATION_REPORT_MISMATCH/);
  assert.deepEqual(await r.receipt(),initial);
});
test('publishAll records a failed site probe and still persists the explicitly labelled notification outcome',async t=>{
  const r=await run(t);let text;
  const receipt=await publishAll(r.dir,{config,env:{...probeEnv,TELEGRAM_BOT_TOKEN:env.TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID:env.TELEGRAM_CHAT_ID},fetchImpl:async(url,init)=>{
    if(url.includes('/internal/report-status'))return new Response('',{status:502});
    text=JSON.parse(init.body).text;return Response.json({ok:true,result:{message_id:42,chat:{id:1234567}}});
  }});
  assert.equal(receipt.channels.externalWebsite.status,'failed');assert.equal(receipt.channels.notifications.status,'accepted');
  assert.match(text,/网站实时交付尚未核验/);assert.equal((await loadReportBundle(r.dir)).receipt.channels.externalWebsite.code,'WEBSITE_PROBE_HTTP_ERROR');
});
test('expired replay recovers its accepted outbox and pre-outbox stored receipts also prevent resending',async t=>{
  const r=await run(t),initial=await r.receipt();
  await publishTelegram(r.dir,{config,env,fetchImpl:async()=>Response.json({ok:true,result:{message_id:42,chat:{id:1234567}}})});
  await writeFile(join(r.dir,'publication.json'),JSON.stringify(initial));
  const restored=await publishTelegram(r.dir,{config,env,clock:()=>new Date(Date.now()+7200000).toISOString(),fetchImpl:async()=>assert.fail('expired replay sent')});
  assert.equal(restored.channels.notifications.status,'accepted');
  const other=await run(t);await publishWebsite(other.dir,{config,env:{}});const stored=await other.receipt();
  stored.channels.notifications={status:'accepted',messageId:57,checkedAt:new Date().toISOString()};
  await persistReportReceipt(other.dir,stored);
  const migrated=await publishTelegram(other.dir,{config,env,fetchImpl:async()=>assert.fail('accepted historical report resent')});
  assert.equal(migrated.channels.notifications.messageId,57);
});
