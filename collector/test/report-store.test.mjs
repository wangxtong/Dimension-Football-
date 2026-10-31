import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { persistReport, persistReportReceipt, loadReportBundle } from '../report-store.mjs';
import { createReportServer } from '../report-server.mjs';
import { sampleBundle, sampleReport, NOW } from '../../website/test/fixtures.mjs';
import { validateReport, MAX_REPORT_BUNDLE_BYTES } from '../../website/report-schema.mjs';
import { buildForecasts } from '../forecast.mjs';
import { predictionDocument } from '../forecast-report.mjs';
const sha=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,bundle=sampleBundle()) {
  const dir=await mkdtemp(join(tmpdir(),'dimension-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const text=JSON.stringify(bundle.report);bundle.receipt.files=[{name:'predictions.json',sha256:sha(text)}];
  await writeFile(join(dir,'predictions.json'),text);await writeFile(join(dir,'publication.json'),JSON.stringify(bundle.receipt));
  return {dir,bundle};
}
test('immutable publication binds report and input snapshot and rejects tampering',async t=>{
  const {dir,bundle}=await fixture(t);const nowISO=new Date(NOW).toISOString();
  const pointer=await persistReport(dir,{nowISO});assert.equal(pointer.reportId,bundle.reportId);
  assert.equal((await loadReportBundle(dir)).reportId,bundle.reportId);
  assert.equal((await persistReport(dir,{nowISO})).revision,1);
  const path=join(dir,'.delivery/reports',bundle.reportId,'content.json');
  const damaged=JSON.parse(await readFile(path));damaged.report.fixtures[0].fixture.home='tampered';await writeFile(path,JSON.stringify(damaged));
  await assert.rejects(loadReportBundle(dir),/PUBLICATION_CONTENT_CHANGED/);
  await assert.rejects(persistReport(dir,{nowISO}),/IMMUTABLE_REPORT_CONFLICT/);
});
test('a late receipt for A cannot replace current report B',async t=>{
  const {dir,bundle:a}=await fixture(t);await persistReport(dir,{nowISO:new Date(NOW).toISOString()});
  const b=sampleBundle();b.report.publication.reportId='b'.repeat(64);b.reportId=b.report.publication.reportId;b.report.generatedAt=new Date(NOW+1000).toISOString();
  b.receipt.reportId=b.reportId;b.receipt.generatedAt=b.report.generatedAt;
  const text=JSON.stringify(b.report);b.receipt.files=[{name:'predictions.json',sha256:sha(text)}];
  await writeFile(join(dir,'predictions.json'),text);await writeFile(join(dir,'publication.json'),JSON.stringify(b.receipt));
  await persistReport(dir,{nowISO:new Date(NOW+1000).toISOString()});
  a.receipt.channels.notifications={status:'accepted',messageId:1};await persistReportReceipt(dir,a.receipt);
  const current=await loadReportBundle(dir);assert.equal(current.reportId,b.reportId);assert.equal(current.receipt.reportId,b.reportId);
  assert.equal((await loadReportBundle(dir,{reportId:a.reportId})).receipt.channels.notifications.status,'accepted');
});
test('source data is required for OpenLiga-derived reports and simulation cannot publish',async t=>{
  const b=sampleBundle();b.report.fixtures[0].fixture.source='openligadb';
  const {dir}=await fixture(t,b);await assert.rejects(persistReport(dir,{nowISO:new Date(NOW).toISOString()}),/ENOENT/);
  const simulated=sampleBundle();simulated.report.simulated=true;simulated.receipt.simulated=true;
  const other=await fixture(t,simulated);await assert.rejects(persistReport(other.dir,{nowISO:new Date(NOW).toISOString()}),/SIMULATION_NOT_PUBLISHED/);
});
test('persisting an initial receipt again cannot erase an accepted notification or its event',async t=>{
  const {dir,bundle}=await fixture(t),nowISO=new Date(NOW).toISOString();await persistReport(dir,{nowISO});
  const checkedAt=new Date(NOW+1000).toISOString();
  const delivered={...bundle.receipt,channels:{...bundle.receipt.channels,notifications:{status:'accepted',checkedAt,messageId:57}},
    events:[{channel:'notifications',status:'accepted',checkedAt,messageId:57}]};
  await persistReportReceipt(dir,delivered);await persistReport(dir,{nowISO});
  const saved=await loadReportBundle(dir);assert.equal(saved.receipt.channels.notifications.messageId,57);
  assert.ok(saved.receipt.events.some(event=>event.messageId===57));
  await persistReportReceipt(dir,bundle.receipt);assert.equal((await loadReportBundle(dir)).receipt.channels.notifications.status,'accepted');
});
async function replaceInputs(directory, bundle) {
  const text=JSON.stringify(bundle.report);
  bundle.receipt.files=[{name:'predictions.json',sha256:sha(text)}];
  await writeFile(join(directory,'predictions.json'),text);
  await writeFile(join(directory,'publication.json'),JSON.stringify(bundle.receipt));
}
test('schema-invalid report or receipt cannot replace the last good current snapshot',async t=>{
  const {dir,bundle}=await fixture(t),nowISO=new Date(NOW+1000).toISOString();
  await persistReport(dir,{nowISO});
  const pointerPath=join(dir,'.delivery/current.json'),before=await readFile(pointerPath,'utf8');
  for(const mutate of [
    b=>{b.report.fixtures[0]={};},
    b=>{b.receipt.channels.files.status='invented';},
    b=>{b.receipt.generatedAt=new Date(NOW).toISOString();},
  ]) {
    const next=sampleBundle(sampleReport('b',1000));mutate(next);await replaceInputs(dir,next);
    await assert.rejects(persistReport(dir,{nowISO}));
    assert.equal(await readFile(pointerPath,'utf8'),before);
    assert.equal((await loadReportBundle(dir)).reportId,bundle.reportId);
  }
});
test('the complete UTF-8 bundle budget includes source data and rejected reports preserve last good',async t=>{
  const {dir,bundle}=await fixture(t),nowISO=new Date(NOW+1000).toISOString();await persistReport(dir,{nowISO});
  const before=await readFile(join(dir,'.delivery/current.json'),'utf8');
  const next=sampleBundle(sampleReport('b',1000));next.report.fixtures[0].fixture.source='openligadb';
  const raw={attribution:{name:'test'},fixtures:[],history:[],evidence:'界'.repeat(Math.ceil(MAX_REPORT_BUNDLE_BYTES/3))};
  await replaceInputs(dir,next);await writeFile(join(dir,'openligadb-fixtures.json'),JSON.stringify(raw));
  assert.ok(JSON.stringify(raw).length<MAX_REPORT_BUNDLE_BYTES,'UTF-8 bytes, not string length, determine the budget');
  await assert.rejects(persistReport(dir,{nowISO}),/REPORT_BUNDLE_TOO_LARGE/);
  assert.equal(await readFile(join(dir,'.delivery/current.json'),'utf8'),before);
  assert.equal((await loadReportBundle(dir)).reportId,bundle.reportId);
});
test('receipt growth or corruption cannot make an already served report unreadable',async t=>{
  const {dir,bundle}=await fixture(t),nowISO=new Date(NOW).toISOString();await persistReport(dir,{nowISO});
  const path=join(dir,'.delivery/reports',bundle.reportId,'receipt.json'),before=await readFile(path,'utf8');
  const invalid=structuredClone(bundle.receipt);invalid.channels.notifications={status:'invented',checkedAt:nowISO};
  await assert.rejects(persistReportReceipt(dir,invalid),/RECEIPT_SCHEMA_INVALID/);
  const large=structuredClone(bundle.receipt);large.events=[{detail:'界'.repeat(Math.ceil(MAX_REPORT_BUNDLE_BYTES/3))}];
  await assert.rejects(persistReportReceipt(dir,large),/REPORT_BUNDLE_TOO_LARGE/);
  assert.equal(await readFile(path,'utf8'),before);
  assert.equal((await loadReportBundle(dir)).reportId,bundle.reportId);
  // Replaying generation with an oversized receipt must also leave the served receipt untouched.
  await replaceInputs(dir,{...bundle,receipt:large});
  await assert.rejects(persistReport(dir,{nowISO}),/REPORT_BUNDLE_TOO_LARGE/);
  assert.equal(await readFile(path,'utf8'),before);
});
test('actual model summaries publish while oversized evaluation vectors preserve that good report',async t=>{
  const nowISO=new Date(NOW).toISOString(),at=days=>new Date(NOW+days*86400000).toISOString(),history=[];
  for(let round=0;round<12;round++)for(let home=1;home<=4;home++)for(let away=1;away<=4;away++)if(home!==away)history.push({
    id:`history-${history.length}`,source:'openligadb',league:'BL1',home:`Club ${home}`,away:`Club ${away}`,
    homeTeamId:String(home),awayTeamId:String(away),kickoff:at(-150+history.length),homeGoals:(round+home)%4,
    awayGoals:(round+away)%3,status:'FINISHED',period:'full-time'});
  const fixtures=Array.from({length:100},(_,i)=>({id:`target-${i}`,source:'openligadb',league:'BL1',home:'Home Club',away:'Away Club',
    homeTeamId:'1',awayTeamId:'2',kickoff:new Date(NOW+3600000*(2+i/4)).toISOString(),status:'SCHEDULED',updatedAt:nowISO}));
  const forecasts=buildForecasts({fixtures,history,nowISO});
  const report=predictionDocument({completedAt:nowISO,simulated:false,forecasts,
    summary:{total:100,forecasts:forecasts.summary.forecasts,forecastUnavailable:forecasts.summary.unavailable,candidates:0},
    publication:{reportId:'b'.repeat(64)},results:fixtures.map((fixture,i)=>({fixture,forecast:forecasts.rows[i],result:{status:'source_insufficient',reasons:[]}}))});
  assert.ok(report.backtests.length>100);assert.equal(validateReport(report),report);
  assert.ok(Buffer.byteLength(JSON.stringify(report))<MAX_REPORT_BUNDLE_BYTES);
  const {dir}=await fixture(t);await persistReport(dir,{nowISO});
  const next=sampleBundle(report);await replaceInputs(dir,next);
  await writeFile(join(dir,'openligadb-fixtures.json'),JSON.stringify({attribution:{name:'test'},fixtures:[],history:[]}));
  await persistReport(dir,{nowISO});
  assert.equal((await loadReportBundle(dir)).reportId,report.publication.reportId);
  const oversized=structuredClone(report);oversized.publication.reportId='c'.repeat(64);
  oversized.backtests=forecasts.backtests;
  assert.ok(Buffer.byteLength(JSON.stringify(oversized))>MAX_REPORT_BUNDLE_BYTES);
  await replaceInputs(dir,sampleBundle(oversized));
  await assert.rejects(persistReport(dir,{nowISO}),/REPORT_BUNDLE_TOO_LARGE/);
  assert.equal((await loadReportBundle(dir)).reportId,report.publication.reportId);
});
test('read-only report server requires its machine identity and exposes no arbitrary file path',async()=>{
  const token='x'.repeat(40),bundle=sampleBundle();let calls=0;
  const server=createReportServer({directory:'/unused',token,load:async()=>{calls++;return bundle;}});
  const request=(path,authorization,method='GET')=>new Promise(resolve=>{
    const response={headers:{},setHeader(k,v){this.headers[k]=v;},end(text){resolve({status:this.statusCode,body:text});}};
    server.emit('request',{method,url:path,headers:authorization?{authorization}:{}},response);
  });
  assert.equal((await request('/api/report')).status,401);assert.equal(calls,0);
  assert.equal((await request('/api/report','Bearer '+token)).status,200);
  assert.equal((await request('/api/report','Bearer '+token,'POST')).status,405);
  assert.equal((await request('/../../etc/passwd','Bearer '+token)).status,404);assert.equal(calls,1);
});
