import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { createDashboard } from '../worker.mjs';
const ORIGIN='https://dashboard.example',PASSWORD='test-only-password',SALT='a1'.repeat(16);
const AUTH={username:'test-viewer',iterations:100000,salt:SALT,hash:pbkdf2Sync(PASSWORD,Buffer.from(SALT,'hex'),100000,32,'sha256').toString('hex')};
const env={DASHBOARD_AUTH:JSON.stringify(AUTH),DASHBOARD_SESSION_SECRET:'a2'.repeat(32),DASHBOARD_ORIGIN:ORIGIN,REPORTS_GITHUB_TOKEN:'unit-test-example-private-repo-read-access'};
const assets={'/index.html':'<h1>protected-report</h1>','/app.mjs':'/* protected-js */','/style.css':'body{}'};
const request=(path,options={})=>new Request(ORIGIN+path,options);
const post=(password=PASSWORD,extra={})=>request('/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/x-www-form-urlencoded',...extra},body:new URLSearchParams({username:AUTH.username,password})});
const cookie=r=>r.headers.get('set-cookie').split(';')[0];

test('anonymous visitors get the custom login; direct assets and reports are protected',async()=>{
  let calls=0;const app=createDashboard(assets,{fetchImpl:async()=>{calls++;}});
  const root=await app.fetch(request('/'),env);assert.equal(root.status,303);assert.equal(root.headers.get('location'),'/login');
  const login=await app.fetch(request('/login'),env),html=await login.text();assert.ok(html.includes('登录预测看板'));assert.ok(!html.includes(PASSWORD));assert.ok(!html.includes(AUTH.hash));
  for(const path of ['/app.mjs','/style.css','/api/predictions.json','/api/publication.json','/api/openligadb-fixtures.json'])assert.equal((await app.fetch(request(path),env)).status,401);
  assert.equal(calls,0);assert.match(login.headers.get('cache-control'),/no-store/);assert.match(login.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('correct credentials issue a secure cookie and authorize the dashboard and fixed data proxy',async()=>{
  const calls=[];const app=createDashboard(assets,{fetchImpl:async(url,options)=>{calls.push({url,options});const body=JSON.stringify({report:'live'});return Response.json({type:'file',name:'predictions.json',encoding:'base64',size:Buffer.byteLength(body),content:Buffer.from(body).toString('base64')});}});
  const login=await app.fetch(post(),env);assert.equal(login.status,303);const session=cookie(login);
  assert.match(login.headers.get('set-cookie'),/^__Host-dimension_session=.*; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  assert.ok(!session.includes(PASSWORD));assert.ok(!session.includes(env.DASHBOARD_SESSION_SECRET));
  const page=await app.fetch(request('/',{headers:{Cookie:session}}),env);assert.equal(page.status,200);assert.equal(await page.text(),assets['/index.html']);
  const data=await app.fetch(request('/api/predictions.json?target=https://evil.example',{headers:{Cookie:session}}),env);
  assert.equal(data.status,200);assert.deepEqual(await data.json(),{report:'live'});assert.equal(calls[0].url,'https://api.github.com/repos/wangxtong/Dimension-Football-/contents/predictions.json?ref=published-reports');
  assert.equal(calls[0].options.redirect,'manual');assert.deepEqual(calls[0].options.headers,{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:'Bearer '+env.REPORTS_GITHUB_TOKEN});
  assert.equal((await app.fetch(request('/worker.mjs',{headers:{Cookie:session}}),env)).status,404);
});
test('wrong passwords, cross-origin forms, duplicate fields and oversized forms fail closed',async()=>{
  const app=createDashboard(assets);
  const wrong=await app.fetch(post('wrong'),env);assert.equal(wrong.status,401);assert.equal(wrong.headers.get('set-cookie'),null);
  assert.equal((await app.fetch(post(PASSWORD,{Origin:'https://evil.example'}),env)).status,403);
  assert.equal((await app.fetch(post(PASSWORD,{'Content-Type':'application/json'}),env)).status,415);
  const duplicate=request('/login',{method:'POST',headers:{Origin:ORIGIN,'Content-Type':'application/x-www-form-urlencoded'},body:'username=test-viewer&password=a&password=b'});
  assert.equal((await app.fetch(duplicate,env)).status,401);
  assert.equal((await app.fetch(post('x'.repeat(3000)),env)).status,413);
});
test('tampered, duplicate, expired and password-rotated sessions are rejected',async()=>{
  let now=1793420000000;const app=createDashboard(assets,{clock:()=>now});const good=cookie(await app.fetch(post(),env));
  const tampered=good.slice(0,-5)+'abcde';
  for(const c of [tampered,good+'; '+good,'__Host-dimension_session=not-signed'])assert.equal((await app.fetch(request('/app.mjs',{headers:{Cookie:c}}),env)).status,401);
  const rotated={...env,DASHBOARD_AUTH:JSON.stringify({...AUTH,hash:'b3'.repeat(32)})};
  assert.equal((await app.fetch(request('/app.mjs',{headers:{Cookie:good}}),rotated)).status,401);
  now+=43200001;assert.equal((await app.fetch(request('/app.mjs',{headers:{Cookie:good}}),env)).status,401);
});
test('logout requires same-origin POST and expires the session cookie',async()=>{
  const app=createDashboard(assets);
  assert.notEqual((await app.fetch(request('/logout'),env)).status,303);
  assert.equal((await app.fetch(request('/logout',{method:'POST',headers:{Origin:'https://evil.example'}}),env)).status,403);
  const logout=await app.fetch(request('/logout',{method:'POST',headers:{Origin:ORIGIN}}),env);
  assert.equal(logout.status,303);assert.equal(logout.headers.get('location'),'/login');assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
});
test('attempt limit is bounded, blocks further guesses and expires with its time window',async()=>{
  let now=1793420000000;const app=createDashboard(assets,{clock:()=>now});
  for(let i=0;i<10;i++)assert.equal((await app.fetch(post('wrong'),env)).status,401);
  const blocked=await app.fetch(post(),env);assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'600');
  now+=600001;assert.equal((await app.fetch(post(),env)).status,303);
});
test('missing runtime secrets and unavailable upstream cannot expose protected content',async()=>{
  const app=createDashboard(assets,{fetchImpl:async()=>new Response('<html>upstream-login</html>')});
  assert.equal((await app.fetch(request('/'),{})).status,503);
  const good=cookie(await app.fetch(post(),env));const r=await app.fetch(request('/api/predictions.json',{headers:{Cookie:good}}),env);
  assert.equal(r.status,502);assert.ok(!(await r.text()).includes('upstream-login'));
});
