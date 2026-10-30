import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fetchFullAnalysisData} from '../full-analysis.mjs';

const NOW='2026-10-30T08:00:00.000Z',KEY='dummy-analysis-secret';
const fixture=id=>({id:`af-${id}`,league:'PL',home:'Home FC',away:'Away FC',kickoff:'2026-10-31T15:00:00.000Z',status:'SCHEDULED',source:'api-football'});
function target(id,season=2026){return {fixture:{id,date:fixture(id).kickoff,timestamp:Date.parse(fixture(id).kickoff)/1000,status:{short:'NS'}},
  league:{id:39,season},teams:{home:{id:11,name:'Home FC'},away:{id:12,name:'Away FC'}}};}
function history(league=39,season=2026){
  if(league!==39)return [];
  return Array.from({length:10},(_,index)=>{
    const date=`${season}-10-0${index%5+1}T15:00:00.000Z`,home=index<5;
    return {fixture:{id:season*10000+index+1000,date,timestamp:Date.parse(date)/1000,status:{short:'FT'}},league:{id:league,season},
      teams:{home:{id:home?11:31+index,name:home?'Home FC':'Opponent'},away:{id:home?21+index:12,name:home?'Opponent':'Away FC'}},goals:{home:2,away:1}};
  });
}
const envelope=(get,response=[],paging={current:1,total:1})=>({get,parameters:{},errors:[],results:response.length,paging,response});
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{Date:new Date(NOW).toUTCString(),'Content-Type':'application/json',...headers}});
function mocked({override,season=2026,emptyHistory=false}={}){
  const calls=[];let active=0,maximum=0;
  return {calls,get maximum(){return maximum;},fetchImpl:async(url,options)=>{
    calls.push({url,options});active++;maximum=Math.max(maximum,active);
    await Promise.resolve();active--;
    const request=new URL(url),query=request.searchParams;
    const changed=await override?.(request,options);if(changed!==undefined)return changed;
    let rows=[];
    if(request.pathname==='/fixtures'){
      if(query.has('ids'))rows=query.get('ids').split('-').map(id=>target(Number(id),season));
      else if(query.has('team'))rows=history().filter(row=>[row.teams.home.id,row.teams.away.id].includes(Number(query.get('team'))));
      else rows=emptyHistory?[]:history(Number(query.get('league')),Number(query.get('season')));
    }
    return json(envelope(request.pathname.slice(1),rows,{current:Number(query.get('page')||1),total:1}));
  }};
}
const collect=(mock,input={})=>fetchFullAnalysisData({fixtures:[fixture(1)],apiKey:KEY,nowISO:NOW,clock:()=>NOW,fetchImpl:mock.fetchImpl,...input});

test('collects every authorized dimension with three workers, official header-only requests and verifiable metadata',async()=>{
  const mock=mocked(),result=await collect(mock);
  assert.equal(mock.calls.length,15);assert.equal(mock.maximum,3);assert.equal(result.coverage.requests,15);
  assert.equal(result.evidence.fixtures.length,1);assert.equal(result.marketSnapshot.fixtures.length,1);
  assert.equal(result.priorHistory.length,5);assert.ok(result.priorHistory.every(row=>row.kind==='history'&&row.period==='prior-season'));
  for(const {url,options}of mock.calls){
    assert.equal(new URL(url).origin,'https://v3.football.api-sports.io');assert.equal(url.includes(KEY),false);
    assert.equal(options.headers['x-apisports-key'],KEY);assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');assert.ok(options.signal instanceof AbortSignal);
  }
  for(const kind of ['injuries','lineups','predictions','odds'])assert.equal(result.evidence.evidence.filter(row=>row.kind===kind&&row.fixtureId==='af-1').length,1);
  const row=result.evidence.evidence.find(row=>row.kind==='fixtures');
  assert.equal(row.fetchedAt,NOW);assert.equal(row.httpDate,new Date(NOW).toUTCString());assert.equal(row.httpStatus,200);
  assert.equal(row.sha256,createHash('sha256').update(JSON.stringify(row.data)).digest('hex'));
  assert.equal(result.status,'partial','empty provider dimensions must not be called complete analysis');
  assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('batches at most 20 IDs and retains explicit missing evidence for every fixture beyond the request budget',async()=>{
  const mock=mocked(),fixtures=Array.from({length:41},(_,index)=>fixture(index+1));
  const result=await collect(mock,{fixtures,maxRequests:3});
  assert.equal(mock.calls.length,3);assert.equal(result.coverage.requests,3);
  assert.deepEqual(mock.calls.map(({url})=>new URL(url).searchParams.get('ids').split('-').length),[20,20,1]);
  assert.equal(result.evidence.fixtures.length,41);assert.equal(result.marketSnapshot.fixtures.length,41);
  assert.equal(result.diagnostics.filter(row=>row.kind==='fixture-coverage').length,41);
  for(const item of result.marketSnapshot.fixtures){assert.equal(item.error,'request_budget_exhausted');assert.equal(item.pages.length,1);assert.equal(item.pages[0].attempted,false);}
  for(const item of fixtures)for(const kind of ['injuries','lineups','predictions','odds']){
    const row=result.evidence.evidence.find(row=>row.fixtureId===item.id&&row.kind===kind);
    assert.equal(row.error,'request_budget_exhausted');assert.equal(row.fetchedAt,null);
  }
});

test('zero budget, missing credentials and an empty input never issue requests',async()=>{
  const mock=mocked();
  const zero=await collect(mock,{maxRequests:0});assert.equal(zero.coverage.requests,0);assert.ok(zero.evidence.evidence.every(row=>row.error==='request_budget_exhausted'));
  const missing=await collect(mock,{apiKey:''});assert.equal(missing.coverage.requests,0);assert.ok(missing.evidence.evidence.every(row=>row.error==='authorization_required'));
  const empty=await collect(mock,{fixtures:[]});assert.equal(empty.status,'empty');assert.deepEqual(empty.evidence.fixtures,[]);assert.deepEqual(empty.marketSnapshot.fixtures,[]);
  assert.deepEqual(empty.priorHistory,[]);assert.deepEqual(empty.diagnostics,[]);assert.equal(mock.calls.length,0);
});

test('prefers the target provider season and supplements venue samples with distinct team requests only when needed',async()=>{
  const mock=mocked({season:2024}),result=await collect(mock);
  const seasons=mock.calls.map(({url})=>new URL(url)).filter(url=>url.searchParams.get('league')==='39').map(url=>url.searchParams.get('season'));
  assert.deepEqual(seasons,['2024','2023']);assert.equal(mock.calls.some(({url})=>new URL(url).searchParams.has('team')),false);
  assert.ok(result.evidence.evidence.some(row=>row.kind==='history'&&row.league==='PL'&&row.seasonSource==='target-fixture'&&row.season===2024));
  const promoted=mocked({emptyHistory:true});const expanded=await collect(promoted,{fixtures:[fixture(1),fixture(2)]});
  const teams=promoted.calls.map(({url})=>new URL(url)).filter(url=>url.searchParams.has('team'));
  assert.deepEqual(teams.map(url=>url.searchParams.get('team')).sort(),['11','12']);
  assert.ok(teams.every(url=>url.searchParams.get('last')==='30'&&url.searchParams.get('status')==='FT'));
  const supplements=expanded.priorHistory.filter(row=>row.period==='team-history');assert.equal(supplements.length,2);
  assert.ok(supplements.every(row=>row.kind==='history'&&row.requestedFor.length===2&&row.data.results===5));
});

test('failure of one dimension never cancels the other fixture endpoints',async()=>{
  const mock=mocked({override:request=>request.pathname==='/predictions'?json({},403):undefined});
  const result=await collect(mock);
  assert.equal(mock.calls.length,15);assert.ok(result.evidence.evidence.some(row=>row.kind==='predictions'&&row.error==='access_denied'));
  for(const kind of ['injuries','lineups','odds'])assert.ok(result.evidence.evidence.some(row=>row.kind===kind&&row.data&&!row.error));
  const coverage=result.diagnostics.find(row=>row.kind==='fixture-coverage');assert.ok(coverage.missingDimensions.includes('predictions'));
  assert.equal(result.status,'partial');
});

test('size, JSON and provider errors retain stable codes without bodies, headers, redirect targets or echoed secrets',async()=>{
  const mock=mocked({override:request=>{
    if(request.pathname==='/injuries')return new Response('x'.repeat(2_000_001),{headers:{Date:new Date(NOW).toUTCString()}});
    if(request.pathname==='/fixtures/lineups')return new Response('not json',{headers:{Date:new Date(NOW).toUTCString()}});
    if(request.pathname==='/predictions')return json(envelope('predictions'),200,{'Content-Length':'2000001'});
    if(request.pathname==='/odds')return json({...envelope('odds'),errors:{token:`bad ${KEY}`}});
  }});
  const result=await collect(mock),errors=Object.fromEntries(result.evidence.evidence.filter(row=>row.fixtureId).map(row=>[row.kind,row.error]));
  assert.deepEqual(errors,{injuries:'response_too_large',lineups:'invalid_json',predictions:'response_too_large',odds:'authorization_required'});
  assert.equal(JSON.stringify(result).includes(KEY),false);assert.equal(JSON.stringify(result).includes('not json'),false);
  const reflected=mocked({override:request=>request.pathname==='/predictions'?json(envelope('predictions',[{reflected:KEY}])):
    request.pathname==='/odds'?json({},302,{Location:`https://other.invalid/?key=${KEY}`}):undefined});
  const safe=await collect(reflected);assert.ok(safe.evidence.evidence.some(row=>row.error==='credential_reflected'));
  assert.equal(safe.marketSnapshot.fixtures[0].error,'redirect_blocked');assert.equal(JSON.stringify(safe).includes(KEY),false);assert.equal(JSON.stringify(safe).includes('other.invalid'),false);
});

test('odds pagination stops at ten pages and declares incomplete coverage instead of claiming success',async()=>{
  const mock=mocked({override:request=>request.pathname==='/odds'?json(envelope('odds',[],{current:Number(request.searchParams.get('page')||1),total:12})):undefined});
  const result=await collect(mock);
  assert.equal(mock.calls.filter(({url})=>new URL(url).pathname==='/odds').length,10);
  assert.equal(result.marketSnapshot.fixtures[0].pages.length,10);assert.equal(result.marketSnapshot.fixtures[0].error,'pagination_limit_reached');
  assert.ok(result.diagnostics.some(row=>row.fixtureId==='af-1'&&row.code==='pagination_limit_reached'&&row.reportedPages===12));
});

test('pagination requests share the global budget and preserve unrequested pages with the exact blocker',async()=>{
  const mock=mocked({override:request=>request.pathname==='/odds'?json(envelope('odds',[],{current:Number(request.searchParams.get('page')||1),total:5})):undefined});
  const result=await collect(mock,{maxRequests:16}),pages=result.marketSnapshot.fixtures[0].pages;
  assert.equal(mock.calls.length,16);assert.equal(result.coverage.requests,16);assert.equal(pages.length,5);
  assert.equal(pages.filter(row=>row.data).length,2);assert.ok(pages.slice(2).every(row=>row.error==='request_budget_exhausted'&&row.attempted===false));
  assert.equal(result.marketSnapshot.fixtures[0].error,'request_budget_exhausted');
});

test('missing, stale and invalid HTTP dates are explicit source failures',async()=>{
  const mock=mocked({override:request=>request.pathname==='/predictions'?json(envelope('predictions'),200,{Date:'invalid'}):
    request.pathname==='/odds'?json(envelope('odds'),200,{Date:'Fri, 30 Oct 2026 07:54:59 GMT'}):undefined});
  const result=await collect(mock);assert.ok(result.evidence.evidence.some(row=>row.kind==='predictions'&&row.error==='stale_response'&&row.httpDate===null));
  assert.equal(result.marketSnapshot.fixtures[0].error,'stale_response');
});

test('external cancellation ends an ignored fetch and explicitly marks the remaining dimensions',async()=>{
  const controller=new AbortController();let calls=0;
  const result=await fetchFullAnalysisData({fixtures:[fixture(1)],apiKey:KEY,nowISO:NOW,clock:()=>NOW,signal:controller.signal,fetchImpl:()=>{
    calls++;controller.abort(`must not copy ${KEY}`);return new Promise(()=>{});
  }});
  assert.equal(calls,1);assert.ok(result.evidence.evidence.every(row=>row.error==='aborted'));
  assert.equal(result.marketSnapshot.fixtures[0].error,'aborted');assert.equal(JSON.stringify(result).includes(KEY),false);
});

test('a fetch that ignores cancellation still has the fifteen-second deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const operation=fetchFullAnalysisData({fixtures:[fixture(1)],apiKey:KEY,nowISO:NOW,clock:()=>NOW,maxRequests:1,fetchImpl:()=>new Promise(()=>{})});
  t.mock.timers.tick(15_000);
  const result=await operation;assert.equal(result.coverage.requests,1);
  assert.equal(result.evidence.evidence.find(row=>row.kind==='fixtures').error,'timeout');
});

test('records injected completion times and rejects invalid inputs before any request',async()=>{
  const mock=mocked();let clockTicks=0;
  const result=await collect(mock,{clock:()=>new Date(Date.parse(NOW)+clockTicks++*1000).toISOString()});
  assert.ok(result.evidence.evidence.filter(row=>row.attempted).every(row=>Date.parse(row.fetchedAt)>Date.parse(NOW)));
  assert.ok(result.evidence.evidence.filter(row=>row.attempted).every(row=>Date.parse(row.fetchedAt)<=Date.parse(result.evidence.capturedAt)));
  let calls=0;const fetchImpl=()=>{calls++;throw new Error('must not fetch');};
  for(const input of [{fixtures:[{id:'fd-1'}]},{fixtures:[fixture(1),fixture(1)]},{fixtures:Array(3001).fill(fixture(1))},
    {maxRequests:-1},{maxRequests:1.5},{apiKey:'x\r\ny'},{nowISO:'invalid'},{signal:{}},{clock:()=>null}]){
    await assert.rejects(()=>fetchFullAnalysisData({fixtures:[fixture(1)],apiKey:KEY,nowISO:NOW,clock:()=>NOW,fetchImpl,...input}),TypeError);
  }
  assert.equal(calls,0);
});
