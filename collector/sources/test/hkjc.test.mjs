import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHkjc, hkjcHandicap, fetchHkjcEvidence, HKJC_ENDPOINT } from '../hkjc.mjs';
import { validQuote, DEFAULT_POLICY } from '../../policy.mjs';
import { marketReadiness } from '../../market-evidence.mjs';

const NOW = '2026-10-31T05:30:00.000Z';
const fixture = { id:'fixture-1', league:'BL1', home:'Bayer 04 Leverkusen', away:'VfB Stuttgart', kickoff:'2026-10-31T14:30:00.000Z', source:'test', status:'SCHEDULED', updatedAt:NOW };
const event = () => ({ id:'50001', status:'PREEVENT', kickOffTime:'2026-10-31T22:30:00+08:00', homeTeam:{id:'11',name_en:'Leverkusen'}, awayTeam:{id:'22',name_en:'Stuttgart'},
  tournament:{code:'GSL',name_en:'German Division 1'}, foPools:[{id:'20001',oddsType:'HDC',instNo:0,inplay:false,status:'SELLINGSTARTED',updateAt:'2026-10-30T08:25:00+08:00',
    lines:[{lineId:'1',condition:'-0.5/-1.0',main:true,status:'AVAILABLE',combinations:[{str:'H',status:'AVAILABLE',currentOdds:'1.88'},{str:'A',status:'AVAILABLE',currentOdds:'1.92'}]}]}] });
const parse = (events=[event()], extra={}) => parseHkjc({data:{matches:events}},{fixtures:[fixture],observedAt:NOW,sourceAsOf:NOW,cacheMaxAgeSeconds:29,...extra});

test('HKJC HDC parses signed split lines, matches identity, and preserves provider time separately', () => {
  const r=parse(), [home,away]=r.quotes;
  assert.equal(r.quotes.length,2);assert.equal(home.handicap,-.75);assert.equal(away.handicap,.75);assert.equal(home.decimalOdds,1.88);
  assert.equal(home.providerPoolUpdatedAt,'2026-10-30T00:25:00.000Z');assert.equal(home.sourceAsOf,NOW);
  assert.ok(validQuote(home,fixture,Date.parse(NOW),DEFAULT_POLICY));assert.ok(!home.opening);
  assert.deepEqual(marketReadiness(fixture,r.quotes,NOW).quoteGroups,['hkjc-first-party']);
  assert.equal(r.diagnostics[0].status,'partial');
});
test('HKJC handicap parser accepts whole, half and valid split lines without inventing signs', () => {
  for(const [s,n] of [['0',0],['+0.5',.5],['0.0/+0.5',.25],['+1/+1.5',1.25],['-1/-1.5',-1.25]])assert.equal(hkjcHandicap(s),n);
  for(const s of ['','null','-0.25','-0.5/+0.5','0/1','1/1','1/1.5/2','1abc','NaN'])assert.equal(hkjcHandicap(s),null);
});
test('live snapshot verification rejects expired/future timestamps, bad cache proof and imported assertions', () => {
  const q=parse().quotes[0];
  for(const change of [{sourceAsOf:'2026-10-31T05:24:59Z'},{sourceAsOf:'2026-10-31T05:30:01Z'},{cacheMaxAgeSeconds:3600},
    {verificationMethod:'owner-verified'},{freshnessBasis:'first-seen'},{bookmaker:'Other'},{evidenceUrl:'https://bet.hkjc.com/en/football/had'}]) {
    assert.equal(validQuote({...q,...change},fixture,Date.parse(NOW),DEFAULT_POLICY),false);
  }
  assert.equal(validQuote(q,fixture,Date.parse(NOW)+300001,DEFAULT_POLICY),false);
});
test('ambiguity, wrong tournament, swapped teams and kickoff mismatch cannot produce quotes', () => {
  for(const change of [e=>({...e,tournament:{...e.tournament,code:'GD2'}}),e=>({...e,tournament:{...e.tournament,name_en:'Women German Division 1'}}),
    e=>({...e,homeTeam:e.awayTeam,awayTeam:e.homeTeam}),e=>({...e,kickOffTime:'2026-11-01T22:30:00+08:00'})])assert.equal(parse([change(event())]).quotes.length,0);
  assert.equal(parse([event(),{...event(),id:'50002'}]).quotes.length,0);
  assert.throws(()=>parse([event(),event()]));
  assert.equal(parse([event()],{fixtures:[fixture,{...fixture,id:'duplicate-match'}]}).quotes.length,0);
});
test('inplay, suspended, other periods/markets and incomplete sides are rejected', async t => {
  const mutations={inplay:e=>e.foPools[0].inplay=true, started:e=>e.status='INPLAY', closed:e=>e.foPools[0].status='SUSPENDED',
    half:e=>e.foPools[0].oddsType='FHH',threeWay:e=>e.foPools[0].oddsType='HHA', sideMissing:e=>e.foPools[0].lines[0].combinations.pop(),
    unavailable:e=>e.foPools[0].lines[0].combinations[0].status='SUSPENDED', badPrice:e=>e.foPools[0].lines[0].combinations[0].currentOdds='0.88',
    duplicateMain:e=>e.foPools[0].lines.push(structuredClone(e.foPools[0].lines[0])), futureUpdate:e=>e.foPools[0].updateAt='2027-01-01T00:00:00Z'};
  for(const [name,mutate] of Object.entries(mutations)) await t.test(name,()=>{const e=event();mutate(e);assert.equal(parse([e]).quotes.length,0);});
});
const response = (body={data:{matches:[event()]}},headers={}) => new Response(JSON.stringify(body),{headers:{Date:new Date(NOW).toUTCString(),'Content-Type':'application/json','Cache-Control':'public, max-age=29',...headers}});
test('public transport sends one fixed readonly HDC request, required JSON header, and no credentials', async () => {
  let calls=0;
  const r=await fetchHkjcEvidence({fixtures:[fixture],nowISO:NOW,clock:()=>NOW,fetchImpl:async(url,init)=>{
    calls++;const u=new URL(url);assert.equal(u.origin+u.pathname,HKJC_ENDPOINT);assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
    assert.equal(init.headers['Content-Type'],'application/json');assert.ok(!init.headers.Authorization&&!init.headers.Cookie);
    assert.ok(u.searchParams.get('query').startsWith('query matchList('));assert.ok(!u.searchParams.get('query').includes('\n'));
    const vars=JSON.parse(u.searchParams.get('variables'));assert.deepEqual(vars.fbOddsTypes,['HDC']);assert.equal(vars.startDate,null);
    return response();
  }});
  assert.equal(calls,1);assert.equal(r.quotes.length,2);
});
test('bad cache age, old server response, errors, challenge pages and authorization never become usable prices', async () => {
  for(const get of [()=>response(undefined,{Age:'90'}),()=>response(undefined,{'Cache-Control':'public, max-age=3600'}),
    ()=>response(undefined,{Date:'Sat, 31 Oct 2026 05:28:59 GMT'}),()=>response({errors:[{message:'WHITELIST_ERROR'}],data:{matches:null}}),
    ()=>new Response('<html>challenge</html>',{headers:{'Content-Type':'text/html'}}),()=>new Response('blocked',{status:403})]) {
    const r=await fetchHkjcEvidence({fixtures:[fixture],nowISO:NOW,clock:()=>NOW,fetchImpl:async()=>get()});assert.equal(r.quotes.length,0);assert.equal(r.diagnostics[0].status,'unavailable');
  }
});
test('budget, hanging transport and cancellation are bounded and diagnostics redact thrown text', async () => {
  let calls=0;
  const empty=await fetchHkjcEvidence({fixtures:[fixture],nowISO:NOW,remaining:()=>0,fetchImpl:async()=>{calls++;}});assert.equal(calls,0);assert.equal(empty.quotes.length,0);
  const timeout=await fetchHkjcEvidence({fixtures:[fixture],nowISO:NOW,remaining:()=>10,fetchImpl:async()=>new Promise(()=>{})});assert.equal(timeout.diagnostics[0].code,'timeout');
  const r=await fetchHkjcEvidence({fixtures:[fixture],nowISO:NOW,fetchImpl:async()=>{throw Error('secret-marker');}});assert.ok(!JSON.stringify(r).includes('secret-marker'));
});
