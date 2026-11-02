import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildResearchSync, researchTelegramDraft, researchWebHTML } from '../website/research-dual-channel.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fatal=code=>{throw new Error('RESEARCH_SYNC_'+code)};
const readJSON=async path=>{
  const stat=await lstat(path);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.size>5_000_000||stat.size<2) fatal('INPUT_INVALID');
  const b=await readFile(path);
  try{return {bytes:b,json:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b))}}
  catch{fatal('JSON_INVALID')}
};
const writeNew=async (path,text)=>{
  const file=await open(path,'wx',0o600);
  try{await file.writeFile(text);await file.sync();}finally{await file.close()}
};
export async function exportResearchWebTg({root}={}){
  if(typeof root!=='string'||!isAbsolute(root))fatal('ROOT_INVALID');
  const base=resolve(root),stat=await lstat(base);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await realpath(base)!==base)fatal('ROOT_INVALID');
  const [report,publication,stage1,evaluation]=await Promise.all([
    readJSON(join(base,'reports/predictions.json')),
    readJSON(join(base,'reports/publication.json')),
    readJSON(join(base,'stage1-status.json')),
    readJSON(join(base,'reports/prospective-evaluation.json')),
  ]);
  const synced=buildResearchSync({report:report.json,publication:publication.json,
    stage1:stage1.json,evaluation:evaluation.json,
    reportBytes:report.bytes,publicationBytes:publication.bytes});
  const web=researchWebHTML(synced),messages=researchTelegramDraft(synced);
  if(messages.some(x=>x.length>4096)||!messages.length)fatal('MESSAGE_LIMIT');
  const dir=join(base,'dual-channel-private-preview');
  await mkdir(dir,{mode:0o700});
  const targets={
    'same-report-snapshot.json':JSON.stringify(synced,null,2)+'\n',
    'web-research-preview.html':web,
    'telegram-research-preview.json':JSON.stringify({reportId:synced.sourceReportId,
      sourceSnapshotSha256:synced.projectionSha256,
      parseMode:'HTML',messages,sendStatus:'NOT_SENT',releaseGate:'BLOCKED'},null,2)+'\n',
  };
  const manifest=[];
  for(const [name,content] of Object.entries(targets)){
    await writeNew(join(dir,name),content);
    manifest.push({name,sha256:sha(Buffer.from(content)),bytes:Buffer.byteLength(content)});
  }
  const receipt={version:1,kind:'private-dual-channel-preview-receipt',
    sourceReportId:synced.sourceReportId,sourceSnapshotSha256:synced.projectionSha256,
    model:synced.model,matchedForecasts:synced.count.researchForecasts,
    webStatus:'LOCAL_PRIVATE_ARTIFACT_ONLY',telegramStatus:'DRAFT_NOT_SENT',
    releaseGate:'BLOCKED',externalDeliveryAttempted:false,
    files:manifest};
  await writeNew(join(dir,'readback-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  return {directory:dir,receipt};
}
export async function verifyResearchWebTg({directory}={}){
  if(typeof directory!=='string'||!isAbsolute(directory))fatal('RECEIPT_DIR_INVALID');
  const root=resolve(directory),st=await lstat(root);
  if(!st.isDirectory()||st.isSymbolicLink()||await realpath(root)!==root)fatal('RECEIPT_DIR_INVALID');
  const x=await readJSON(join(root,'readback-receipt.json'));
  const receipt=x.json;
  if(receipt.version!==1||receipt.kind!=='private-dual-channel-preview-receipt'
    ||receipt.webStatus!=='LOCAL_PRIVATE_ARTIFACT_ONLY'
    ||receipt.telegramStatus!=='DRAFT_NOT_SENT'
    ||receipt.releaseGate!=='BLOCKED'||receipt.externalDeliveryAttempted!==false
    ||!Array.isArray(receipt.files)||receipt.files.length!==3)fatal('RECEIPT_INVALID');
  const expected=['same-report-snapshot.json','web-research-preview.html','telegram-research-preview.json'];
  const files={};
  for(let i=0;i<expected.length;i++){
    const item=receipt.files[i];
    if(item.name!==expected[i])fatal('FILE_MANIFEST_INVALID');
    const content=await readFile(join(root,item.name));
    if(sha(content)!==item.sha256||content.length!==item.bytes)fatal('FILE_HASH_MISMATCH');
    files[item.name]=content.toString('utf8');
  }
  const projection=JSON.parse(files['same-report-snapshot.json']);
  const telegram=JSON.parse(files['telegram-research-preview.json']);
  const { projectionSha256: embeddedHash, ...withoutHash } = projection;
  if(sha(Buffer.from(JSON.stringify(withoutHash)))!==embeddedHash)fatal('PROJECTION_HASH_MISMATCH');
  if(projection.sourceReportId!==receipt.sourceReportId
    ||projection.projectionSha256!==receipt.sourceSnapshotSha256
    ||telegram.reportId!==receipt.sourceReportId
    ||telegram.sourceSnapshotSha256!==receipt.sourceSnapshotSha256
    ||telegram.sendStatus!=='NOT_SENT'||telegram.releaseGate!=='BLOCKED'
    ||JSON.stringify(telegram.messages)!==JSON.stringify(researchTelegramDraft(projection))
    ||files['web-research-preview.html']!==researchWebHTML(projection))fatal('CROSS_CHANNEL_MISMATCH');
  return {status:'PRIVATE_WEB_TG_PREVIEWS_VERIFIED',reportId:receipt.sourceReportId,
    rows:projection.count.fixtures,forecasts:projection.count.researchForecasts,
    telegramPages:telegram.messages.length,webLive:false,telegramSent:false,
    sha256:receipt.sourceSnapshotSha256,releaseGate:'BLOCKED'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [action,folder]=process.argv.slice(2);
  try{
    const r=action==='export'?await exportResearchWebTg({root:folder})
      :action==='verify'?await verifyResearchWebTg({directory:folder})
      :fatal('INVALID_ARGUMENTS');
    process.stdout.write(JSON.stringify(r)+'\n');
  }catch(error){
    process.stderr.write(error.message?.startsWith('RESEARCH_SYNC_')?error.message+'\n':'RESEARCH_SYNC_FAILED\n');
    process.exitCode=1;
  }
}