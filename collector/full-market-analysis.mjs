import {isoMillis} from './policy.mjs';

const RESEARCH_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const LIVE_MAX_AGE_MS = 5 * 60 * 1000;
const LEAGUES = {PL:39,PD:140,SA:135,BL1:78,FL1:61};
const FORMAL_BLOCKERS = ['EXISTING_FORMAL_POLICY_GATE_REQUIRED', 'SECOND_INDEPENDENT_SOURCE_NOT_IN_SNAPSHOT',
  'OPENING_HISTORY_NOT_IN_SNAPSHOT', 'INDEPENDENT_FORECAST_NOT_IN_SNAPSHOT'];
const SPECS = {
  matchWinner: {betId:1,market:'1x2',line:null,selections:['home','draw','away']},
  goalsOverUnder25: {betId:5,market:'goals-over-under',line:2.5,selections:['over','under']},
};
const unique = values => [...new Set(values)];
const median = values => {
  const sorted = [...values].sort((a,b)=>a-b), mid = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
};
const normalizedName = name => typeof name==='string'?name.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu,' '):'';
const crown = name => /crown|皇冠|crow\*/iu.test(normalizedName(name));
function odds(value){
  const number = typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;
  return Number.isFinite(number)&&number>1?number:NaN;
}
function age(value,now){const time=isoMillis(value);return Number.isFinite(time)?now-time:null;}
function timestamp(value){const time=isoMillis(value);return Number.isFinite(time)?new Date(time).toISOString():null;}

function parseMarket(bookmaker,spec){
  if(!Array.isArray(bookmaker.bets))return {blockers:['BOOKMAKER_BETS_INVALID']};
  const bets=bookmaker.bets.filter(bet=>bet?.id===spec.betId);
  if(!bets.length)return {blockers:['MARKET_NOT_PUBLISHED']};
  // A second record cannot supply the missing side of the first record.
  const parsed=bets.map(bet=>{
    if(!Array.isArray(bet.values))return {blockers:['MARKET_VALUES_INVALID']};
    const entries=spec.betId===1?bet.values:bet.values.filter(row=>{
      const found=typeof row?.value==='string'&&row.value.match(/^(Over|Under) (\d+(?:\.\d+)?)$/);
      return found&&Number(found[2])===spec.line;
    });
    const values={},blockers=[];
    for(const row of entries){
      const selection=spec.betId===1?({Home:'home',Draw:'draw',Away:'away'})[row?.value]:row.value.startsWith('Over ')?'over':'under';
      if(!spec.selections.includes(selection)){blockers.push('MARKET_SELECTION_INVALID');continue;}
      if(Object.hasOwn(values,selection)){blockers.push('DUPLICATE_MARKET_SELECTION');continue;}
      const price=odds(row.odd);if(!Number.isFinite(price))blockers.push('MARKET_ODDS_INVALID');
      values[selection]=price;
    }
    if(spec.selections.some(selection=>!Object.hasOwn(values,selection)))blockers.push(entries.length?'INCOMPLETE_COMPANY_MARKET':'MARKET_NOT_PUBLISHED');
    return blockers.length?{blockers:unique(blockers)}:{odds:values,blockers:[]};
  });
  if(parsed.some(row=>row.blockers.length))return {blockers:unique(parsed.flatMap(row=>row.blockers))};
  if(new Set(parsed.map(row=>JSON.stringify(spec.selections.map(selection=>row.odds[selection])))).size!==1)return {blockers:['AMBIGUOUS_COMPANY_MARKET']};
  return parsed[0];
}

function readEntry(entry,now){
  const fixture=entry?.fixture, pages=Array.isArray(entry?.pages)?entry.pages:[], blockers=[], records=[];
  const providerId=typeof fixture?.id==='string'&&fixture.id.match(/^af-(\d+)$/)?.[1];
  const kickoff=isoMillis(fixture?.kickoff);
  if(!providerId||!Number.isSafeInteger(Number(providerId))||!LEAGUES[fixture?.league]||!Number.isFinite(kickoff))blockers.push('FIXTURE_IDENTITY_INVALID');
  if(!['SCHEDULED','TIMED'].includes(fixture?.status)||!Number.isFinite(kickoff)||kickoff<=now)blockers.push('NOT_PREMATCH');
  if(!pages.length)blockers.push('NO_MARKET_PAGES');
  const paging=[];
  for(const page of pages){
    const data=page?.data;
    if(!data||data.get!=='odds'||!Array.isArray(data.response)||!data.errors||typeof data.errors!=='object'){
      blockers.push('PAGE_RESPONSE_INVALID');continue;
    }
    if(Object.keys(data.errors).length){blockers.push('PROVIDER_API_ERROR');continue;}
    if(data.results!==data.response.length){blockers.push('PAGE_RESPONSE_COUNT_MISMATCH');continue;}
    if(!Number.isSafeInteger(data.paging?.current)||data.paging.current<1||!Number.isSafeInteger(data.paging?.total)||data.paging.total<1){
      blockers.push('PAGE_PAGING_INVALID');continue;
    }
    paging.push(data.paging);
    const fetched=isoMillis(page.fetchedAt), served=Date.parse(page.httpDate);
    const pageBlockers=[];
    if(!Number.isFinite(fetched)||fetched>now)pageBlockers.push('PAGE_FETCH_TIME_INVALID');
    if(!Number.isFinite(served)||!Number.isFinite(fetched)||Math.abs(fetched-served)>LIVE_MAX_AGE_MS)pageBlockers.push('PAGE_HTTP_DATE_UNVERIFIED');
    blockers.push(...pageBlockers);
    for(const response of data.response){
      if(!providerId||response?.fixture?.id!==Number(providerId)||response?.league?.id!==LEAGUES[fixture?.league]||!Number.isSafeInteger(response?.fixture?.timestamp)
        ||isoMillis(response?.fixture?.date)!==kickoff||response?.fixture?.timestamp*1000!==kickoff){
        blockers.push('RESPONSE_FIXTURE_IDENTITY_MISMATCH');continue;
      }
      if(!Array.isArray(response.bookmakers)){blockers.push('BOOKMAKERS_INVALID');continue;}
      for(const bookmaker of response.bookmakers)records.push({bookmaker,updatedAt:timestamp(response.update),ageMs:age(response.update,now),
        fetchedAt:timestamp(page.fetchedAt),httpDate:Number.isFinite(served)?new Date(served).toISOString():null,pageBlockers});
    }
  }
  if(paging.length){
    const totals=unique(paging.map(page=>page.total)), currents=unique(paging.map(page=>page.current));
    if(totals.length!==1||currents.length!==totals[0]||currents.some(page=>page>totals[0])
      ||!currents.includes(1))blockers.push('PAGINATION_INCOMPLETE');
  }
  const groups=new Map(), rejectedCompanies=[], names=new Map();
  for(const record of records){
    const company=record.bookmaker;
    if(crown(company?.name)){
      rejectedCompanies.push({bookmakerId:Number.isSafeInteger(company?.id)?company.id:null,bookmaker:company?.name||null,blockers:['CROWN_EXCLUDED']});continue;
    }
    if(!Number.isSafeInteger(company?.id)||company.id<=0||typeof company?.name!=='string'||!company.name.trim()
      ||company.name.length>100||/[\u0000-\u001f]/u.test(company.name)){
      rejectedCompanies.push({bookmakerId:Number.isSafeInteger(company?.id)?company.id:null,bookmaker:null,blockers:['BOOKMAKER_IDENTITY_INVALID']});continue;
    }
    const name=normalizedName(company.name), list=groups.get(company.id)||[];list.push(record);groups.set(company.id,list);
    const ids=names.get(name)||new Set();ids.add(company.id);names.set(name,ids);
  }
  for(const [id,rows] of groups){
    if(unique(rows.map(row=>normalizedName(row.bookmaker.name))).length!==1||names.get(normalizedName(rows[0].bookmaker.name)).size!==1){
      rejectedCompanies.push({bookmakerId:id,bookmaker:rows[0].bookmaker.name,blockers:['AMBIGUOUS_BOOKMAKER_IDENTITY']});groups.delete(id);
    }
  }
  return {fixture,blockers:unique(blockers),groups,rejectedCompanies};
}

function analyzeMarket(input,spec,now){
  const companyEvidence=[], rejectedCompanies=[...input.rejectedCompanies];
  for(const [id,records] of input.groups){
    const parsed=records.map(record=>({...record,...parseMarket(record.bookmaker,spec)}));
    // Pick one coherent provider update; do not combine partial observations.
    const times=parsed.map(row=>isoMillis(row.updatedAt)), latest=Math.max(...times.filter(Number.isFinite));
    const latestRows=Number.isFinite(latest)?parsed.filter(row=>isoMillis(row.updatedAt)===latest):parsed;
    const companyBlockers=unique(latestRows.flatMap(row=>row.blockers));
    const complete=latestRows.filter(row=>!row.blockers.length);
    if(complete.length&&new Set(complete.map(row=>JSON.stringify(spec.selections.map(selection=>row.odds[selection])))).size!==1)companyBlockers.push('AMBIGUOUS_COMPANY_MARKET');
    if(companyBlockers.length||!complete.length){
      rejectedCompanies.push({bookmakerId:id,bookmaker:records[0].bookmaker.name,blockers:unique(companyBlockers)});continue;
    }
    const record=complete[0], inverse=spec.selections.map(selection=>1/record.odds[selection]), total=inverse.reduce((sum,value)=>sum+value,0);
    const probabilities=Object.fromEntries(spec.selections.map((selection,index)=>[selection,inverse[index]/total]));
    companyEvidence.push({bookmakerId:id,bookmaker:record.bookmaker.name,odds:record.odds,probabilities,
      updatedAt:record.updatedAt,ageMs:record.ageMs,fetchedAt:record.fetchedAt,httpDate:record.httpDate,
      duplicateRecordCount:records.length-1,blockers:unique([
        ...record.pageBlockers,...(record.ageMs===null?['SOURCE_TIMESTAMP_INVALID']:record.ageMs<0?['SOURCE_TIMESTAMP_FUTURE']:[]),
        ...(record.ageMs>RESEARCH_MAX_AGE_MS?['RESEARCH_SOURCE_STALE']:[]),...(record.ageMs>LIVE_MAX_AGE_MS?['LIVE_SOURCE_STALE']:[]),
      ])});
  }
  const blockers=[...input.blockers];
  if(companyEvidence.length<3)blockers.push('FEWER_THAN_THREE_COMPLETE_COMPANIES');
  const medians=Object.fromEntries(spec.selections.map(selection=>[selection,companyEvidence.length?median(companyEvidence.map(row=>row.probabilities[selection])):null]));
  const medianTotal=companyEvidence.length?Object.values(medians).reduce((sum,value)=>sum+value,0):null;
  const probabilities=Object.fromEntries(spec.selections.map(selection=>[selection,companyEvidence.length?medians[selection]/medianTotal:null]));
  const selection=companyEvidence.length?[...spec.selections].sort((a,b)=>probabilities[b]-probabilities[a])[0]:null;
  const decimalOdds=selection?median(companyEvidence.map(row=>row.odds[selection])):null;
  if(decimalOdds!==null&&(decimalOdds<1.65||decimalOdds>1.95))blockers.push('SELECTED_ODDS_OUTSIDE_1_65_TO_1_95');
  blockers.push(...companyEvidence.flatMap(row=>row.blockers));
  const ages=companyEvidence.map(row=>row.ageMs), validTimes=companyEvidence.map(row=>isoMillis(row.updatedAt)).filter(Number.isFinite);
  const updatedAt=validTimes.length===companyEvidence.length&&validTimes.length?new Date(Math.min(...validTimes)).toISOString():null;
  const allBlockers=unique(blockers), researchBlockers=allBlockers.filter(code=>code!=='LIVE_SOURCE_STALE');
  const researchStatus=!companyEvidence.length?'unavailable':allBlockers.includes('RESEARCH_SOURCE_STALE')?'stale_reference':
    researchBlockers.length?'blocked_reference':'research_reference';
  return {...spec,selections:[...spec.selections],period:'full-time',selection,decimalOdds,normalizedImpliedProbability:selection?probabilities[selection]:null,
    probabilityMethod:'per-company inverse-odds normalization; selection medians renormalized across outcomes',
    probabilities,companyCount:companyEvidence.length,updatedAt,ageMs:ages.length&&ages.every(value=>value!==null)?Math.max(...ages):null,
    latestUpdatedAt:validTimes.length?new Date(Math.max(...validTimes)).toISOString():null,
    researchStatus,researchMaxAgeMs:RESEARCH_MAX_AGE_MS,liveMaxAgeMs:LIVE_MAX_AGE_MS,
    companyEvidence,rejectedCompanies,blockers:allBlockers,
    formalRecommendation:{allowed:false,requiresExistingPolicyGate:true,blockers:unique([...FORMAL_BLOCKERS,...allBlockers])}};
}

function asianFacts(input){
  const companyEvidence=[];
  for(const [id,records] of input.groups){
    const available=records.filter(row=>Array.isArray(row.bookmaker.bets)&&row.bookmaker.bets.some(bet=>bet?.id===4));
    if(!available.length)continue;
    const record=[...available].sort((a,b)=>(isoMillis(b.updatedAt)||0)-(isoMillis(a.updatedAt)||0))[0];
    const values=record.bookmaker.bets.filter(bet=>bet?.id===4).flatMap(bet=>Array.isArray(bet.values)?bet.values:[])
      .filter(row=>typeof row?.value==='string'&&Number.isFinite(odds(row.odd))).map(row=>({label:row.value,decimalOdds:odds(row.odd)}));
    companyEvidence.push({bookmakerId:id,bookmaker:record.bookmaker.name,updatedAt:record.updatedAt,ageMs:record.ageMs,values,
      blockers:unique([...(record.ageMs===null?['SOURCE_TIMESTAMP_INVALID']:record.ageMs<0?['SOURCE_TIMESTAMP_FUTURE']:[]),
        ...(record.ageMs>RESEARCH_MAX_AGE_MS?['RESEARCH_SOURCE_STALE']:[]),...(record.ageMs>LIVE_MAX_AGE_MS?['LIVE_SOURCE_STALE']:[])])});
  }
  return {betId:4,market:'asian-handicap',period:'full-time',interpretation:'provider labels and decimal odds only; no inferred handicap pairing or cover probability',
    companyCount:companyEvidence.length,companyEvidence,blockers:unique([...input.blockers,...companyEvidence.flatMap(row=>row.blockers),...(!companyEvidence.length?['ASIAN_HANDICAP_NOT_PUBLISHED']:[])]),
    formalRecommendation:{allowed:false,requiresExistingPolicyGate:true,blockers:[...FORMAL_BLOCKERS]}};
}

/** Analyze each dimension independently. Probabilities describe bookmaker prices, not true win rates or expected value. */
export function analyzeFullMarketSnapshot(snapshot,{nowISO=snapshot?.fetchedAt}={}){
  const now=isoMillis(nowISO);
  if(!Number.isFinite(now)||!Array.isArray(snapshot?.fixtures)||snapshot.fixtures.length>3000)throw new TypeError('Invalid full market snapshot');
  return {provider:'API-Football',analyzedAt:new Date(now).toISOString(),researchMaxAgeMs:RESEARCH_MAX_AGE_MS,liveMaxAgeMs:LIVE_MAX_AGE_MS,
    probabilityMeaning:'normalized market-implied reference; not true win probability and not an expected-value estimate',
    fixtures:snapshot.fixtures.map(entry=>{
      const input=readEntry(entry,now),markets={matchWinner:analyzeMarket(input,SPECS.matchWinner,now),
        goalsOverUnder25:analyzeMarket(input,SPECS.goalsOverUnder25,now),asianHandicap:asianFacts(input)};
      return {fixture:input.fixture??null,markets,formalRecommendation:{allowed:false,requiresExistingPolicyGate:true,
        blockers:unique([...FORMAL_BLOCKERS,...Object.values(markets).flatMap(market=>market.blockers)])}};
    })};
}
