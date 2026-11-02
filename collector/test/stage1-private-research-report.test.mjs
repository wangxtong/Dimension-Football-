import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStage1, renderStage1HTML } from '../../scripts/stage1-private-research-report.mjs';

const sha = 'a'.repeat(64);
const normalizedSha = 'b'.repeat(64);
const commit = 'c'.repeat(40);
const input = () => ({
  original:{receipt:{observationMode:'LIVE_SOURCE_HTTP',httpStatus:200,
    sourceId:'openligadb-bl1-history',rawSha256:sha}},
  receipt:{status:'RESEARCH_HISTORICAL_RAW_IMPORTED',rawSha256:sha,
    batchSha256:normalizedSha,records:306},
  normalized:{kind:'research-history-batch',rawSha256:sha,releaseGate:'BLOCKED',
    historicalPregameObserved:false,modelReadyForProspective:false,
    observedAt:'2026-11-02T04:30:00.000Z',records:Array.from({length:306},()=>null)},
  lanes:{lanes:{
    results:{mode:'private-research',forecastPublished:false,
      publicationStatus:'not_attempted',releaseGate:{decision:'BLOCKED',productionAuthorization:false},
      status:'complete',exitCode:0},
    fixtures:{mode:'private-research',forecastPublished:false,
      publicationStatus:'not_attempted',releaseGate:{decision:'BLOCKED',productionAuthorization:false},
      status:'partial',exitCode:1}
  }},
  evaluation:{scope:'private-research-freezes',forecastPublished:false,releaseGate:'BLOCKED',
    summary:{recordedResults:306,recordedScores:0}},
  report:null,publication:null,gateBlocked:true,sourceCommit:commit,
  capturedAt:'2026-11-02T04:31:00.000Z',
});
test('true research result reports actual 306 archived FT and zero fictional prospective scores',()=>{
  const r=summarizeStage1(input());
  assert.equal(r.source.verifiedFT,306);
  assert.equal(r.dailyResearch.prospectiveScores,0);
  assert.equal(r.lanes.fixtures.status,'partial');
  assert.equal(r.releaseGate,'BLOCKED');
  assert.equal(r.forecastPublished,false);
  assert.equal(r.externalDeliveryAttempted,false);
  assert.equal(r.modelReadyForProspective,false);
});
test('malicious published lane or external notification is never accepted as private research',()=>{
  const a=input();a.lanes.lanes.results.releaseGate.decision='GREEN';
  assert.throws(()=>summarizeStage1(a),/STAGE1_LANE_NOT_PRIVATE/);
  const b=input();b.publication={channels:{notifications:{status:'accepted'}}};
  assert.throws(()=>summarizeStage1(b),/STAGE1_EXTERNAL_PUBLICATION_FOUND/);
});
test('false model release, wrong raw SHA or missing real gate confirmation is rejected',()=>{
  const a=input();a.gateBlocked=false;
  assert.throws(()=>summarizeStage1(a),/STAGE1_SOURCE_OR_RELEASE_INVALID/);
  const b=input();b.receipt.rawSha256='d'.repeat(64);
  assert.throws(()=>summarizeStage1(b),/STAGE1_SOURCE_OR_RELEASE_INVALID/);
  const c=input();c.normalized.historicalPregameObserved=true;
  assert.throws(()=>summarizeStage1(c),/STAGE1_SOURCE_OR_RELEASE_INVALID/);
});
test('offline web preview escapes any runtime status strings',()=>{
  const a=summarizeStage1(input());
  a.lanes.fixtures.status='<script>alert(1)</script>';
  const result=renderStage1HTML(a);
  assert.ok(result.includes('&lt;script&gt;'));
  assert.equal(result.includes('<script>'),false);
  assert.ok(result.includes('BLOCKED'));
});
