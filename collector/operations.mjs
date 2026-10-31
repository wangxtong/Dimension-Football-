import { readFile, statfs, access, realpath } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { isIP } from 'node:net';
import { atomicJson, readJson } from './storage.mjs';

const exec = promisify(execFile), IDS = ['fixtures', 'markets', 'delivery', 'results'];
const stamp = () => new Date().toISOString();
const safeCode = value => /^[A-Z][A-Z0-9_]{1,70}$/.test(value || '') ? value : 'OPERATION_FAILED';
export function validateOperations(config) {
  if (config?.version !== 1 || config.stateSchemaVersion !== 1 || typeof config.browserRequired !== 'boolean'
    || !Number.isInteger(config.reportMaxAgeSeconds) || config.reportMaxAgeSeconds < 60 || config.reportMaxAgeSeconds > 86400
    || !Number.isSafeInteger(config.minimumDiskBytes) || config.minimumDiskBytes < 0
    || !Array.isArray(config.jobs) || config.jobs.length !== IDS.length || new Set(config.jobs.map(j => j.id)).size !== IDS.length) throw Error('OPERATIONS_CONFIG_INVALID');
  if(config.stateRelativePath!==undefined&&!['state.json','state/state.json'].includes(config.stateRelativePath))throw Error('OPERATIONS_STATE_PATH_INVALID');
  for (const job of config.jobs) if (!IDS.includes(job.id) || job.entrypoint !== 'collector/orchestrate.mjs'
    || !Number.isInteger(job.intervalSeconds) || job.intervalSeconds < 60 || job.intervalSeconds > 86400
    || !Number.isInteger(job.timeoutSeconds) || job.timeoutSeconds < 5 || job.timeoutSeconds > 180
    || !Number.isFinite(job.budgetMinutes) || job.budgetMinutes <= 0 || job.budgetMinutes * 60 >= job.timeoutSeconds) throw Error('OPERATIONS_CONFIG_INVALID');
  if (config.publicReportOrigin != null) {
    let url;try {url=new URL(config.publicReportOrigin);}catch{throw Error('HTTPS_REPORT_ORIGIN_INVALID');}
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(url.pathname)||isIP(url.hostname)||url.hostname==='localhost')throw Error('HTTPS_REPORT_ORIGIN_INVALID');
  }
  return config;
}
export function runtimeCheck(version = process.versions.node, features = { proxy: typeof http.setGlobalProxyFromEnv === 'function', fetch: typeof fetch === 'function', abort: typeof AbortSignal.any === 'function' }) {
  const [major, minor] = version.split('.').map(Number);
  return { version, minimum: '24.14.0', ok: major === 24 && minor >= 14 && Object.values(features).every(Boolean), features };
}
async function optionalJson(path, max = 8_000_000) {
  try { return await readJson(path, max); } catch (error) { if (error.code === 'ENOENT') return null; throw Error('OPERATIONS_INPUT_UNREADABLE'); }
}
export function dueJobs(config, scheduler, now = Date.now()) {
  return config.jobs.map(job => ({ ...job, dueAt: Date.parse(scheduler.jobs?.[job.id]?.nextRunAt || '') || 0 }))
    .filter(job => job.dueAt <= now).sort((a,b) => a.dueAt - b.dueAt || IDS.indexOf(a.id) - IDS.indexOf(b.id));
}
export function evaluateHealth({ config, scheduler, report, receipt, tasks, diskFreeBytes, services = {}, release = null, now = Date.now() }) {
  const findings = [], add = (priority, code, action) => findings.push({ priority, code, action });
  if(!config.publicReportOrigin)add('P1','HTTPS_REPORT_ORIGIN_REQUIRED','Configure the existing HTTPS reverse proxy and certificate; do not expose the loopback feed over plaintext.');
  const age = value => Number.isFinite(Date.parse(value)) ? Math.max(0, (now - Date.parse(value)) / 1000) : null;
  const reportAgeSeconds = age(report?.generatedAt), reportId = report?.publication?.reportId;
  if (!report) add('P0','REPORT_MISSING','Check fixtures lane and configured source access; do not claim published.');
  else if (reportAgeSeconds === null || reportAgeSeconds > config.reportMaxAgeSeconds) add('P1','REPORT_STALE','Inspect last successful fixtures/markets run and source diagnostics.');
  if (receipt && receipt.reportId !== reportId) add('P0','REPORT_RECEIPT_MISMATCH','Stop notifications and reconcile the immutable report and receipt.');
  if(report&&!receipt)add('P0','PUBLICATION_RECEIPT_MISSING','Reconcile the report with its same-report publication receipt.');
  const website = receipt?.channels?.externalWebsite, notification = receipt?.channels?.notifications;
  const reportHash = report ? createHash('sha256').update(JSON.stringify(report)).digest('hex') : null;
  const servedVerified = website?.status === 'published' && website.servedVerified === true && website.reportId === reportId && website.reportHash === reportHash;
  if (website?.status === 'failed' || website?.status === 'unknown') add('P0','WEBSITE_DELIVERY_FAILED','Inspect actual Site readback and upstream authorization before retrying delivery.');
  else if(website?.servedVerified === true && !servedVerified)add('P0','WEBSITE_READBACK_MISMATCH','Reconcile the website reportId and canonical JSON digest before notification.');
  else if(!servedVerified)add('P1','WEBSITE_NOT_VERIFIED','Run the authenticated Site readback; GitHub storage and bootstrap snapshots do not prove ECS delivery.');
  if (notification?.status === 'unknown') add('P1','NOTIFICATION_UNKNOWN','Reconcile provider receipt; do not automatically resend.');
  else if (notification?.status === 'failed') add('P1','NOTIFICATION_FAILED','Inspect the sanitized delivery code and destination permissions.');
  if (scheduler?.active && age(scheduler.active.startedAt) > scheduler.active.timeoutSeconds + 45) add('P1','LANE_STUCK','Inspect the owning service/process and lock before recovery.');
  const lanes = config.jobs.map(job => {
    const state = scheduler?.jobs?.[job.id] || {}, dueSeconds = age(state.nextRunAt);
    if (state.status === 'blocked') add('P1',`${job.id.toUpperCase()}_BLOCKED`,'Verify the configured entrypoint and integrated release contract.');
    else if (state.status === 'failed' || state.status === 'interrupted') add('P1',`${job.id.toUpperCase()}_FAILED`,'Inspect lane exit status and sanitized diagnostics; preserve state.');
    if (dueSeconds !== null && dueSeconds > Math.max(180, job.intervalSeconds)) add('P1',`${job.id.toUpperCase()}_OVERDUE`,'Check scheduler timer, lock contention and lane time budget.');
    return { id: job.id, status: state.status || 'never_run', lastStartedAt: state.lastStartedAt || null, lastSuccessAt: state.lastSuccessAt || null, nextRunAt: state.nextRunAt || null, exitCode: state.exitCode ?? null };
  });
  if (!scheduler?.checkedAt || age(scheduler.checkedAt) > 240) add('P1','SCHEDULER_HEARTBEAT_STALE','Check vantis-collector.timer; a successful inactive oneshot is normal.');
  for (const [name, service] of Object.entries(services)) {
    if(service.unavailable){add('P2','SERVICE_STATUS_UNAVAILABLE',`Read ${name} status on the target host; do not infer deployment from source.`);continue;}
    if (service.ActiveState === 'failed' || (service.Result && service.Result !== 'success') || Number(service.ExecMainStatus || 0) !== 0) add('P1','SERVICE_FAILED',`Inspect ${name} result; do not treat inactive/dead alone as failure.`);
    if (name.endsWith('.timer') && service.ActiveState !== 'active') add('P1','TIMER_INACTIVE',`Check ${name} is enabled and scheduled.`);
    if(name==='vantis-report.service'&&service.ActiveState!=='active')add('P0','REPORT_SERVICE_INACTIVE','Inspect loopback report service configuration and runtime result.');
  }
  if (Number.isFinite(diskFreeBytes) && diskFreeBytes < config.minimumDiskBytes) add('P0','DISK_LOW','Preserve current state, rotate verified old artifacts and check disk capacity.');
  const progress = (Array.isArray(tasks?.tasks) ? tasks.tasks : []).slice(0,100).map(task => {
    const validState = ['pending','active','review','verified','blocked'].includes(task.status);
    const evidence = Array.isArray(task.evidence) ? task.evidence.filter(x => typeof x === 'string' && /^[A-Za-z0-9_.:/ -]{1,200}$/.test(x)).slice(0,10) : [];
    const status = validState && (task.status !== 'verified' || evidence.length > 0 && Number.isFinite(Date.parse(task.verifiedAt))) ? task.status : 'review';
    return { id: /^[A-Za-z0-9_-]{1,60}$/.test(task.id || '') ? task.id : 'invalid', role: /^A[1-8]$/.test(task.role || '') ? task.role : null, status, evidence, updatedAt: Number.isFinite(Date.parse(task.updatedAt)) ? task.updatedAt : null,
      ...(status === 'blocked' ? { dependency: /^[A-Za-z0-9_. -]{1,120}$/.test(task.dependency || '') ? task.dependency : 'dependency_not_recorded' } : {}) };
  });
  if (progress.some(task => task.status === 'blocked')) add('P2','REPAIR_TASK_BLOCKED','Resolve the recorded dependency; no automatic deployment or secret changes.');
  const quotes = (report?.fixtures || []).flatMap(row => row.marketCandidate?.candidate?.quotes || []);
  const fresh = quotes.filter(q => Date.parse(q.validUntil) > now).length;
  return { version: 1, checkedAt: new Date(now).toISOString(), status: findings.some(f => f.priority === 'P0') ? 'critical' : findings.length ? 'degraded' : 'healthy',
    report: { reportId: /^[a-f0-9]{64}$/.test(reportId || '') ? reportId : null, ageSeconds: reportAgeSeconds, validCandidateQuotes: fresh, candidateQuotes: quotes.length, servedVerified },
    release, diskFreeBytes: Number.isFinite(diskFreeBytes) ? diskFreeBytes : null, lanes, services, progress,
    findings: findings.sort((a,b) => a.priority.localeCompare(b.priority)), meaning: 'rule-driven-observations-not-proof-of-production-acceptance' };
}
export async function serviceSnapshot() {
  const rows = {};
  for (const name of ['vantis-collector.service','vantis-collector.timer','vantis-health.timer','vantis-sync.service','vantis-report.service']) {
    try { const {stdout} = await exec('systemctl',['show',name,'--property=ActiveState,SubState,Result,ExecMainStatus'],{timeout:3000,maxBuffer:8000});
      rows[name] = Object.fromEntries(stdout.trim().split('\n').map(s => s.split('='))); } catch { rows[name] = { unavailable: true }; }
  }
  return rows;
}
export async function healthSnapshot(root, config, { services = {}, now = Date.now() } = {}) {
  const [scheduler,report,receipt,tasks,release] = await Promise.all([
    optionalJson(resolve(root,'operations/scheduler.json')), optionalJson(resolve(root,'reports/predictions.json')),
    optionalJson(resolve(root,'reports/publication.json')), optionalJson(resolve(root,'operations/tasks.json')), optionalJson(resolve(root,'operations/release.json'))]);
  let diskFreeBytes = null; try { const disk = await statfs(root); diskFreeBytes = Number(disk.bavail) * Number(disk.bsize); } catch {}
  return evaluateHealth({config,scheduler,report,receipt,tasks,diskFreeBytes,services,release,now});
}
export async function executeLane(job, { root, release, statePath = resolve(root,'state/state.json'), spawnImpl = spawn, env = process.env }) {
  const file = resolve(release,job.entrypoint), actual = await realpath(file);
  if (relative(await realpath(release),actual).startsWith('..')) throw Error('ENTRYPOINT_OUTSIDE_RELEASE');
  await access(file);
  let sourceCommit;
  try {
    const commitPath=await realpath(resolve(release,'.source-commit'));
    if(relative(await realpath(release),commitPath).startsWith('..'))throw Error('RELEASE_COMMIT_INVALID');
    sourceCommit=(await readFile(commitPath,'utf8')).trim();
  } catch {throw Error('RELEASE_COMMIT_INVALID');}
  if(!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('RELEASE_COMMIT_INVALID');
  return new Promise((resolveResult, reject) => {
    const child = spawnImpl(process.execPath,[file,'--lane',job.id,'--state',statePath,'--out',resolve(root,'reports'),'--budget-minutes',String(job.budgetMinutes)],
      // Keep the run.sh flock descriptor open in the worker even if this parent dies.
      // Direct tick calls without the wrapper cannot silently bypass the OS lock.
      { cwd:root, env:{...env,COLLECTOR_COMMIT:sourceCommit}, stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',9] });
    let expired = false, killTimer;
    const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); killTimer=setTimeout(() => child.kill('SIGKILL'),15000); },job.timeoutSeconds*1000);
    const finish = () => { clearTimeout(timer); clearTimeout(killTimer); };
    child.once('error',() => {finish();reject(Error('LANE_START_FAILED'));});
    child.once('close',(code,signal) => {finish();resolveResult({ exitCode:Number.isInteger(code)?code:1, signal:signal || null, timedOut:expired });});
  });
}
// The installed run.sh holds an OS flock across this entire operation, including child exit.
export async function tick({ root, release, config, clock = stamp, execute = executeLane }) {
  const path=resolve(root,'operations/scheduler.json'), now=Date.parse(clock());
  const state=await optionalJson(path) || {version:1,jobs:{}};
  if(state.version!==1 || !state.jobs || typeof state.jobs!=='object') throw Error('SCHEDULER_STATE_INVALID');
  if(state.active) { const old=state.active;state.jobs[old.id]={...state.jobs[old.id],status:'interrupted',code:'PREVIOUS_RUN_INTERRUPTED'};state.active=null; }
  const job=dueJobs(config,state,now)[0];state.checkedAt=new Date(now).toISOString();
  if(!job) {await atomicJson(path,state);return {status:'idle'};}
  state.active={id:job.id,startedAt:state.checkedAt,timeoutSeconds:job.timeoutSeconds};
  state.jobs[job.id]={...state.jobs[job.id],status:'active',lastStartedAt:state.checkedAt};await atomicJson(path,state);
  let result;
  try {result=await execute(job,{root,release,statePath:resolve(root,config.stateRelativePath||'state.json')});}
  catch(error) {result={exitCode:1,code:error.code==='ENOENT'?'ENTRYPOINT_MISSING':safeCode(error.message),blocked:true};}
  const finishedAt=clock();
  state.jobs[job.id]={...state.jobs[job.id],status:result.blocked?'blocked':result.exitCode===0?'success':'failed',exitCode:result.exitCode,
    code:result.code || (result.timedOut?'LANE_TIMEOUT':result.exitCode===0?'LANE_COMPLETED':'LANE_FAILED'),lastFinishedAt:finishedAt,
    ...(result.exitCode===0?{lastSuccessAt:finishedAt}:{}), nextRunAt:new Date(Date.parse(finishedAt)+job.intervalSeconds*1000).toISOString()};
  state.active=null;state.checkedAt=finishedAt;await atomicJson(path,state);return {id:job.id,...state.jobs[job.id]};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [mode,...args]=process.argv.slice(2);
    if(mode==='--help') {console.log('operations.mjs self-check|health|tick --root DIR --release DIR --config FILE');}
    else {
      if(!['self-check','health','tick'].includes(mode)||args.length%2)throw Error('OPERATIONS_USAGE');
      const options={};for(let i=0;i<args.length;i+=2){if(!['--root','--release','--config'].includes(args[i])||options[args[i]])throw Error('OPERATIONS_USAGE');options[args[i]]=args[i+1];}
      const root=resolve(options['--root']||'/var/lib/vantis'),release=resolve(options['--release']||'/opt/vantis/current');
      const config=validateOperations(await readJson(options['--config']||'/etc/vantis/operations.json'));
      if(mode==='self-check') {
        let entrypointPresent=true;try{await access(resolve(release,'collector/orchestrate.mjs'));await access(resolve(release,'collector/report-server.mjs'));}catch{entrypointPresent=false;}
        let browser={required:config.browserRequired,checked:false};
        if(config.browserRequired){ const {browserRuntime}=await import('./browser.mjs');try{const result=await browserRuntime({env:{...process.env,VANTIS_CRAWLER_ENGINE:'crawlee'}});browser={required:true,checked:true,ok:result.metadata.launchVerified===true};}catch{browser={required:true,checked:true,ok:false};} }
        const runtime=runtimeCheck(),installable=runtime.ok&&entrypointPresent&&(!browser.required||browser.ok);
        console.log(JSON.stringify({version:1,checkedAt:stamp(),runtime,entrypointPresent,browser,installation:{status:installable?'ready':'blocked'},
          externalDelivery:{status:'blocked',code:config.publicReportOrigin?'LIVE_TLS_READBACK_REQUIRED':'HTTPS_REPORT_ORIGIN_REQUIRED',originConfigured:!!config.publicReportOrigin}},null,2));
        if(!runtime.ok||!entrypointPresent||browser.required&&!browser.ok)process.exitCode=1;
      } else if(mode==='health') {
        const report=await healthSnapshot(root,config,{services:await serviceSnapshot()});await atomicJson(resolve(root,'operations/health.json'),report);console.log(JSON.stringify({status:report.status,checkedAt:report.checkedAt,findings:report.findings.length}));
      } else { if(!runtimeCheck().ok)throw Error('NODE_CAPABILITY_REQUIRED');console.log(JSON.stringify(await tick({root,release,config}))); }
    }
  }catch(error){console.error(JSON.stringify({status:'failed',code:safeCode(error.message)}));process.exitCode=1;}
}
