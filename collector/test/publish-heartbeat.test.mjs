import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publishHeartbeat} from '../publish-heartbeat.mjs';
const ID='a'.repeat(64),REPORT='b'.repeat(64);
const saved=()=>({heartbeatId:ID,reportId:REPORT,status:'accepted',
  messageId:123,payloadSha256:'c'.repeat(64),destinationFingerprint:'d'.repeat(16),
  sentAt:'2026-11-02T09:01:00.000Z'});
async function root(t){
  const dir=await mkdtemp(join(tmpdir(),'heartbeat-publish-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  await mkdir(join(dir,'reports','heartbeat'),{recursive:true});
  await writeFile(join(dir,'reports','heartbeat','heartbeat.json'),
    JSON.stringify({kind:'dimension-football-daily-system-heartbeat',heartbeatId:ID,
      reportId:REPORT,telegram:{status:'NOT_SENT',messageId:null}}));
  return dir;
}
test('accepted Bot message ID and independent Site readback are required',async t=>{
  const dir=await root(t),calls=[];
  const client={request:async(path,opts)=>{
    calls.push([path,opts.method]);
    return saved();
  }};
  const result=await publishHeartbeat(dir,{client});
  assert.equal(result.status,'accepted');
  assert.equal(result.persistedAndReadBack,true);
  assert.equal(result.messageId,123);
  assert.deepEqual(calls,[['/internal/system-heartbeat','POST'],['/internal/system-heartbeat','GET']]);
  assert.equal(JSON.parse(await readFile(join(dir,'reports','heartbeat','telegram-receipt.json'),'utf8')).messageId,123);
});
test('unknown send, changed message ID or forged GET all prevent success receipt',async t=>{
  const candidates=[
    async()=>({status:'unknown',heartbeatId:ID,reportId:REPORT}),
    async(path,opts)=>opts.method==='POST'?saved():{...saved(),messageId:124},
    async(path,opts)=>opts.method==='POST'?saved():{...saved(),payloadSha256:'0'.repeat(64)}
  ];
  for(const handler of candidates){
    const dir=await root(t);
    await assert.rejects(publishHeartbeat(dir,{client:{request:handler}}),/HEARTBEAT_/);
    await assert.rejects(readFile(join(dir,'reports','heartbeat','telegram-receipt.json'),'utf8'));
  }
});
test('not-sent source is mandatory; never take a previously asserted sent receipt on trust',async t=>{
  const dir=await root(t);
  await writeFile(join(dir,'reports','heartbeat','heartbeat.json'),
    JSON.stringify({kind:'dimension-football-daily-system-heartbeat',heartbeatId:ID,
      reportId:REPORT,telegram:{status:'accepted',messageId:12}}));
  await assert.rejects(publishHeartbeat(dir,{client:{request:async()=>saved()}}),/HEARTBEAT_REPORT_INVALID/);
});
