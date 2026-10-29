import {teamName} from './team-names.mjs';

// Company IDs are corroborated by Titan's own commonWs.js and the named
// company table in iSports' public documentation. They are separate prices,
// not independent prediction votes and not evidence of a shared trading feed.
export const marketSourceRegistry = [
  {id:'m88',name:'M88',bookmaker:'M88',companyId:17},
  {id:'12bet',name:'12bet',bookmaker:'12Bet',companyId:24},
  {id:'sbobet',name:'SBOBET',bookmaker:'SBOBET',companyId:31},
];
const marketSourceLeagueNames={PL:'英超',PD:'西甲',SA:'意甲',BL1:'德甲',FL1:'法甲'};
const marketSourceAliases={'巴黎圣日尔曼':'巴黎圣日耳曼','巴黎圣日门':'巴黎圣日耳曼','AC 米兰':'AC米兰','门兴':'门兴格拉德巴赫','霍芬海姆':'霍芬海姆','云达不莱梅':'云达不莱梅'};
const marketSourceEvidence=['https://live.titan007.com/commonWs.js','https://live.titan007.com/common2.js','https://www.isportsapi.com/docs.html?id=24&lang=en'];
const marketSourceFailureReasons={access_denied:'公开赔率源返回 HTTP 403，拒绝本次访问。',authorization_required:'公开赔率源返回 HTTP 401，要求授权。',
  rate_limited:'公开赔率源返回 HTTP 429，请求受限。',http_unavailable:'公开赔率源返回非成功 HTTP 状态，未取得可用快照。',
  stale_snapshot:'快照更新时间或服务器时间未通过核验，不能当作当前盘口。',empty_snapshot:'服务器返回空快照，没有可解析赔率。',
  snapshot_too_large:'快照超过已核验的数据大小上限，已停止解析。',timeout:'8 秒内未取得完整快照，已停止本次请求。',
  network_unavailable:'网络请求未成功，未取得可校验快照。',invalid_schedule:'赛程快照不符合已核验格式，无法关联比赛。',
  invalid_snapshot:'赔率快照不符合已核验的 XML 字段格式。',maintenance:'公开源标记赔率数据正在维护。'};
class MarketSourceError extends Error {
  constructor(code,status){super(code);this.code=code;if(status)this.status=status;}
}
function marketSourceName(value){
  if(typeof value!=='string'||!value.trim())return '';
  const name=teamName(value.trim().normalize('NFKC')).toLowerCase().replace(/\s+/gu,' ').trim();
  return Object.hasOwn(marketSourceAliases,name)?marketSourceAliases[name]:name;
}
function marketSourceKickoff(row){
  if(!/^20\d{2}$/.test(row[43]||'')||!/^\d{2}-\d{2}$/.test(row[36]||'')||!/^\d{2}:\d{2}$/.test(row[11]||''))return NaN;
  const date=`${row[43]}-${row[36]}T${row[11]}:00+08:00`,ms=Date.parse(date);
  return Number.isFinite(ms)&&new Date(ms+8*3600000).toISOString().slice(0,16)===date.slice(0,16)?ms:NaN;
}
function marketSourceFixtureAllowed(fixture,now){
  const kickoff=Date.parse(fixture?.kickoff);
  return !!fixture?.id&&!fixture.demo&&fixture.source!=='fictional-demo'&&['TIMED','SCHEDULED'].includes(fixture.status)
    &&!!marketSourceLeagueNames[fixture.league]&&Number.isFinite(kickoff)&&kickoff>now&&kickoff-now<=14*86400000
    &&!!marketSourceName(fixture.home)&&!!marketSourceName(fixture.away)&&marketSourceName(fixture.home)!==marketSourceName(fixture.away);
}
async function marketSourceRead(path,companyId,fetchImpl,now){
  const controller=new AbortController();let timer;
  const feedUrl=`https://livestatic.titan007.com/vbsxml/${path}`;
  try{
    const operation=(async()=>{
      const response=await fetchImpl(`${feedUrl}?r=007${now}`,{method:'GET',redirect:'manual',signal:controller.signal,
        headers:{Referer:`https://live.titan007.com/index2in1.aspx?id=${companyId}`,Accept:'text/plain, application/javascript, text/xml','User-Agent':'VantisSports-OddsReader/1.0'}});
      const status=response?.status||0;
      if(!response?.ok)throw new MarketSourceError(status===403?'access_denied':status===401?'authorization_required':status===429?'rate_limited':'http_unavailable',status);
      const updated=Date.parse(response.headers?.get('last-modified')),served=Date.parse(response.headers?.get('date'));
      if(!Number.isFinite(updated)||!Number.isFinite(served)||Math.abs(now-served)>300000||updated>now+30000
        ||now-updated>(path==='bfdata_ut.js'?86400000:300000))throw new MarketSourceError('stale_snapshot',status);
      const reader=response.body?.getReader();if(!reader)throw new MarketSourceError('empty_snapshot',status);
      const decoder=new TextDecoder();let text='',bytes=0;
      try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>1500000)throw new MarketSourceError('snapshot_too_large',status);text+=decoder.decode(chunk.value,{stream:true});}text+=decoder.decode();}
      finally{await reader.cancel().catch(()=>{});}
      if(!text)throw new MarketSourceError('empty_snapshot',status);
      return {text,httpStatus:status,sourceUpdatedAt:new Date(updated).toISOString(),feedUrl};
    })();
    return await Promise.race([operation,new Promise((resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new MarketSourceError('timeout'));},8000);})]);
  }catch(error){if(error instanceof MarketSourceError)throw error;throw new MarketSourceError('network_unavailable');}
  finally{clearTimeout(timer);}
}
function marketSourceSchedule(text){
  const events=[];
  for(const match of text.matchAll(/A\[\d+\]\s*=\s*("(?:[^"\\]|\\.)*")\.split\('\^'\)/g)){
    let row;try{row=JSON.parse(match[1]).split('^');}catch{throw new MarketSourceError('invalid_schedule');}
    if(row.length<44||!/^\d{1,20}$/.test(row[0])||events.length>=3000)throw new MarketSourceError('invalid_schedule');
    events.push(row);
  }
  if(!events.length)throw new MarketSourceError('invalid_schedule');return events;
}
function marketSourcePrices(text){
  if(/<!DOCTYPE|<!ENTITY/i.test(text)||!/^\s*(?:<\?xml[^>]*>\s*)?<c>/.test(text)||!/<\/c>\s*$/.test(text))throw new MarketSourceError('invalid_snapshot');
  const maintenance=[...text.matchAll(/<isMaintain>([01])<\/isMaintain>/g)],sections=[...text.matchAll(/<match>([\s\S]*?)<\/match>/g)];
  if(maintenance.length!==1||sections.length!==1)throw new MarketSourceError('invalid_snapshot');
  if(maintenance[0][1]!=='0')throw new MarketSourceError('maintenance');
  const markets=new Map();let parsedCount=0;
  for(const match of sections[0][1].matchAll(/<m>([^<>]*)<\/m>/g)){
    if(++parsedCount>3000)throw new MarketSourceError('invalid_snapshot');
    const row=match[1].split(','),entries=markets.get(row[0])||[];entries.push(row);markets.set(row[0],entries);
  }
  return {markets,parsedCount};
}
function marketSourceQuote(fixture,events,prices,source,priceData,scheduleData,now){
  const kickoff=Date.parse(fixture.kickoff);
  const candidates=events.filter(row=>row[2]===marketSourceLeagueNames[fixture.league]&&marketSourceName(row[5])===marketSourceName(fixture.home)
    &&marketSourceName(row[8])===marketSourceName(fixture.away)&&Math.abs(marketSourceKickoff(row)-kickoff)<=300000);
  if(candidates.length!==1||candidates[0][13]!=='0'||marketSourceKickoff(candidates[0])<=now)return null;
  const id=candidates[0][0],rows=prices.get(id)||[];if(rows.length!==1)return null;const row=rows[0];
  if(row.length<19||!['0','1'].includes(row[13])||row[14]!=='0'||!/^\d{1,20}$/.test(row[1]))return null;
  const values=[row[2],row[3],row[4]].map(value=>/^-?\d+(?:\.\d+)?$/.test(value||'')?Number(value):NaN),[line,home,away]=values;
  if(!Number.isFinite(line)||Math.abs(line)>10||!Number.isInteger(line*4)||![home,away].every(value=>Number.isFinite(value)&&value>0&&value<=20))return null;
  const observedAt=new Date(now).toISOString(),base={bookmaker:source.bookmaker,companyId:source.companyId,source:'titan007-public-market',
    sourceUrl:`https://live.titan007.com/index2in1.aspx?id=${source.companyId}`,sourceLabel:`${source.name}（球探公开指数）`,providerMatchId:id,
    observedAt,sourceUpdatedAt:priceData.sourceUpdatedAt,market:'asian-handicap',period:'full-time'};
  return {...base,sourceId:source.id,provider:'titan007-public-market',scheduleUpdatedAt:scheduleData.sourceUpdatedAt,
    fixtureSnapshot:{id:fixture.id,home:fixture.home,away:fixture.away,league:fixture.league,kickoff:fixture.kickoff,source:fixture.source},
    validUntil:new Date(Math.min(now+300000,Date.parse(priceData.sourceUpdatedAt)+300000,kickoff)).toISOString(),maintenance:false,inPlay:false,closed:false,
    quotes:[{...base,selection:'home',handicap:line===0?0:-line,decimalOdds:Number((1+home).toFixed(4))},
      {...base,selection:'away',handicap:line===0?0:line,decimalOdds:Number((1+away).toFixed(4))}]};
}

export function isMarketQuoteCurrent(quote,fixture,nowISO=new Date().toISOString()){
  const now=Date.parse(nowISO),source=marketSourceRegistry.find(entry=>entry.id===quote?.sourceId);
  if(!Number.isFinite(now)||!source||!marketSourceFixtureAllowed(fixture,now)||quote.provider!=='titan007-public-market'||quote.bookmaker!==source.bookmaker
    ||quote.companyId!==source.companyId||quote.sourceUrl!==`https://live.titan007.com/index2in1.aspx?id=${source.companyId}`
    ||quote.source!=='titan007-public-market'||!/^\d{1,20}$/.test(quote.providerMatchId||'')||quote.market!=='asian-handicap'||quote.period!=='full-time'||quote.maintenance!==false||quote.inPlay!==false||quote.closed!==false)return false;
  if(!['id','home','away','league','kickoff','source'].every(key=>quote.fixtureSnapshot?.[key]===fixture[key]))return false;
  const times=[quote.observedAt,quote.sourceUpdatedAt,quote.scheduleUpdatedAt,quote.validUntil].map(value=>Date.parse(value));
  if(!times.every(Number.isFinite)||times[0]>now+30000||times[1]>now+30000||times[2]>now+30000||now-times[0]>300000||now-times[1]>300000||now-times[2]>86400000||times[3]<=now)return false;
  if(!Array.isArray(quote.quotes)||quote.quotes.length!==2)return false;
  const home=quote.quotes.find(q=>q.selection==='home'),away=quote.quotes.find(q=>q.selection==='away');
  return !!home&&!!away&&home.handicap===-away.handicap&&quote.quotes.every(q=>q.bookmaker===source.bookmaker&&q.companyId===source.companyId
    &&q.source==='titan007-public-market'&&q.sourceUrl===quote.sourceUrl&&q.providerMatchId===quote.providerMatchId&&q.observedAt===quote.observedAt&&q.sourceUpdatedAt===quote.sourceUpdatedAt
    &&q.market==='asian-handicap'&&q.period==='full-time'&&Number.isFinite(q.handicap)&&Math.abs(q.handicap)<=10&&Number.isInteger(q.handicap*4)
    &&Number.isFinite(q.decimalOdds)&&q.decimalOdds>1&&q.decimalOdds<=21);
}

export async function fetchMarketSourceAudit({fixtures=[],fetchImpl=fetch,nowISO=new Date().toISOString()}={}){
  const now=Date.parse(nowISO);
  if(!Array.isArray(fixtures)||fixtures.length>3000||!Number.isFinite(now)||typeof fetchImpl!=='function')throw new TypeError('Invalid market source request');
  const checkedAt=new Date(now).toISOString(),eligible=fixtures.filter(f=>marketSourceFixtureAllowed(f,now));
  const sources=[],quotes=[];
  const pending=[
    {id:'singbet',name:'Singbet',url:'https://ac88dev.atlassian.net/wiki/spaces/AWA/pages/542900336/4.3.+GetMatches'},
    {id:'ibc',name:'IBC Sports',url:'https://ac88dev.atlassian.net/wiki/spaces/AWA/pages/542900336/4.3.+GetMatches'},
  ].map(source=>({...source,status:'unavailable',note:'authorization_required',reason:'已核实 Asianodds 文档提供该公司，但 GetMatches 明确要求登录生成的 AOToken；当前没有获授权的账号令牌，未发现可核实的匿名赔率源。',
    action:'需获授权的账号令牌，并复核该账号的公司可用状态；当前使用已取得的真实公开报价。',checkedAt,checkType:'configuration',evidence:[source.url,'https://ac88dev.atlassian.net/wiki/spaces/AWA/pages/352157793/3.3.+GetBookies'],matchedCount:0,parsedCount:0}));
  if(!eligible.length)return {quotes,sources:[...marketSourceRegistry.map(source=>({...source,status:'pending',note:'no_eligible_fixtures',reason:'当前没有可严格匹配的未开赛五大联赛场次。',action:'出现覆盖范围内的未开赛比赛后自动获取。',checkedAt,matchedCount:0,parsedCount:0,evidence:marketSourceEvidence})),...pending],checkedAt};
  const results=await Promise.allSettled([marketSourceRead('bfdata_ut.js',17,fetchImpl,now),...marketSourceRegistry.map(source=>marketSourceRead(`goal${source.companyId}.xml`,source.companyId,fetchImpl,now))]);
  let events,scheduleError;
  try{if(results[0].status!=='fulfilled')throw results[0].reason;events=marketSourceSchedule(results[0].value.text);}catch(error){scheduleError=error;}
  for(let i=0;i<marketSourceRegistry.length;i++){
    const source=marketSourceRegistry[i],result=results[i+1],url=`https://live.titan007.com/index2in1.aspx?id=${source.companyId}`;
    const common={...source,url,checkedAt,checkType:'live-feed',evidence:marketSourceEvidence,feedUrl:`https://livestatic.titan007.com/vbsxml/goal${source.companyId}.xml`};
    try{
      if(result.status!=='fulfilled')throw result.reason;const priceData=result.value,parsed=marketSourcePrices(priceData.text);
      if(scheduleError)throw scheduleError;
      const matched=eligible.map(fixture=>({fixtureId:fixture.id,quote:marketSourceQuote(fixture,events,parsed.markets,source,priceData,results[0].value,now)})).filter(item=>item.quote&&isMarketQuoteCurrent(item.quote,eligible.find(f=>f.id===item.fixtureId),checkedAt));
      quotes.push(...matched);
      sources.push({...common,status:matched.length?'available':'pending',note:matched.length?`matched_${matched.length}`:'no_fixture_match',httpStatus:priceData.httpStatus,
        sourceUpdatedAt:priceData.sourceUpdatedAt,parsedCount:parsed.parsedCount,matchedCount:matched.length,
        reason:matched.length?`已读取并严格匹配 ${matched.length} 场真实赛前亚洲盘。`:`公开快照含 ${parsed.parsedCount} 场指数，但当前赛程没有通过球队、联赛、开赛时间及开盘状态核验的报价。`,
        action:'每轮采集时获取；盘口及水位分别显示，三家公司共享球探来源组，不计为三个独立来源。'});
    }catch(error){
      sources.push({...common,status:'unavailable',note:error?.code||'network_unavailable',httpStatus:error?.status||null,matchedCount:0,parsedCount:0,
        reason:(scheduleError===error?'赛程身份快照校验失败，无法安全关联到比赛：':'')+(marketSourceFailureReasons[error?.code]||marketSourceFailureReasons.network_unavailable),action:'保留具体错误代码，下一轮自动重新核验；失效报价不参与比较。'});
    }
  }
  return {quotes,sources:[...sources,...pending],checkedAt};
}
