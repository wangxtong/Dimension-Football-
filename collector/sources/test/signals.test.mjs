import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchPredictionSignals,parseStatareaSignals} from '../signals.mjs';

const nowISO='2026-10-27T07:30:00.000Z';
const fixture={id:'fd-1',league:'SA',home:'AS Roma',away:'Cagliari Calcio',kickoff:'2026-10-27T19:45:00.000Z',source:'football-data.org',status:'TIMED'};
function match({home='Roma',away='Cagliari',date='2026-10-27',time='19:45',tip='1',probabilities=[65,22,13],goals='-'}={}) {
  const url=`https://www.statarea.com/compare/teams/${home} (Italy)/${away} (Italy)`;
  return `<div class='match' id='1755279'><div class='matchrow'><div class='tip'><div class='ownheader'>TIP</div><div class='value'><div class='type1'>${tip}</div></div></div><div class='teams'><div class='ownheader'><div class='marker'>&nbsp;</div>${date} ${time}</div><div class='hostteam'><div class='goals'>${goals}</div><div class='name'><a href='${url}'>${home}</a></div></div><div class='guestteam'><div class='goals'>-</div><div class='name'><a href='${url}'>${away}</a></div></div></div></div><div class='inforow'><div class='coefrow'><div class='ownheader'><div class='coefbox'>1</div><div class='coefbox'>X</div><div class='coefbox'>2</div></div>${probabilities.map(p=>`<div class='coefbox'><div class='value r${p}'>${p}</div></div>`).join('')}</div><div class='userrow'><div class='value'>99</div></div></div></div>`;
}
function page(matches=match(),league='ITALY - SERIE A',zone='GMT 0') {
  return `<meta name="pubdate" content="2026-10-27"><div class='gmt'>${zone}</div><div class='competition' id='017282'><div class='header'><div class='name'>${league}</div></div><div class='body'>${matches}</div></div>`;
}
function publicFetch(html=page(),date=nowISO) {
  return async url=>url.includes('statarea.com')?new Response(html,{headers:{date:new Date(date).toUTCString(),'content-type':'text/html'}}):new Response('Denied',{status:403});
}
test('parses actual Statarea pregame class structure and only model probabilities',()=>{
  const rows=parseStatareaSignals(page());
  assert.equal(rows.length,1);
  assert.equal(rows[0].probability,.65);
  assert.equal(rows[0].selection,'home');
  assert.equal(rows[0].kickoff,fixture.kickoff);
  assert.equal(rows[0].league,'SA');
});
test('emits provenance and expiry only after exact two-team league/time fixture matching',async()=>{
  const result=await fetchPredictionSignals({fixtures:[fixture],fetchImpl:publicFetch(),nowISO});
  assert.equal(result.signals.length,1);
  const signal=result.signals[0];
  assert.deepEqual(signal.fixtureSnapshot,{id:fixture.id,home:fixture.home,away:fixture.away,kickoff:fixture.kickoff,league:fixture.league,source:fixture.source});
  assert.equal(signal.market,'1x2');
  assert.equal(signal.sourceId,'statarea');
  assert.equal(signal.verified,true);
  assert.equal(signal.verificationMethod,'automatic');
  assert.equal(signal.validUntil,'2026-10-27T13:30:00.000Z');
  assert.ok(signal.evidenceUrl.startsWith('https://www.statarea.com/compare/teams/'));
  assert.equal(result.sources.find(s=>s.id==='forebet').status,'restricted');
  assert.equal(result.sources.find(s=>s.id==='statarea').httpStatus,200);
  assert.equal(result.sources.find(s=>s.id==='statarea').parsedCount,1);
  assert.equal(result.sources.find(s=>s.id==='statarea').matchedCount,1);
});
test('rejects reversed teams, league mismatch, kickoff mismatch, demos and non-upcoming local fixtures',async()=>{
  const fixtures=[{...fixture,id:'reverse',home:fixture.away,away:fixture.home},{...fixture,id:'league',league:'PL'},
    {...fixture,id:'time',kickoff:'2026-10-27T19:51:00Z'},{...fixture,id:'demo',demo:true},
    {...fixture,id:'finished',status:'FINISHED'},{...fixture,id:'past',kickoff:'2026-10-27T01:00:00Z'}];
  const result=await fetchPredictionSignals({fixtures,fetchImpl:publicFetch(),nowISO});
  assert.equal(result.signals.length,0);
});
test('rejects ambiguous identical provider matches rather than picking first',async()=>{
  const result=await fetchPredictionSignals({fixtures:[fixture],fetchImpl:publicFetch(page(match()+match())),nowISO});
  assert.equal(result.signals.length,0);
});
test('one prediction row cannot support multiple local fixture identities',async()=>{
  const result=await fetchPredictionSignals({fixtures:[fixture,{...fixture,id:'af-same-event',source:'api-football'}],fetchImpl:publicFetch(),nowISO});
  assert.equal(result.signals.length,0);
});
test('uses an explicit provider GMT offset and rejects unknown or ambiguous zones',()=>{
  const rows=parseStatareaSignals(page(match(),'ITALY - SERIE A','GMT +1'));
  assert.equal(rows[0].kickoff,'2026-10-27T18:45:00.000Z');
  assert.equal(parseStatareaSignals(page(match(),'ITALY - SERIE A','GMT -5'))[0].kickoff,'2026-10-28T00:45:00.000Z');
  assert.deepEqual(parseStatareaSignals(page(match(),'ITALY - SERIE A','Europe/London')),[]);
  assert.deepEqual(parseStatareaSignals(page(match(),'ITALY - SERIE A','GMT +15')),[]);
  assert.deepEqual(parseStatareaSignals(page()+`<div class='gmt'>GMT +1</div>`),[]);
});

test('rejects wrong page date, invalid calendar and in-play/result rows',()=>{
  assert.deepEqual(parseStatareaSignals(page(match({date:'2026-10-28'}))),[]);
  assert.deepEqual(parseStatareaSignals(page(match({date:'2026-02-30'})).replace('content="2026-10-27"','content="2026-02-30"')),[]);
  assert.deepEqual(parseStatareaSignals(page(match({goals:'1'}))),[]);
  assert.deepEqual(parseStatareaSignals(page(match({probabilities:[70,30,30]}))),[]);
});
test('fresh prices or reachable core source alone never creates core prediction consensus',async()=>{
  const fetchImpl=async url=>new Response(url.includes('statarea.com')?page():page(),{headers:{date:new Date(nowISO).toUTCString()}});
  const result=await fetchPredictionSignals({fixtures:[fixture],fetchImpl,nowISO});
  assert.equal(result.signals.length,1);
  assert.equal(result.sources.find(s=>s.id==='forebet').status,'restricted');
  assert.equal(result.sources.find(s=>s.id==='footymetrics').status,'restricted');
});
test('rejects stale HTTP dates, failed access and oversized public responses safely',async()=>{
  const stale=await fetchPredictionSignals({fixtures:[fixture],fetchImpl:publicFetch(page(),'2026-10-26T00:00:00Z'),nowISO});
  assert.equal(stale.signals.length,0);
  assert.equal(stale.sources.find(s=>s.id==='statarea').note,'stale_response');
  const tooBig=await fetchPredictionSignals({fixtures:[fixture],fetchImpl:async()=>new Response('x',{headers:{date:new Date(nowISO).toUTCString(),'content-length':'1500001'}}),nowISO});
  assert.equal(tooBig.signals.length,0);
  assert.ok(tooBig.sources.filter(s=>!s.restriction).every(s=>s.note==='oversized_response'));
});
test('invalid observation time fails before upstream access',async()=>{
  await assert.rejects(()=>fetchPredictionSignals({fixtures:[fixture],nowISO:'invalid',fetchImpl:()=>{throw new Error('must not fetch');}}),/Invalid signal/);
});
test('restricted sources are never automatically fetched or counted as consensus',async()=>{
  const requested=[];
  const fetchImpl=async url=>{requested.push(url);return new Response(page(),{headers:{date:new Date(nowISO).toUTCString()}});};
  const result=await fetchPredictionSignals({fixtures:[fixture],fetchImpl,nowISO});
  for(const id of ['footymetrics','forebet','tactix','golsinyali','fotmob']) {
    const source=result.sources.find(s=>s.id===id);
    assert.equal(requested.some(url=>new URL(url).hostname===new URL(source.url).hostname),false);
    assert.equal(source.note,'authorization_required');
    assert.equal(source.status,'restricted');
    assert.equal(source.fetchedAt,null);
    assert.equal(source.httpStatus,null);
    assert.ok(source.termsUrl.startsWith('https://'));
  }
  assert.deepEqual(result.signals.map(s=>s.sourceId),['statarea']);
});

test('free-list monitor uses only documented free upcoming filter and reports actual empty response',async()=>{
  const requests=[];
  const fetchImpl=async (url,request)=>{
    requests.push({url,request});
    return new Response(url.includes('ttyingqiu.com')?JSON.stringify({isSuccess:true,hasNext:false}):page(),{headers:{date:new Date(nowISO).toUTCString()}});
  };
  const result=await fetchPredictionSignals({fixtures:[fixture],fetchImpl,nowISO});
  const request=requests.find(r=>r.url.includes('ttyingqiu.com'));
  assert.equal(request.url,'https://www.ttyingqiu.com/query/hall/jdList');
  assert.equal(request.request.method,'POST');
  const params=new URLSearchParams(request.request.body);
  assert.equal(params.get('amountMode'),'3');
  assert.equal(params.get('raceStatus'),'0');
  const source=result.sources.find(s=>s.id==='tiantian');
  assert.equal(source.status,'pending');
  assert.equal(source.note,'no_free_prematch_signals');
  assert.equal(source.httpStatus,200);
  assert.equal(source.parsedCount,0);
  assert.equal(source.matchedCount,0);
  assert.equal(source.fetchedAt,nowISO);
  assert.equal(result.signals.some(s=>s.sourceId==='tiantian'),false);
});

test('nonempty free list remains unverified until its actual pick format is verified',async()=>{
  const result=await fetchPredictionSignals({fixtures:[fixture],nowISO,fetchImpl:async url=>new Response(url.includes('ttyingqiu.com')
    ?JSON.stringify({isSuccess:true,data:[{title:'Roma winner',price:0}]}):page(),{headers:{date:new Date(nowISO).toUTCString()}})});
  const source=result.sources.find(s=>s.id==='tiantian');
  assert.equal(source.note,'prediction_format_not_verified');
  assert.equal(source.parsedCount,1);
  assert.equal(source.matchedCount,0);
  assert.equal(result.signals.some(s=>s.sourceId==='tiantian'),false);
});

test('date pages use their explicit forecast day while publication date proves refresh day',async()=>{
  const next={...fixture,id:'tomorrow',kickoff:'2026-10-28T19:45:00.000Z'};
  const later={...fixture,id:'far',kickoff:'2026-10-31T19:45:00.000Z'};
  const requests=[];
  const fetchImpl=async url=>{
    requests.push(url);
    const tomorrow=url.includes('/date/2026-10-28/');
    const html=tomorrow?`<h1>Match predictions, statistics and tips for 2026-10-28</h1>${page(match({date:'2026-10-28'}))}`:page();
    return new Response(url.includes('ttyingqiu.com')?JSON.stringify({isSuccess:true}):html,{headers:{date:new Date(nowISO).toUTCString()}});
  };
  const result=await fetchPredictionSignals({fixtures:[fixture,next,later],fetchImpl,nowISO});
  assert.deepEqual(result.signals.map(s=>s.fixtureId),[fixture.id,next.id]);
  assert.ok(requests.includes('https://www.statarea.com/predictions/date/2026-10-28/competition'));
  assert.equal(requests.some(url=>url.includes('2026-10-31')),false);
  assert.equal(result.sources.find(s=>s.id==='statarea').requests.length,2);
});

test('a stale source publication day and a mismatched forecast-day header are not refreshed by fresh HTTP date',async()=>{
  const stale=page().replace('content="2026-10-27"','content="2026-10-26"');
  const staleResult=await fetchPredictionSignals({fixtures:[fixture],fetchImpl:publicFetch(stale),nowISO});
  assert.equal(staleResult.sources.find(s=>s.id==='statarea').note,'stale_page');
  assert.equal(staleResult.signals.length,0);
  const next={...fixture,id:'tomorrow',kickoff:'2026-10-28T19:45:00.000Z'};
  const mismatch=await fetchPredictionSignals({fixtures:[next],fetchImpl:publicFetch(),nowISO});
  assert.equal(mismatch.signals.length,0);
  assert.equal(mismatch.sources.find(s=>s.id==='statarea').requests[1].code,'stale_page');
});

test('a reachable parsed page with no matching fixture is pending rather than connected',async()=>{
  const result=await fetchPredictionSignals({fixtures:[{...fixture,home:'Other Team'}],fetchImpl:publicFetch(),nowISO});
  const source=result.sources.find(s=>s.id==='statarea');
  assert.equal(source.parsedCount,1);
  assert.equal(source.matchedCount,0);
  assert.equal(source.status,'pending');
});
