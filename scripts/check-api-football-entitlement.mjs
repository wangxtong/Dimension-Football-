// Read-only, bounded credential/entitlement smoke. Never prints API keys or account PII.
// Usage (on an approved runner with rotated secret injected): node scripts/check-api-football-entitlement.mjs
const endpoint = 'https://v3.football.api-sports.io';
const token = process.env.API_FOOTBALL_KEY?.trim();
if (!token) { console.error('API_FOOTBALL_KEY_NOT_CONFIGURED'); process.exitCode=2; }
else {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(endpoint+'/status', { method:'GET', redirect:'manual', signal:controller.signal,
      headers:{ 'x-apisports-key':token } });
    if (!response.ok || response.status !== 200) throw Error(response.status===401?'AUTHORIZATION_FAILED':
      response.status===403?'ACCESS_DENIED':response.status===429?'RATE_LIMITED':'HTTP_UNAVAILABLE');
    const raw = await response.text();
    if (Buffer.byteLength(raw)>65536) throw Error('RESPONSE_TOO_LARGE');
    let json; try { json=JSON.parse(raw); } catch { throw Error('INVALID_JSON'); }
    if (json.get!=='status' || !json.response?.subscription || !json.response?.requests ||
      !Number.isSafeInteger(json.response.requests.limit_day)) throw Error('INVALID_STATUS_SCHEMA');
    const sub=json.response.subscription, usage=json.response.requests;
    const result={ checkedAt:new Date().toISOString(), provider:'api-football', httpStatus:response.status,
      subscription:{plan:typeof sub.plan==='string'?sub.plan:null, active:sub.active===true,
        end:typeof sub.end==='string'?sub.end:null},
      requests:{current:Number.isSafeInteger(usage.current)?usage.current:null,
        limitDay:usage.limit_day},
      minuteLimit:response.headers.get('x-ratelimit-limit')||null,
      dayRemaining:response.headers.get('x-ratelimit-requests-remaining')||null,
      classification:sub.active===true && (!sub.end || Date.parse(sub.end)>Date.now())
        ? 'SUBSCRIPTION_ACTIVE_ACCOUNT_SCOPE_ONLY':'SUBSCRIPTION_NOT_VERIFIED',
      commercialRedistributionRights:'NOT_VERIFIED', fixtureCoverage:'NOT_VERIFIED',
      oddsRights:'NOT_VERIFIED' };
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(result.classification!=='SUBSCRIPTION_ACTIVE_ACCOUNT_SCOPE_ONLY')process.exitCode=1;
  }catch(e){console.error(['AUTHORIZATION_FAILED','ACCESS_DENIED','RATE_LIMITED','HTTP_UNAVAILABLE',
    'RESPONSE_TOO_LARGE','INVALID_JSON','INVALID_STATUS_SCHEMA'].includes(e.message)?e.message:
    controller.signal.aborted?'TIMEOUT':'PROBE_FAILED');process.exitCode=1;}
  finally{clearTimeout(timer);}
}
