import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildHeartbeat} from '../../collector/heartbeat-contract.mjs';
import {validateHeartbeat,formatHeartbeat,deliverHeartbeat} from '../system-heartbeat.mjs';
import {MemoryBucket} from './hosted-fixtures.mjs';
import {VERIFIED_DASHBOARD_ORIGIN} from '../hosted-notifications.mjs';
const nowISO='2026-11-02T09:00:00.000Z',NOW=Date.parse(nowISO);
const codeSha='a'.repeat(40),reportId='b'.repeat(64),chatId='-1001234567890';
const fingerprint=createHash('sha256').update(chatId).digest('hex').slice(0,16);
function report(){
  return buildHeartbeat({nowISO,codeSha,sourceManifest:{simulated:false,checkedAt:'2026-11-02T08:59:00.000Z',
    diagnostics:[{id:'openligadb',league:'BL1',season:'2026',status:'partial',httpStatus:200,
      checkedAt:'2026-11-02T08:59:00.000Z',fetchedAt:'2026-11-02T08:59:01.000Z'}]},
  predictionDocument:{kind:'prematch-forecast-report',simulated:false,
    generatedAt:'2026-11-02T08:59:20.000Z',publication:{reportId},model:{id:'venue-poisson-v2',version:2},
    summary:{forecasts:1},fixtures:[{fixture:{id:'oldb-100',kickoff:'2026-11-06T19:30:00.000Z'},
      forecast:{status:'forecast',generatedAt:'2026-11-02T08:59:20.000Z'}}]},
  siteReceipt:null});
}
function env(extra={}){
  return {BUCKET:new MemoryBucket(),HOSTED_PUBLICATION_ENABLED:'true',
    VANTIS_SYSTEM_HEARTBEAT_ENABLED:'true',DASHBOARD_ORIGIN:VERIFIED_DASHBOARD_ORIGIN,
    TELEGRAM_BOT_TOKEN:'8858788137:isolated-test',TELEGRAM_CHAT_ID:chatId,...extra};
}
test('only SHA-consistent, bounded actual heartbeat report is accepted',async()=>{
  const r=report();await validateHeartbeat(r,NOW);
  const p=formatHeartbeat(r);
  assert.match(p.text,/采集成功\/失败：1\/0/);
  assert.match(p.text,/自动预测场数：1/);
  assert.match(p.text,/部署环境：<b>Unhealthy<\/b>/);
  assert.match(p.text,new RegExp(r.heartbeatId));
  await assert.rejects(validateHeartbeat({...r,forecastsGenerated:99},NOW),/HEARTBEAT_HASH_MISMATCH/);
  await assert.rejects(validateHeartbeat({...r,telegram:{status:'accepted',messageId:123}},NOW),/HEARTBEAT_INPUT_INVALID/);
});
test('Site private Telegram sender accepts exact destination and persists one message only',async()=>{
  const r=report(),environment=env(),calls=[];
  const fetchImpl=async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body)});
    return Response.json({ok:true,result:{message_id:321,chat:{id:Number(chatId)}}});
  };
  const options={now:NOW,fetchImpl,targetFingerprint:fingerprint,verifiedBotId:'8858788137'};
  const first=await deliverHeartbeat(environment,r,options);
  assert.equal(first.status,'accepted');assert.equal(first.messageId,321);
  assert.equal(first.heartbeatId,r.heartbeatId);assert.equal(first.reportId,r.reportId);
  assert.equal(first.destinationFingerprint,fingerprint);
  assert.equal(calls.length,1);
  assert.equal(calls[0].body.chat_id,chatId);
  assert.match(calls[0].body.text,/系统心跳/);
  const dup=await deliverHeartbeat(environment,r,options);
  assert.equal(dup.messageId,321);
  assert.equal(calls.length,1,'retry must not send a second Telegram message');
  const storage=environment.BUCKET.json('system-heartbeat/2026-11-02-'+fingerprint);
  assert.equal(storage.state,'complete');assert.equal(storage.outcome.messageId,321);
});
test('no feature flag, unauthorized destination or uncertain Telegram HTTP cannot silently pass',async()=>{
  const r=report(),e=env({VANTIS_SYSTEM_HEARTBEAT_ENABLED:'false'});
  await assert.rejects(deliverHeartbeat(e,r,{now:NOW,targetFingerprint:fingerprint}),/HEARTBEAT_DISABLED/);
  assert.equal(e.BUCKET.rows.size,0);
  await assert.rejects(deliverHeartbeat(env({TELEGRAM_CHAT_ID:'-1001112223334'}),r,
    {now:NOW,targetFingerprint:fingerprint}),/HEARTBEAT_DESTINATION_DENIED/);
  const failed=env();
  const output=await deliverHeartbeat(failed,r,{now:NOW,targetFingerprint:fingerprint,
    fetchImpl:async()=>Response.json({ok:false,description:'blocked'},{status:403})});
  assert.equal(output.status,'failed');
  assert.equal(output.messageId,null);
  const second=await deliverHeartbeat(failed,r,{now:NOW,targetFingerprint:fingerprint,
    fetchImpl:async()=>{throw Error('should not retry')}});
  assert.equal(second.status,'failed');
});
