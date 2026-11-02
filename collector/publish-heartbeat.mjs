import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostedClient} from './hosted.mjs';
const fail=x=>{throw new Error('HEARTBEAT_'+x)};
export async function publishHeartbeat(root,{env=process.env,fetchImpl=fetch,client}={}){
  if(!root)fail('ROOT_REQUIRED');
  const dir=resolve(root,'reports/heartbeat');
  const heartbeat=JSON.parse(await readFile(join(dir,'heartbeat.json'),'utf8'));
  if(heartbeat.kind!=='dimension-football-daily-system-heartbeat'
    ||heartbeat.telegram?.status!=='NOT_SENT'
    ||heartbeat.telegram?.messageId!==null)fail('REPORT_INVALID');
  const transport=client||createHostedClient({env,fetchImpl});
  const sent=await transport.request('/internal/system-heartbeat',{method:'POST',body:heartbeat});
  if(sent?.status!=='accepted'||!Number.isSafeInteger(sent.messageId)||sent.messageId<1
    ||sent.heartbeatId!==heartbeat.heartbeatId||sent.reportId!==heartbeat.reportId)
    fail('SEND_NOT_CONFIRMED');
  const readback=await transport.request('/internal/system-heartbeat',{method:'GET'});
  if(readback?.status!=='accepted'||readback?.messageId!==sent.messageId
    ||readback?.heartbeatId!==sent.heartbeatId||readback?.payloadSha256!==sent.payloadSha256)
    fail('READBACK_MISMATCH');
  const receipt={kind:'heartbeat-telegram-accepted-receipt',status:'accepted',
    heartbeatId:heartbeat.heartbeatId,reportId:heartbeat.reportId,
    messageId:sent.messageId,payloadSha256:sent.payloadSha256,
    destinationFingerprint:sent.destinationFingerprint,sentAt:sent.sentAt,
    persistedAndReadBack:true};
  await writeFile(join(dir,'telegram-receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  try{
    if(args.length!==2||args[0]!=='--root')fail('ARGS_INVALID');
    console.log(JSON.stringify(await publishHeartbeat(args[1])));
  }catch(error){
    console.error(/^HEARTBEAT_/.test(error?.message||'')?error.message:'HEARTBEAT_DELIVERY_UNVERIFIED');
    process.exitCode=1;
  }
}
