import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnoseForecastDenominators, writeDenominatorAudit } from '../diagnose-forecast-denominators.mjs';

const nowISO = '2026-11-04T02:00:00.000Z';
const codeSha = 'a'.repeat(40);
const fixtures = [
  { id:'f-1',source:'openligadb',league:'BL1',home:'A',away:'B',kickoff:'2026-11-04T12:00:00.000Z' },
  { id:'f-2',source:'thesportsdb-free',league:'PL',home:'C',away:'D',kickoff:'2026-11-04T15:00:00.000Z' },
  { id:'f-3',source:'thesportsdb-free',league:'PD',home:'E',away:'F',kickoff:'2026-11-09T15:00:00.000Z' }
];
const manifest={fixtures,diagnostics:[
  {id:'openligadb',league:'BL1',status:'partial',code:'community_schedule_unverified',matchedCount:1,httpStatus:200},
  {id:'thesportsdb-free',league:'PL',status:'partial',code:'free_tier_limited',matchedCount:1,httpStatus:200}
]};
const doc={simulated:false,summary:{strictCandidates:0},fixtures:[
  {fixture:fixtures[0],forecast:{status:'forecast',reasons:[]},marketCandidate:{status:'unavailable',reasons:['NO_FRESH_COMPLETE_ASIAN_MARKET']}},
  {fixture:fixtures[1],forecast:{status:'unavailable',reasons:['HISTORY_UNAVAILABLE','BACKTEST_INSUFFICIENT']}},
  {fixture:fixtures[2],forecast:{status:'unavailable',reasons:['HOME_HISTORY_INSUFFICIENT']}}
]};
const daily={reportId:'f'.repeat(64),codeSha,sourceReportId:'e'.repeat(64),state:'zero-qualified-forecasts',
  commercialReleaseGate:'BLOCKED',forecasts:{total:0,skipped:3}};

test('retains exact input denominator and each multi-reason rejection; no market/forecast conflation',()=>{
 const r=diagnoseForecastDenominators({sourceManifest:manifest,document:doc,daily,nowISO,codeSha});
 assert.equal(r.status,'EVIDENCE_OBSERVED_NONCOMMERCIAL');
 assert.deepEqual([r.counts.sourceFixtureInputs,r.counts.pipelineFixtureInputs,r.counts.modelForecasts,
   r.counts.modelUnavailable,r.counts.frozenQualified,r.counts.sourceWithin36h,r.counts.pipelineWithin36h],
   [3,3,1,2,0,2,2]);
 assert.equal(r.rejectionReasons.HISTORY_UNAVAILABLE,1);
 assert.equal(r.rejectionReasons.BACKTEST_INSUFFICIENT,1);
 assert.equal(r.rejectionReasons.HOME_HISTORY_INSUFFICIENT,1);
 assert.equal(r.marketRejectionReasons.NO_FRESH_COMPLETE_ASIAN_MARKET,1);
 assert.equal(r.pipelineCandidates.length,3);
 assert.equal(r.sourceFixtures.length,3);
 assert.equal(r.byLeague.length,3);
 assert.equal(r.sourceDiagnostics[1].httpStatus,200);
 assert.equal(r.report.commercialReleaseGate,'BLOCKED');
});

test('missing source/reports are NOT_EXECUTED, not zero-qualified or success',()=>{
 const r=diagnoseForecastDenominators({nowISO,codeSha});
 assert.equal(r.status,'INCOMPLETE_EVIDENCE_NOT_ZERO_QUALIFIED');
 assert.equal(r.counts.sourceFixtureInputs,null);
 assert.equal(r.counts.pipelineFixtureInputs,null);
 assert.equal(r.counts.frozenQualified,null);
 assert.deepEqual(r.presence,{sourceManifest:false,sourceDiagnostics:false,predictions:false,researchDaily:false});
});

test('source and model pools remain separate if credentials change the provider identity',()=>{
 const managed={simulated:false,summary:{strictCandidates:0},fixtures:[{fixture:
   {...fixtures[0],id:'api-123',source:'api-football'},forecast:{status:'unavailable',reasons:['HISTORY_UNAVAILABLE']}}]};
 const r=diagnoseForecastDenominators({sourceManifest:manifest,document:managed,daily,nowISO,codeSha});
 assert.equal(r.counts.sourceFixtureInputs,3);
 assert.equal(r.counts.pipelineFixtureInputs,1);
 assert.equal(r.counts.sourceRowsAbsentFromPipeline,3);
 assert.equal(r.counts.pipelineRowsAbsentFromPublicSourcePool,1);
});

test('real input files are hashed and private audit write is verified',async()=>{
 const root=await mkdtemp(join(tmpdir(),'df-denominator-'));
 try{
  await mkdir(join(root,'reports/research-daily'),{recursive:true});
  await Promise.all([
   writeFile(join(root,'reports/public-source-fixtures.json'),JSON.stringify(manifest)),
   writeFile(join(root,'reports/predictions.json'),JSON.stringify(doc)),
   writeFile(join(root,'reports/research-daily/latest.json'),JSON.stringify(daily))
  ]);
  const out=join(root,'denominator-diagnostics.json');
  const result=await writeDenominatorAudit(root,out,codeSha,nowISO);
  assert.ok(/^[a-f0-9]{64}$/.test(result.inputHashes.predictions));
  assert.equal(JSON.parse(await readFile(out,'utf8')).counts.modelUnavailable,2);
  await assert.rejects(writeDenominatorAudit(root,join(tmpdir(),'df-outside.json'),codeSha,nowISO),/AUDIT_OUTPUT_OUTSIDE_ROOT/);
 }finally{await rm(root,{recursive:true,force:true});}
});
