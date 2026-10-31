import * as REPORT_FEED from './report-feed.mjs';
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
const loginPage = (message='',status=200,extra={}) => response(LOGIN.replace('<!-- message -->',message?`<p class="error" role="alert">${message}</p>`:''),status,'text/html; charset=utf-8',extra);
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
    const config=configuration(env);if(!config)return response('登录服务尚未配置，请联系管理员。',503);
    const now=Math.floor(clock()/1000),path=new URL(request.url).pathname,method=request.method;
    const sameOrigin=request.headers.get('origin')===config.origin;
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
      if(!attempts.has(ip)&&attempts.size>=5000)return loginPage('登录请求较多，请稍后再试。',429,{'Retry-After':'600'});
      const entry=attempts.get(ip)||{count:0,until:now+600};
      if(entry.count>=10)return loginPage('尝试次数过多，请稍后再试。',429,{'Retry-After':String(Math.max(1,entry.until-now))});
      entry.count++;attempts.set(ip,entry);
      let form;try{form=new URLSearchParams(await boundedBody(request,2048));}catch{return response('表单内容过长。',413);}
      if(form.getAll('username').length!==1||form.getAll('password').length!==1)return loginPage('用户名或密码不正确。',401);
      const username=form.get('username'),password=form.get('password');
      if(username.length>80||password.length>256)return loginPage('用户名或密码不正确。',401);
      const valid=await passwordMatches(password,config);
      if(username!==config.username||!valid)return loginPage('用户名或密码不正确。',401);
      attempts.delete(ip);
      return redirect('/',{'Set-Cookie':cookieValue(await session(config,now))});
    }
    if(path==='/logout'&&method==='POST'){
      if(!sameOrigin)return response('请求来源不匹配。',403);
      return redirect('/login',{'Set-Cookie':`${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`});
    }
    if(!['GET','HEAD'].includes(method))return response('不支持此请求方式。',405,undefined,{Allow:'GET, HEAD'});
    const signedIn=await authenticated(request,config,now);
    if(path==='/login')return signedIn?redirect('/'):method==='HEAD'?response(null,200,'text/html; charset=utf-8'):loginPage();
    if(!signedIn)return path==='/'||path==='/index.html'?redirect('/login'):response('请先登录。',401);
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
    return response(method==='HEAD'?null:assets[file],200,file.endsWith('.mjs')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');
  }};
}
export default createDashboard(typeof EMBEDDED_ASSETS==='undefined'?{}:EMBEDDED_ASSETS);
