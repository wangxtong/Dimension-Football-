import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordTask } from '../control.mjs';
const NOW='2026-10-31T08:00:00Z',commit='a'.repeat(40);
test('task ownership and review acceptance prevent an active task masquerading as verified deployment',async t=>{
 const root=await mkdtemp(join(tmpdir(),'vantis-control-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input={root,id:'operations',role:'A7',status:'active',clock:()=>NOW};
 await recordTask(input);await assert.rejects(recordTask({...input,role:'A6'}),/OWNER_MISMATCH/);
 await assert.rejects(recordTask({...input,status:'verified'}),/REQUIRES_ACCEPTANCE/);
 await mkdir(join(root,'operations/evidence'));
 await writeFile(join(root,'operations/evidence/check.json'),JSON.stringify({kind:'acceptance',passed:true,commitSha:commit,checkedAt:NOW,checks:['runtime_contract']}));
 await assert.rejects(recordTask({...input,status:'verified',commit,evidenceFile:'check.json'}),/REQUIRES_REVIEW/);
 await recordTask({...input,status:'review',commit});
 const result=await recordTask({...input,status:'verified',commit,evidenceFile:'check.json'});assert.equal(result.status,'verified');assert.match(result.evidence[0],/^sha256:[a-f0-9]{64}$/);
 assert.equal(JSON.parse(await readFile(join(root,'operations/tasks.json'))).events.length,3);
});
