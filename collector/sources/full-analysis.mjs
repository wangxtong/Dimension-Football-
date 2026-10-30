import {createHash} from 'node:crypto';
import {isoMillis} from '../policy.mjs';
import {analyzeFixtureHistory} from '../team-analysis.mjs';
import {apiFootballLeagues} from './api-football.mjs';

const ORIGIN='https://v3.football.api-sports.io';
const DEADLINE_MS=15_000, RESPONSE_LIMIT=2_000_000, MAX_PAGES=10;
const ENDPOINTS=new Set(['/fixtures','/injuries','/fixtures/lineups','/predictions','/odds']);
const DIMENSIONS=['injuries','lineups','predictions','odds'];
const idOK=value=>Number.isSafeInteger(value)&&value>0;
const unique=values=>[...new Set(values)];
class SourceError extends Error{constructor(code){super(code);this.code=code;}}

async function readBody(response){
  if(Number(response.headers?.get('content-length'))>RESPONSE_LIMIT)throw new SourceError('response_too_large');
  const reader=response.body?.getReader?.();let text='';
  if(reader){
    const decoder=new TextDecoder();let bytes=0;
    try{
      for(;;){
        const {done,value}=await reader.read();if(done)break;
        bytes+=value.byteLength;if(bytes>RESPONSE_LIMIT)throw new SourceError('response_too_large');
        text+=decoder.decode(value,{stream:true});
      }
      text+=decoder.decode();
    }finally{await reader.cancel().catch(()=>{});}
  }else{
    text=await response.text();
    if(new TextEncoder().encode(text).byteLength>RESPONSE_LIMIT)throw new SourceError('response_too_large');
  }
  return {text,sha256:createHash('sha256').update(text).digest('hex')};
}

function validateData(data,job){
  if(!data||data.get!==job.path.slice(1)||!Array.isArray(data.response)
    ||!data.errors||typeof data.errors!=='object')throw new SourceError('invalid_response');
  const errors=Object.keys(data.errors);
  if(errors.length)throw new SourceError(errors.includes('plan')?'plan_restricted':errors.includes('token')?'authorization_required':
    errors.includes('rateLimit')?'rate_limited':errors.includes('requests')?'quota_exceeded':'api_error');
  if(!Number.isSafeInteger(data.results)||data.results!==data.response.length)throw new SourceError('invalid_response');
  if(data.paging?.current!==(job.page||1)||!Number.isSafeInteger(data.paging?.total)||data.paging.total<1
    ||data.paging.current>data.paging.total)throw new SourceError('invalid_paging');
  if(!['history','odds'].includes(job.kind)&&data.paging.total!==1)throw new SourceError('invalid_paging');
  if(job.params.ids){
    const ids=new Set(job.params.ids.split('-').map(Number)),seen=new Set();
    for(const row of data.response){
      if(!idOK(row?.fixture?.id)||!ids.has(row.fixture.id)||seen.has(row.fixture.id))throw new SourceError('response_fixture_mismatch');
      seen.add(row.fixture.id);
    }
  }
  if(job.kind==='odds'&&data.response.some(row=>row?.fixture?.id!==Number(job.params.fixture)))throw new SourceError('response_fixture_mismatch');
}

function jobMetadata(job){
  return Object.fromEntries(['kind','fixtureId','fixtureIds','league','leagueId','season','seasonSource','period','teamId','requestedFor','page']
    .filter(key=>job[key]!==undefined).map(key=>[key,job[key]]));
}

function createRequester({apiKey,fetchImpl,signal,maxRequests,readClock}){
  let usedRequests=0;
  async function request(job){
    if(!ENDPOINTS.has(job.path))throw new TypeError('Unsupported analysis endpoint');
    const url=new URL(job.path,ORIGIN);
    for(const [key,value]of Object.entries(job.params))url.searchParams.set(key,String(value));
    const base={...jobMetadata(job),url:url.href,path:url.pathname+url.search,attempted:false,requestIndex:null,
      fetchedAt:null,httpDate:null,httpStatus:null,sha256:null};
    if(signal?.aborted)return {...base,error:'aborted'};
    if(!apiKey)return {...base,error:'authorization_required'};
    if(usedRequests>=maxRequests)return {...base,error:'request_budget_exhausted'};
    usedRequests++;base.attempted=true;base.requestIndex=usedRequests;
    const controller=new AbortController();let timer,abortListener;
    try{
      const operation=(async()=>{
        const response=await fetchImpl(url.href,{method:'GET',redirect:'manual',signal:controller.signal,
          headers:{'x-apisports-key':apiKey,Accept:'application/json','User-Agent':'DimensionFootball-Collector/1.0'}});
        base.httpStatus=Number.isInteger(response?.status)?response.status:null;
        const served=Date.parse(response?.headers?.get('date'));
        base.httpDate=Number.isFinite(served)?new Date(served).toUTCString():null;
        if(response?.redirected||base.httpStatus>=300&&base.httpStatus<400)throw new SourceError('redirect_blocked');
        if(!response?.ok)throw new SourceError(base.httpStatus===401?'authorization_required':base.httpStatus===403?'access_denied':
          base.httpStatus===429?'rate_limited':'http_unavailable');
        const body=await readBody(response);base.sha256=body.sha256;base.fetchedAt=readClock();
        if(!Number.isFinite(served)||Math.abs(isoMillis(base.fetchedAt)-served)>300_000)throw new SourceError('stale_response');
        let data;try{data=JSON.parse(body.text);}catch{throw new SourceError('invalid_json');}
        validateData(data,job);
        // Never persist an echoed credential, including in an otherwise successful body.
        if(body.text.includes(apiKey)||JSON.stringify(data).includes(apiKey))throw new SourceError('credential_reflected');
        return {...base,data};
      })();
      const deadline=new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new SourceError('timeout'));},DEADLINE_MS);});
      const racers=[operation,deadline];
      if(signal)racers.push(new Promise((resolve,reject)=>{
        abortListener=()=>{controller.abort();reject(new SourceError('aborted'));};
        signal.addEventListener('abort',abortListener,{once:true});
        if(signal.aborted)abortListener();
      }));
      return await Promise.race(racers);
    }catch(error){
      return {...base,fetchedAt:base.fetchedAt??readClock(),error:error instanceof SourceError?error.code:signal?.aborted?'aborted':'network_unavailable'};
    }finally{clearTimeout(timer);if(abortListener)signal.removeEventListener('abort',abortListener);controller.abort();}
  }
  async function run(jobs){
    const rows=Array(jobs.length);let next=0;
    await Promise.all(Array.from({length:Math.min(3,jobs.length)},async()=>{
      while(next<jobs.length){const index=next++;rows[index]=await request(jobs[index]);}
    }));
    return rows;
  }
  return {run,get usedRequests(){return usedRequests;}};
}

function targetIndex(fixtures,rows){
  const index=new Map(),issues=[];
  for(const fixture of fixtures){
    const found=rows.filter(row=>!row.error).flatMap(row=>row.data.response).filter(row=>`af-${row?.fixture?.id}`===fixture.id);
    const target=found.length===1?found[0]:null;
    const valid=target&&idOK(target.teams?.home?.id)&&idOK(target.teams?.away?.id)&&target.teams.home.id!==target.teams.away.id
      &&(!fixture.league||target.league?.id===apiFootballLeagues[fixture.league])
      &&(!fixture.home||target.teams.home.name===fixture.home)&&(!fixture.away||target.teams.away.name===fixture.away)
      &&Number.isFinite(isoMillis(target.fixture.date))&&Number.isSafeInteger(target.fixture.timestamp)&&target.fixture.timestamp*1000===isoMillis(target.fixture.date);
    if(valid)index.set(fixture.id,target);
    else issues.push({id:'api-football-full-analysis',sourceId:'api-football',kind:'identity',fixtureId:fixture.id,status:'partial',
      code:!found.length?'target_fixture_missing':found.length>1?'target_fixture_ambiguous':'target_fixture_identity_unverified'});
  }
  return {index,issues};
}

function historyJobs(targets,nowISO){
  const jobs=[],issues=[],now=new Date(isoMillis(nowISO)),fallback=now.getUTCFullYear()-(now.getUTCMonth()<6?1:0);
  for(const [league,leagueId]of Object.entries(apiFootballLeagues)){
    const seasons=unique([...targets.values()].filter(row=>row.league?.id===leagueId).map(row=>row.league.season)
      .filter(year=>Number.isSafeInteger(year)&&year>=1900&&year<=now.getUTCFullYear()+1));
    const season=seasons.length?Math.max(...seasons):fallback,seasonSource=seasons.length?'target-fixture':'calendar-inference';
    if(!seasons.length||seasons.length>1)issues.push({id:'api-football-full-analysis',sourceId:'api-football',kind:'history',league,season,
      status:'partial',code:seasons.length?'season_ambiguous':'season_inferred'});
    for(const [year,period]of [[season,'current-season'],[season-1,'prior-season']])jobs.push({kind:'history',path:'/fixtures',
      params:{league:leagueId,season:year,status:'FT'},page:1,league,leagueId,season:year,seasonSource,period});
  }
  return {jobs,issues};
}

function pageJobs(jobs,rows){
  const more=[],issues=[];
  for(let index=0;index<jobs.length;index++){
    const job=jobs[index],row=rows[index];if(row.error||!['history','odds'].includes(job.kind))continue;
    const total=row.data.paging.total;
    for(let page=2;page<=Math.min(total,MAX_PAGES);page++)more.push({...job,page,params:{...job.params,page}});
    if(total>MAX_PAGES)issues.push({id:'api-football-full-analysis',sourceId:'api-football',...jobMetadata(job),status:'partial',
      code:'pagination_limit_reached',reportedPages:total,pageLimit:MAX_PAGES});
  }
  return {jobs:more,issues};
}

function supplementalJobs(fixtures,targets,rows,nowISO){
  const history=rows.filter(row=>row.kind==='history'&&!row.error).flatMap(row=>row.data.response),teams=new Map();
  for(const fixture of fixtures){
    const target=targets.get(fixture.id);if(!target)continue;
    const analysis=analyzeFixtureHistory({fixture:target,history,nowISO});
    for(const side of ['home','away'])if(analysis[side].venueLast5.sampleCount<5){
      const teamId=target.teams[side].id,entry=teams.get(teamId)||{teamId,requestedFor:[]};entry.requestedFor.push(fixture.id);teams.set(teamId,entry);
    }
  }
  return [...teams.values()].map(({teamId,requestedFor})=>({kind:'history',path:'/fixtures',params:{team:teamId,last:30,status:'FT'},
    page:1,teamId,requestedFor:unique(requestedFor),period:'team-history'}));
}

function requestDiagnostic(row,checkedAt){
  return {id:'api-football-full-analysis',sourceId:'api-football',...Object.fromEntries(
    ['kind','fixtureId','fixtureIds','league','leagueId','season','seasonSource','period','teamId','requestedFor','page','attempted','requestIndex',
      'fetchedAt','httpDate','httpStatus','sha256'].filter(key=>row[key]!==undefined).map(key=>[key,row[key]])),checkedAt,
    status:row.error?'unavailable':row.data.results?'available':'complete',code:row.error||(row.data.results?'response_received':'empty_response'),
    receivedCount:row.data?.results??null};
}

/** Collect only the authorized official endpoints. Missing evidence remains explicit for every input fixture. */
export async function fetchFullAnalysisData({fixtures=[],apiKey='',nowISO=new Date().toISOString(),fetchImpl=fetch,signal,
  maxRequests=250,clock=()=>new Date().toISOString()}={}){
  const now=isoMillis(nowISO);
  if(!Array.isArray(fixtures)||fixtures.length>3000||!Number.isFinite(now)||typeof fetchImpl!=='function'||typeof clock!=='function'
    ||!Number.isSafeInteger(maxRequests)||maxRequests<0||maxRequests>50_000||typeof apiKey!=='string'||apiKey.length>256||/[\r\n]/.test(apiKey)
    ||signal!==undefined&&(!signal||typeof signal.aborted!=='boolean'||typeof signal.addEventListener!=='function'||typeof signal.removeEventListener!=='function'))throw new TypeError('Invalid full analysis request');
  const ids=new Set();
  for(const fixture of fixtures){
    const id=typeof fixture?.id==='string'&&fixture.id.match(/^af-([1-9]\d*)$/)?.[1];
    if(!id||!idOK(Number(id))||ids.has(fixture.id)||fixture.league!==undefined&&!Object.hasOwn(apiFootballLeagues,fixture.league))throw new TypeError('Full analysis requires unique API-Football fixture IDs');
    ids.add(fixture.id);
  }
  const readClock=()=>{const value=clock(),time=isoMillis(value);if(!Number.isFinite(time))throw new TypeError('Invalid full analysis clock');return new Date(time).toISOString();};
  const startedAt=readClock();
  if(!fixtures.length)return {evidence:{provider:'API-Football',capturedAt:startedAt,fixtures:[],evidence:[]},
    marketSnapshot:{provider:'API-Football',fetchedAt:startedAt,fixtures:[]},priorHistory:[],diagnostics:[],
    coverage:{inputFixtures:0,requests:0,maxRequests,failedRequests:0,unrequestedRequests:0,fixturesWithAllDimensions:0},status:'empty'};
  const requester=createRequester({apiKey:apiKey.trim(),fetchImpl,signal,maxRequests,readClock}),targetJobs=[];
  for(let offset=0;offset<fixtures.length;offset+=20){
    const batch=fixtures.slice(offset,offset+20);targetJobs.push({kind:'fixtures',path:'/fixtures',params:{ids:batch.map(fixture=>fixture.id.slice(3)).join('-')},
      fixtureIds:batch.map(fixture=>fixture.id),page:1});
  }
  const targetRows=await requester.run(targetJobs),targets=targetIndex(fixtures,targetRows),histories=historyJobs(targets.index,nowISO);
  const historyRows=await requester.run(histories.jobs);
  const dimensionJobs=fixtures.flatMap(fixture=>DIMENSIONS.map(kind=>({kind,fixtureId:fixture.id,path:kind==='lineups'?'/fixtures/lineups':`/${kind}`,
    params:{fixture:fixture.id.slice(3)},page:1})));
  const dimensionRows=await requester.run(dimensionJobs);
  const pagination=pageJobs([...histories.jobs,...dimensionJobs],[...historyRows,...dimensionRows]);
  const additionalRows=await requester.run(pagination.jobs);
  const teamJobs=supplementalJobs(fixtures,targets.index,[...historyRows,...additionalRows],readClock());
  const teamRows=await requester.run(teamJobs),teamPagination=pageJobs(teamJobs,teamRows);
  const teamAdditionalRows=await requester.run(teamPagination.jobs);
  const rows=[...targetRows,...historyRows,...dimensionRows,...additionalRows,...teamRows,...teamAdditionalRows],capturedAt=readClock();
  const priorHistory=rows.filter(row=>row.kind==='history'&&['prior-season','team-history'].includes(row.period));
  const evidenceRows=rows.filter(row=>!priorHistory.includes(row));
  const issues=[...targets.issues,...histories.issues,...pagination.issues,...teamPagination.issues].map(row=>({...row,checkedAt:capturedAt}));
  const marketFixtures=fixtures.map(fixture=>{
    const pages=rows.filter(row=>row.kind==='odds'&&row.fixtureId===fixture.id).sort((a,b)=>a.page-b.page);
    const failed=pages.find(row=>row.error),limited=issues.some(row=>row.kind==='odds'&&row.fixtureId===fixture.id&&row.code==='pagination_limit_reached');
    return {fixture,pages,...(failed||limited?{error:failed?.error||'pagination_limit_reached'}:{})};
  });
  const fixtureCoverage=fixtures.map(fixture=>{
    const dimensions=Object.fromEntries(DIMENSIONS.map(kind=>{
      const found=rows.filter(row=>row.kind===kind&&row.fixtureId===fixture.id),limited=issues.some(row=>row.kind===kind&&row.fixtureId===fixture.id&&row.code==='pagination_limit_reached');
      const error=found.find(row=>row.error)?.error;
      return [kind,{status:error?'unavailable':limited?'partial':found.some(row=>row.data?.results)?'available':'complete',
        code:error||(limited?'pagination_limit_reached':found.some(row=>row.data?.results)?'response_received':'empty_response')}];
    }));
    const missingDimensions=[...(!targets.index.has(fixture.id)?['identity']:[]),...DIMENSIONS.filter(kind=>dimensions[kind].status!=='available')];
    return {id:'api-football-full-analysis',sourceId:'api-football',kind:'fixture-coverage',fixtureId:fixture.id,checkedAt:capturedAt,
      status:missingDimensions.length?'partial':'available',code:missingDimensions.length?'analysis_evidence_incomplete':'all_endpoint_evidence_received',
      dimensions,missingDimensions};
  });
  const diagnostics=[...rows.map(row=>requestDiagnostic(row,capturedAt)),...issues,...fixtureCoverage];
  return {evidence:{provider:'API-Football',capturedAt,fixtures:[...fixtures],evidence:evidenceRows},
    marketSnapshot:{provider:'API-Football',fetchedAt:capturedAt,fixtures:marketFixtures},priorHistory,diagnostics,
    coverage:{inputFixtures:fixtures.length,requests:requester.usedRequests,maxRequests,failedRequests:rows.filter(row=>row.attempted&&row.error).length,
      unrequestedRequests:rows.filter(row=>!row.attempted).length,fixturesWithAllDimensions:fixtureCoverage.filter(row=>!row.missingDimensions.length).length},
    status:diagnostics.some(row=>['unavailable','partial'].includes(row.status))?'partial':'collected'};
}
