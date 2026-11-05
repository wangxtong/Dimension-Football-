// football-data free tier: 10 calls/minute. One queue covers hosted result,
// history and fixture lanes; waiting happens before network-only deadlines.
// https://www.football-data.org/pricing
// https://docs.football-data.org/general/v4/lookup_tables.html
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { retryAfterMs } from './health.mjs';
const quotas = new WeakMap();
const fail = code => { const error=Error(code); error.code=code; throw error; };
export function createFootballDataQuota({clock=()=>Date.now(),sleep=(ms,signal)=>sleepTimer(ms,undefined,{signal}),gapMs=6500}={}) {
  if(!Number.isFinite(gapMs)||gapMs<6001)throw Error('INVALID_FOOTBALL_DATA_QUOTA');
  let tail=Promise.resolve(),nextAt=0,blockedUntil=0;
  return {
    acquire({signal,remaining=()=>Infinity}={}) {
      const task=tail.then(async()=>{
        if(signal?.aborted)fail('cancelled');
        // A response may extend the cooldown while a concurrent caller waits.
        for(;;){
          const delay=Math.max(0,nextAt-clock(),blockedUntil-clock());
          if(remaining()<=delay+1000)fail('budget_exhausted');
          if(!delay)break;
          await sleep(delay,signal);
          if(signal?.aborted)fail('cancelled');
        }
        if(signal?.aborted)fail('cancelled');
        const startedAt=clock(); nextAt=startedAt+gapMs; return startedAt;
      });
      tail=task.catch(()=>{});
      if(!signal)return task;
      return new Promise((resolve,reject)=>{
        const abort=()=>{const error=Error('cancelled');error.code='cancelled';reject(error);};
        signal.addEventListener('abort',abort,{once:true}); if(signal.aborted)abort();
        task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
      });
    },
    observe(response) {
      const now=clock(),headers=response?.headers;
      const retry=retryAfterMs(headers?.get('retry-after'),now);
      const reset=retryAfterMs(headers?.get('x-requestcounter-reset'),now);
      const available=headers?.get('x-requestsavailable') ?? headers?.get('x-requests-available-minute');
      if(response?.status===429)blockedUntil=Math.max(blockedUntil,now+(retry ?? reset ?? 60000));
      else if(available!==null && available!==undefined && /^0$/.test(available.trim()))blockedUntil=Math.max(blockedUntil,now+(reset ?? 60000));
    },
    state(){return {nextAt,blockedUntil};},
  };
}
// Enable at the orchestration boundary, sharing the same fetch function across
// its lanes. The registry holds no credentials and uses no token as a map key.
export function enableFootballDataQuota(fetchImpl,options) {
  if(typeof fetchImpl!=='function')throw Error('INVALID_FOOTBALL_DATA_FETCH');
  if(!quotas.has(fetchImpl))quotas.set(fetchImpl,createFootballDataQuota(options));
  return quotas.get(fetchImpl);
}
export function footballDataQuota(fetchImpl){return quotas.get(fetchImpl) || null;}

// Persist only bounded metadata; provider messages and URLs may contain secrets.
export function safeFootballDataDiagnostics(value) {
  const allowed=new Set(['HISTORY_FETCH_FAILED','HISTORY_FETCH_UNCONFIRMED','HISTORY_INVALID_JSON','HISTORY_INVALID_PAYLOAD','HISTORY_KEY_REQUIRED','HISTORY_BUDGET_EXHAUSTED','HISTORY_CANCELLED']);
  const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:null;
  return (Array.isArray(value)?value:[]).filter(row=>row&&typeof row==='object').slice(0,10).map(row=>({
    source:'football-data.org',league:['PL','PD','SA','BL1','FL1'].includes(row.league)?row.league:null,
    status:row.status==='available'?'available':'unavailable',
    code:row.status==='available'?'OK':allowed.has(row.code)||/^HISTORY_HTTP_[45][0-9]{2}$/.test(row.code||'')?row.code:'HISTORY_FETCH_UNCONFIRMED',
    httpStatus:Number.isSafeInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599?row.httpStatus:null,
    matchedCount:count(row.matchedCount),receivedCount:count(row.receivedCount),
  }));
}


