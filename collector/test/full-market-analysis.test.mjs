import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeFullMarketSnapshot} from '../full-market-analysis.mjs';

const NOW='2026-10-30T08:00:00.000Z';
const UPDATE='2026-10-30T07:59:00+00:00';
const at=offset=>new Date(Date.parse(NOW)+offset).toISOString();
const fixture={id:'af-123',league:'PL',home:'Home FC',away:'Away FC',kickoff:'2026-10-31T15:00:00.000Z',status:'SCHEDULED',source:'api-football'};
const winner=(prices=['1.85','3.80','4.50'])=>({id:1,name:'Match Winner',values:['Home','Draw','Away'].map((value,index)=>({value,odd:prices[index]}))});
const goals=(prices=['1.85','2.00'])=>({id:5,name:'Goals Over/Under',values:[{value:'Over 2.5',odd:prices[0]},{value:'Under 2.5',odd:prices[1]}]});
const company=(id,bets=[winner(),goals()],name=`Company ${id}`)=>({id,name,bets});
function page(bookmakers=[company(1),company(2),company(3)],changes={}){
  const {update=UPDATE,paging={current:1,total:1},responseChanges={},...pageChanges}=changes;
  return {url:'https://v3.football.api-sports.io/odds?fixture=123',fetchedAt:NOW,httpDate:new Date(NOW).toUTCString(),
    data:{get:'odds',parameters:{fixture:'123'},errors:[],results:1,paging,response:[{
      fixture:{id:123,date:fixture.kickoff,timestamp:Date.parse(fixture.kickoff)/1000},league:{id:39},update,bookmakers,...responseChanges,
    }]},...pageChanges};
}
const snapshot=(pages=[page()])=>({provider:'API-Football',fetchedAt:NOW,fixtures:[{fixture,pages}]});
const analyze=input=>analyzeFullMarketSnapshot(input).fixtures[0];
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-12,`${a} != ${b}`);

test('all three dimensions are returned, and 1X2 and full-time goals continue when Asian handicap is absent',()=>{
  const result=analyze(snapshot()),{matchWinner,goalsOverUnder25,asianHandicap}=result.markets;
  assert.equal(matchWinner.selection,'home');assert.equal(goalsOverUnder25.selection,'over');
  assert.equal(matchWinner.decimalOdds,1.85);assert.equal(goalsOverUnder25.decimalOdds,1.85);
  assert.equal(matchWinner.companyCount,3);assert.equal(goalsOverUnder25.companyCount,3);
  assert.equal(matchWinner.researchStatus,'research_reference');assert.equal(goalsOverUnder25.researchStatus,'research_reference');
  assert.equal(asianHandicap.companyCount,0);assert.deepEqual(asianHandicap.blockers,['ASIAN_HANDICAP_NOT_PUBLISHED']);
  assert.equal(result.formalRecommendation.allowed,false);assert.equal(matchWinner.formalRecommendation.allowed,false);
  assert.ok(result.formalRecommendation.blockers.includes('EXISTING_FORMAL_POLICY_GATE_REQUIRED'));
  assert.ok(result.formalRecommendation.blockers.includes('SECOND_INDEPENDENT_SOURCE_NOT_IN_SNAPSHOT'));
  assert.equal(matchWinner.updatedAt,'2026-10-30T07:59:00.000Z');assert.equal(matchWinner.ageMs,60_000);
  assert.equal(matchWinner.companyEvidence[0].bookmakerId,1);assert.equal(matchWinner.companyEvidence[0].odds.home,1.85);
  near(Object.values(matchWinner.probabilities).reduce((sum,value)=>sum+value,0),1);
});

test('normalizes each complete company first, then renormalizes outcome medians and deterministically resolves a tie',()=>{
  const result=analyze(snapshot([page([
    company(1,[winner(['2','4','4'])]),company(2,[winner(['4','2','4'])]),company(3,[winner(['4','4','2'])]),
  ])])).markets.matchWinner;
  near(result.companyEvidence[0].probabilities.home,.5);near(result.companyEvidence[1].probabilities.draw,.5);
  for(const probability of Object.values(result.probabilities))near(probability,1/3);
  assert.equal(result.selection,'home');assert.equal(result.decimalOdds,4);
  assert.ok(result.blockers.includes('SELECTED_ODDS_OUTSIDE_1_65_TO_1_95'));
});

test('does not switch to a lower-probability selection to fit the permitted odds band',()=>{
  const result=analyze(snapshot([page([1,2,3].map(id=>company(id,[winner(['3.8','4.0','1.45'])])))])).markets.matchWinner;
  assert.equal(result.selection,'away');assert.equal(result.decimalOdds,1.45);
  assert.ok(result.blockers.includes('SELECTED_ODDS_OUTSIDE_1_65_TO_1_95'));
});

test('counts complete bookmakers once across pages and excludes Crown without altering the consensus',()=>{
  const companies=[company(1),company(2),company(3),company(4,[winner(['10','10','1.01']),goals(['1.01','10'])],'Crown 皇冠')];
  const result=analyze(snapshot([page(companies,{paging:{current:1,total:2}}),page(companies,{paging:{current:2,total:2}})]));
  for(const market of [result.markets.matchWinner,result.markets.goalsOverUnder25]){
    assert.equal(market.companyCount,3);assert.equal(market.decimalOdds,1.85);
    assert.ok(market.companyEvidence.every(row=>row.duplicateRecordCount===1));
    assert.ok(market.rejectedCompanies.some(row=>row.blockers.includes('CROWN_EXCLUDED')));
  }
});

test('never combines partial outcomes across companies, snapshots or different totals lines',()=>{
  const partialHome=winner();partialHome.values.pop();
  const partialAway=winner();partialAway.values=partialAway.values.slice(2);
  const overOnly=goals();overOnly.values.pop();
  const underOtherLine={id:5,values:[{value:'Under 3.5',odd:'1.85'}]};
  const result=analyze(snapshot([page([
    company(1,[partialHome,overOnly]),company(1,[partialAway,underOtherLine]),
    company(2,[winner(),underOtherLine]),company(3,[winner(),goals()]),
  ])]));
  assert.equal(result.markets.matchWinner.companyCount,2);
  assert.equal(result.markets.goalsOverUnder25.companyCount,1);
  assert.ok(result.markets.matchWinner.blockers.includes('FEWER_THAN_THREE_COMPLETE_COMPANIES'));
  assert.ok(result.markets.goalsOverUnder25.rejectedCompanies.some(row=>row.blockers.includes('INCOMPLETE_COMPANY_MARKET')));
});

test('one missing market cannot stop the other dimension and half-time bet 6 is never treated as bet 5',()=>{
  const result=analyze(snapshot([page([1,2,3].map(id=>company(id,[{...goals(),id:6},winner()]))) ]));
  assert.equal(result.markets.matchWinner.selection,'home');assert.equal(result.markets.matchWinner.companyCount,3);
  assert.equal(result.markets.goalsOverUnder25.selection,null);assert.equal(result.markets.goalsOverUnder25.companyCount,0);
  assert.ok(result.markets.goalsOverUnder25.rejectedCompanies.every(row=>row.blockers.includes('MARKET_NOT_PUBLISHED')));
});

test('research uses an explicit three-hour limit while the five-minute live limit remains separate',()=>{
  for(const [elapsed,researchStatus] of [[300_000,'research_reference'],[300_001,'research_reference'],[10_800_000,'research_reference'],[10_800_001,'stale_reference']]){
    const result=analyze(snapshot([page(undefined,{update:at(-elapsed)})])).markets.matchWinner;
    assert.equal(result.selection,'home');assert.equal(result.companyCount,3);assert.equal(result.ageMs,elapsed);
    assert.equal(result.researchStatus,researchStatus);assert.equal(result.researchMaxAgeMs,10_800_000);assert.equal(result.liveMaxAgeMs,300_000);
    assert.equal(result.blockers.includes('LIVE_SOURCE_STALE'),elapsed>300_000);
    assert.equal(result.blockers.includes('RESEARCH_SOURCE_STALE'),elapsed>10_800_000);
    assert.equal(result.formalRecommendation.allowed,false);
  }
});

test('invalid and future provider timestamps retain calculated references but never pass freshness checks',()=>{
  for(const [update,code] of [['invalid','SOURCE_TIMESTAMP_INVALID'],[at(1),'SOURCE_TIMESTAMP_FUTURE']]){
    const result=analyze(snapshot([page(undefined,{update})])).markets.goalsOverUnder25;
    assert.equal(result.selection,'over');assert.equal(result.companyCount,3);
    assert.ok(result.blockers.includes(code));assert.equal(result.researchStatus,'blocked_reference');assert.equal(result.formalRecommendation.allowed,false);
  }
});

test('ambiguous or duplicate outcome rows are rejected per company without hiding other blockers',()=>{
  const invalid=winner();invalid.values[0].odd='NaN';invalid.values.push({value:'Home',odd:'1.85'});
  const result=analyze(snapshot([page([company(1,[invalid,goals()]),company(2),company(3)])]));
  assert.equal(result.markets.matchWinner.companyCount,2);assert.equal(result.markets.goalsOverUnder25.companyCount,3);
  const excluded=result.markets.matchWinner.rejectedCompanies.find(row=>row.bookmakerId===1);
  assert.ok(excluded.blockers.includes('MARKET_ODDS_INVALID'));assert.ok(excluded.blockers.includes('DUPLICATE_MARKET_SELECTION'));
  const conflict=analyze(snapshot([page([company(1),company(1,[winner(['1.9','3.8','4.5']),goals()]),company(2),company(3)])]));
  assert.equal(conflict.markets.matchWinner.companyCount,2);
  assert.ok(conflict.markets.matchWinner.rejectedCompanies.some(row=>row.blockers.includes('AMBIGUOUS_COMPANY_MARKET')));
  const extra=winner();extra.values.push({value:'__proto__',odd:'1.85'});
  const unknown=analyze(snapshot([page([company(1,[extra,goals()]),company(2),company(3)])]));
  assert.equal(unknown.markets.matchWinner.companyCount,2);
  assert.ok(unknown.markets.matchWinner.rejectedCompanies.some(row=>row.blockers.includes('MARKET_SELECTION_INVALID')));
});

test('response identity errors and malformed pages do not stop subsequent fixtures',()=>{
  const input=snapshot([page(undefined,{responseChanges:{league:{id:140}}})]);
  input.fixtures.push({fixture:{...fixture},pages:[page()]});
  const result=analyzeFullMarketSnapshot(input);
  assert.equal(result.fixtures.length,2);assert.equal(result.fixtures[0].markets.matchWinner.companyCount,0);
  assert.ok(result.fixtures[0].markets.matchWinner.blockers.includes('RESPONSE_FIXTURE_IDENTITY_MISMATCH'));
  assert.equal(result.fixtures[1].markets.matchWinner.companyCount,3);
  const broken=page();broken.data.errors={token:'private token is not copied'};
  const bad=analyze(snapshot([broken]));assert.ok(bad.markets.matchWinner.blockers.includes('PROVIDER_API_ERROR'));
  assert.equal(JSON.stringify(bad).includes('private token'),false);
});

test('incomplete pagination and unverified page times are reported alongside the available research calculations',()=>{
  const result=analyze(snapshot([page(undefined,{paging:{current:1,total:2},httpDate:'invalid'})])).markets.matchWinner;
  assert.equal(result.companyCount,3);assert.equal(result.selection,'home');
  assert.ok(result.blockers.includes('PAGINATION_INCOMPLETE'));assert.ok(result.blockers.includes('PAGE_HTTP_DATE_UNVERIFIED'));
  assert.equal(result.researchStatus,'blocked_reference');
});

test('Asian handicap remains provider-specific facts without inventing line pairing or win probability',()=>{
  const asian={id:4,values:[{value:'Home +0.25',odd:'1.85'},{value:'Away +0.25',odd:'2.00'}]};
  const result=analyze(snapshot([page([company(1,[winner(),goals(),asian]),company(2),company(3)])])).markets.asianHandicap;
  assert.equal(result.companyCount,1);assert.deepEqual(result.companyEvidence[0].values,[
    {label:'Home +0.25',decimalOdds:1.85},{label:'Away +0.25',decimalOdds:2},
  ]);
  assert.equal(Object.hasOwn(result,'normalizedImpliedProbability'),false);
  assert.equal(result.formalRecommendation.allowed,false);
});

test('analysis is deterministic, does not mutate its input and validates top-level bounds before work',()=>{
  const input=snapshot(),before=structuredClone(input),first=analyzeFullMarketSnapshot(input);
  assert.deepEqual(input,before);assert.deepEqual(analyzeFullMarketSnapshot(input),first);
  first.fixtures[0].markets.matchWinner.selections[0]='changed';
  first.fixtures[0].markets.asianHandicap.formalRecommendation.blockers.length=0;
  assert.equal(analyze(input).markets.matchWinner.selections[0],'home');
  assert.ok(analyze(input).markets.asianHandicap.formalRecommendation.blockers.length>0);
  for(const bad of [null,{fixtures:[]},{fixtures:Array(3001).fill({}),fetchedAt:NOW}])assert.throws(()=>analyzeFullMarketSnapshot(bad),TypeError);
});
