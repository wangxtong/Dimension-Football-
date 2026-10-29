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
});

test('different bookmaker prices remain different and zero handicap has no negative zero',async()=>{
  const {result}=await read({byCompany:{24:{rows:market({2:'0',3:'0.8',4:'1.02'})},31:{rows:market({2:'0.5',3:'0.91',4:'0.97'})}}});
  assert.deepEqual(result.quotes.map(item=>item.quote.quotes.map(q=>[q.handicap,q.decimalOdds])),[
    [[.25,1.87],[-.25,1.95]],[[0,1.8],[0,2.02]],[[-.5,1.91],[.5,1.97]]]);
  assert.ok(result.quotes[1].quote.quotes.every(q=>!Object.is(q.handicap,-0)));
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
