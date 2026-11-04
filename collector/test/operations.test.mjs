import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { validateOperations, runtimeCheck, dueJobs, evaluateHealth, tick, executeLane } from '../operations.mjs';
const config=JSON.parse(await readFile(new URL('../../deploy/operations.json',import.meta.url),'utf8'));
const NOW='2026-10-31T08:00:00.000Z', REPORT='a'.repeat(64);
const healthy=()=>{const report={generatedAt:NOW,publication:{reportId:REPORT},fixtures:[]};return {config:{...config,publicReportOrigin:'https://reports.example'},scheduler:{checkedAt:NOW,jobs:{}},report,receipt:{reportId:REPORT,channels:{externalWebsite:{status:'published',servedVerified:true,reportId:REPORT,reportHash:createHash('sha256').update(JSON.stringify(report)).digest('hex')}}},now:Date.parse(NOW),diskFreeBytes:2e9};};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'vantis-ops-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(join(root,'.source-commit'),'a'.repeat(40)+'\n');return root;}

test('configuration uses independent schedules and requires supported entrypoints and runtime capabilities',()=>{
  assert.equal(validateOperations(config),config);
  assert.deepEqual(config.jobs.map(j=>j.intervalSeconds),[900,120,60,3600]);
  const bad=structuredClone(config);bad.jobs[0].entrypoint='../../evil.mjs';assert.throws(()=>validateOperations(bad));
  assert.equal(runtimeCheck('24.13.0',{proxy:true,fetch:true,abort:true}).ok,false);
  assert.equal(runtimeCheck('24.14.0',{proxy:true,fetch:true,abort:true}).ok,true);
  assert.equal(runtimeCheck('24.19.0',{proxy:false,fetch:true,abort:true}).ok,false);
  assert.equal(validateOperations({...config,publicReportOrigin:'https://dimension-football-research.anan220920shan.workers.dev/'}).publicReportOrigin,'https://dimension-football-research.anan220920shan.workers.dev/');
  assert.throws(()=>validateOperations({...config,publicReportOrigin:'http://8.218.6.246/dimension-football/'}));
});
test('successful inactive oneshot is healthy; failed exit and inactive timer are actionable',()=>{
  const input=healthy();input.services={'vantis-collector.service':{ActiveState:'inactive',SubState:'dead',Result:'success',ExecMainStatus:'0'}};
  assert.equal(evaluateHealth(input).status,'healthy');
  input.services['vantis-collector.service'].ExecMainStatus='1';assert.ok(evaluateHealth(input).findings.some(f=>f.code==='SERVICE_FAILED'));
  input.services['vantis-collector.timer']={ActiveState:'inactive'};assert.ok(evaluateHealth(input).findings.some(f=>f.code==='TIMER_INACTIVE'));
});
test('report/receipt mismatch and disk loss outrank notification unknown; no auto resend recommendation',()=>{
  const input=healthy();input.receipt={reportId:'b'.repeat(64),channels:{notifications:{status:'unknown'}}};input.diskFreeBytes=1;
  const result=evaluateHealth(input);assert.equal(result.status,'critical');assert.equal(result.findings[0].priority,'P0');
  assert.ok(result.findings.some(f=>f.code==='REPORT_RECEIPT_MISMATCH'));assert.ok(result.findings.some(f=>f.code==='DISK_LOW'));
  assert.match(result.findings.find(f=>f.code==='NOTIFICATION_UNKNOWN').action,/do not automatically resend/);
});
test('task claims require evidence and do not imply runtime or production verification',()=>{
  const input=healthy();input.tasks={tasks:[{id:'a7',role:'A7',status:'verified'},{id:'a6',role:'A6',status:'active'}]};
  const result=evaluateHealth(input);assert.equal(result.progress[0].status,'review');assert.equal(result.progress[1].status,'active');assert.match(result.meaning,/not-proof/);
});
test('legacy published storage receipts and mismatched readback hashes cannot appear verified',()=>{
 const input=healthy();input.receipt.channels.externalWebsite={status:'published'};
 assert.ok(evaluateHealth(input).findings.some(f=>f.code==='WEBSITE_NOT_VERIFIED'));assert.equal(evaluateHealth(input).report.servedVerified,false);
 input.receipt.channels.externalWebsite={status:'published',servedVerified:true,reportId:REPORT,reportHash:'b'.repeat(64)};
 assert.ok(evaluateHealth(input).findings.some(f=>f.code==='WEBSITE_READBACK_MISMATCH'));
});
test('scheduler persists success, honors due times, survives prior interruption and preserves fairness',async t=>{
  const root=await fixture(t);const calls=[];const execute=async j=>{calls.push(j.id);return {exitCode:0};};
  for(let i=0;i<4;i++)await tick({root,release:root,config,clock:()=>NOW,execute});
  assert.deepEqual(calls,['fixtures','markets','delivery','results']);
  assert.equal((await tick({root,release:root,config,clock:()=>NOW,execute})).status,'idle');
  const path=join(root,'operations/scheduler.json'),state=JSON.parse(await readFile(path));
  assert.equal(state.jobs.markets.lastSuccessAt,NOW);assert.equal(dueJobs(config,state,Date.parse(NOW)+61000)[0].id,'delivery');
  state.active={id:'markets',startedAt:NOW,timeoutSeconds:90};await writeFile(path,JSON.stringify(state));
  await tick({root,release:root,config,clock:()=>NOW,execute});assert.equal(JSON.parse(await readFile(path)).jobs.markets.status,'interrupted');
});
test('scheduler uses one explicit state path and preserves legacy fallback on code-only updates',async t=>{
 const root=await fixture(t);let observed;
 await tick({root,release:root,config,clock:()=>NOW,execute:async(_job,options)=>{observed=options.statePath;return {exitCode:0};}});
 assert.equal(observed,join(root,'state/state.json'));
 const old=structuredClone(config);delete old.stateRelativePath;
 await tick({root,release:root,config:old,clock:()=>NOW,execute:async(_job,options)=>{observed=options.statePath;return {exitCode:0};}});
 assert.equal(observed,join(root,'state.json'));
});
test('self-check can install valid local inputs while unverified external delivery remains blocked',async t=>{
 const root=await fixture(t);await mkdir(join(root,'collector'));
 await writeFile(join(root,'collector/orchestrate.mjs'),'');await writeFile(join(root,'collector/report-server.mjs'),'');
 const settings=join(root,'operations.json');await writeFile(settings,JSON.stringify({...config,publicReportOrigin:null}));
 const output=join(root,'self-check-output.json'),fd=await open(output,'w');
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../operations.mjs',import.meta.url)),'self-check','--root',root,'--release',root,'--config',settings],{stdio:['ignore',fd.fd,fd.fd]});await fd.close();
 assert.equal(child.error,undefined);assert.equal(child.status,0);
 const result=JSON.parse(await readFile(output,'utf8'));assert.equal(result.installation.status,'ready');assert.equal(result.externalDelivery.status,'blocked');
});
test('missing integrated entrypoint is blocked, never successful or a fallback collection',async t=>{
  const root=await fixture(t);const result=await tick({root,release:root,config,clock:()=>NOW});
  assert.equal(result.status,'blocked');assert.equal(result.code,'ENTRYPOINT_MISSING');assert.equal(result.lastSuccessAt,undefined);
});
test('executor passes fixed argv, ignores child output and waits for timeout termination',async t=>{
  const root=await fixture(t);await mkdir(join(root,'collector'));await writeFile(join(root,'collector/orchestrate.mjs'),'');
  const child=new EventEmitter();let options,args,killed;
  child.kill=signal=>{killed=signal;queueMicrotask(()=>child.emit('close',null,signal));};
  const result=await executeLane({...config.jobs[0],timeoutSeconds:0.005},{root,release:root,env:{COLLECTOR_COMMIT:'b'.repeat(40)},spawnImpl:(_bin,a,o)=>{args=a;options=o;return child;}});
  assert.equal(killed,'SIGTERM');assert.equal(result.timedOut,true);assert.deepEqual(options.stdio.slice(0,3),['ignore','ignore','ignore']);assert.equal(options.stdio[9],9);assert.equal(args[2],'fixtures');
  assert.equal(options.env.COLLECTOR_COMMIT,'a'.repeat(40));
});
test('missing or malformed release identity blocks execution instead of trusting an external commit',async t=>{
 const root=await fixture(t);await mkdir(join(root,'collector'));await writeFile(join(root,'collector/orchestrate.mjs'),'');
 await writeFile(join(root,'.source-commit'),'unverified');
 await assert.rejects(executeLane(config.jobs[0],{root,release:root,env:{COLLECTOR_COMMIT:'b'.repeat(40)}}),/RELEASE_COMMIT_INVALID/);
});
test('executor rejects symlink entrypoint outside immutable release',async t=>{
  const root=await fixture(t);await mkdir(join(root,'release/collector'),{recursive:true});await writeFile(join(root,'outside.mjs'),'');await symlink(join(root,'outside.mjs'),join(root,'release/collector/orchestrate.mjs'));
  await assert.rejects(executeLane(config.jobs[0],{root,release:join(root,'release')}),/ENTRYPOINT_OUTSIDE_RELEASE/);
});
test('real worker inherits the kernel lock through fd 9', {skip:process.platform!=='linux'},async t=>{
 const root=await fixture(t);await mkdir(join(root,'collector'));
 await writeFile(join(root,'collector/orchestrate.mjs'),`import {spawnSync} from 'node:child_process'; const r=spawnSync('flock',['-n',${JSON.stringify(join(root,'run.lock'))},'true']);process.exit(r.status===1?0:1);`);
 const module=fileURLToPath(new URL('../operations.mjs',import.meta.url));
 const entry=join(root,'test-executor.mjs');await writeFile(entry,`import {executeLane} from ${JSON.stringify(module)};const r=await executeLane(${JSON.stringify(config.jobs[0])},{root:${JSON.stringify(root)},release:${JSON.stringify(root)}});process.exit(r.exitCode);`);
 await promisify(execFile)('bash',['-c','exec 9>"$1/run.lock"; flock -n 9; exec "$2" "$3"','bash',root,process.execPath,entry],{timeout:5000});
});
