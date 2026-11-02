import * as REPORT_FEED from './report-feed.mjs';
import { handleHostedRequest, loadHostedBundle, updateHostedReceipt } from './hosted-publications.mjs';
import { verifyActionsIdentity } from './github-oidc.mjs';
import { saveDailyResearch, readDailyResearch } from './research-daily-store.mjs';
import { notifyHostedReport } from './hosted-notifications.mjs';
import { notifyDailyObservation, readDailyObservationStatus } from './daily-observation-notifications.mjs';
import { handleTelegramWebhook, readTelegramBotStatus } from './telegram-bot.mjs';
const COOKIE = '__Host-dimension_session', SESSION_SECONDS = 43200;
const encoder = new TextEncoder();
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode = value => Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
const hex = value => Uint8Array.from(value.match(/../g), x => parseInt(x,16));
const LOGIN = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 维度足球</title>
<style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0c151b;color:#e9f1f2;font:16px/1.6 system-ui,sans-serif;padding:24px}main{width:min(100%,420px);padding:34px;background:#14212a;border:1px solid #2b3c45;border-radius:16px}.brand{color:#b6ed90;font-size:13px;letter-spacing:3px}h1{font-size:29px;margin:14px 0 5px}p{color:#93a8b1;font-size:14px}label{display:block;margin:22px 0 7px;font-size:14px}input{width:100%;padding:12px;border:1px solid #3b505a;border-radius:7px;background:#0c151b;color:#e9f1f2;font:inherit}input:focus{outline:2px solid #b6ed90;outline-offset:2px}button{width:100%;margin-top:26px;padding:12px;border:0;border-radius:7px;background:#b6ed90;color:#14212a;font:600 16px system-ui;cursor:pointer}.error{color:#efc67e}.note{font-size:12px;margin-top:22px}</style></head>
<body><main><div class="brand">维度足球</div><h1>登录预测看板</h1><p>输入访问账号，查看最新比赛分析。</p><!-- message -->
<form method="post" action="/login"><label for="username">用户名</label><input id="username" name="username" autocomplete="username" maxlength="80" required>
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" maxlength="256" required><button type="submit">登录看板 →</button></form>
<p class="note">登录有效期为 12 小时，可随时退出。</p></main></body></html>`;
const baseHeaders = {
  'Cache-Control':'private, no-store, max-age=0', 'Vary':'Cookie', 'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'same-origin', 'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const response = (body,status=200,type='text/plain; charset=utf-8',extra={}) => new Response(body,{status,headers:{...baseHeaders,'Content-Type':type,...extra}});
const loginPage = (message='',status=200,extra={},view='') => response(LOGIN.replace('action="/login"',view ? 'action="/login?view='+view+'"' : 'action="/login"').replace('<!-- message -->',message?`<p class="error" role="alert">${message}</p>`:''),status,'text/html; charset=utf-8',extra);
const redirect = (path,headers={}) => response(null,303,'text/plain; charset=utf-8',{Location:path,...headers});
const cookieValue = token => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;

function configuration(env) {
  let auth;try{auth=JSON.parse(env.DASHBOARD_AUTH);}catch{return null;}
  if(typeof auth.username!=='string'||!auth.username||auth.username.length>80||auth.iterations!==100000
    ||!/^([a-f0-9]{32})$/.test(auth.salt)||!/^([a-f0-9]{64})$/.test(auth.hash)||!/^([a-f0-9]{64})$/.test(env.DASHBOARD_SESSION_SECRET||''))return null;
  let origin;try{origin=new URL(env.DASHBOARD_ORIGIN).origin;}catch{return null;}
  return {...auth,origin,sessionSecret:env.DASHBOARD_SESSION_SECRET};
}
async function signingKey(config) {
  return crypto.subtle.importKey('raw',encoder.encode(config.sessionSecret+'\0'+config.hash),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
}
async function session(config,now) {
  const payload=encode(encoder.encode(JSON.stringify({v:1,user:config.username,iat:now,exp:now+SESSION_SECONDS,nonce:crypto.randomUUID()})));
  const signature=encode(await crypto.subtle.sign('HMAC',await signingKey(config),encoder.encode(payload)));
  return payload+'.'+signature;
}
async function authenticated(request,config,now) {
  const values=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(COOKIE+'='));
  if(values.length!==1)return false;
  const token=values[0].slice(COOKIE.length+1);if(token.length>1500||!(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/).test(token))return false;
  try{
    const [payload,signature]=token.split('.');
    if(!await crypto.subtle.verify('HMAC',await signingKey(config),decode(signature),encoder.encode(payload)))return false;
    const data=JSON.parse(new TextDecoder().decode(decode(payload)));
    return data.v===1&&data.user===config.username&&Number.isSafeInteger(data.iat)&&Number.isSafeInteger(data.exp)
      &&data.iat<=now&&data.exp>now&&data.exp===data.iat+SESSION_SECONDS;
  }catch{return false;}
}
async function passwordMatches(password,config) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const result=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:hex(config.salt),iterations:config.iterations},key,256));
  const expected=hex(config.hash);let difference=0;for(let i=0;i<32;i++)difference|=result[i]^expected[i];return difference===0;
}
async function boundedBody(request,limit) {
  if(Number(request.headers.get('content-length'))>limit)throw Error('too_large');
  const reader=request.body?.getReader();if(!reader)return '';
  let length=0,text='';const decoder=new TextDecoder();
  try{for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>limit)throw Error('too_large');text+=decoder.decode(part.value,{stream:true});}return text+decoder.decode();}
  finally{await reader.cancel().catch(()=>{});}
}

export function createDashboard(assets, {clock=()=>Date.now(),fetchImpl=(...args)=>fetch(...args)}={}) {
  // Bounded per-isolate abuse protection. It is not a persistent/global rate limit.
  const attempts=new Map();
  return {async fetch(request,env) {
    const path=new URL(request.url).pathname,method=request.method;
    if(path==='/telegram/webhook')return handleTelegramWebhook(request,env,{fetchImpl,now:clock(),loadBundle:loadHostedBundle,
      assets,loadObservationReceipt:readDailyObservationStatus});
    const config=configuration(env);if(!config)return response('登录服务尚未配置，请联系管理员。',503);
    const now=Math.floor(clock()/1000);
    const requestedView = new URL(request.url).searchParams.get('view');
    const view = ['analysis','strict','missing','schedule','status','picks','backtest','overview'].includes(requestedView) ? requestedView : '';
    const landing = view ? '/?view='+view+'#'+view : '/';
    const loginPath = view ? '/login?view='+view : '/login';
    const sameOrigin=request.headers.get('origin')===config.origin;
    if(env.HOSTED_PUBLICATION_ENABLED==='true'&&path.startsWith('/internal/')) {
      if(path==='/internal/research-daily') {
        if(!['GET','POST'].includes(method))return response(JSON.stringify({error:'METHOD_NOT_ALLOWED'}),405,'application/json; charset=utf-8');
        try { await verifyActionsIdentity(request,env,{fetchImpl,now:clock()}); }
        catch { return response(JSON.stringify({error:'MACHINE_IDENTITY_REQUIRED'}),401,'application/json; charset=utf-8'); }
        try {
          if(method==='GET') {
            const record=await readDailyResearch(env);
            return response(record?JSON.stringify(record):JSON.stringify({error:'RESEARCH_REPORT_NOT_FOUND'}),record?200:404,'application/json; charset=utf-8');
          }
          if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')
            return response(JSON.stringify({error:'RESEARCH_REQUEST_INVALID'}),415,'application/json; charset=utf-8');
          const record=JSON.parse(await boundedBody(request,750000));
          const saved=await saveDailyResearch(env,record,{now:clock()});
          return response(JSON.stringify(saved),200,'application/json; charset=utf-8');
        }catch(error){
          const allowed=['RESEARCH_REPORT_INVALID','RESEARCH_FORECAST_INVALID','RESEARCH_DUPLICATE_FIXTURE',
            'RESEARCH_REPORT_HASH_MISMATCH','RESEARCH_REPORT_STALE','RESEARCH_REPORT_ORDER_CONFLICT','RESEARCH_POINTER_CONFLICT',
            'RESEARCH_STORAGE_INVALID','RESEARCH_STORAGE_UNAVAILABLE','RESEARCH_REPORT_CONFLICT'];
          const code=allowed.includes(error.code)?error.code:'RESEARCH_REQUEST_INVALID';
          return response(JSON.stringify({error:code}),allowed.includes(error.code)?error.status:400,'application/json; charset=utf-8');
        }
      }
      if(path==='/internal/observation-notifications') {
        if(method!=='POST')return response('不支持此请求方式。',405);
        try {await verifyActionsIdentity(request,env,{fetchImpl,now:clock()});}
        catch{return response(JSON.stringify({error:'MACHINE_IDENTITY_REQUIRED'}),401,'application/json; charset=utf-8');}
        if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()!=='application/json')return response(JSON.stringify({error:'DAILY_REQUEST_INVALID'}),400,'application/json; charset=utf-8');
        let body;
        try {body=JSON.parse(await boundedBody(request,4096));}
        catch{return response(JSON.stringify({error:'DAILY_REQUEST_INVALID'}),400,'application/json; charset=utf-8');}
        try {
          const result=await notifyDailyObservation(env,{body,fetchImpl,now:clock(),loadBundle:loadHostedBundle});
          const status=result.receipt.status==='unknown'?503:result.receipt.status==='failed'?502:200;
          return response(JSON.stringify(result),status,'application/json; charset=utf-8');
        } catch(error) {
          const allowed=['DAILY_REQUEST_INVALID','DAILY_CREDENTIALS_REQUIRED','DAILY_CONFIGURATION_INVALID','DAILY_DESTINATION_MISMATCH','DAILY_ORIGIN_INVALID',
            'DAILY_STORAGE_UNAVAILABLE','DAILY_STORAGE_INVALID','DAILY_REPORT_INVALID','DAILY_REPORT_NOT_CURRENT','DAILY_OBSERVATION_REQUIRED','DAILY_REPORT_READBACK_REQUIRED','DAILY_REPORT_EXPIRED'];
          const code=allowed.includes(error.code)?error.code:'DAILY_NOTIFICATION_FAILED';
          return response(JSON.stringify({error:code}),allowed.includes(error.code)?error.status:503,'application/json; charset=utf-8');
        }
      }
      if(path==='/internal/notifications') {
        if(method!=='POST')return response('不支持此请求方式。',405);
        try { await verifyActionsIdentity(request,env,{fetchImpl,now:clock()}); }
        catch { return response(JSON.stringify({error:'MACHINE_IDENTITY_REQUIRED'}),401,'application/json; charset=utf-8'); }
        let body;try {body=JSON.parse(await boundedBody(request,4096));} catch {return response(JSON.stringify({error:'INVALID_NOTIFICATION_REQUEST'}),400,'application/json; charset=utf-8');}
        if(!body||!/^[a-f0-9]{64}$/.test(body.reportId||''))return response(JSON.stringify({error:'INVALID_NOTIFICATION_REQUEST'}),400,'application/json; charset=utf-8');
        try {
          const receipt=await notifyHostedReport(env,{reportId:body.reportId,fetchImpl,now:clock(),loadBundle:loadHostedBundle,updateReceipt:updateHostedReceipt});
          return response(JSON.stringify({receipt}),200,'application/json; charset=utf-8');
        } catch (error) { return response(JSON.stringify({error:error.code === 'RELEASE_GATE_BLOCKED' ? 'RELEASE_GATE_BLOCKED' : 'HOSTED_NOTIFICATION_FAILED'}),error.code === 'RELEASE_GATE_BLOCKED' ? 409 : 503,'application/json; charset=utf-8'); }
      }
      const hosted=await handleHostedRequest(request,env,{fetchImpl,now:clock()});
      if(hosted)return hosted;
    }
    if(path==='/internal/report-status'){
      const token=env.REPORTS_PROBE_TOKEN;
      if(method!=='GET')return response('不支持此请求方式。',405);
      if(!/^[a-f0-9]{64}$/.test(token||'')||request.headers.get('authorization')!=='Bearer '+token)return response('访问未授权。',401);
      try{
        const bundle=await REPORT_FEED.readDashboardBundle(env,{fetchImpl,now:clock()});
        return response(JSON.stringify({version:1,reportId:bundle.reportId,reportHash:bundle.reportHash,generatedAt:bundle.report.generatedAt,mode:bundle.freshness.mode,health:bundle.health.status}),200,'application/json; charset=utf-8');
      }catch{return response(JSON.stringify({error:'REPORT_UPSTREAM_UNAVAILABLE'}),503,'application/json; charset=utf-8');}
    }
    if(path==='/login'&&method==='POST'){
      if(!sameOrigin)return response('请求来源不匹配。',403);
      if(!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))return response('不支持的表单格式。',415);
      const ip=request.headers.get('cf-connecting-ip')||'unknown';
      for(const [key,value] of attempts)if(value.until<=now)attempts.delete(key);
      if(!attempts.has(ip)&&attempts.size>=5000)return loginPage('登录请求较多，请稍后再试。',429,{'Retry-After':'600'},view);
      const entry=attempts.get(ip)||{count:0,until:now+600};
      if(entry.count>=10)return loginPage('尝试次数过多，请稍后再试。',429,{'Retry-After':String(Math.max(1,entry.until-now))},view);
      entry.count++;attempts.set(ip,entry);
      let form;try{form=new URLSearchParams(await boundedBody(request,2048));}catch{return response('表单内容过长。',413);}
      if(form.getAll('username').length!==1||form.getAll('password').length!==1)return loginPage('用户名或密码不正确。',401,{},view);
      const username=form.get('username'),password=form.get('password');
      if(username.length>80||password.length>256)return loginPage('用户名或密码不正确。',401,{},view);
      const valid=await passwordMatches(password,config);
      if(username!==config.username||!valid)return loginPage('用户名或密码不正确。',401,{},view);
      attempts.delete(ip);
      return redirect(landing,{'Set-Cookie':cookieValue(await session(config,now))});
    }
    if(path==='/logout'&&method==='POST'){
      if(!sameOrigin)return response('请求来源不匹配。',403);
      return redirect('/login',{'Set-Cookie':`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`});
    }
    if(!['GET','HEAD'].includes(method))return response('不支持此请求方式。',405,undefined,{Allow:'GET, HEAD'});
    const signedIn=await authenticated(request,config,now);
    if(path==='/login')return signedIn?redirect(landing):method==='HEAD'?response(null,200,'text/html; charset=utf-8'):loginPage('',200,{},view);
    if(!signedIn)return path==='/'||path==='/index.html'?redirect(loginPath):response('请先登录。',401);
    if(path==='/api/research-daily') {
      if(env.HOSTED_PUBLICATION_ENABLED!=='true')
        return response(JSON.stringify({error:'RESEARCH_STORAGE_UNAVAILABLE'}),503,'application/json; charset=utf-8');
      try {
        const record=await readDailyResearch(env);
        return response(method==='HEAD'?null:JSON.stringify(record||{error:'RESEARCH_REPORT_NOT_FOUND'}),record?200:404,
          'application/json; charset=utf-8',record?{'X-Research-Report-Id':record.reportId}:{});
      }catch{return response(JSON.stringify({error:'RESEARCH_STORAGE_UNAVAILABLE'}),503,'application/json; charset=utf-8');}
    }
    if(path==='/api/telegram-bot-status') {
      try {const result=await readTelegramBotStatus(env,{now:clock()});return response(method==='HEAD'?null:JSON.stringify(result),200,'application/json; charset=utf-8');}
      catch{return response(JSON.stringify({error:'BOT_STATUS_UNAVAILABLE'}),503,'application/json; charset=utf-8');}
    }
    if(path==='/api/observation-notifications') {
      if(env.HOSTED_PUBLICATION_ENABLED!=='true')return response(JSON.stringify({error:'DAILY_STORAGE_UNAVAILABLE'}),503,'application/json; charset=utf-8');
      try {const result=await readDailyObservationStatus(env,{now:clock()});return response(method==='HEAD'?null:JSON.stringify(result),200,'application/json; charset=utf-8');}
      catch{return response(JSON.stringify({error:'DAILY_STORAGE_UNAVAILABLE'}),503,'application/json; charset=utf-8');}
    }
    if(['/api/report','/api/predictions.json','/api/publication.json','/api/openligadb-fixtures.json'].includes(path)){
      try{
        const bundle=await REPORT_FEED.readDashboardBundle(env,{fetchImpl,now:clock()});
        const data=REPORT_FEED.dashboardBundleFile(bundle,path);
        if(data===null)return response(JSON.stringify({error:'REPORT_COMPONENT_UNAVAILABLE'}),404,'application/json; charset=utf-8');
        return response(method==='HEAD'?null:JSON.stringify(data),200,'application/json; charset=utf-8',{'X-Report-Id':bundle.reportId});
      }catch{return response(JSON.stringify({error:'REPORT_UPSTREAM_UNAVAILABLE'}),502,'application/json; charset=utf-8');}
    }
    const file=path==='/'?'/index.html':path;
    if(!Object.hasOwn(assets,file))return response('页面不存在。',404);
    return response(method==='HEAD'?null:assets[file],200,file.endsWith('.mjs')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8');
  }};
}
export default createDashboard(typeof EMBEDDED_ASSETS==='undefined'?{}:EMBEDDED_ASSETS);
