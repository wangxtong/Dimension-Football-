import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { acquireLock, atomicJson, readJson } from './storage.mjs';

const STATES=['pending','active','review','verified','blocked'];
// Updates a local repair ledger only. No source changes, deployments or AI calls.
export async function recordTask({root,id,role,status,commit,evidenceFile,dependency,clock=()=>new Date().toISOString()}) {
  if(!/^[A-Za-z0-9_-]{1,60}$/.test(id||'')||!/^A[1-8]$/.test(role||'')||!STATES.includes(status)
    ||commit&&!/^[a-f0-9]{40}$/.test(commit)||status==='blocked'&&!/^[A-Za-z0-9_. -]{1,120}$/.test(dependency||''))throw Error('TASK_INVALID');
  const now=clock(), evidence=[];
  if(evidenceFile) {
    const evidenceRoot=await realpath(resolve(root,'operations/evidence')),path=await realpath(resolve(evidenceRoot,evidenceFile));
    const name=relative(evidenceRoot,path);
    if(name.startsWith('..')||name===''||!name.endsWith('.json'))throw Error('EVIDENCE_PATH_INVALID');
    const bytes=await readFile(path);if(bytes.length>100000)throw Error('EVIDENCE_TOO_LARGE');
    const document=JSON.parse(bytes);
    if(document.kind!=='acceptance'||document.passed!==true||document.commitSha!==commit||!Number.isFinite(Date.parse(document.checkedAt))
      ||Date.parse(document.checkedAt)>Date.parse(now)||Date.parse(now)-Date.parse(document.checkedAt)>86400000
      ||!Array.isArray(document.checks)||document.checks.length===0)throw Error('ACCEPTANCE_EVIDENCE_INVALID');
    evidence.push(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  if(status==='verified'&&(!evidence.length||!commit))throw Error('VERIFIED_REQUIRES_ACCEPTANCE_EVIDENCE');
  const path=resolve(root,'operations/tasks.json'),release=await acquireLock(path);
  try {
    let ledger;try{ledger=await readJson(path);}catch(error){if(error.code!=='ENOENT')throw error;ledger={version:1,tasks:[],events:[]};}
    if(ledger.version!==1||!Array.isArray(ledger.tasks)||!Array.isArray(ledger.events))throw Error('TASK_LEDGER_INVALID');
    const old=ledger.tasks.find(task=>task.id===id);
    if(old?.role!==undefined&&old.role!==role)throw Error('TASK_OWNER_MISMATCH');
    if(status==='verified'&&old?.status!=='review')throw Error('VERIFICATION_REQUIRES_REVIEW');
    const row={id,role,status,updatedAt:now,evidence,...(commit?{commit}:{}),...(status==='verified'?{verifiedAt:now}:{}),...(status==='blocked'?{dependency}: {})};
    ledger.tasks=[...ledger.tasks.filter(task=>task.id!==id),row];
    ledger.events=[...ledger.events.slice(-199),{id,from:old?.status||null,to:status,at:now}];
    await atomicJson(path,ledger);return row;
  } finally {await release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args[0]==='--help')console.log('control.mjs --root DIR --id TASK --role A1..A8 --status pending|active|review|verified|blocked [--commit SHA] [--evidence-file FILE.json] [--dependency CODE]');
    else {
      if(args.length%2)throw Error('TASK_USAGE');const o={};
      for(let i=0;i<args.length;i+=2){if(!['--root','--id','--role','--status','--commit','--evidence-file','--dependency'].includes(args[i])||o[args[i]])throw Error('TASK_USAGE');o[args[i]]=args[i+1];}
      console.log(JSON.stringify(await recordTask({root:resolve(o['--root']||'/var/lib/vantis'),id:o['--id'],role:o['--role'],status:o['--status'],commit:o['--commit'],evidenceFile:o['--evidence-file'],dependency:o['--dependency']})));
    }
  }catch(error){console.error(JSON.stringify({status:'failed',code:/^[A-Z_]{3,80}$/.test(error.message)?error.message:'TASK_UPDATE_FAILED'}));process.exitCode=1;}
}
