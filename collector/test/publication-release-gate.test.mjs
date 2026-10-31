import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { FIVE_LEAGUES, RELEASE_CHECKS, validateGreenForecastApproval } from '../publication-release-gate.mjs';

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
test('both orchestration and manually invoked publisher require external release approval',async()=>{
  const orchestrate=await readFile(new URL('../orchestrate.mjs',import.meta.url),'utf8');
  const publisher=await readFile(new URL('../publish.mjs',import.meta.url),'utf8');
  assert.match(orchestrate,/await requireGreenForecastDelivery\(directory\)/);
  assert.match(orchestrate,/'RELEASE_GATE_BLOCKED'/);
  assert.match(publisher,/await requireGreenForecastDelivery\(out\)/);
});
