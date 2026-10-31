import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadAgentPlan, verifyAgentPlan, routeAgent } from '../../scripts/agents-route.mjs';

test('all eight custom agent profiles and audit responsibilities exist', async()=>{
  const plan=verifyAgentPlan(await loadAgentPlan());
  assert.equal(plan.roles.length,8);
  for(const role of plan.roles){
    const text=await readFile(new URL('../../'+role.profile,import.meta.url),'utf8');
    assert.match(text,/^---\nname: a[1-8]-[a-z0-9-]+\ndescription: "/);
    assert.match(text,/target: github-copilot\n/);
    assert.match(text, /BACKTEST_ALL_GREEN_ONLY/);
    assert.match(text, /RELEASE_GATE/);
    assert.match(text, new RegExp('#'+role.issue+'\\b'));
    assert.match(text, new RegExp(role.reviewedBy));
  }
});
test('issue routing, most-specific file ownership, cross-review work', async()=>{
  const plan=await loadAgentPlan();
  for(const role of plan.roles){
    assert.equal(routeAgent(plan,{role:role.id})?.id,role.id);
    assert.equal(routeAgent(plan,{issue:String(role.issue)})?.id,role.id);
    assert.notEqual(role.reviewedBy,role.id);
  }
  assert.equal(routeAgent(plan,{path:'collector/forecast.mjs'})?.id,'A4');
  assert.equal(routeAgent(plan,{path:'collector/sources/team-names.mjs'})?.id,'A3');
  assert.equal(routeAgent(plan,{path:'collector/sources/hkjc.mjs'})?.id,'A2');
  assert.equal(routeAgent(plan,{path:'website/worker.mjs'})?.id,'A8');
  assert.equal(routeAgent(plan,{path:'deploy/release.sh'})?.id,'A7');
  assert.equal(routeAgent(plan,{path:'.github/workflows/test.yml'})?.id,'A1');
  assert.equal(routeAgent(plan,{issue:999}),null);
});
test('unsafe routes and malformed role configs fail closed', async()=>{
  const plan=await loadAgentPlan();
  assert.throws(()=>routeAgent(plan,{path:'../private.env'}));
  assert.throws(()=>routeAgent(plan,{path:'/etc/vantis/collector.env'}));
  assert.throws(()=>routeAgent(plan,{path:'docs\\secret'}));
  assert.throws(()=>routeAgent(plan,{role:'A9'}));
  assert.throws(()=>routeAgent(plan,{issue:'-1'}));
  assert.throws(()=>verifyAgentPlan({...plan,roles:[...plan.roles,plan.roles[0]]}));
  assert.throws(()=>verifyAgentPlan({...plan,roles:plan.roles.map((r,i)=>i===0?{...r,reviewedBy:r.id}:r)}));
  assert.throws(()=>verifyAgentPlan({...plan,roles:plan.roles.map((r,i)=>i===0?{...r,owns:['../escape']}:r)}));
});
