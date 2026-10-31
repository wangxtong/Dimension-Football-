import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchMarketSourceAudit,isMarketQuoteCurrent,marketSourceRegistry} from '../market-sources.mjs';

const now='2026-10-27T08:30:00.000Z';
const fixture={id:'fd-test',league:'SA',home:'US Sassuolo Calcio',away:'SS Lazio',kickoff:'2026-10-27T17:30:00.000Z',status:'TIMED',source:'football-data'};
function schedule(changes={}){
  const row=Array(69).fill('');Object.assign(row,{0:'310001',2:'意甲',5:'萨索洛',8:'拉齐奥',11:'01:30',13:'0',36:'10-28',43:'2026'},changes);
  return `A[1]=${JSON.stringify(row.join('^'))}.split('^');`;
}
function market(changes={}){
  const row=Array(52).fill('');Object.assign(row,{0:'310001',1:'1788000',2:'-0.25',3:'0.87',4:'0.95',13:'1',14:'0'},changes);
  return `<m>${row.join(',')}</m>`;
}
function sourceMock({sched=schedule(),rows=market(),maintenance='0',updated='Tue, 27 Oct 2026 08:29:55 GMT',date='Tue, 27 Oct 2026 08:30:00 GMT',byCompany={}}={}){
  const calls=[];
  return {calls,fetchImpl:async(url,options)=>{
    calls.push({url,options});const path=new URL(url).pathname,isSchedule=path.endsWith('.js'),companyId=Number(path.match(/goal(\d+)\.xml/)?.[1]);
    const override=byCompany[companyId]||{};
    return new Response(isSchedule?sched:`<c><match>${override.rows??rows}</match><isMaintain>${override.maintenance??maintenance}</isMaintain></c>`,{
      status:override.status??200,headers:{Date:override.date??date,'Last-Modified':override.updated??updated}});
  }};
}
async function read(options={},input={}){const mock=sourceMock(options);return {result:await fetchMarketSourceAudit({fixtures:[fixture],fetchImpl:mock.fetchImpl,nowISO:now,...input}),calls:mock.calls};}

test('three separately attributed real bookmaker feeds share one strict schedule request',async()=>{
  const {result,calls}=await read();assert.equal(calls.length,4);assert.equal(result.quotes.length,3);
  assert.deepEqual(result.quotes.map(item=>[item.fixtureId,item.quote.sourceId,item.quote.bookmaker,item.quote.companyId]),[
    ['fd-test','m88','M88',17],['fd-test','12bet','12Bet',24],['fd-test','sbobet','SBOBET',31]]);
  assert.deepEqual(result.quotes[0].quote.quotes.map(q=>[q.selection,q.handicap,q.decimalOdds]),[['home',.25,1.87],['away',-.25,1.95]]);
  for(const {url,options} of calls){assert.equal(new URL(url).hostname,'livestatic.titan007.com');assert.equal(options.redirect,'manual');assert.equal(options.method,'GET');assert.ok(options.signal instanceof AbortSignal);}
  for(const source of result.sources.slice(0,3)){assert.equal(source.status,'available');assert.equal(source.matchedCount,1);assert.equal(source.parsedCount,1);assert.equal(source.httpStatus,200);assert.equal(source.evidence.length,3);}
  assert.ok(result.quotes.every(item=>isMarketQuoteCurrent(item.quote,fixture,now)));
  assert.equal(result.fixtureDiagnostics.length,3);
  for(const diagnostic of result.fixtureDiagnostics){
    assert.equal(diagnostic.fixtureId,fixture.id);assert.equal(diagnostic.sourceId,'titan007');assert.equal(diagnostic.note,'matched');
    assert.equal(diagnostic.code,'matched');assert.equal(diagnostic.status,'available');assert.equal(diagnostic.matchedCount,1);
    assert.equal(diagnostic.scheduleCandidateCount,1);assert.equal(diagnostic.marketRowCount,1);
    assert.equal(diagnostic.sourceUpdatedAt,'2026-10-27T08:29:55.000Z');assert.equal(diagnostic.scheduleUpdatedAt,'2026-10-27T08:29:55.000Z');
  }
  for(const source of result.sources.slice(0,3)){
    assert.equal(source.requestedFixtureCount,1);assert.equal(source.eligibleFixtureCount,1);assert.equal(source.unmatchedFixtureCount,0);
    assert.equal(source.scheduleParsedCount,1);assert.equal(source.scheduleCoverageFrom,fixture.kickoff);assert.equal(source.scheduleCoverageTo,fixture.kickoff);
  }
});

test('different bookmaker prices remain different and zero handicap has no negative zero',async()=>{
  const {result}=await read({byCompany:{24:{rows:market({2:'0',3:'0.8',4:'1.02'})},31:{rows:market({2:'0.5',3:'0.91',4:'0.97'})}}});
  assert.deepEqual(result.quotes.map(item=>item.quote.quotes.map(q=>[q.handicap,q.decimalOdds])),[
    [[.25,1.87],[-.25,1.95]],[[0,1.8],[0,2.02]],[[-.5,1.91],[.5,1.97]]]);
  assert.ok(result.quotes[1].quote.quotes.every(q=>!Object.is(q.handicap,-0)));
});

test('one provider event cannot be assigned to two local fixture identities',async()=>{
  const {result}=await read({}, {fixtures:[fixture,{...fixture,id:'other-provider-fixture',source:'api-football'}]});
  assert.equal(result.quotes.length,0);
  assert.equal(result.marketStates.length,6);
  assert.ok(result.fixtureDiagnostics.every(d=>d.code==='fixture_identity_ambiguous'));
  assert.ok(result.marketStates.every(s=>s.providerMatchId==='310001'&&s.marketState==='unavailable'));
});

test('a fresh incomplete provider snapshot retains an explicit negative market state',async()=>{
  const {result}=await read({rows:market({4:''})});
  assert.equal(result.quotes.length,0);
  assert.equal(result.marketStates.length,3);
  assert.ok(result.marketStates.every(s=>s.marketState==='unavailable'&&s.stateReason==='incomplete_market'
    &&s.sourceId==='titan007'&&s.providerMatchId==='310001'&&s.sourceUpdatedAt==='2026-10-27T08:29:55.000Z'));
  assert.ok(result.marketStates.every(s=>!Object.hasOwn(s,'decimalOdds')&&!Object.hasOwn(s,'opening')));
});

test('HTTP 200 without strict fixture identity is not reported connected',async()=>{
  for(const changes of [{2:'意乙'},{5:'尤文图斯'},{5:'拉齐奥',8:'萨索洛'},{11:'02:00'},{36:'10-29'},{36:'02-30'},{13:'1'}]){
    const {result}=await read({sched:schedule(changes)});assert.equal(result.quotes.length,0);
    assert.ok(result.sources.slice(0,3).every(source=>source.status==='pending'&&source.note==='no_fixture_match'&&source.parsedCount===1));
  }
  assert.equal((await read({sched:schedule()+schedule()})).result.quotes.length,0);
});

test('partial source failures preserve usable independent bookmaker comparisons without retries',async()=>{
  const {result,calls}=await read({byCompany:{17:{status:403},24:{status:429}}});assert.equal(calls.length,4);
  assert.equal(result.quotes.length,1);assert.equal(result.quotes[0].quote.sourceId,'sbobet');
  assert.equal(result.sources[0].note,'access_denied');assert.equal(result.sources[0].httpStatus,403);
  assert.equal(result.sources[1].note,'rate_limited');assert.equal(result.sources[1].httpStatus,429);
});

test('closed, live, invalid and ambiguous rows never generate usable odds',async()=>{
  for(const rows of [market({13:'2'}),market({14:'1'}),market({2:'0.1'}),market({3:'0'}),market({4:'NaN'}),market()+market()]){
    assert.equal((await read({rows})).result.quotes.length,0);
  }
  const maintained=await read({byCompany:{17:{maintenance:'1'}}});assert.equal(maintained.result.sources[0].note,'maintenance');assert.equal(maintained.result.quotes.length,2);
});

test('stale prices, missing timestamps and unsafe XML fail closed',async()=>{
  for(const updated of ['Tue, 27 Oct 2026 08:24:59 GMT','Tue, 27 Oct 2026 08:35:00 GMT','invalid']){
    const {result}=await read({updated});assert.equal(result.quotes.length,0);assert.ok(result.sources.slice(0,3).every(s=>s.note==='stale_snapshot'));
  }
  const mock=sourceMock();const result=await fetchMarketSourceAudit({fixtures:[fixture],nowISO:now,fetchImpl:async(url,options)=>{
    if(url.includes('goal17'))return new Response('<!DOCTYPE c [<!ENTITY x "injected">]><c><match></match><isMaintain>0</isMaintain></c>',{headers:{Date:new Date(now).toUTCString(),'Last-Modified':new Date(now).toUTCString()}});
    return mock.fetchImpl(url,options);
  }});
  assert.equal(result.sources[0].note,'invalid_snapshot');assert.equal(result.quotes.length,2);
});

test('executable schedule contents are never executed',async()=>{
  const {result}=await read({sched:'throw new Error("do not execute");'});assert.equal(result.quotes.length,0);
  assert.ok(result.sources.slice(0,3).every(s=>s.note==='invalid_schedule'));
});

test('cached quote helper rejects expiry, wrong fixture, source forgery and mutated metadata',async()=>{
  const quote=(await read()).result.quotes[0].quote;
  assert.equal(isMarketQuoteCurrent(quote,fixture,'2026-10-27T08:34:54.000Z'),true);
  assert.equal(isMarketQuoteCurrent(quote,fixture,'2026-10-27T08:34:55.000Z'),false);
  for(const changes of [{companyId:3},{bookmaker:'Crown'},{sourceId:'singbet'},{provider:'manual'},{maintenance:true},{closed:true},{inPlay:true},{sourceUrl:'https://example.com/'},
    {observedAt:'2026-10-27T09:00:00.000Z'},{sourceUpdatedAt:'2026-10-27T08:00:00.000Z'},{validUntil:'invalid'}])assert.equal(isMarketQuoteCurrent({...quote,...changes},fixture,now),false);
  assert.equal(isMarketQuoteCurrent(quote,{...fixture,home:'Juventus FC'},now),false);
  assert.equal(isMarketQuoteCurrent({...quote,quotes:quote.quotes.map(q=>({...q,companyId:3}))},fixture,now),false);
});

test('invalid, started or demo fixtures cause no provider requests',async()=>{
  for(const invalid of [{...fixture,demo:true},{...fixture,status:'IN_PLAY'},{...fixture,kickoff:now},{...fixture,league:'EL'}]){
    const {result,calls}=await read({}, {fixtures:[invalid]});assert.equal(calls.length,0);assert.equal(result.quotes.length,0);
    assert.ok(result.sources.slice(0,3).every(s=>s.note==='no_eligible_fixtures'));
  }
});

test('Singbet and IBC state the actual authorization blocker without fabricating live probes or prices',async()=>{
  const {result,calls}=await read();assert.equal(calls.length,4);
  for(const source of result.sources.slice(3)){assert.equal(source.status,'unavailable');assert.equal(source.note,'authorization_required');assert.equal(source.checkType,'configuration');assert.equal(source.httpStatus,undefined);assert.equal(source.matchedCount,0);assert.match(source.reason,/AOToken/);}
  assert.deepEqual(marketSourceRegistry.map(s=>s.companyId),[17,24,31]);
});

test('per-fixture diagnostics distinguish absent and ambiguous identities from non-prematch events',async()=>{
  const cases=[
    {sched:schedule({2:'意乙'}),note:'fixture_identity_unmatched',leagueCount:0,teamCount:0,candidateCount:0},
    {sched:schedule({5:'尤文图斯'}),note:'fixture_identity_unmatched',leagueCount:1,teamCount:0,candidateCount:0},
    {sched:schedule({11:'02:00'}),note:'fixture_identity_unmatched',leagueCount:1,teamCount:1,candidateCount:0},
    {sched:schedule()+schedule(),note:'fixture_identity_ambiguous',leagueCount:2,teamCount:2,candidateCount:2},
    {sched:schedule({13:'1'}),note:'not_prematch',leagueCount:1,teamCount:1,candidateCount:1},
  ];
  for(const expected of cases){
    const {result}=await read({sched:expected.sched});assert.equal(result.quotes.length,0);assert.equal(result.fixtureDiagnostics.length,3);
    for(const diagnostic of result.fixtureDiagnostics){
      assert.equal(diagnostic.note,expected.note);assert.equal(diagnostic.status,'pending');assert.equal(diagnostic.matchedCount,0);
      assert.equal(diagnostic.leagueCandidateCount,expected.leagueCount);assert.equal(diagnostic.teamCandidateCount,expected.teamCount);
      assert.equal(diagnostic.scheduleCandidateCount,expected.candidateCount);assert.equal(diagnostic.marketRowCount,0);
    }
  }
});

test('API-Football team aliases match a same-day schedule while preserving the original fixture identity',async()=>{
  const input={...fixture,league:'FL1',home:'Le Havre',away:'Paris Saint Germain'};
  const {result}=await read({sched:schedule({2:'法甲',5:'勒阿弗尔',8:'巴黎圣日尔曼'})},{fixtures:[input]});
  assert.equal(result.quotes.length,3);assert.ok(result.fixtureDiagnostics.every(d=>d.note==='matched'));
  for(const {quote} of result.quotes){
    assert.equal(quote.fixtureSnapshot.home,input.home);assert.equal(quote.fixtureSnapshot.away,input.away);
    assert.equal(isMarketQuoteCurrent(quote,input,now),true);
  }
});

test('missing, ambiguous, one-sided and illegal market rows retain their actual rejection cause',async()=>{
  const cases=[
    {rows:'',note:'market_not_published',count:0},
    {rows:market()+market(),note:'market_ambiguous',count:2},
    {rows:market({3:''}),note:'incomplete_market',count:1},
    {rows:market({4:''}),note:'incomplete_market',count:1},
    {rows:market({2:'0.1'}),note:'invalid_market_fields',count:1},
    {rows:market({3:'NaN'}),note:'invalid_market_fields',count:1},
    {rows:market({14:'1'}),note:'invalid_market_fields',count:1},
  ];
  for(const expected of cases){
    const {result}=await read({rows:expected.rows});assert.equal(result.quotes.length,0);
    for(const diagnostic of result.fixtureDiagnostics){
      assert.equal(diagnostic.note,expected.note);assert.equal(diagnostic.scheduleCandidateCount,1);
      assert.equal(diagnostic.marketRowCount,expected.count);assert.equal(diagnostic.matchedCount,0);
    }
  }
});

test('stale source failures and exact-boundary expired quotes are attributed per fixture and bookmaker',async()=>{
  const {result}=await read({byCompany:{17:{updated:'Tue, 27 Oct 2026 08:24:59 GMT'},24:{updated:'Tue, 27 Oct 2026 08:25:00 GMT'}}});
  assert.deepEqual(result.quotes.map(item=>item.quote.sourceId),['sbobet']);
  assert.deepEqual(result.fixtureDiagnostics.map(d=>[d.id,d.note,d.status]),[
    ['m88','stale_snapshot','unavailable'],['12bet','quote_expired','pending'],['sbobet','matched','available']]);
  assert.ok(result.fixtureDiagnostics.every(d=>d.fixtureId===fixture.id&&d.scheduleUpdatedAt==='2026-10-27T08:29:55.000Z'));
  assert.equal(result.fixtureDiagnostics[0].marketRowCount,null,'a failed fetch has no verified row count');
  assert.equal(result.fixtureDiagnostics[1].marketRowCount,1);
  assert.deepEqual(result.sources.slice(0,3).map(source=>source.unmatchedFixtureCount),[1,1,0]);
});

test('schedule failures propagate to every eligible fixture while ineligible inputs make no matching claim',async()=>{
  const ineligible={...fixture,id:'started',status:'IN_PLAY'};
  const {result}=await read({sched:'not a schedule'},{fixtures:[fixture,ineligible]});
  assert.equal(result.fixtureDiagnostics.length,6);
  assert.ok(result.fixtureDiagnostics.filter(d=>d.fixtureId===fixture.id).every(d=>d.note==='invalid_schedule'&&d.status==='unavailable'));
  assert.ok(result.fixtureDiagnostics.filter(d=>d.fixtureId===ineligible.id).every(d=>d.note==='fixture_ineligible'&&d.status==='pending'));
  for(const source of result.sources.slice(0,3)){
    assert.equal(source.scheduleParsedCount,0);assert.equal(source.scheduleCoverageFrom,null);assert.equal(source.scheduleCoverageTo,null);
    assert.equal(source.requestedFixtureCount,2);assert.equal(source.eligibleFixtureCount,1);
  }
  const empty=await read({}, {fixtures:[ineligible]});assert.equal(empty.calls.length,0);
  assert.equal(empty.result.fixtureDiagnostics.length,3);assert.ok(empty.result.fixtureDiagnostics.every(d=>d.note==='fixture_ineligible'));
});
