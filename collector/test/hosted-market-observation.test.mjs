import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShadow, observationBundle, HOSTED_ORIGIN } from '../hosted.mjs';
import { summarizeMarketObservation } from '../market-observation.mjs';
import { createArchiveEpoch, createArchiveShard, emptyArchive, appendArchive } from '../state-archive.mjs';
import { atomicJson, readJson } from '../storage.mjs';
import { reportHash } from '../report-store.mjs';

const NOW=Date.parse('2026-11-01T10:00:00.000Z'),SHA='a'.repeat(40),minute=60000;
const at=offset=>new Date(NOW+offset).toISOString();
const file=(path,value)=>({path,content:Buffer.from(JSON.stringify(value)).toString('base64')});
const decode=row=>JSON.parse(Buffer.from(row.content,'base64'));
const row=(api,path)=>decode(api.state.files.find(item=>item.path===path));
async function workspace(t){const root=await mkdtemp(join(tmpdir(),'hosted-market-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
function manifest(offset=0,{near=true,fetchedAt=at(offset)}={}){
  const fixture={id:'oldb-1',sourceFixtureId:'1',source:'openligadb',league:'BL1',season:'2026',home:'A',away:'B',
    homeTeamId:'1',awayTeamId:'2',kickoff:at(near?7200000:172800000),status:'SCHEDULED',updatedAt:fetchedAt,fetchedAt};
  return {version:1,kind:'public-fixture-sample',dataSchemaVersion:2,simulated:false,checkedAt:at(offset),
    fixtures:[fixture,{...fixture,id:'oldb-2',sourceFixtureId:'2',home:'C',away:'D',homeTeamId:'3',awayTeamId:'4',kickoff:at(172800000)}],
    sources:[{name:'OpenLigaDB',license:'ODbL-1.0',url:'https://www.openligadb.de/'}],diagnostics:[],coverage:[]};
}
function backend(initial=null){
  const api={state:initial,calls:[],posts:[],served:null,async request(path,{method='GET',body}={}){
    api.calls.push({path,method,body});
    if(path==='/internal/state'){
      if(method==='GET')return structuredClone(api.state);
      if(body.expectedRevision!==(api.state?.revision||0))throw Error('HOSTED_STATE_CONFLICT');
      if(api.state?.version===2)assert.deepEqual(body.archive,api.state.archive);
      api.state={revision:body.expectedRevision+1,files:structuredClone(body.files),
        ...(body.version===2?{version:2,archive:structuredClone(body.archive)}:{})};
      return {revision:api.state.revision};
    }
    if(path==='/internal/observations'&&method==='POST'){
      api.posts.push(structuredClone(body));
      api.served={version:1,reportId:reportHash({projection:body.reportId}),originReportId:body.reportId,reportHash:reportHash(body.report),
        generatedAt:body.report.generatedAt,mode:'hosted',health:'available',publicationKind:'observations',forecastPublished:false};
      return structuredClone(api.served);
    }
    if(path==='/internal/report-status')return structuredClone(api.served);
    assert.fail('Unexpected network endpoint: '+path);
  }};return api;
}
async function fakePublic(args,{clock,collectMode,env}){
  assert.equal(collectMode,'public');assert.equal(env.COLLECTOR_COMMIT,SHA);assert.ok(!args.includes('--collect'));
  const input=manifest(Date.parse(clock())-NOW),out=args[args.indexOf('--out')+1];
  await atomicJson(join(out,'public-fixtures.json'),input);
  return {manifest:input,collection:null,exitCode:0};
}
function marketResult(fixtures,clock,evidence={quotes:[],diagnostics:[]}){
  return {privateEvidence:evidence,summary:summarizeMarketObservation({fixtures,evidence,checkedAt:clock()})};
}
async function run(t,api,offset=0,overrides={}){
  return runShadow({root:await workspace(t),client:api,env:{GITHUB_SHA:SHA,HOSTED_MARKET_OBSERVATIONS:'true'},clock:()=>at(offset),
    stdout:()=>{},runPublicImpl:fakePublic,fetchImpl:()=>assert.fail('Real transport must not run in orchestration tests'),
    collectMarketImpl:async({fixtures,clock})=>marketResult(fixtures,clock),...overrides});
}
function patchState(api,path,change){
  const item=api.state.files.find(item=>item.path===path);item.content=file(path,change(decode(item))).content;
}
function seedPending(bundle,startedAt){
  return {revision:1,files:[file('state/hosted-observation.json',{version:1,bundle,bundleHash:reportHash(bundle),delivery:{status:'pending'}}),
    file('state/hosted-scheduler.json',{version:1,lanes:{observations:{startedAt,status:'collected'}}})]};
}
function quotes(fixtures,offset=0){
  const fixture=fixtures[0];
  return ['home','away'].map(selection=>({sourceId:'macauslot',bookmaker:'Macau SLOT',provider:'macauslot-official',
    evidenceUrl:'https://www.macauslot.com/soccer/json/realtime/threeinone_odds_cn_fb.json',fixtureId:fixture.id,fixtureSnapshot:{...fixture},
    verified:true,verificationMethod:'automatic',observedAt:at(offset),sourceUpdatedAt:at(offset),validUntil:at(offset+5*minute),
    market:'asian-handicap',period:'full-time',providerMatchId:'macau-1',providerPoolId:'pool-1',inPlay:false,closed:false,
    selection,handicap:selection==='home'?-.25:.25,decimalOdds:1.9}));
}

test('market feature is opt-in and preserves the original fixture report hash and zero market calls',async t=>{
  const api=backend(),result=await run(t,api,0,{env:{GITHUB_SHA:SHA},collectMarketImpl:()=>assert.fail('flag disabled')});
  assert.equal(result.status,'complete');assert.equal(result.marketObserved,undefined);
  assert.equal(api.posts[0].reportId,observationBundle(manifest(),{commit:SHA,nowISO:at(0)}).reportId);
  assert.equal(api.posts[0].report.marketObservation,undefined);
  assert.ok(!api.state.files.some(item=>item.path==='state/hosted-market-observation.json'));
});

test('fresh runners keep 5-minute market and 15-minute fixture cadences without renewing acquisition or quotes',async t=>{
  const api=backend();let fixtureCalls=0,marketCalls=0,originalQuotes;
  const options={runPublicImpl:async(...args)=>{fixtureCalls++;return fakePublic(...args);},collectMarketImpl:async({fixtures,clock})=>{
    marketCalls++;assert.equal(fixtures.length,1);originalQuotes||=quotes(fixtures);return marketResult(fixtures,clock,{quotes:originalQuotes});
  }};
  const first=await run(t,api,0,options);assert.equal(first.status,'complete');assert.equal(first.marketFixtureCount,1);
  assert.equal(api.posts[0].report.fixtures.length,2);assert.equal(api.posts[0].report.marketObservation.sources[1].quoteCount,2);
  const cached=await run(t,api,4*minute,options);
  assert.equal(cached.status,'idle');assert.equal(cached.marketObserved,false);assert.equal(cached.marketCheckedAt,at(0));
  const next=await run(t,api,5*minute,options);
  assert.equal(next.status,'complete');assert.equal(next.collected,false);assert.equal(next.marketObserved,true);
  assert.notEqual(next.originReportId,first.originReportId);
  const updated=api.posts.at(-1).report;
  assert.equal(updated.generatedAt,at(5*minute));assert.equal(updated.acquisition.checkedAt,at(0));
  assert.equal(updated.fixtures[0].fixture.fetchedAt,at(0));
  assert.equal(updated.marketObservation.sources.find(item=>item.id==='macauslot').latestSourceUpdatedAt,at(0));
  assert.equal(updated.marketObservation.sources.find(item=>item.id==='macauslot').quoteCount,0);
  await run(t,api,10*minute,options);await run(t,api,15*minute,options);
  assert.equal(fixtureCalls,2);assert.equal(marketCalls,4);
  assert.equal(api.posts.at(-1).report.acquisition.checkedAt,at(15*minute));
  assert.equal(api.posts.at(-1).report.publication.releaseGate,'BLOCKED');
  assert.ok(api.calls.every(item=>!['/internal/publications','/internal/notifications'].includes(item.path)));
});

test('a changed fixture target set forces a market refresh before the five-minute interval',async t=>{
  const api=backend();let calls=0;
  const options={collectMarketImpl:async({fixtures,clock})=>{calls++;return marketResult(fixtures,clock);}};
  await run(t,api,0,options);
  // A scheduler recovery makes fixture collection due early; the new target
  // must not reuse evidence bound to the old event set.
  patchState(api,'state/hosted-scheduler.json',value=>({...value,lanes:{...value.lanes,observations:{startedAt:at(-20*minute),status:'complete'}}}));
  const result=await run(t,api,minute,{...options,runPublicImpl:async(...args)=>{
    const value=await fakePublic(...args);value.manifest.fixtures[0].kickoff=at(10800000);return value;
  }});
  assert.equal(result.status,'complete');assert.equal(result.marketObserved,true);assert.equal(calls,2);
  assert.equal(result.marketCheckedAt,at(minute));
});

test('market generation cannot extend old acquisition age and stale legacy fixtures never reach collection',async t=>{
  const input=manifest(),base=observationBundle(input,{commit:SHA,nowISO:at(0)});
  const summary=summarizeMarketObservation({fixtures:[base.report.fixtures[0].fixture],evidence:{},checkedAt:at(19*minute)});
  const recentMarket=observationBundle(input,{commit:SHA,nowISO:at(19*minute),marketObservation:summary});
  const legacyOldFixture=observationBundle(manifest(0,{fetchedAt:at(-10*minute)}),{commit:SHA,nowISO:at(0)});
  for(const [bundle,offset] of [[recentMarket,21*minute],[legacyOldFixture,11*minute]]){
    const api=backend(seedPending(bundle,at(offset)));
    const result=await run(t,api,offset,{runPublicImpl:()=>assert.fail('fixture lane not due'),collectMarketImpl:()=>assert.fail('stale fixtures reached market')});
    assert.equal(result.code,'HOSTED_OBSERVATION_INPUT_STALE_OR_INVALID');assert.equal(api.posts.length,0);
  }
  const future=structuredClone(base);future.report.fixtures[0].fixture.fetchedAt=at(minute);
  const api=backend(seedPending(future,at(0)));
  const result=await run(t,api,0,{collectMarketImpl:()=>assert.fail('future fixture reached market')});
  assert.equal(result.code,'HOSTED_OBSERVATION_INPUT_STALE_OR_INVALID');assert.equal(api.posts.length,0);
});

test('failure publishes a safe unavailable aggregate while private evidence and provider cooldowns remain in state',async t=>{
  const api=backend();
  const first=await run(t,api,0,{collectMarketImpl:async({fixtures,clock,statePath,providerStatePath})=>{
    assert.match(statePath,/\/state\/market-observation-crawler\.json$/);
    assert.match(providerStatePath,/\/state\/market-observation-providers\.json$/);
    await atomicJson(statePath,{cooldownUntil:at(10*minute)});await atomicJson(providerStatePath,{cooldownUntil:at(20*minute)});
    return marketResult(fixtures,clock,{quotes:[],diagnostics:[{id:'macauslot',status:'unavailable',detail:'private-provenance-only'}]});
  }});
  assert.equal(first.status,'complete');
  assert.match(JSON.stringify(row(api,'state/hosted-market-observation.json')),/private-provenance-only/);
  assert.doesNotMatch(JSON.stringify(api.posts),/private-provenance-only|privateEvidence|decimalOdds/);
  const next=await run(t,api,5*minute,{collectMarketImpl:async({statePath,providerStatePath})=>{
    assert.equal((await readJson(statePath)).cooldownUntil,at(10*minute));
    assert.equal((await readJson(providerStatePath)).cooldownUntil,at(20*minute));
    throw Error('SECRET-BEARER-and-sensitive-origin-url');
  }});
  assert.equal(next.status,'complete');assert.equal(next.marketStatus,'unavailable');assert.equal(next.forecastPublished,false);
  assert.ok(api.posts.at(-1).report.marketObservation.sources.every(item=>item.status==='unavailable'));
  assert.doesNotMatch(JSON.stringify([api.posts,api.state,next]),/SECRET-BEARER-and-sensitive-origin-url/);
});

test('no targets skip source transport, and insufficient remaining time preserves the publication reserve',async t=>{
  const api=backend();let elapsed=0;
  const noTargets=await run(t,api,0,{runPublicImpl:async()=>({manifest:manifest(0,{near:false}),collection:null,exitCode:0}),
    collectMarketImpl:()=>assert.fail('no targets must skip market transport')});
  assert.equal(noTargets.status,'complete');assert.equal(noTargets.marketFixtureCount,0);assert.equal(noTargets.marketStatus,'no_targets');
  const limited=await run(t,backend(),0,{monotonic:()=>elapsed,runPublicImpl:async(...args)=>{const value=await fakePublic(...args);elapsed=150001;return value;},
    collectMarketImpl:()=>assert.fail('remaining time is reserved for checkpoint/publication')});
  assert.equal(limited.status,'complete');assert.equal(limited.marketStatus,'budget_exhausted');
  assert.equal(limited.RELEASE_GATE,'BLOCKED');
});

test('market transport receives a bounded shared deadline and overruns become explicit failure evidence',async t=>{
  let elapsed=0;const api=backend();
  const result=await run(t,api,0,{monotonic:()=>elapsed,collectMarketImpl:async({fixtures,clock,remaining,signal})=>{
    assert.ok(signal instanceof AbortSignal);assert.equal(remaining(),90000);elapsed=90001;
    return marketResult(fixtures,clock,{quotes:quotes(fixtures)});
  }});
  assert.equal(result.status,'complete');assert.equal(result.marketStatus,'budget_exhausted');
  assert.ok(api.posts[0].report.marketObservation.sources.every(item=>item.quoteCount===0));
  assert.equal(row(api,'state/hosted-market-observation.json').privateEvidence.diagnostics[0].code,'COLLECTION_BUDGET_EXHAUSTED');
});

test('stale positive market evidence is not retried as a fresh valid observation before the next collection',async t=>{
  const api=backend();await run(t,api,0,{collectMarketImpl:async({fixtures,clock})=>marketResult(fixtures,clock,
    {quotes:quotes(fixtures).map(item=>({...item,validUntil:at(minute)}))})});
  patchState(api,'state/hosted-observation.json',value=>({...value,delivery:{status:'pending'}}));
  const count=api.posts.length;
  const result=await run(t,api,2*minute,{collectMarketImpl:()=>assert.fail('five-minute interval not elapsed')});
  assert.equal(result.code,'HOSTED_MARKET_OBSERVATION_EXPIRED');assert.equal(api.posts.length,count);
  assert.equal(row(api,'state/hosted-market-observation.json').summary.checkedAt,at(0));
});

test('legacy private ledger bytes and v2 cold archive references survive market observations and CAS revisions',async t=>{
  const retained=[file(`reports/forecast-ledger/${'a'.repeat(64)}/predictions/${'b'.repeat(64)}.json`,{unscored:true}),
    file(`reports/replays/${'a'.repeat(64)}/run-inputs.json`,{original:'retained'})];
  const epoch=createArchiveEpoch(HOSTED_ORIGIN,0),shard=createArchiveShard(epoch,retained),archive=appendArchive(emptyArchive(epoch),[shard.descriptor]);
  for(const initial of [{revision:3,files:structuredClone(retained)},{version:2,revision:3,files:[],archive}]){
    const api=backend(initial);
    for(const offset of [0,5*minute])assert.equal((await run(t,api,offset)).status,'complete');
    assert.equal(api.state.revision,7);
    if(initial.version===2){assert.deepEqual(api.state.archive,archive);assert.ok(api.calls.every(item=>!item.path.startsWith('/internal/state/objects/')));}
    else{assert.equal(api.state.version,undefined);for(const original of retained)assert.deepEqual(api.state.files.find(item=>item.path===original.path),original);}
  }
});

test('global cancellation and checkpoint conflicts never reach observation or forecast publication',async t=>{
  const api=backend(),controller=new AbortController();
  const aborted=await run(t,api,0,{signal:controller.signal,collectMarketImpl:async()=>{controller.abort();throw Error('cancelled');}});
  assert.equal(aborted.code,'HOSTED_OBSERVATION_CANCELLED');assert.equal(api.posts.length,0);
  const conflicted=backend(),request=conflicted.request.bind(conflicted);let puts=0;
  conflicted.request=async(path,options)=>{if(path==='/internal/state'&&options?.method==='PUT'){puts++;throw Error('HOSTED_STATE_CONFLICT');}return request(path,options);};
  const result=await run(t,conflicted,0);assert.equal(result.code,'HOSTED_STATE_CONFLICT');assert.equal(puts,1);assert.equal(conflicted.posts.length,0);
});
