import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObservationDigest, runObservationDigest } from '../observation-digest.mjs';
import { observationBundle, createHostedClient, HOSTED_ORIGIN, HOSTED_REQUEST_TIMEOUT_MS } from '../hosted.mjs';
import { reportHash } from '../report-store.mjs';
import { summarizeMarketObservation } from '../market-observation.mjs';
import { atomicJson, readJson } from '../storage.mjs';

const NOW=Date.parse('2026-11-02T01:05:00.000Z'),SHA='a'.repeat(40),KIND='daily-observation-delivery';
const CHAT='-1001234567890',TOKEN='123456:synthetic_bot_token_for_offline_tests_0000';
const FP=createHash('sha256').update(CHAT).digest('hex').slice(0,16),at=offset=>new Date(NOW+offset).toISOString();
const runDigest=createObservationDigest({verifiedTargetFingerprint:FP});
const environment={HOSTED_MODE:'observations',TELEGRAM_BOT_TOKEN:TOKEN,TELEGRAM_CHAT_ID:CHAT,GITHUB_SHA:SHA,GITHUB_RUN_ID:'123456',GITHUB_RUN_ATTEMPT:'1'};
const oidc={ACTIONS_ID_TOKEN_REQUEST_URL:'https://pipelines.actions.githubusercontent.com/idtoken?api-version=2.0',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-request-bearer'};
const jwt=()=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({aud:HOSTED_ORIGIN,exp:Math.floor(NOW/1000)+300})).toString('base64url')}.signature`;
async function setup(t,{status='complete',offset=0,withMarkets=false}={}){
  const root=await mkdtemp(join(tmpdir(),'observation-digest-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const manifest={version:1,kind:'public-fixture-sample',dataSchemaVersion:2,simulated:false,checkedAt:at(offset),
    fixtures:[{id:'oldb-1',sourceFixtureId:'1',source:'openligadb',league:'BL1',season:'2026',home:'A',away:'B',
      homeTeamId:'1',awayTeamId:'2',kickoff:at(offset+7200000),status:'SCHEDULED',updatedAt:at(offset),fetchedAt:at(offset)}],
    sources:[{name:'OpenLigaDB',license:'ODbL-1.0',url:'https://www.openligadb.de/'}],diagnostics:[],coverage:[]};
  const marketObservation=withMarkets?summarizeMarketObservation({fixtures:manifest.fixtures,checkedAt:at(offset),evidence:{quotes:
    ['home','away'].map(selection=>({sourceId:'macauslot',bookmaker:'Macau SLOT',provider:'macauslot-official',
      evidenceUrl:'https://www.macauslot.com/soccer/json/realtime/threeinone_odds_cn_fb.json',fixtureId:manifest.fixtures[0].id,
      fixtureSnapshot:{...manifest.fixtures[0]},verified:true,verificationMethod:'automatic',observedAt:at(offset),
      sourceUpdatedAt:at(offset),validUntil:at(offset+60000),market:'asian-handicap',period:'full-time',providerMatchId:'macau-1',
      providerPoolId:'pool-1',inPlay:false,closed:false,selection,handicap:selection==='home'?-.25:.25,decimalOdds:1.9}))}}):undefined;
  const bundle=observationBundle(manifest,{commit:SHA,nowISO:at(offset),...(withMarkets?{marketObservation}:{})});
  const served={version:1,reportId:reportHash({projection:bundle.reportId}),reportHash:reportHash({projectedReport:bundle.report}),
    originReportId:bundle.reportId,generatedAt:at(offset),mode:'hosted',health:'available',publicationKind:'observations',forecastPublished:false};
  const record={version:1,bundle,bundleHash:reportHash(bundle),delivery:{...served,status:'verified',checkedAt:at(offset)}};
  const run={version:1,mode:'observations',status,RELEASE_GATE:'BLOCKED',forecastPublished:false,checkedAt:at(offset),revision:2,
    observationServedVerified:true,originReportId:bundle.reportId,observationGeneratedAt:at(offset),servedReportId:served.reportId,servedReportHash:served.reportHash};
  await atomicJson(join(root,'hosted-run.json'),run);await atomicJson(join(root,'state/hosted-observation.json'),record);
  const calls=[],logs=[];
  const response={version:1,kind:KIND,requestedReportId:served.reportId,sentNow:true,receipt:{version:1,kind:KIND,date:'2026-11-02',
    reportId:served.reportId,reportHash:served.reportHash,destinationFingerprint:FP,checkedAt:at(offset),status:'accepted',
    code:'DAILY_TELEGRAM_ACCEPTED',sentNow:true,messageId:42,payloadSha256:'b'.repeat(64)}};
  const client={async request(path,options={}){calls.push({path,...options});return structuredClone(path==='/internal/report-status'?served:response);}};
  return {root,run,record,served,response,calls,logs,client,options:{root,env:environment,mode:'observations',clock:()=>at(offset),client,stdout:value=>logs.push(value)}};
}
async function artifact(h){return readFile(join(h.root,'observation-digest.json'),'utf8');}
function noSecrets(value){assert.ok(!value.includes(TOKEN));assert.ok(!value.includes(CHAT));assert.ok(!value.includes(oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN));}

test('complete and idle observation runs bind projected IDs through local evidence and fresh site readback before a separate digest POST',async t=>{
  for(const status of ['complete','idle']){
    const h=await setup(t,{status});h.response.receipt.untrusted={token:TOKEN,chatId:CHAT};h.response.credentials={botToken:TOKEN,chatId:CHAT};
    const result=await runDigest(h.options);
    assert.equal(result.exitCode,0);assert.equal(result.status,'accepted');assert.equal(result.sentNow,true);
    assert.deepEqual(h.calls.map(row=>row.path),['/internal/report-status','/internal/observation-notifications']);
    assert.deepEqual(h.calls[1].body,{reportId:h.served.reportId});
    assert.notEqual(result.reportId,result.originReportId);assert.equal(result.receipt.reportId,result.reportId);
    assert.equal(result.runnerCommit,SHA);assert.equal(result.workflowRunId,'123456');
    noSecrets(JSON.stringify(result)+h.logs.join('')+await artifact(h));
    assert.equal(result.receipt.untrusted,undefined);assert.equal(result.credentials,undefined);
  }
});
test('runner never reads or forwards Telegram credentials and production receipt validation remains pinned',async t=>{
  const h=await setup(t),env={...environment};
  for(const key of ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'])Object.defineProperty(env,key,{get(){assert.fail('runner must never read Telegram credentials');}});
  const result=await runDigest({...h.options,env});assert.equal(result.exitCode,0);
  assert.deepEqual(h.calls[1].body,{reportId:h.served.reportId});noSecrets(await artifact(h));
  const pinned=await setup(t);const blocked=await runObservationDigest(pinned.options);
  assert.equal(blocked.code,'DIGEST_RECEIPT_INVALID');assert.equal(blocked.receipt,undefined);
});
test('research and invalid modes cannot send even when an observations record and credentials are available',async t=>{
  for(const mode of ['research','',undefined]){
    const h=await setup(t),result=await runDigest({...h.options,mode,env:{...environment,HOSTED_MODE:mode}});
    assert.equal(result.code,'DIGEST_MODE_NOT_OBSERVATIONS');assert.equal(result.exitCode,1);assert.equal(h.calls.length,0);noSecrets(await artifact(h));
  }
});
test('missing, failed, stale or cross-version run evidence cannot be replaced by whichever report the site serves',async t=>{
  for(const change of [{mode:'research'},{status:'blocked'},{observationServedVerified:false},{originReportId:'c'.repeat(64)},
    {servedReportId:'c'.repeat(64)},{servedReportHash:'c'.repeat(64)},{servedReportId:undefined},{checkedAt:at(-300001)}]){
    const h=await setup(t);await atomicJson(join(h.root,'hosted-run.json'),{...h.run,...change});
    const result=await runDigest(h.options);assert.equal(result.exitCode,1);assert.equal(h.calls.length,0);
  }
  const h=await setup(t);await rm(join(h.root,'hosted-run.json'));assert.equal((await runDigest(h.options)).code,'DIGEST_LOCAL_EVIDENCE_UNREADABLE');assert.equal(h.calls.length,0);
});
test('tampered local bundles and unverified or mismatched publication receipts stop the digest',async t=>{
  for(const mutate of [row=>{row.bundleHash='c'.repeat(64);},row=>{row.delivery.status='pending';},
    row=>{row.delivery.reportHash='c'.repeat(64);},row=>{row.delivery.publicationKind='forecasts';},
    row=>{row.bundle.report.fixtures[0].forecast.probabilities={home:1,draw:0,away:0};row.bundleHash=reportHash(row.bundle);}]){
    const h=await setup(t);mutate(h.record);await atomicJson(join(h.root,'state/hosted-observation.json'),h.record);
    assert.equal((await runDigest(h.options)).exitCode,1);assert.equal(h.calls.length,0);
  }
});
test('expired positive observations and stale schedules cannot be sent merely because this runner is recent',async t=>{
  const h=await setup(t,{withMarkets:true});assert.equal(h.record.bundle.report.marketObservation.sources[1].quoteCount,2);
  const result=await runDigest({...h.options,clock:()=>at(120000)});
  assert.equal(result.code,'DIGEST_MARKET_OBSERVATION_EXPIRED');assert.equal(h.calls.length,0);
  const stale=await setup(t,{offset:-1200001});await atomicJson(join(stale.root,'hosted-run.json'),{...stale.run,checkedAt:at(0)});
  const blocked=await runDigest({...stale.options,clock:()=>at(0)});assert.equal(blocked.code,'DIGEST_OBSERVATION_INVALID');assert.equal(stale.calls.length,0);
});
test('live readback mismatches stop before POST instead of replacing the requested report ID',async t=>{
  for(const change of [{reportId:'c'.repeat(64)},{originReportId:'c'.repeat(64)},{reportHash:'c'.repeat(64)},
    {health:'stale'},{mode:'bootstrap'},{publicationKind:'forecasts'},{forecastPublished:true}]){
    const h=await setup(t);Object.assign(h.served,change);const result=await runDigest(h.options);
    assert.equal(result.code,'DIGEST_CURRENT_READBACK_MISMATCH');assert.equal(h.calls.length,1);
  }
});
test('wrong requested ID, sent report, fingerprint, hash or malformed receipt is rejected without printing the response',async t=>{
  for(const mutate of [r=>{r.requestedReportId='c'.repeat(64);},r=>{r.receipt.reportId='c'.repeat(64);},
    r=>{r.receipt.destinationFingerprint='c'.repeat(16);},r=>{r.receipt.reportHash='c'.repeat(64);},
    r=>{r.receipt.date='2026-11-01';},r=>{r.receipt.sentNow=false;},r=>{r.receipt.messageId=-1;},r=>{r.receipt.code=TOKEN;}]){
    const h=await setup(t);mutate(h.response);h.response.secret=TOKEN;
    const result=await runDigest(h.options);assert.equal(result.code,'DIGEST_RECEIPT_INVALID');assert.equal(result.exitCode,1);
    assert.equal(result.receipt,undefined);assert.equal(h.calls.length,2);noSecrets(h.logs.join('')+await artifact(h));
  }
});
test('an already sent daily digest retains its original report ID and does not claim a new send',async t=>{
  const h=await setup(t);h.response.sentNow=false;Object.assign(h.response.receipt,{sentNow:false,reportId:'d'.repeat(64),reportHash:'e'.repeat(64)});
  const result=await runDigest(h.options);assert.equal(result.exitCode,0);assert.equal(result.sentNow,false);
  assert.equal(result.reportId,h.served.reportId);assert.equal(result.receipt.reportId,'d'.repeat(64));
});
async function midnightReceipt(t,{status='accepted',start=Date.parse('2026-11-02T15:59:58.000Z'),elapsed=15000,date='2026-11-02',checked=start+elapsed,code}={}){
  const h=await setup(t,{offset:start-NOW});let clock=start;
  const sentNow=status==='accepted';h.response.sentNow=sentNow;
  Object.assign(h.response.receipt,{date,status,sentNow,checkedAt:new Date(checked).toISOString(),
    code:code||({accepted:'DAILY_TELEGRAM_ACCEPTED',unknown:'DAILY_TELEGRAM_UNKNOWN_NO_RETRY',failed:'DAILY_TELEGRAM_REJECTED',skipped:'DAILY_DATE_CHANGED_BEFORE_SEND'})[status]});
  if(!sentNow){delete h.response.receipt.messageId;delete h.response.receipt.payloadSha256;}
  const base=h.client.request;h.client.request=async(...args)=>{
    const result=await base(...args);if(args[0]!=='/internal/observation-notifications')return result;
    clock=start+elapsed;
    if(status==='unknown'||status==='failed')throw Object.assign(Error('HOSTED_HTTP_'+(status==='unknown'?503:502)),{
      httpStatus:status==='unknown'?503:502,digestResponse:result});
    return result;
  };
  const result=await runDigest({...h.options,clock:()=>new Date(clock).toISOString()});return {h,result};
}
test('a request begun before Beijing midnight preserves accepted, failed and unknown acknowledgements received within the HTTP deadline',async t=>{
  assert.equal(HOSTED_REQUEST_TIMEOUT_MS,20000);
  for(const status of ['accepted','unknown','failed','skipped']){
    const {h,result}=await midnightReceipt(t,{status});
    assert.equal(result.status,status);assert.ok(result.receipt);assert.equal(result.receipt.date,'2026-11-02');
    assert.equal(result.receipt.checkedAt,'2026-11-02T16:00:13.000Z');assert.equal(result.requestStartedAt,'2026-11-02T15:59:58.000Z');
    assert.equal(result.sentNow,status==='accepted');assert.equal(result.exitCode,status==='accepted'?0:1);
    assert.notEqual(result.code,'DIGEST_RECEIPT_INVALID');assert.equal(h.calls.length,2);noSecrets(await artifact(h));
  }
  const edge=await midnightReceipt(t,{elapsed:HOSTED_REQUEST_TIMEOUT_MS+5000});assert.equal(edge.result.exitCode,0);
});
test('the midnight exception rejects unrelated old dates, old acknowledgements, excessive elapsed time and future timestamps',async t=>{
  const midnight=Date.parse('2026-11-02T16:00:00.000Z'),start=midnight-2000;
  for(const options of [
    {start:midnight+2000,date:'2026-11-02'},
    {date:'2026-11-01'},
    {checked:start-5001},
    {elapsed:HOSTED_REQUEST_TIMEOUT_MS+5001},
    {checked:start+15000+5001},
    {date:'2026-11-04'},
  ]){
    const {h,result}=await midnightReceipt(t,options);assert.equal(result.code,'DIGEST_RECEIPT_INVALID');
    assert.equal(result.exitCode,1);assert.equal(result.receipt,undefined);assert.equal(result.sentNow,false);
    assert.equal(h.calls.length,2);noSecrets(await artifact(h));
  }
});
test('a request received by the server after midnight may legitimately return the new day not-due receipt',async t=>{
  const {result}=await midnightReceipt(t,{status:'skipped',date:'2026-11-03',code:'DAILY_NOT_DUE',elapsed:3000});
  assert.equal(result.exitCode,0);assert.equal(result.receipt.date,'2026-11-03');assert.equal(result.sentNow,false);
});
test('not-due status is recorded separately from platform acceptance',async t=>{
  const h=await setup(t,{offset:-2100000});h.response.sentNow=false;
  h.response.receipt={version:1,kind:KIND,date:'2026-11-02',reportId:h.served.reportId,destinationFingerprint:FP,checkedAt:at(-2100000),status:'skipped',code:'DAILY_NOT_DUE',sentNow:false};
  const result=await runDigest(h.options);assert.equal(result.exitCode,0);assert.equal(result.status,'skipped');assert.equal(result.sentNow,false);assert.equal(result.receipt.messageId,undefined);
});
test('a durable skipped claim caused by a report changing before send remains visible as an incomplete delivery',async t=>{
  const h=await setup(t);h.response.sentNow=false;
  Object.assign(h.response.receipt,{status:'skipped',code:'DAILY_REPORT_CHANGED_BEFORE_SEND',sentNow:false});delete h.response.receipt.messageId;
  const result=await runDigest(h.options);assert.equal(result.status,'skipped');assert.equal(result.receipt.code,'DAILY_REPORT_CHANGED_BEFORE_SEND');
  assert.equal(result.code,'DIGEST_DELIVERY_NOT_ACCEPTED');assert.equal(result.exitCode,1);assert.equal(result.sentNow,false);
});
test('uncertain transport is not retried and arbitrary exception text never enters logs or artifacts',async t=>{
  for(const message of ['HOSTED_REQUEST_UNCONFIRMED',TOKEN]){
    const h=await setup(t),base=h.client.request;
    h.client.request=async(...args)=>{if(args[0]==='/internal/observation-notifications'){h.calls.push({path:args[0]});throw Error(message);}return base(...args);};
    const result=await runDigest(h.options);assert.equal(result.exitCode,1);assert.equal(result.status,'unknown');assert.equal(result.sentNow,false);
    assert.equal(h.calls.filter(row=>row.path==='/internal/observation-notifications').length,1);noSecrets(h.logs.join('')+await artifact(h));
  }
});
test('bounded error receipts preserve unknown delivery and fixed precondition errors without echoing remote secrets',async t=>{
  const h=await setup(t);h.response.sentNow=false;
  Object.assign(h.response.receipt,{status:'unknown',code:'DAILY_TELEGRAM_UNKNOWN_NO_RETRY',sentNow:false});delete h.response.receipt.messageId;
  const base=h.client.request;h.client.request=async(...args)=>{if(args[0]==='/internal/observation-notifications')throw Object.assign(Error('HOSTED_HTTP_503'),{httpStatus:503,digestResponse:{...h.response,secret:TOKEN}});return base(...args);};
  const result=await runDigest(h.options);assert.equal(result.exitCode,1);assert.equal(result.status,'unknown');assert.equal(result.receipt.code,'DAILY_TELEGRAM_UNKNOWN_NO_RETRY');noSecrets(await artifact(h));
  for(const error of ['DAILY_DESTINATION_MISMATCH','DAILY_CREDENTIALS_REQUIRED',TOKEN]){
    const f=await setup(t),original=f.client.request;f.client.request=async(...args)=>{if(args[0]==='/internal/observation-notifications')throw Object.assign(Error('HOSTED_HTTP_400'),{httpStatus:400,digestResponse:{error,credentials:TOKEN}});return original(...args);};
    const output=await runDigest(f.options);assert.equal(output.code,error===TOKEN?'HOSTED_HTTP_400':'DIGEST_REMOTE_'+error);
    if(error==='DAILY_CREDENTIALS_REQUIRED'){assert.equal(output.status,'not_configured');assert.equal(output.exitCode,1);}
    noSecrets(await artifact(f));
  }
});
test('OIDC client uses only the fixed HTTPS POST endpoint and does not retry an unconfirmed write',async()=>{
  let calls=0;
  const client=createHostedClient({env:oidc,clock:()=>NOW,fetchImpl:async(url,options)=>{
    assert.equal(options.redirect,'error');
    if(url.startsWith('https://pipelines.actions.githubusercontent.com/'))return Response.json({value:jwt()});
    assert.equal(url,HOSTED_ORIGIN+'/internal/observation-notifications');assert.equal(options.method,'POST');calls++;throw Error(TOKEN);
  }});
  await assert.rejects(client.request('/internal/observation-notifications'),/HOSTED_INVALID_ENDPOINT/);
  await assert.rejects(client.request('/internal/observation-notifications?redirect=evil',{method:'POST'}),/HOSTED_INVALID_ENDPOINT/);
  await assert.rejects(client.request('/internal/observation-notifications',{method:'POST',body:{reportId:'a'.repeat(64)}}),/^Error: HOSTED_REQUEST_UNCONFIRMED$/);
  assert.equal(calls,1);
  const bounded=createHostedClient({env:oidc,clock:()=>NOW,fetchImpl:async url=>url.includes('actions.githubusercontent.com')?Response.json({value:jwt()}):Response.json({error:'DAILY_DESTINATION_MISMATCH',secret:TOKEN},{status:400})});
  await assert.rejects(bounded.request('/internal/observation-notifications',{method:'POST',body:{}}),error=>{
    assert.equal(error.message,'HOSTED_HTTP_400');assert.equal(error.httpStatus,400);assert.equal(error.digestResponse.error,'DAILY_DESTINATION_MISMATCH');return true;
  });
});
test('an injected hosted client keeps its own transport while the runner records the bounded request',async t=>{
  const h=await setup(t);let posts=0;
  const client=createHostedClient({env:oidc,clock:()=>NOW,fetchImpl:async(url)=>{
    if(url.includes('actions.githubusercontent.com'))return Response.json({value:jwt()});
    if(url.endsWith('/internal/report-status'))return Response.json(h.served);
    assert.equal(url,HOSTED_ORIGIN+'/internal/observation-notifications');posts++;return Response.json(h.response);
  }});
  const result=await runDigest({...h.options,client,fetchImpl:()=>assert.fail('injected client transport must not be replaced')});
  assert.equal(result.exitCode,0);assert.equal(posts,1);assert.equal(result.requestStartedAt,at(0));
});
test('workflow isolates the successful observations digest step without Telegram credentials and preserves artifact exclusions',async()=>{
  const text=await readFile(new URL('../../.github/workflows/live-publication.yml',import.meta.url),'utf8');
  const start=text.indexOf('      - name: 北京时间'),end=text.indexOf('      - name:',start+1),step=text.slice(start,end);
  assert.match(step,/if: success\(\) && env\.HOSTED_MODE == 'observations'/);
  for(const key of ['TELEGRAM_BOT_TOKEN','TELEGRAM_CHAT_ID'])assert.ok(!text.includes(key));
  assert.ok(step.includes('node collector/observation-digest.mjs --root "$RUNNER_TEMP/dimension-live" --mode "$HOSTED_MODE"'));
  assert.ok(text.includes('!${{ runner.temp }}/dimension-live/**/*credential*'));assert.ok(text.includes('!${{ runner.temp }}/dimension-live/**/*token*'));
});
