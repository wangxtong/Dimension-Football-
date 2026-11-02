import test from 'node:test';
import assert from 'node:assert/strict';
import {buildHeartbeat,formatHeartbeatHTML} from '../heartbeat-contract.mjs';
const nowISO='2026-11-02T09:00:00.000Z',codeSha='a'.repeat(40),reportId='b'.repeat(64);
const fixture={id:'oldb-123',source:'openligadb',league:'BL1',home:'FC <Research>',
  away:'TSG Test',kickoff:'2026-11-07T19:30:00.000Z'};
function input(){
  const sourceManifest={simulated:false,checkedAt:'2026-11-02T08:55:00.000Z',
    diagnostics:[{id:'openligadb',league:'BL1',season:'2026',endpoint:'https://api.openligadb.de/getmatchdata/bl1/2026',
      checkedAt:'2026-11-02T08:55:00.000Z',fetchedAt:'2026-11-02T08:55:01.000Z',httpStatus:200,status:'partial'},
      {id:'openligadb',league:'BL1',season:'2026',endpoint:'https://api.openligadb.de/getmatchdata/bl1/2026',
        checkedAt:'2026-11-02T08:55:00.000Z',fetchedAt:'2026-11-02T08:55:01.000Z',httpStatus:200,status:'partial'},
      {id:'thesportsdb-free',league:'PL',endpoint:'https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=4328',
        checkedAt:'2026-11-02T08:55:00.000Z',httpStatus:403,status:'unavailable'}]};
  const predictionDocument={kind:'prematch-forecast-report',simulated:false,
    generatedAt:'2026-11-02T08:56:00.000Z',publication:{reportId},model:{id:'venue-poisson-v2',version:2},
    summary:{forecasts:1},fixtures:[{fixture,forecast:{status:'forecast',generatedAt:'2026-11-02T08:56:00.000Z'}}]};
  const siteReceipt={verified:true,status:'published',servedVerified:true,
    reportId,deployedSha:codeSha,checkedAt:'2026-11-02T08:58:00.000Z',manualBackfill:false};
  return {sourceManifest,predictionDocument,siteReceipt,nowISO,codeSha};
}
test('real HTTP probes counted by unique transport, not fixture or duplicated history interpretation',()=>{
  const r=buildHeartbeat(input());
  assert.equal(r.probes.successful,1);assert.equal(r.probes.failed,1);
  assert.equal(r.probes.total,2);assert.equal(r.forecastsGenerated,1);
  assert.equal(r.model.computedAt,'2026-11-02T08:56:00.000Z');
  assert.equal(r.deployment.status,'Healthy');
  assert.equal(r.telegram.status,'NOT_SENT');
  assert.equal(r.telegram.messageId,null);
  assert.match(formatHeartbeatHTML(r),/采集成功数 \/ 失败数：1 \/ 1/);
});
test('missing site deployment attestation, stale snapshots and manual backfill fail closed',()=>{
  let x=input();x.siteReceipt=null;
  let r=buildHeartbeat(x);
  assert.equal(r.deployment.status,'Unhealthy');
  assert.ok(r.blockers.includes('SITE_DEPLOYMENT_UNVERIFIED'));
  x=input();x.sourceManifest.manualBackfill=true;
  r=buildHeartbeat(x);assert.ok(r.blockers.includes('MANUAL_BACKFILL_DETECTED'));
  x=input();x.nowISO='2026-11-02T11:01:00.000Z';
  r=buildHeartbeat(x);assert.ok(r.blockers.includes('COLLECTION_OR_MODEL_STALE'));
});
test('model input cannot be fabricated or miscounted',()=>{
  for(const mutate of [
    x=>x.predictionDocument.simulated=true,
    x=>x.sourceManifest.simulated=true,
    x=>x.predictionDocument.model.id='alien-model',
    x=>x.predictionDocument.summary.forecasts=3,
    x=>x.predictionDocument.fixtures[0].forecast.generatedAt='2026-11-10T00:00:00.000Z'
  ]){
    const x=input();mutate(x);assert.throws(()=>buildHeartbeat(x),/HEARTBEAT_/);
  }
});
test('report HTML escapes untrusted fields and never claims Telegram accepted',()=>{
  const x=input();const r=buildHeartbeat(x);
  const h=formatHeartbeatHTML(r);
  assert.ok(h.includes('NOT_SENT')===false);
  assert.match(h,new RegExp(r.heartbeatId));
  assert.ok(!h.includes('TELEGRAM_ACCEPTED'));
});

test('redacted real acquisition entries with no full URL produce 6 successful unique transport calls',()=>{
  const x=input();
  const first=x.sourceManifest.diagnostics[0];
  delete first.endpoint;
  delete x.sourceManifest.diagnostics[1].endpoint;
  const d=x.sourceManifest.diagnostics;
  d.splice(2,0,{id:'openligadb',league:'BL1',season:'2025',checkedAt:'2026-11-02T08:55:00.000Z',
    fetchedAt:'2026-11-02T08:55:02.000Z',httpStatus:200,status:'partial'});
  for(const league of ['PD','SA','FL1'])d.push({id:'thesportsdb-free',league,
    checkedAt:'2026-11-02T08:55:00.000Z',fetchedAt:'2026-11-02T08:55:03.000Z',
    httpStatus:200,status:'partial'});
  delete d[3].endpoint;
  const result=buildHeartbeat(x);
  assert.equal(result.probes.successful,5);
  assert.equal(result.probes.failed,1);
  assert.equal(result.probes.unknown,0);
  assert.equal(result.probes.total,6);
});
