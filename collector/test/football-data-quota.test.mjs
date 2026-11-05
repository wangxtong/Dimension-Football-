import test from 'node:test';
import assert from 'node:assert/strict';
import {createFootballDataQuota,enableFootballDataQuota,footballDataQuota,safeFootballDataDiagnostics} from '../sources/football-data-quota.mjs';
import {collectFootballDataHistory} from '../sources/football-data-history.mjs';
import {fetchFootballFixtures} from '../sources/fixtures.mjs';
import {buildDailyResearchReport,researchAcquisitionLimitations} from '../research-daily-report.mjs';
const NOW=Date.parse('2026-11-05T04:00:00Z');
const at=offset=>new Date(NOW+offset).toISOString();
function virtualQuota(){let time=NOW;return {clock:()=>time,sleep:async ms=>{await new Promise(resolve=>setImmediate(resolve));time+=ms;}};}

test('fifteen requests share a quota and every rolling minute stays within ten starts',async()=>{
 const clock=virtualQuota(),quota=createFootballDataQuota(clock);
 const starts=await Promise.all(Array.from({length:15},()=>quota.acquire()));
 assert.equal(starts[0],NOW);assert.equal(starts[14]-NOW,91000);
 for(const start of starts)assert.ok(starts.filter(value=>value>=start && value<start+60000).length<=10);
});
test('Retry-After, v4 reset/remaining headers and legacy headers are observed without raw values',async()=>{
 const clock=virtualQuota(),quota=createFootballDataQuota(clock);
 quota.observe(new Response('',{status:429,headers:{'Retry-After':'70','X-RequestCounter-Reset':'2'}}));
 assert.equal(quota.state().blockedUntil,NOW+70000);
 assert.equal(await quota.acquire(),NOW+70000);
 quota.observe(new Response('',{headers:{'X-RequestsAvailable':'0','X-RequestCounter-Reset':'30'}}));
 assert.equal(await quota.acquire(),NOW+100000);
 quota.observe(new Response('',{headers:{'X-Requests-Available-Minute':'0','X-RequestCounter-Reset':'10'}}));
 assert.equal(await quota.acquire(),NOW+110000);
});
test('quota cancellation and insufficient budgets stop before a network request',async()=>{
 const clock=virtualQuota(),quota=createFootballDataQuota(clock);await quota.acquire();
 await assert.rejects(quota.acquire({remaining:()=>500}),{code:'budget_exhausted'});
 const controller=new AbortController();controller.abort();
 await assert.rejects(quota.acquire({signal:controller.signal}),{code:'cancelled'});
 assert.equal(quota.state().nextAt,NOW+6500);
});
test('results, historical training and all five fixture adapters share slots before their network timeouts',async()=>{
 const clock=virtualQuota(),requests=[];
 const fakeFetch=async(url,init)=>{
  assert.equal(init.signal.aborted,false);
  const parsed=new URL(url),league=parsed.pathname.split('/')[3];requests.push(clock.clock());
  const history=parsed.searchParams.get('status')==='FINISHED';
  return Response.json({competition:{code:league},matches:[{id:requests.length,competition:{code:league},
   utcDate:history?at(-86400000):at(86400000),status:history?'FINISHED':'TIMED',lastUpdated:at(-1000),
   homeTeam:{id:100,name:'Offline home'},awayTeam:{id:101,name:'Offline away'},score:{fullTime:{home:1,away:0}}}]},
   {headers:{date:new Date(clock.clock()).toUTCString()}});
 };
 const quota=enableFootballDataQuota(fakeFetch,clock);
 assert.equal(footballDataQuota(fakeFetch),quota);
 const options={apiKey:'offline-placeholder',fetchImpl:fakeFetch,nowISO:at(0),remaining:()=>180000-(clock.clock()-NOW)};
 assert.equal((await collectFootballDataHistory({...options,days:7,timeoutMs:1})).history.length,5);
 assert.equal((await collectFootballDataHistory({...options,days:420,timeoutMs:1})).history.length,5);
 const fixtures=await fetchFootballFixtures(options);
 assert.equal(fixtures.fixtures.length,5);assert.ok(fixtures.diagnostics.every(row=>row.httpStatus===200));
 assert.equal(requests.length,15);assert.equal(requests.at(-1)-NOW,91000);
 for(const start of requests)assert.ok(requests.filter(value=>value>=start && value<start+60000).length<=10);
});
function reportAndCollection(){return {document:{simulated:false,kind:'prematch-forecast-report',generatedAt:at(0),
 publication:{reportId:'a'.repeat(64)},fixtures:[],summary:{strictCandidates:0},diagnostics:[{code:'NO_USABLE_FIXTURE_SOURCE'}]},
 collection:{publication:{reportId:'a'.repeat(64)},sourceManagement:{attempts:[{id:'football-data.org',code:'rate_limited',leagues:[{httpStatus:429}],message:'secret-not-for-output'}]}}};}
test('zero fixtures from HTTP429 carry a fixed explanation and preserve the blocked schema and history',()=>{
 const input=reportAndCollection(),ledger={exists:true,events:[]};
 const report=buildDailyResearchReport({...input,ledger,nowISO:at(0),codeSha:'b'.repeat(40)});
 assert.equal(report.state,'zero-qualified-forecasts');assert.equal(report.forecasts.total,0);
 assert.match(report.limitations[0],/^本轮采集：主赛程源限流（HTTP 429）/);
 assert.equal(report.commercialReleaseGate,'BLOCKED');assert.equal(report.externalTelegramSent,false);
 assert.equal(report.strictMarkets.releasedCandidates,0);assert.doesNotMatch(JSON.stringify(report),/secret-not-for-output/);
 assert.match(report.reportId,/^[a-f0-9]{64}$/);
});
test('mismatched collection evidence and arbitrary server text cannot create a 429 claim',()=>{
 const {document,collection}=reportAndCollection();collection.publication.reportId='c'.repeat(64);
 assert.deepEqual(researchAcquisitionLimitations(document,collection),['本轮采集：赛程源不可用，本轮未取得新研究赛程；原冻结及结算记录保留。']);
 document.diagnostics=[];assert.deepEqual(researchAcquisitionLimitations(document,collection),[]);
});

test('a 429 response extends the cooldown of a caller that was already waiting',async()=>{
 let time=NOW;let release;const waiting=[];
 const quota=createFootballDataQuota({clock:()=>time,sleep:ms=>new Promise(resolve=>{waiting.push(ms);release=()=>{time+=ms;resolve();};})});
 await quota.acquire();const pending=quota.acquire();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(waiting,[6500]);
 quota.observe(new Response('',{status:429,headers:{'Retry-After':'60'}}));
 release();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(waiting,[6500,53500]);release();assert.equal(await pending,NOW+60000);
});
test('history diagnostic metadata preserves failure codes while rejecting raw messages, URLs and arbitrary codes',()=>{
 const safe=safeFootballDataDiagnostics([{league:'PL',status:'unavailable',code:'HISTORY_HTTP_429',httpStatus:429,message:'secret',url:'https://example.test/key=secret'},
 {league:'secret',status:'unavailable',code:'secret',matchedCount:-1}]);
 assert.equal(safe[0].code,'HISTORY_HTTP_429');assert.equal(safe[0].httpStatus,429);
 assert.equal(safe[1].code,'HISTORY_FETCH_UNCONFIRMED');assert.equal(safe[1].league,null);assert.equal(safe[1].matchedCount,null);
 assert.doesNotMatch(JSON.stringify(safe),/secret|https:/);
});


