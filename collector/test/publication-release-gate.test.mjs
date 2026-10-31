import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { FIVE_LEAGUES, RELEASE_CHECKS, RELEASE_GATE, validateGreenForecastApproval, requireGreenForecastDelivery } from '../publication-release-gate.mjs';
import * as productionDelivery from '../delivery.mjs';
import { publishAll as reexportedPublishAll } from '../publish.mjs';
import { runOrchestration } from '../orchestrate.mjs';
import { runCollection } from '../pipeline.mjs';
import { publishSummary, recordArtifact } from '../publication.mjs';

const sha = 'a'.repeat(40), now = Date.parse('2026-10-31T15:00:00Z');
const reportId = 'b'.repeat(64);
function validFixture() {
  const report = {
    generatedAt:'2026-10-31T14:30:00Z', simulated:false,
    publication:{reportId}, model:{calibrated:true},
    fixtures:[], summary:{fixtures:0,forecasts:0,unavailable:0,strictCandidates:0},
    backtests:FIVE_LEAGUES.map(league=>({
      league, evaluated:250, status:'verified-prospective',
      provenance:'prospective-ledger', metrics:{brier:0.5,logLoss:0.9},
    })),
  };
  const receipt = {reportId,simulated:false,channels:{files:{status:'published'}}};
  const approval = {
    schemaVersion:1, commitSha:sha, reportId,
    reportSha256:createHash('sha256').update(JSON.stringify(report)).digest('hex'),
    BACKTEST_ALL_GREEN_ONLY:'GREEN',RELEASE_GATE:'GREEN',
    approvedAt:'2026-10-31T14:45:00Z',
    checks:Object.fromEntries(RELEASE_CHECKS.map(key=>[key,'GREEN'])),
    evidence:{
      backtestSha256:'c'.repeat(64),stagingSmokeSha256:'d'.repeat(64),
      regressionSha256:'e'.repeat(64),oldProductionSha:'f'.repeat(40),
      mergedPrUrl:'https://github.com/wangxtong/Dimension-Football-/pull/123',
      ciRunUrl:'https://github.com/wangxtong/Dimension-Football-/actions/runs/98765',
    },
  };
  return {report,receipt,approval,commitSha:sha,nowMs:now};
}
const run = data => validateGreenForecastApproval(data);
test('synthetic complete attestation format validates without claiming actual external evidence',()=>{
  assert.equal(run(validFixture()),true);
});
test('all mandatory checks fail closed on missing or blocking values',()=>{
  for(const key of RELEASE_CHECKS){
    for(const status of ['FAIL','WARN_BLOCKING','UNKNOWN','BACKTEST_INSUFFICIENT',null]){
      const data=validFixture();data.approval.checks[key]=status;
      assert.equal(run(data),false,key+': '+status);
    }
    const data=validFixture();delete data.approval.checks[key];
    assert.equal(run(data),false,key+' missing');
  }
  for(const key of ['BACKTEST_ALL_GREEN_ONLY','RELEASE_GATE']){
    const data=validFixture();data.approval[key]='UNKNOWN';
    assert.equal(run(data),false,key);
  }
});
test('five leagues, sufficient real prospective counts and calibrated probabilities are required',()=>{
  for(const league of FIVE_LEAGUES){
    const a=validFixture();a.report.backtests=a.report.backtests.filter(x=>x.league!==league);
    assert.equal(run(a),false,league+' absent');
  }
  const edits=[
    x=>{x.report.backtests[0].evaluated=63;},
    x=>{x.report.backtests[1].status='insufficient-validation';},
    x=>{x.report.backtests[2].provenance='historical-snapshot';},
    x=>{x.report.model.calibrated=false;},
    x=>{x.report.backtests[3].metrics=null;},
    x=>{x.report.simulated=true;},
    x=>{x.receipt.simulated=true;},
  ];
  for(const edit of edits){const a=validFixture();edit(a);assert.equal(run(a),false);}
});
test('approval cannot be reused for a different report, source commit or stale payload',()=>{
  const edits=[
    x=>{x.approval.commitSha='0'.repeat(40);},
    x=>{x.approval.reportId='0'.repeat(64);},
    x=>{x.approval.reportSha256='0'.repeat(64);},
    x=>{x.approval.approvedAt='2026-10-30T14:45:00Z';},
    x=>{x.approval.evidence.oldProductionSha=sha;},
    x=>{x.approval.evidence.ciRunUrl='https://untrusted.invalid/green';},
    x=>{x.receipt.reportId='0'.repeat(64);},
    x=>{x.nowMs=Date.parse('2026-10-31T18:30:00Z');},
  ];
  for(const edit of edits){const a=validFixture();edit(a);assert.equal(run(a),false);}
});
const config = JSON.parse(await readFile(new URL('../../config/delivery.json', import.meta.url)));
const env = { RELEASE_GATE:'GREEN', BACKTEST_ALL_GREEN_ONLY:'GREEN', NODE_ENV:'test',
  TELEGRAM_BOT_TOKEN:'123456:abcdefghijklmnopqrstuv', TELEGRAM_CHAT_ID:'1234567',
  GITHUB_TOKEN:'offline-archive-token', REPORTS_PROBE_TOKEN:'a'.repeat(64) };
async function workspace(t) {
  const dir=await mkdtemp(join(tmpdir(),'release-gate-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  await runCollection({fixtures:[],outDir:dir,statePath:join(dir,'state.json'),simulated:false,
    collectEvidence:async()=>({quotes:[],signals:[],diagnostics:[]})});
  return dir;
}
const blocked = error => {
  assert.equal(error.code,'RELEASE_GATE_BLOCKED');
  assert.equal(error.releaseGate.RELEASE_GATE,'BLOCKED');
  assert.equal(error.releaseGate.productionAuthorization,false);
  for(const name of RELEASE_CHECKS)assert.ok(error.releaseGate.missingEvidence.includes(name));
  assert.ok(error.releaseGate.missingEvidence.includes('EXTERNAL_EVIDENCE_AUTHENTICITY_VERIFIER'));
  return true;
};

test('production has no release branch even for a root-owned structurally complete GREEN approval',async()=>{
  const candidate=validFixture();assert.equal(validateGreenForecastApproval(candidate),true);
  const target=new URL('../publication-release-gate.mjs?root-green-format-test',import.meta.url);
  const storage='data:text/javascript,'+encodeURIComponent(`export async function readJson(p){return p.endsWith('publication.json')?${JSON.stringify(candidate.receipt)}:${JSON.stringify(candidate.report)}}`);
  const files='data:text/javascript,'+encodeURIComponent(`export async function readFile(p){return p.endsWith('.source-commit')?${JSON.stringify(sha)}:${JSON.stringify(JSON.stringify(candidate.approval))}};export async function lstat(p){return {isDirectory:()=>p.endsWith('publish-approvals'),isFile:()=>!p.endsWith('publish-approvals'),isSymbolicLink:()=>false,uid:0,mode:0o750}}`);
  const hook=registerHooks({resolve(specifier,context,next){
    if(context.parentURL===target.href && ['node:fs/promises','./storage.mjs'].includes(specifier))
      return {url:specifier==='node:fs/promises'?files:storage,shortCircuit:true};
    return next(specifier,context);
  }});
  let module;try{module=await import(target);}finally{hook.deregister();}
  // File modes can be root-owned, group-readable and otherwise protected;
  // neither that nor self-asserted GREEN proves evidence or independence.
  await assert.rejects(module.requireGreenForecastDelivery('/unused-test-only',now),error=>{
    blocked(error);assert.equal(error.releaseGate.approvalFormat,'valid-unverified');return true;
  });
  assert.equal(RELEASE_GATE,'BLOCKED');
});

test('all direct production exports and CLI re-export stop before network, persistence or receipts',async t=>{
  const directory=await workspace(t),before=await readFile(join(directory,'publication.json'),'utf8');
  const names=await readdir(directory);let requests=0,persisted=0,injected=0;
  const options={config,env,fetchImpl:async()=>{requests++;throw Error('unexpected network');},
    persistReceipt:async()=>{persisted++;},releaseGate:async()=>{injected++;},
    requireGreenForecastDelivery:async()=>{injected++;},expectedReportId:'b'.repeat(64)};
  for(const operation of [productionDelivery.publishAll,productionDelivery.publishWebsite,
    productionDelivery.publishWebsiteReceipt,productionDelivery.publishTelegram,reexportedPublishAll])
    await assert.rejects(operation(directory,options),blocked);
  assert.equal(requests,0);assert.equal(persisted,0);assert.equal(injected,0);
  assert.equal(await readFile(join(directory,'publication.json'),'utf8'),before);
  assert.deepEqual(await readdir(directory),names);
});

test('a locally supplied approval file and GREEN env do not authorize the real gate',async t=>{
  const directory=await workspace(t),candidate=validFixture();
  await writeFile(join(directory,'approval.json'),JSON.stringify(candidate.approval));
  await assert.rejects(requireGreenForecastDelivery(directory,now),blocked);
});

test('internal archive, summary and artifact bookkeeping remain available without release authorization',async t=>{
  const directory=await workspace(t);
  await productionDelivery.publishGitHubArchive(directory,{config,env:{},fetchImpl:async()=>assert.fail('no archive credential')});
  await publishSummary(directory,join(directory,'internal-summary.md'));
  const receipt=await recordArtifact(directory,{outcome:'success',id:'42',repository:'wangxtong/Dimension-Football-',runId:'7',
    url:'https://github.com/wangxtong/Dimension-Football-/actions/runs/7/artifacts/42',digest:'a'.repeat(64)});
  assert.equal(receipt.channels.repositoryArchive.status,'not_configured');
  assert.equal(receipt.channels.githubSummary.status,'published');assert.equal(receipt.channels.githubArtifact.status,'published');
  assert.equal(receipt.channels.externalWebsite.status,'not_configured');assert.equal(receipt.channels.notifications.status,'not_configured');
});

test('production orchestration blocks even an injected publisher and records missing evidence',async t=>{
  const directory=await workspace(t),state=join(directory,'scheduler-state.json');let published=0,requests=0;
  const result=await runOrchestration(['--lane','delivery','--state',state,'--out',directory],{
    env,stdout:()=>{},fetchImpl:async()=>{requests++;},dependencies:{publishAll:async()=>{published++;return {};}}});
  assert.equal(result.status,'blocked');assert.equal(result.code,'RELEASE_GATE_BLOCKED');
  assert.equal(published,0);assert.equal(requests,0);
  const saved=JSON.parse(await readFile(state+'.lanes.json','utf8')).lanes.delivery;
  assert.equal(saved.releaseGate.RELEASE_GATE,'BLOCKED');
  assert.ok(saved.releaseGate.missingEvidence.includes('INDEPENDENT_RELEASE_AUTHORITY_VERIFIED'));
});

test('all external CLI modes fail closed before any outbound request despite GREEN env',async t=>{
  const directory=await workspace(t),before=await readFile(join(directory,'publication.json'),'utf8');
  const preload=join(directory,'network-never-used.mjs'),marker=join(directory,'unexpected-network');
  await writeFile(preload,`import {writeFile} from 'node:fs/promises';globalThis.fetch=async()=>{await writeFile(${JSON.stringify(marker)},'called');throw Error('NO_NETWORK_ALLOWED')}`);
  const childEnv={...process.env,...env};
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NODE_OPTIONS'])delete childEnv[key];
  for(const mode of ['website','website-receipt','telegram','all']){
    const output=await open(join(directory,mode+'.stdout'),'w'),errors=await open(join(directory,mode+'.stderr'),'w');
    let result;
    try{result=spawnSync(process.execPath,['--import',preload,fileURLToPath(new URL('../publish.mjs',import.meta.url)),mode,directory],
      {env:childEnv,stdio:['ignore',output.fd,errors.fd]});}finally{await output.close();await errors.close();}
    assert.equal(result.status,1);
    const diagnostic=JSON.parse(await readFile(join(directory,mode+'.stderr'),'utf8'));
    assert.equal(diagnostic.code,'RELEASE_GATE_BLOCKED');assert.equal(diagnostic.RELEASE_GATE,'BLOCKED');
    assert.ok(diagnostic.missingEvidence.includes('EXTERNAL_EVIDENCE_AUTHENTICITY_VERIFIER'));
    assert.ok(!JSON.stringify(diagnostic).includes(env.TELEGRAM_BOT_TOKEN));
  }
  assert.equal(await readFile(join(directory,'publication.json'),'utf8'),before);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
});

