import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCollection } from '../pipeline.mjs';
import { publishTelegram, publishWebsite, publishWebsiteReceipt, commitReportFiles, deliveryConfig } from '../delivery.mjs';

const config = JSON.parse(await readFile(new URL('../../config/delivery.json', import.meta.url)));
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
test('delivery CLI fails the workflow on confirmed Telegram rejection while persisting its receipt',async t=>{
  const r=await run(t),preload=join(r.dir,'mock-fetch.mjs');
  await writeFile(preload,`globalThis.fetch=async(url)=>url.endsWith('/getMe')?Response.json({ok:true,result:{is_bot:true,username:'test_delivery_bot'}}):Response.json({ok:false,description:'Bad Request: chat not found'},{status:400});`);
  const childEnv={...process.env,...env};for(const k of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_OPTIONS'])delete childEnv[k];
  await assert.rejects(promisify(execFile)(process.execPath,['--import',preload,fileURLToPath(new URL('../publish.mjs',import.meta.url)),'telegram',r.dir],{env:childEnv}),error=>{
    assert.equal(error.code,1);assert.ok(error.stdout.includes('TELEGRAM_CHAT_NOT_FOUND'));assert.ok(!error.stdout.includes(env.TELEGRAM_BOT_TOKEN));return true;
  });
  assert.equal((await r.receipt()).channels.notifications.code,'TELEGRAM_CHAT_NOT_FOUND');
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
test('website publishes an orphan data branch, verifies bytes and later publishes final receipt without force',async t=>{
  const r=await run(t),mock=githubMock();
  await publishWebsite(r.dir,{config,env,...mock});const receipt=await r.receipt();assert.equal(receipt.channels.externalWebsite.status,'published');
  assert.deepEqual(mock.calls.find(c=>c.path==='/git/commits').body.parents,[]);
  assert.equal(mock.calls.find(c=>c.path==='/git/refs').body.ref,'refs/heads/published-reports');
  const count=mock.calls.length;await publishWebsite(r.dir,{config,env,...mock});assert.equal(mock.calls.length,count);
  await publishWebsiteReceipt(r.dir,{config,env,...mock});assert.equal(mock.calls.find(c=>c.method==='PATCH').body.force,false);
  assert.equal(JSON.parse(mock.files['publication.json']).reportId,receipt.reportId);assert.ok(!JSON.stringify(receipt).includes(env.GITHUB_TOKEN));
});
test('website readback mismatch persists failure and cannot claim publication',async t=>{
  const r=await run(t);await assert.rejects(publishWebsite(r.dir,{config,env,...githubMock({corrupt:true})}),{message:'WEBSITE_READBACK_MISMATCH'});
  assert.equal((await r.receipt()).channels.externalWebsite.status,'failed');
});
test('delivery refuses arbitrary repositories, branches and workflow file injection',async()=>{
  assert.throws(()=>deliveryConfig({...config,website:{...config.website,repository:'someone/else'}}));
  assert.throws(()=>deliveryConfig({...config,website:{...config.website,branch:'main'}}));
  await assert.rejects(commitReportFiles(async()=>assert.fail('request'),{'.github/workflows/unsafe.yml':'x'},'a'.repeat(64)));
});
