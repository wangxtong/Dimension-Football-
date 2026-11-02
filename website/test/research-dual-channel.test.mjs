import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResearchSync, researchWebHTML, researchTelegramDraft } from '../research-dual-channel.mjs';
import { exportResearchWebTg, verifyResearchWebTg } from '../../scripts/export-research-web-tg.mjs';

const ID='a'.repeat(64), COMMIT='b'.repeat(40);
const NOW='2026-11-02T04:58:44.000Z';
const fixture=(id,status='forecast')=>({
  fixture:{id,source:'openligadb',league:'BL1',home:id==='oldb-1'?'FC Bayern München':'Borussia Dortmund',
    away:'VfB Stuttgart',kickoff:'2026-11-04T19:30:00.000Z',fetchedAt:'2026-11-02T04:58:43.000Z'},
  forecast:status==='forecast'?{fixtureId:id,generatedAt:'2026-11-02T04:58:43.800Z',status,
    probabilities:{home:.5,draw:.25,away:.25},selection:'home',
    trainingCutoff:'2026-11-02T04:57:43.000Z',freshness:{validUntil:'2026-11-02T05:58:43.800Z'}}
  :{fixtureId:id,generatedAt:'2026-11-02T04:58:43.800Z',status,reasons:['HISTORY_UNAVAILABLE']}
});
function inputs(){
 const report={version:1,kind:'prematch-forecast-report',generatedAt:NOW,simulated:false,
   model:{id:'venue-poisson-v2',version:2,calibrated:false},
   publication:{reportId:ID},summary:{fixtures:2,forecasts:1,unavailable:1},
   fixtures:[fixture('oldb-1'),fixture('oldb-2','unavailable')]};
 const publication={version:1,reportId:ID,generatedAt:NOW,simulated:false,
   channels:{files:{status:'published'},externalWebsite:{status:'not_configured'},notifications:{status:'not_configured'}}};
 const stage1={version:1,kind:'dimension-football-stage1-private-research',
   capturedAt:'2026-11-02T05:00:00.000Z',codeSha:COMMIT,
   releaseGate:'BLOCKED',forecastPublished:false,externalDeliveryAttempted:false,
   modelReadyForProspective:false,historicalPregameVisibility:false,
   dailyResearch:{reportId:ID,reportFixtures:2,prospectiveScores:0},
   lanes:{fixtures:{reportId:ID,code:null}}};
 const evaluation={scope:'private-research-freezes',releaseGate:'BLOCKED',forecastPublished:false,
   summary:{recordedScores:0}};
 return {report,publication,stage1,evaluation};
}
function build(x){return buildResearchSync({...x,reportBytes:Buffer.from(JSON.stringify(x.report)),publicationBytes:Buffer.from(JSON.stringify(x.publication))})}
async function workspace(t,x){const dir=await mkdtemp(join(tmpdir(),'dimension-sync-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await mkdir(join(dir,'reports'));
 await Promise.all([
 writeFile(join(dir,'reports','predictions.json'),JSON.stringify(x.report)),
 writeFile(join(dir,'reports','publication.json'),JSON.stringify(x.publication)),
 writeFile(join(dir,'reports','prospective-evaluation.json'),JSON.stringify(x.evaluation)),
 writeFile(join(dir,'stage1-status.json'),JSON.stringify(x.stage1))]);return dir;
}
test('same report and same fingerprint render both research previews without sending',()=>{
 const x=build(inputs()), html=researchWebHTML(x), msg=researchTelegramDraft(x);
 assert.equal(x.count.fixtures,2);assert.equal(x.count.researchForecasts,1);
 assert.equal(x.count.unavailable,1);assert.equal(x.count.settledProspective,0);
 assert.equal(x.sourceReportId,ID);assert.equal(x.releaseGate,'BLOCKED');
 assert.equal(x.forecastPublished,false);assert.equal(x.webPublished,false);assert.equal(x.telegramSent,false);
 assert.ok(html.includes(ID));assert.ok(html.includes(x.projectionSha256));
 assert.ok(msg.join('\n').includes(ID.slice(0,12)));
 assert.ok(msg.join('\n').includes(x.projectionSha256.slice(0,12)));
 assert.ok(msg[0].includes('50.0%'));assert.ok(msg.every(t=>t.length<=4096));
});
test('reject fake public release, wrong reportId or already-sent receipt',()=>{
 for(const change of [
  x=>x.stage1.releaseGate='GREEN',
  x=>x.stage1.forecastPublished=true,
  x=>x.publication.channels.notifications.status='accepted',
  x=>x.stage1.dailyResearch.reportId='e'.repeat(64),
  x=>x.evaluation.summary.recordedScores=12,
  x=>x.report.model.calibrated=true
 ]){const x=inputs();change(x);assert.throws(()=>build(x),/RESEARCH_SYNC_PRIVATE_PROVENANCE_INVALID/)}
});
test('reject impossible probabilities, future training cutoff, mismatched score totals',()=>{
 for(const change of [
  x=>x.report.fixtures[0].forecast.probabilities.home=.9,
  x=>x.report.fixtures[0].forecast.trainingCutoff='2026-11-05T04:58:43.000Z',
  x=>x.report.fixtures[0].forecast.selection='invalid',
  x=>x.report.summary.forecasts=2
 ]){const x=inputs();change(x);assert.throws(()=>build(x),/RESEARCH_SYNC_(FORECAST_INVALID|TOTAL_MISMATCH)/)}
});
test('escape malicious team labels for both HTML outputs and protect low-risk fields',()=>{
 const x=inputs();x.report.fixtures[0].fixture.home='<img src=x onerror=alert(1)>';
 const s=build(x),web=researchWebHTML(s),tg=researchTelegramDraft(s).join('\n');
 assert.ok(web.includes('&lt;img src=x'));assert.ok(tg.includes('&lt;img src=x'));
 assert.equal(web.includes('<img src=x'),false);assert.equal(tg.includes('<img src=x'),false);
});
test('export and independent re-read verify bytewise Web and Telegram parity',async t=>{
 const x=inputs(),dir=await workspace(t,x);
 const saved=await exportResearchWebTg({root:dir});assert.equal(saved.receipt.matchedForecasts,1);
 const result=await verifyResearchWebTg({directory:saved.directory});
 assert.equal(result.status,'PRIVATE_WEB_TG_PREVIEWS_VERIFIED');
 assert.equal(result.webLive,false);assert.equal(result.telegramSent,false);
 assert.equal(result.releaseGate,'BLOCKED');
 assert.equal(result.reportId,ID);
 await assert.rejects(exportResearchWebTg({root:dir}),/EEXIST/);
});
test('tampering or replacing shared output cannot silently pass verification',async t=>{
 const dir=await workspace(t,inputs());const saved=await exportResearchWebTg({root:dir});
 const p=join(saved.directory,'telegram-research-preview.json');
 const raw=await readFile(p,'utf8');await writeFile(p,raw.replace('NOT_SENT','SENT'));
 await assert.rejects(verifyResearchWebTg({directory:saved.directory}),/RESEARCH_SYNC_FILE_HASH_MISMATCH/);
});
test('symbolic-link root or a report with no research freeze is rejected',async t=>{
 const dir=await workspace(t,inputs());const link=join(dir,'symlink');
 await symlink(dir,link);await assert.rejects(exportResearchWebTg({root:link}),/RESEARCH_SYNC_ROOT_INVALID/);
 const stage=JSON.parse(await readFile(join(dir,'stage1-status.json'),'utf8'));
 stage.dailyResearch.reportId='f'.repeat(64);
 await writeFile(join(dir,'stage1-status.json'),JSON.stringify(stage));
 await assert.rejects(exportResearchWebTg({root:dir}),/RESEARCH_SYNC_PRIVATE_PROVENANCE_INVALID/);
});