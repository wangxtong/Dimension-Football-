import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claimNotification, recordNotificationOutcome } from '../outbox.mjs';

const reportId='a'.repeat(64),destinationFingerprint='b'.repeat(16),nowISO='2026-10-31T08:00:00.000Z';
const options={reportId,destinationFingerprint,nowISO};
async function fixture(t){const dir=await mkdtemp(join(tmpdir(),'dimension-outbox-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
test('independent processes compete for one durable claim and unresolved claims cannot be resent',async t=>{
  const dir=await fixture(t),module=new URL('../outbox.mjs',import.meta.url).href;
  const code=`import {claimNotification} from ${JSON.stringify(module)};console.log(JSON.stringify(await claimNotification(process.argv[1],JSON.parse(process.argv[2]))));`;
  const children=await Promise.all(Array.from({length:3},()=>promisify(execFile)(process.execPath,['--input-type=module','-e',code,dir,JSON.stringify(options)])));
  const results=children.map(child=>JSON.parse(child.stdout));assert.equal(results.filter(r=>r.claim).length,1);
  assert.ok(results.filter(r=>!r.claim).every(r=>r.result.status==='unknown'));
  const resumed=await claimNotification(dir,options);assert.equal(resumed.result.status,'unknown');
});
test('a saved API acceptance survives recovery and cannot be overwritten by a later outcome',async t=>{
  const dir=await fixture(t),{claim}=await claimNotification(dir,options);
  const result={status:'accepted',checkedAt:nowISO,messageId:42,destinationFingerprint};
  await recordNotificationOutcome(dir,claim,result);
  assert.deepEqual((await claimNotification(dir,options)).result,result);
  assert.deepEqual(await recordNotificationOutcome(dir,claim,{status:'unknown'}),result);
  const body=await readFile(join(dir,'.delivery/outbox',`${reportId}-${destinationFingerprint}.json`),'utf8');assert.ok(!body.includes('chat_id'));
});
test('hourly claims suppress other reports, next hour permits a new report, corrupt claims fail closed',async t=>{
  const dir=await fixture(t);await claimNotification(dir,options);
  const second=await claimNotification(dir,{...options,reportId:'c'.repeat(64)});assert.equal(second.result.code,'HOURLY_SUMMARY_ALREADY_CLAIMED');
  assert.ok((await claimNotification(dir,{...options,reportId:'d'.repeat(64),nowISO:'2026-10-31T09:00:00.000Z'})).claim);
  await writeFile(join(dir,'.delivery/outbox',`${reportId}-${destinationFingerprint}.json`),'{');
  assert.equal((await claimNotification(dir,options)).result.code,'DELIVERY_OUTBOX_UNREADABLE');
});
