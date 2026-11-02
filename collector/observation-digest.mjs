import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, atomicJson } from './storage.mjs';
import { createHostedClient, HOSTED_REQUEST_TIMEOUT_MS } from './hosted.mjs';
import { reportHash } from './report-store.mjs';
import { validateBundle, MAX_REPORT_BUNDLE_BYTES } from '../website/report-schema.mjs';
import { VERIFIED_TARGET_FINGERPRINT } from '../website/hosted-notifications.mjs';
import { configureEnvironmentProxy } from './network.mjs';

const KIND='daily-observation-delivery',ID=/^[a-f0-9]{64}$/,FP=/^[a-f0-9]{16}$/;
const CLOCK_TOLERANCE_MS=5000;
const stamp=()=>new Date().toISOString(),object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=code=>{throw Error(code);};
const day=time=>new Date(time+8*3600000).toISOString().slice(0,10);
const CODES=new Set(['DAILY_NOT_DUE','DAILY_CLAIM_UNRESOLVED_NO_RETRY','DAILY_STORAGE_UNCERTAIN_NO_RETRY',
  'DAILY_TELEGRAM_ACCEPTED','DAILY_TELEGRAM_REJECTED','DAILY_TELEGRAM_RATE_LIMITED','DAILY_TELEGRAM_UNKNOWN_NO_RETRY',
  'DAILY_OUTCOME_NOT_PERSISTED_NO_RETRY','DAILY_REPORT_CHANGED_BEFORE_SEND','DAILY_REPORT_EXPIRED_BEFORE_SEND','DAILY_DATE_CHANGED_BEFORE_SEND']);
const REMOTE_ERRORS=new Set(['DAILY_REQUEST_INVALID','DAILY_CREDENTIALS_REQUIRED','DAILY_CONFIGURATION_INVALID',
  'DAILY_DESTINATION_MISMATCH','DAILY_ORIGIN_INVALID','DAILY_STORAGE_UNAVAILABLE','DAILY_STORAGE_INVALID','DAILY_REPORT_INVALID',
  'DAILY_REPORT_NOT_CURRENT','DAILY_OBSERVATION_REQUIRED','DAILY_REPORT_READBACK_REQUIRED','DAILY_REPORT_EXPIRED','MACHINE_IDENTITY_REQUIRED']);
const SKIPPED_CODES=new Set(['DAILY_NOT_DUE','DAILY_REPORT_CHANGED_BEFORE_SEND','DAILY_REPORT_EXPIRED_BEFORE_SEND','DAILY_DATE_CHANGED_BEFORE_SEND']);
const safeError=error=>/^(?:DIGEST_[A-Z0-9_]+|HOSTED_(?:OIDC_(?:NOT_CONFIGURED|REQUEST_FAILED|INVALID_RESPONSE)|REQUEST_UNCONFIRMED|INVALID_RESPONSE|RESPONSE_LIMIT_EXCEEDED|HTTP_[0-9]{3}))$/.test(error?.message||'')?error.message:'DIGEST_OPERATION_FAILED';

function verifiedStatus(value,expected){
  return object(value)&&value.version===1&&value.reportId===expected.reportId&&value.reportHash===expected.reportHash
    &&value.originReportId===expected.originReportId&&value.generatedAt===expected.generatedAt
    &&value.mode==='hosted'&&value.health==='available'&&value.publicationKind==='observations'&&value.forecastPublished===false;
}
async function localEvidence(root,now){
  let run,record;
  try{run=await readJson(resolve(root,'hosted-run.json'),32000);record=await readJson(resolve(root,'state/hosted-observation.json'),MAX_REPORT_BUNDLE_BYTES+64000);}
  catch{fail('DIGEST_LOCAL_EVIDENCE_UNREADABLE');}
  if(!object(run)||run.version!==1||run.mode!=='observations'||!['complete','idle'].includes(run.status)
    ||run.RELEASE_GATE!=='BLOCKED'||run.forecastPublished!==false||run.observationServedVerified!==true
    ||!ID.test(run.originReportId||'')||!ID.test(run.servedReportId||'')||!ID.test(run.servedReportHash||'')
    ||!Number.isFinite(Date.parse(run.checkedAt))||Date.parse(run.checkedAt)>now||now-Date.parse(run.checkedAt)>300000)
    fail('DIGEST_RUN_NOT_VERIFIED');
  const bundle=record?.bundle,report=bundle?.report,delivery=record?.delivery;
  try{validateBundle(bundle);}catch{fail('DIGEST_OBSERVATION_INVALID');}
  if(record.version!==1||record.bundleHash!==reportHash(bundle)||bundle.reportId!==run.originReportId
    ||report.generatedAt!==run.observationGeneratedAt||report.publicationKind!=='collection-observation'
    ||report.publication?.forecastPublished!==false||report.publication?.releaseGate!=='BLOCKED'||report.model!==null
    ||report.summary?.forecasts!==0||report.summary?.strictCandidates!==0||report.backtests?.length!==0
    ||report.fixtures.some(row=>row.forecast?.status!=='unavailable'||row.forecast?.probabilities!==undefined||row.marketCandidate?.candidate!==null)
    ||!Number.isFinite(Date.parse(report.generatedAt))||Date.parse(report.generatedAt)>now||now-Date.parse(report.generatedAt)>1200000
    ||!ID.test(report.acquisition?.snapshotHash||'')||!Number.isFinite(Date.parse(report.acquisition.checkedAt))
    ||Date.parse(report.acquisition.checkedAt)>Date.parse(report.generatedAt)||now-Date.parse(report.acquisition.checkedAt)>1200000)
    fail('DIGEST_OBSERVATION_INVALID');
  const expected={reportId:run.servedReportId,reportHash:run.servedReportHash,originReportId:run.originReportId,generatedAt:run.observationGeneratedAt};
  if(delivery?.status!=='verified'||!verifiedStatus(delivery,expected)||delivery.reportId===bundle.reportId
    ||!Number.isFinite(Date.parse(delivery.checkedAt))||Date.parse(delivery.checkedAt)>Date.parse(run.checkedAt))fail('DIGEST_LOCAL_READBACK_MISMATCH');
  if(report.marketObservation?.sources?.some(source=>source.quoteCount>0)
    &&!(Date.parse(report.marketObservation.expiresAt)>now))fail('DIGEST_MARKET_OBSERVATION_EXPIRED');
  return expected;
}
function receiptTimeValid(row,now,requestAt){
  const checked=Date.parse(row?.checkedAt);
  if(!Number.isFinite(checked)||!Number.isFinite(now)||!Number.isFinite(requestAt)||checked>now+CLOCK_TOLERANCE_MS)return false;
  if(row.code==='DAILY_DATE_CHANGED_BEFORE_SEND'&&day(checked)===row.date)return false;
  if(row.date===day(now)&&day(checked)===row.date)return true;
  // A real POST begun before Beijing midnight may be acknowledged just after
  // midnight. Keep the original daily lock, bounded by this HTTP request's
  // deadline; an arbitrary previous-day receipt is never made current.
  const requestDay=day(requestAt),nextDay=day(requestAt+86400000);
  return row.date===requestDay&&day(now)===nextDay&&now>=requestAt
    &&now-requestAt<=HOSTED_REQUEST_TIMEOUT_MS+CLOCK_TOLERANCE_MS
    &&checked>=requestAt-CLOCK_TOLERANCE_MS&&[requestDay,nextDay].includes(day(checked));
}
function safeReceipt(response,expected,expectedFingerprint,now,requestAt,httpStatus=200){
  const row=response?.receipt;
  if(response?.version!==1||response.kind!==KIND||response.requestedReportId!==expected.reportId
    ||typeof response.sentNow!=='boolean'||!object(row)||row.version!==1||row.kind!==KIND
    ||!ID.test(row.reportId||'')||row.destinationFingerprint!==expectedFingerprint
    ||!receiptTimeValid(row,now,requestAt)
    ||!['accepted','skipped','unknown','failed'].includes(row.status)||!CODES.has(row.code)
    ||(row.status==='accepted'||row.status==='skipped'?httpStatus!==200:row.status==='unknown'?httpStatus!==503:httpStatus!==502)
    ||row.sentNow!==response.sentNow||response.sentNow&&row.status!=='accepted'
    ||(response.sentNow||row.code==='DAILY_NOT_DUE')&&row.reportId!==expected.reportId
    ||row.status==='accepted'&&row.code!=='DAILY_TELEGRAM_ACCEPTED'||row.status==='skipped'&&!SKIPPED_CODES.has(row.code)
    ||row.code==='DAILY_NOT_DUE'&&new Date(now+8*3600000).getUTCHours()>=9
    ||row.reportHash!==undefined&&(!ID.test(row.reportHash)||row.reportId===expected.reportId&&row.reportHash!==expected.reportHash)
    ||row.payloadSha256!==undefined&&!ID.test(row.payloadSha256)
    ||row.status==='accepted'&&(!Number.isSafeInteger(row.messageId)||row.messageId<=0||!ID.test(row.reportHash||'')||!ID.test(row.payloadSha256||''))
    ||row.status!=='accepted'&&row.messageId!==undefined)fail('DIGEST_RECEIPT_INVALID');
  // Construct a new object. Never persist unknown server fields, error text,
  // credentials, target IDs, Telegram response bodies or the POST request.
  return {version:1,kind:KIND,date:row.date,reportId:row.reportId,status:row.status,code:row.code,
    checkedAt:row.checkedAt,destinationFingerprint:row.destinationFingerprint,sentNow:response.sentNow,
    ...(row.reportHash===undefined?{}:{reportHash:row.reportHash}),...(row.payloadSha256===undefined?{}:{payloadSha256:row.payloadSha256}),
    ...(row.status==='accepted'?{messageId:row.messageId}:{})};
}

/** Test factory supports a synthetic target; the production export is pinned. */
export function createObservationDigest({verifiedTargetFingerprint=VERIFIED_TARGET_FINGERPRINT}={}){
  if(!FP.test(verifiedTargetFingerprint))fail('DIGEST_CONFIGURATION_INVALID');
  return async function run({root,env=process.env,mode=env.HOSTED_MODE,clock=stamp,fetchImpl=fetch,client:providedClient,
    stdout=text=>process.stdout.write(text)}={}){
    let expected,receipt,failure=null,postStarted=false,requestAt;
    const now=Date.parse(clock());
    try{
      if(!root||!Number.isFinite(now))fail('DIGEST_INVALID_ARGUMENT');
      if(mode!=='observations')fail('DIGEST_MODE_NOT_OBSERVATIONS');
      expected=await localEvidence(resolve(root),now);
      const client=providedClient||createHostedClient({env,fetchImpl,clock:()=>Date.parse(clock())});
      if(!verifiedStatus(await client.request('/internal/report-status'),expected))fail('DIGEST_CURRENT_READBACK_MISMATCH');
      postStarted=true;requestAt=Date.parse(clock());
      let result;
      try{result=await client.request('/internal/observation-notifications',{method:'POST',body:{reportId:expected.reportId},limit:32000,
        ...(!providedClient?{fetchImpl:(...args)=>{requestAt=Date.parse(clock());return fetchImpl(...args);}}:{})});}
      catch(error){
        if(error.digestResponse?.receipt)receipt=safeReceipt(error.digestResponse,expected,verifiedTargetFingerprint,Date.parse(clock()),requestAt,error.httpStatus);
        else if(REMOTE_ERRORS.has(error.digestResponse?.error))fail('DIGEST_REMOTE_'+error.digestResponse.error);
        throw error;
      }
      receipt=safeReceipt(result,expected,verifiedTargetFingerprint,Date.parse(clock()),requestAt);
      if(receipt.status!=='accepted'&&!(receipt.status==='skipped'&&receipt.code==='DAILY_NOT_DUE'))fail('DIGEST_DELIVERY_NOT_ACCEPTED');
    }catch(error){failure=safeError(error);}
    const output={version:1,kind:'observation-digest-run',checkedAt:clock(),RELEASE_GATE:'BLOCKED',forecastPublished:false,
      status:receipt?.status||(failure==='DIGEST_REMOTE_DAILY_CREDENTIALS_REQUIRED'?'not_configured':failure?.startsWith('DIGEST_REMOTE_')?'blocked':postStarted?'unknown':'blocked'),
      ...(failure?{code:failure}:{}),sentNow:receipt?.sentNow===true,
      ...(Number.isFinite(requestAt)?{requestStartedAt:new Date(requestAt).toISOString()}:{}),
      ...(expected?{reportId:expected.reportId,reportHash:expected.reportHash,originReportId:expected.originReportId}:{}),
      ...(receipt?{receipt}:{}),
      ...(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||'')?{runnerCommit:env.GITHUB_SHA}:{}),
      ...(/^[1-9][0-9]{0,19}$/.test(env.GITHUB_RUN_ID||'')?{workflowRunId:env.GITHUB_RUN_ID}:{}),
      ...(/^[1-9][0-9]{0,5}$/.test(env.GITHUB_RUN_ATTEMPT||'')?{workflowRunAttempt:env.GITHUB_RUN_ATTEMPT}:{}),
      meaning:'schedule-and-data-status-only; not-forecast-recommendations; api-accepted-not-user-read'};
    try{if(root)await atomicJson(resolve(root,'observation-digest.json'),output);}
    catch{output.code='DIGEST_EVIDENCE_WRITE_FAILED';failure=output.code;}
    stdout(JSON.stringify(output)+'\n');return {...output,exitCode:failure?1:0};
  };
}
export const runObservationDigest=createObservationDigest();

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  try{
    for(let i=0;i<args.length;i+=2){if(!['--root','--mode'].includes(args[i])||!args[i+1]||options[args[i]])fail('DIGEST_INVALID_ARGUMENT');options[args[i]]=args[i+1];}
    configureEnvironmentProxy(process.env);
    process.exitCode=(await runObservationDigest({root:options['--root'],mode:options['--mode']})).exitCode;
  }catch(error){console.error(JSON.stringify({status:'blocked',code:safeError(error)}));process.exitCode=1;}
}
