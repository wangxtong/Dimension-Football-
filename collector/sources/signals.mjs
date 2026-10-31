import { teamName } from './team-names.mjs';
import { CRAWLER_CODES } from './crawler.mjs';

// Only public, pre-match 1X2 signals are read here. A source being reachable is
// never treated as a prediction, and a 1X2 signal is never an Asian-cover vote.
const signalSources = [
  {id:'tiantian',url:'https://www.ttyingqiu.com/interpretationList/zq',requestUrl:'https://www.ttyingqiu.com/query/hall/jdList'},
  {id:'forebet',url:'https://www.forebet.com/en/football-predictions',termsUrl:'https://www.forebet.com/en/terms-of-use',restriction:'redistribution_permission_required',
    lastAudit:{httpStatus:403,observedAt:'2026-10-27T08:23:38.000Z',code:'access_challenge'}},
  {id:'footymetrics',url:'https://www.footymetrics.com/',termsUrl:'https://www.footymetrics.com/terms-of-service',restriction:'automated_collection_permission_required'},
  {id:'tactix',url:'https://tactix.football/predictions/',termsUrl:'https://tactix.football/terms',restriction:'api_agreement_required'},
  {id:'golsinyali',url:'https://www.golsinyali.com/',termsUrl:'https://www.golsinyali.com/en/terms',restriction:'automated_collection_permission_required'},
  {id:'fotmob',url:'https://www.fotmob.com/',termsUrl:'https://www.fotmob.com/tos.txt',restriction:'automated_collection_permission_required'},
  {id:'statarea',url:'https://www.statarea.com/predictions'},
];
const signalTermsReviewedAt='2026-10-27T08:30:00.000Z';
const signalLeagueAliases = {
  'ENGLAND - PREMIER LEAGUE':'PL','英超':'PL','PL':'PL',
  'SPAIN - LALIGA':'PD','SPAIN - PRIMERA DIVISION':'PD','西甲':'PD','PD':'PD',
  'ITALY - SERIE A':'SA','意甲':'SA','SA':'SA',
  'GERMANY - BUNDESLIGA':'BL1','德甲':'BL1','BL1':'BL1',
  'FRANCE - LIGUE 1':'FL1','法甲':'FL1','FL1':'FL1',
};
const signalTeamAliases = {
  'Werder Bremen':'云达不莱梅','FSV Mainz 05':'美因茨','VfL Bochum':'波鸿',
  'Bayern Munich':'拜仁慕尼黑','Borussia Monchengladbach':'门兴格拉德巴赫',
  'Paris Saint Germain':'巴黎圣日耳曼','Paris Saint-Germain':'巴黎圣日耳曼',
  'Inter Milan':'国际米兰','Inter Milano':'国际米兰',
  'Unione Venezia':'威尼斯','AC Monza':'蒙扎','Monza':'蒙扎',
  'Sassuolo':'萨索洛','Elche':'埃尔切','Frosinone':'弗罗西诺内',
  'Tottenham Hotspur':'热刺','Newcastle Utd':'纽卡斯尔联',
  'Brighton and Hove Albion':'布莱顿','West Ham United':'西汉姆联',
  'Wolverhampton':'狼队','Wolverhampton Wanderers':'狼队','Leeds United':'利兹联',
  'Celta Vigo':'塞尔塔','Rayo Vallecano':'巴列卡诺','Real Betis':'皇家贝蒂斯',
};

function signalText(value='') {
  return String(value).replace(/<[^>]*>/g,' ').replace(/&#(x[\da-f]+|\d+);/gi,(_,code)=>{
    const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);
    return Number.isSafeInteger(n)&&n>0&&n<=0x10ffff?String.fromCodePoint(n):'';
  }).replace(/&amp;/g,'&').replace(/&nbsp;/g,' ').replace(/&quot;/g,'"').replace(/&#39;/g,"'")
    .normalize('NFKC').replace(/\s+/gu,' ').trim();
}
function signalTeam(value) {
  const clean=signalText(value);
  return teamName(signalTeamAliases[clean]||clean).toLowerCase();
}
function signalLeague(value) { return signalLeagueAliases[signalText(value).toUpperCase()]||null; }

function signalCalendarISO(date,time,offsetMinutes=0) {
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date||'')||!/^\d{2}:\d{2}$/.test(time||'')) return null;
  const input=`${date}T${time}:00.000Z`,ms=Date.parse(input);
  return Number.isFinite(ms)&&new Date(ms).toISOString()===input?new Date(ms-offsetMinutes*60000).toISOString():null;
}

// Statarea's unauthenticated HTML explicitly labels its displayed GMT offset.
// Parse only its match blocks, not user votes, expert picks or bookmaker prices.
export function parseStatareaSignals(html) {
  if (typeof html!=='string') return [];
  const zones=[...html.matchAll(/<div class=['"]gmt['"]>GMT (0|[+-]\d{1,2})<\/div>/g)];
  if (zones.length!==1||Math.abs(Number(zones[0][1]))>14) return [];
  const offsetMinutes=Number(zones[0][1])*60;
  const publishedDate=html.match(/<meta name=['"]pubdate['"] content=['"](20\d{2}-\d{2}-\d{2})['"]/i)?.[1];
  const pageDate=html.match(/<h1>Match predictions, statistics and tips for (20\d{2}-\d{2}-\d{2})<\/h1>/)?.[1]||publishedDate;
  if (!signalCalendarISO(publishedDate,'00:00')||!signalCalendarISO(pageDate,'00:00')) return [];
  const rows=[];
  for (const competition of html.split(/<div class=['"]competition['"] id=['"]\d+['"]>/).slice(1)) {
    const header=competition.split(/<div class=['"]body['"]>/,1)[0];
    const league=signalLeague(header.match(/<div class=['"]name['"]>([^<]+)<\/div>/)?.[1]);
    if (!league) continue;
    for (const match of competition.split(/<div class=['"]match['"] id=['"]\d+['"]>/).slice(1)) {
      const row=match.split(/<div class=['"]cmatch['"]>/,1)[0];
      const dateTime=row.match(/<div class=['"]marker['"]>[^]*?<\/div>(20\d{2}-\d{2}-\d{2}) (\d{2}:\d{2})<\/div>/);
      const host=row.match(/<div class=['"]hostteam['"]><div class=['"]goals['"]>([^<]*)<\/div><div class=['"]name['"]><a href=['"]([^'"]+)['"]>([^]*?)<\/a>/);
      const guest=row.match(/<div class=['"]guestteam['"]><div class=['"]goals['"]>([^<]*)<\/div><div class=['"]name['"]><a href=['"]([^'"]+)['"]>([^]*?)<\/a>/);
      const tip=row.match(/<div class=['"]tip['"]><div class=['"]ownheader['"]>TIP<\/div><div class=['"]value['"]><div class=['"]type\d+['"]>(1|X|2)<\/div>/)?.[1];
      const coef=row.split(/<div class=['"]coefrow['"]>/)[1]?.split(/<div class=['"]userrow['"]>/,1)[0]||'';
      const probabilities=[...coef.matchAll(/<div class=['"]value r\d{1,3}['"]>(\d{1,3})<\/div>/g)].slice(0,3).map(m=>Number(m[1]));
      const kickoff=signalCalendarISO(dateTime?.[1],dateTime?.[2],offsetMinutes);
      if (!host||!guest||host[1]!=='-'||guest[1]!=='-'||!tip||!kickoff||dateTime[1]!==pageDate
        ||probabilities.length!==3||probabilities.some(p=>p<0||p>100)||Math.abs(probabilities.reduce((a,b)=>a+b,0)-100)>1) continue;
      let evidenceUrl;
      try {const u=new URL(host[2]);if(u.origin!=='https://www.statarea.com'||!u.pathname.startsWith('/compare/teams/'))continue;evidenceUrl=u.href;}catch{continue;}
      if (host[2]!==guest[2]) continue;
      rows.push({home:signalText(host[3]),away:signalText(guest[3]),league,kickoff,
        selection:{1:'home',X:'draw',2:'away'}[tip],probability:probabilities[{1:0,X:1,2:2}[tip]]/100,evidenceUrl});
    }
  }
  return rows;
}

async function signalReadPublic(url,fetchImpl,now,request={}) {
  const controller=new AbortController();let timer;
  const deadlineMs=Math.min(120000,Math.max(8000,Number(fetchImpl.timeoutMs)||8000));
  let httpStatus=null;
  try {
    return await Promise.race([(async()=>{
      const response=await fetchImpl(url,{method:'GET',...request,redirect:'manual',signal:controller.signal,
        headers:{Accept:'text/html','User-Agent':'VantisSports-SignalReader/1.0',...request.headers}});
      httpStatus=Number.isInteger(response?.status)?response.status:null;
      if (!response?.ok) return {httpStatus,error:response?.status===403?'access_denied':response?.status===429?'rate_limited':'http_unavailable'};
      const date=Date.parse(response.headers?.get('date'));
      if (!Number.isFinite(date)||Math.abs(now-date)>600000) return {httpStatus,error:'stale_response'};
      const length=Number(response.headers?.get('content-length'));
      if (length>1500000) return {httpStatus,error:'oversized_response'};
      const reader=response.body?.getReader?.();let text='';
      if (reader) {
        const decoder=new TextDecoder();let size=0;
        for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1500000){await reader.cancel();return {httpStatus,error:'oversized_response'};}text+=decoder.decode(value,{stream:true});}
        text+=decoder.decode();
      } else text=await response.text();
      if(!text||text.length>1500000)return {httpStatus,error:'invalid_response'};
      return {html:text,httpStatus,responseAt:new Date(date).toISOString()};
    })(),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve({httpStatus,error:'timeout'});},deadlineMs);})]);
  } catch (error) { return {httpStatus: Number.isInteger(error?.status) ? error.status : httpStatus,error:CRAWLER_CODES.has(error?.code)?error.code:'network_unavailable'}; }
  finally {clearTimeout(timer);controller.abort();}
}

function signalFixtureEligible(fixture,now) {
  const kickoff=Date.parse(fixture?.kickoff);
  return Boolean(signalLeague(fixture?.league)&&Number.isFinite(kickoff)&&kickoff>now&&fixture?.home&&fixture?.away&&!fixture?.demo
    &&fixture?.source!=='fictional-demo'&&['TIMED','SCHEDULED'].includes(fixture?.status));
}

function signalMatchRows(rows,fixtures,sourceId,checkedAt,now) {
  const signals=[],mappings=[];
  for (const fixture of fixtures) {
    if (!signalFixtureEligible(fixture,now)) continue;
    const kickoff=Date.parse(fixture.kickoff),league=signalLeague(fixture.league);
    const matches=rows.filter(row=>row.league===league&&signalTeam(row.home)===signalTeam(fixture.home)
      &&signalTeam(row.away)===signalTeam(fixture.away)&&Math.abs(Date.parse(row.kickoff)-kickoff)<=300000);
    if (matches.length!==1) continue;
    const row=matches[0];
    mappings.push({fixture,row});
  }
  for(const {fixture,row} of mappings) {
    if(mappings.filter(mapping=>mapping.row===row).length!==1)continue;
    const kickoff=Date.parse(fixture.kickoff);
    signals.push({fixtureId:fixture.id,fixtureSnapshot:{id:fixture.id,home:fixture.home,away:fixture.away,kickoff:fixture.kickoff,league:fixture.league,source:fixture.source},
      sourceId,market:'1x2',selection:row.selection,probability:row.probability,observedAt:checkedAt,
      validUntil:new Date(Math.min(now+21600000,kickoff)).toISOString(),evidenceUrl:row.evidenceUrl,
      verified:true,verificationMethod:'automatic'});
  }
  return signals;
}

async function signalFetchStatarea(source,fixtures,fetchImpl,now,checkedAt) {
  const currentDay=checkedAt.slice(0,10),today=Date.parse(`${currentDay}T00:00:00Z`);
  // Only the site's published date navigator (today through +3) is queried.
  // Beyond that range the site does not yet advertise a public prediction page.
  const dates=[...new Set(fixtures.filter(f=>signalFixtureEligible(f,now)).map(f=>new Date(f.kickoff).toISOString().slice(0,10)))]
    .filter(day=>Date.parse(`${day}T00:00:00Z`)>today&&Date.parse(`${day}T00:00:00Z`)<=today+259200000).sort();
  const urls=[source.url,...dates.map(day=>`${source.url}/date/${day}/competition`)];
  const pages=await Promise.all(urls.map(async url=>{
    const result=await signalReadPublic(url,fetchImpl,now);
    if(result.error)return {url,httpStatus:result.httpStatus,code:result.error,parsedCount:null,rows:[]};
    const publishedDate=result.html.match(/<meta name=['"]pubdate['"] content=['"](20\d{2}-\d{2}-\d{2})['"]/i)?.[1];
    const expectedDate=url===source.url?currentDay:url.match(/\/date\/(20\d{2}-\d{2}-\d{2})\//)?.[1];
    const headerDate=result.html.match(/<h1>Match predictions, statistics and tips for (20\d{2}-\d{2}-\d{2})<\/h1>/)?.[1]||publishedDate;
    if(publishedDate!==currentDay||headerDate!==expectedDate)return {url,httpStatus:result.httpStatus,responseAt:result.responseAt,code:'stale_page',parsedCount:0,rows:[]};
    const rows=parseStatareaSignals(result.html);
    return {url,httpStatus:result.httpStatus,responseAt:result.responseAt,code:rows.length?'parsed':'prediction_format_not_verified',parsedCount:rows.length,rows};
  }));
  const rows=pages.flatMap(page=>page.rows),signals=signalMatchRows(rows,fixtures,source.id,checkedAt,now);
  const errors=pages.filter(page=>page.code!=='parsed');
  const diagnostic={...source,checkedAt,fetchedAt:checkedAt,httpStatus:pages[0]?.httpStatus??null,
    responseAt:pages[0]?.responseAt||null,parsedCount:rows.length,matchedCount:signals.length,
    requests:pages.map(({rows,...page})=>page),coverageThrough:new Date(today+259200000).toISOString().slice(0,10),
    termsUrl:'https://www.statarea.com/help/terms',reviewedAt:signalTermsReviewedAt,
    status:signals.length?'available':rows.length?'pending':'unavailable',
    note:rows.length?`matched_${signals.length}`:errors[0]?.code||'prediction_format_not_verified'};
  if(errors.length&&rows.length)diagnostic.warning='partial_source_failure';
  return {source:diagnostic,signals};
}

async function signalCheckTiantian(source,fetchImpl,now,checkedAt) {
  // These parameters are the official free, not-started filter from its public
  // list UI. Paid lists/details are never fetched or inferred from headlines.
  const body=new URLSearchParams({raceStatus:'0',amountMode:'3',sortType:'10',raceType:'1',gameId:'0',pageNo:'1',pageSize:'30'}).toString();
  const result=await signalReadPublic(source.requestUrl,fetchImpl,now,{method:'POST',body,
    headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'}});
  const diagnostic={...source,checkedAt,fetchedAt:checkedAt,httpStatus:result.httpStatus??null,responseAt:result.responseAt||null,
    parsedCount:null,matchedCount:0,status:'unavailable',note:result.error||'invalid_response',reviewedAt:signalTermsReviewedAt,
    helpUrl:'https://www.ttyingqiu.com/home/help'};
  if(!result.error)try {
    const payload=JSON.parse(result.html);
    if(payload?.isSuccess===true&&(!Object.hasOwn(payload,'data')||Array.isArray(payload.data))){
      diagnostic.parsedCount=payload.data?.length||0;
      diagnostic.status='pending';
      diagnostic.note=diagnostic.parsedCount?'prediction_format_not_verified':'no_free_prematch_signals';
    }
  }catch{}
  return {source:diagnostic,signals:[]};
}

export async function fetchPredictionSignals({fixtures=[],fetchImpl=fetch,nowISO=new Date().toISOString()}={}) {
  const now=Date.parse(nowISO);
  if (!Number.isFinite(now)) throw new Error('Invalid signal observation time');
  const checkedAt=new Date(now).toISOString();
  const outputs=await Promise.all(signalSources.map(async source=>{
    // Explicit source restrictions are assessed without a network request.
    // An ordinary subscription is not permission to scrape or redistribute.
    if(source.restriction)return {source:{...source,status:'restricted',note:'authorization_required',blockerCode:source.restriction,
      checkedAt,reviewedAt:signalTermsReviewedAt,fetchedAt:null,httpStatus:null,parsedCount:null,matchedCount:0},signals:[]};
    if(source.id==='tiantian')return signalCheckTiantian(source,fetchImpl,now,checkedAt);
    return signalFetchStatarea(source,fixtures,fetchImpl,now,checkedAt);
  }));
  return {signals:outputs.flatMap(o=>o.signals),sources:outputs.map(o=>o.source),checkedAt};
}
