import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson } from './storage.mjs';
import { runOrchestration } from './orchestrate.mjs';
import { persistReport, persistReportReceipt, loadReportBundle, reportHash } from './report-store.mjs';
import { mergePublicationReceipts } from './publication.mjs';
import { validateBundle, validateReceipt, MAX_REPORT_BUNDLE_BYTES } from '../website/report-schema.mjs';
import { verifyAcquisitionSnapshot } from './data/acquisition-snapshot.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { requireGreenForecastDelivery } from './publication-release-gate.mjs';
import { runPublic } from './public.mjs';
import { createAcquisitionSnapshot } from './data/acquisition-snapshot.mjs';
import { DEFAULT_POLICY } from './policy.mjs';
import { ARCHIVE_LIMITS, archiveHash, archivePath, createArchiveEpoch, emptyArchive, validateArchive,
  createArchiveShard, decodeArchiveShard, appendArchive } from './state-archive.mjs';

export const HOSTED_ORIGIN = 'https://dimension-football-live-wangxtong.secretmelon37.chatgpt.site';
export const HOSTED_REQUEST_TIMEOUT_MS = 20000;
export const STATE_LIMITS = Object.freeze({ jsonBytes:32 * 1024 * 1024, decodedBytes:64 * 1024 * 1024, files:10000 });
const TOP_REPORTS = new Set(['predictions.json','publication.json','public-fixtures.json','public-source-fixtures.json','openligadb-fixtures.json',
  'run-inputs.json','run-manifest.json','prospective-evaluation.json']);
const ID = /^[a-f0-9]{64}$/;
const PRIVATE_NAME = /(?:^|[._-])(?:secrets?|credentials?|tokens?|auth|password|env|locks?|symlinks?|private[-_]?key)(?:[._-]|$)/i;
const stamp = () => new Date().toISOString();
const safeCode = error => /^(?:HOSTED_[A-Z0-9_]+|RELEASE_GATE_BLOCKED)$/.test(error?.message || '') ? error.message : 'HOSTED_OPERATION_FAILED';
const fail = code => { throw Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
async function optionalJson(path, limit) { try { return await readJson(path, limit); } catch (error) { if(error.code==='ENOENT')return null; throw error; } }

export function allowedStatePath(path) {
  if (typeof path !== 'string' || path.length > 300 || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..' || PRIVATE_NAME.test(p))) return false;
  if (/^state\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(path)) return true;
  if (path.startsWith('reports/') && TOP_REPORTS.has(path.slice(8))) return true;
  // 研究日报与它的 Telegram 回执必须随 state 跨 runner 存活：否则每个新 runner 都是空回执，
  // 同一天被 schedule 补偿重跑时会重复推送。
  if (/^reports\/research-daily\/(?:latest|telegram-receipt)\.(?:json|md)$/.test(path)) return true;
  return /^reports\/forecast-ledger\/[a-f0-9]{64}\/(?:predictions|results|scores|opportunities)\/[a-f0-9]{64}\.json$/.test(path)
    || /^reports\/replays\/[a-f0-9]{64}\/(?:run-inputs|run-manifest)\.json$/.test(path)
    || path === 'reports/.delivery/current.json'
    || /^reports\/\.delivery\/reports\/[a-f0-9]{64}\/(?:content|receipt)\.json$/.test(path);
}
function allowedDirectory(path, currentId) {
  if (path.length > 300) return false;
  if (path === 'state' || /^state\/(?:[A-Za-z0-9_-]+\/?)+$/.test(path)) return !path.split('/').some(p => PRIVATE_NAME.test(p));
  if (['reports','reports/forecast-ledger','reports/replays','reports/.delivery','reports/.delivery/reports'].includes(path)) return true;
  if (path === 'reports/research-daily') return true;
  return /^reports\/forecast-ledger\/[a-f0-9]{64}(?:\/(?:predictions|results|scores|opportunities))?$/.test(path)
    || /^reports\/replays\/[a-f0-9]{64}$/.test(path)
    || currentId && path === `reports/.delivery/reports/${currentId}`;
}
function decodeFile(file) {
  if (!object(file) || Object.keys(file).sort().join(',') !== 'content,path' || !allowedStatePath(file.path)
    || typeof file.content !== 'string' || file.content.length % 4 || /[^A-Za-z0-9+/=]/.test(file.content)) fail('HOSTED_STATE_INVALID_FILE');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content) fail('HOSTED_STATE_INVALID_FILE');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal:true }).decode(bytes)); } catch { fail('HOSTED_STATE_INVALID_JSON'); }
  return { bytes, value };
}
export function validateStateSnapshot(snapshot, limits = STATE_LIMITS) {
  if (!object(snapshot) || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.files)) fail('HOSTED_STATE_INVALID');
  if (snapshot.files.length > limits.files || Buffer.byteLength(JSON.stringify(snapshot)) > limits.jsonBytes) fail('HOSTED_STATE_LIMIT_EXCEEDED');
  const decoded = new Map(); let total = 0;
  for (const file of snapshot.files) {
    if (decoded.has(file.path)) fail('HOSTED_STATE_DUPLICATE_PATH');
    const entry = decodeFile(file); total += entry.bytes.length;
    if (total > limits.decodedBytes) fail('HOSTED_STATE_LIMIT_EXCEEDED');
    decoded.set(file.path, entry);
  }
  const pointer = decoded.get('reports/.delivery/current.json')?.value;
  const snapshots = [...decoded.keys()].filter(path => path.startsWith('reports/.delivery/reports/'));
  if (decoded.has('reports/.delivery/current.json') || snapshots.length) {
    if (!ID.test(pointer?.reportId || '') || !ID.test(pointer.contentHash || '') || !ID.test(pointer.reportHash || '')) fail('HOSTED_STATE_BUNDLE_INVALID');
    const prefix = `reports/.delivery/reports/${pointer.reportId}/`;
    const content = decoded.get(prefix+'content.json')?.value, receipt = decoded.get(prefix+'receipt.json')?.value;
    if (snapshots.length !== 2 || snapshots.some(path => !path.startsWith(prefix)) || !content || !receipt
      || content.reportId !== pointer.reportId || receipt.reportId !== pointer.reportId || content.report?.generatedAt !== pointer.generatedAt
      || reportHash(content) !== pointer.contentHash || reportHash(content.report) !== pointer.reportHash) fail('HOSTED_STATE_BUNDLE_INVALID');
    try { validateBundle({ ...content, receipt }); } catch { fail('HOSTED_STATE_BUNDLE_INVALID'); }
  }
  return decoded;
}
async function safeRoot(root, { empty = false } = {}) {
  let ancestor='/';
  for(const segment of resolve(root).split('/').filter(Boolean)){
    ancestor=resolve(ancestor,segment);let meta;
    try{meta=await lstat(ancestor);}catch(error){if(error.code==='ENOENT')break;throw error;}
    if(meta.isSymbolicLink()||!meta.isDirectory())fail('HOSTED_STATE_UNSAFE_FILE');
  }
  await mkdir(root, { recursive:true });
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== resolve(root)) fail('HOSTED_STATE_UNSAFE_FILE');
  if (empty && (await readdir(root)).length) fail('HOSTED_RESTORE_REQUIRES_EMPTY_DIRECTORY');
}
async function safeBytes(root, path, maxBytes) {
  let parent = root;
  for (const segment of path.split('/').slice(0,-1)) {
    parent = resolve(parent, segment);
    if ((await lstat(parent)).isSymbolicLink()) fail('HOSTED_STATE_UNSAFE_FILE');
  }
  const file = await open(resolve(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) fail('HOSTED_STATE_UNSAFE_FILE');
    if (stat.size > maxBytes) fail('HOSTED_STATE_LIMIT_EXCEEDED');
    const bytes = await file.readFile(), after = await file.stat();
    if (bytes.length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) fail('HOSTED_STATE_CHANGED_DURING_CHECKPOINT');
    return bytes;
  } finally { await file.close(); }
}
export async function captureState(root, revision, limits = STATE_LIMITS) {
  await safeRoot(root);
  let pointer = null;
  try { pointer = JSON.parse((await safeBytes(root,'reports/.delivery/current.json',64000)).toString('utf8')); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if (pointer && !ID.test(pointer.reportId || '')) fail('HOSTED_STATE_BUNDLE_INVALID');
  const files = []; let decodedBytes = 0, encodedBytes = 64;
  async function walk(path) {
    let entries; try { entries = await readdir(resolve(root,path), { withFileTypes:true }); } catch(error) { if(error.code==='ENOENT')return;throw error; }
    for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
      const relative = `${path}/${entry.name}`, dir = allowedDirectory(relative,pointer?.reportId), file = allowedStatePath(relative);
      if (!dir && !file) continue;
      // Dirent.d_type 不可信：某些文件系统/overlay 会把普通文件报成 symlink。
      // 安全边界以 lstat 的真实类型为准，不能拿 d_type 放行或拒绝。
      const meta = await lstat(resolve(root, relative));
      if (meta.isSymbolicLink()) fail('HOSTED_STATE_UNSAFE_FILE');
      if (meta.isDirectory()) { if(dir)await walk(relative); continue; }
      if (!file) continue;
      if (files.length >= limits.files) fail('HOSTED_STATE_LIMIT_EXCEEDED');
      const bytes = await safeBytes(root,relative,limits.decodedBytes-decodedBytes); decodedBytes += bytes.length;
      const row = { path:relative, content:bytes.toString('base64') }; decodeFile(row);
      encodedBytes += Buffer.byteLength(JSON.stringify(row))+1;
      if (encodedBytes > limits.jsonBytes) fail('HOSTED_STATE_LIMIT_EXCEEDED');
      files.push(row);
    }
  }
  await walk('state'); await walk('reports');
  const snapshot = { revision, files }; validateStateSnapshot(snapshot,limits); return snapshot;
}
export async function restoreState(root, snapshot, limits = STATE_LIMITS) {
  const decoded = validateStateSnapshot(snapshot,limits);
  await safeRoot(root,{empty:true});
  for (const [path,{bytes}] of decoded) {
    const destination = resolve(root,path); await mkdir(dirname(destination),{recursive:true});
    await writeFile(destination,bytes,{flag:'wx',mode:0o600});
  }
  return snapshot.revision;
}

const archiveEndpoint = (epoch, hash) => `/internal/state/objects/${epoch}/${hash}`;
const archiveEndpointPattern = /^\/internal\/state\/objects\/[a-f0-9]{64}\/[a-f0-9]{64}$/;
/** Stage the whole restore away from the working root. A missing or corrupt shard
 * never leaves a partially restored ledger available to the collector. */
async function restorePartitionedState(root, snapshot, client, { limits, archiveLimits, restoreArchive }) {
  if (snapshot.version !== 2) fail('HOSTED_STATE_INVALID');
  const archive = validateArchive(snapshot.archive, archiveLimits);
  const hot = validateStateSnapshot({ revision: snapshot.revision, files: snapshot.files }, limits);
  if (snapshot.files.some(file => archivePath(file.path))) fail('HOSTED_ARCHIVE_PATH_IN_HOT_STATE');
  await safeRoot(root, { empty: true });
  const staged = await mkdtemp(resolve(dirname(root), '.hosted-restore-'));
  const known = restoreArchive ? new Map() : null;
  try {
    async function save(path, bytes) {
      const target = resolve(staged, path); await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    if (restoreArchive) {
      let decodedBytes = 0;
      for (const descriptor of archive.shards) {
        const body = await client.request(archiveEndpoint(archive.epoch, descriptor.sha256), { limit: archiveLimits.shardBytes });
        for (const file of decodeArchiveShard(body, descriptor, archive.epoch, archiveLimits)) {
          if (known.has(file.path)) fail('HOSTED_ARCHIVE_DUPLICATE_PATH');
          known.set(file.path, archiveHash(file.bytes)); decodedBytes += file.bytes.length;
          await save(file.path, file.bytes);
        }
      }
      if (known.size !== archive.fileCount || decodedBytes !== archive.decodedBytes) fail('HOSTED_ARCHIVE_TOTAL_MISMATCH');
    }
    for (const [path, file] of hot) await save(path, file.bytes);
    await safeRoot(root, { empty: true });
    await rename(staged, root);
    return { revision: snapshot.revision, archive, known };
  } finally { await rm(staged, { recursive: true, force: true }); }
}

async function capturePartitionedState(root, revision, client, previous, known, { limits, archiveLimits }) {
  await safeRoot(root);
  let pointer = null;
  try { pointer = JSON.parse((await safeBytes(root, 'reports/.delivery/current.json', 64000)).toString('utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (pointer && !ID.test(pointer.reportId || '')) fail('HOSTED_STATE_BUNDLE_INVALID');
  const hot = [], seen = new Set(), added = new Map(), descriptors = [];
  let hotBytes = 0, hotWire = 64, rows = [], rowWire = 0, newBytes = 0;
  const overhead = Buffer.byteLength(JSON.stringify({ version: 1, kind: 'state-archive-shard', epoch: previous.epoch, files: [] }));
  async function flush() {
    if (!rows.length) return;
    if (descriptors.length >= archiveLimits.newShards) fail('HOSTED_ARCHIVE_CHECKPOINT_BATCH_EXCEEDED');
    const { body, descriptor } = createArchiveShard(previous.epoch, rows, archiveLimits);
    appendArchive(previous, [...descriptors, descriptor], archiveLimits);
    const path = archiveEndpoint(previous.epoch, descriptor.sha256);
    const saved = await client.request(path, { method: 'PUT', body, limit: 64000 });
    if (saved?.epoch !== previous.epoch || Object.entries(descriptor).some(([key, value]) => saved[key] !== value))
      fail('HOSTED_ARCHIVE_WRITE_UNCONFIRMED');
    const readback = await client.request(path, { limit: archiveLimits.shardBytes });
    decodeArchiveShard(readback, descriptor, previous.epoch, archiveLimits);
    descriptors.push(descriptor); rows = []; rowWire = 0;
  }
  async function walk(path) {
    let entries;
    try { entries = await readdir(resolve(root, path), { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${path}/${entry.name}`, directory = allowedDirectory(relative, pointer?.reportId), file = allowedStatePath(relative);
      if (!directory && !file) continue;
      // 同上：以 lstat 真实类型判定，不信任 Dirent.d_type。
      const meta = await lstat(resolve(root, relative));
      if (meta.isSymbolicLink()) fail('HOSTED_STATE_UNSAFE_FILE');
      if (meta.isDirectory()) { if (directory) await walk(relative); continue; }
      if (!file) continue;
      if (archivePath(relative)) {
        // Observation-only sessions deliberately preserve archive references
        // without fetching private ledgers; they may not write archive files.
        if (known === null) fail('HOSTED_ARCHIVE_RESEARCH_REQUIRED');
        const bytes = await safeBytes(root, relative, archiveLimits.shardBytes), sha = archiveHash(bytes);
        seen.add(relative);
        if (known.has(relative)) { if (known.get(relative) !== sha) fail('HOSTED_ARCHIVE_IMMUTABLE_CHANGED'); continue; }
        if (previous.fileCount + added.size + 1 > archiveLimits.files || previous.decodedBytes + newBytes + bytes.length > archiveLimits.decodedBytes)
          fail('HOSTED_ARCHIVE_LIMIT_EXCEEDED');
        const row = { path: relative, content: bytes.toString('base64') }; decodeFile(row);
        const size = Buffer.byteLength(JSON.stringify(row));
        if (size + overhead > archiveLimits.shardBytes) fail('HOSTED_ARCHIVE_SHARD_TOO_LARGE');
        if (rows.length >= archiveLimits.shardFiles || overhead + rowWire + size + (rows.length ? 1 : 0) > archiveLimits.shardBytes) await flush();
        rowWire += size + (rows.length ? 1 : 0); rows.push(row); added.set(relative, sha); newBytes += bytes.length;
      } else {
        if (hot.length >= limits.files) fail('HOSTED_STATE_LIMIT_EXCEEDED');
        const bytes = await safeBytes(root, relative, limits.decodedBytes - hotBytes); hotBytes += bytes.length;
        const row = { path: relative, content: bytes.toString('base64') }; decodeFile(row);
        hotWire += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (hotWire > limits.jsonBytes) fail('HOSTED_STATE_LIMIT_EXCEEDED');
        hot.push(row);
      }
    }
  }
  await walk('state'); await walk('reports');
  if (known && [...known.keys()].some(path => !seen.has(path))) fail('HOSTED_ARCHIVE_FILE_MISSING');
  validateStateSnapshot({ revision, files: hot }, limits);
  await flush();
  const archive = appendArchive(previous, descriptors, archiveLimits);
  return { snapshot: { version: 2, expectedRevision: revision, files: hot, archive }, added };
}

async function boundedJson(response, limit) {
  const reader = response.body?.getReader(); if(!reader)fail('HOSTED_INVALID_RESPONSE');
  let bytes = 0; const chunks = [];
  try { for(;;) { const part=await reader.read();if(part.done)break;bytes+=part.value.length;if(bytes>limit)fail('HOSTED_RESPONSE_LIMIT_EXCEEDED');chunks.push(part.value); } }
  finally { await reader.cancel().catch(()=>{}); }
  try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))); } catch { fail('HOSTED_INVALID_RESPONSE'); }
}
export function createHostedClient({ env = process.env, fetchImpl = fetch, clock = () => Date.now(), signal } = {}) {
  let cached = null;
  async function identity(force = false) {
    if(!force && cached && cached.expiresAt > clock()+45000)return cached.token;
    let url;
    try { url=new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL); } catch { fail('HOSTED_OIDC_NOT_CONFIGURED'); }
    if(url.protocol!=='https:' || url.username || url.password || url.hash || !url.hostname.endsWith('.actions.githubusercontent.com')
      || typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN!=='string' || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)fail('HOSTED_OIDC_NOT_CONFIGURED');
    url.searchParams.set('audience',HOSTED_ORIGIN);
    let response;
    try { response=await fetchImpl(url.href,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(15000)].filter(Boolean)),
      headers:{Authorization:'Bearer '+env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,Accept:'application/json'}}); }
    catch { fail('HOSTED_OIDC_REQUEST_FAILED'); }
    if(!response.ok){await response.body?.cancel();fail('HOSTED_OIDC_REQUEST_FAILED');}
    const value=await boundedJson(response,64000);let claims;
    try {
      if(typeof value.value!=='string'||value.value.length>16000||!/^[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+\.[-A-Za-z0-9_]+$/.test(value.value))throw Error();
      claims=JSON.parse(Buffer.from(value.value.split('.')[1],'base64url').toString('utf8'));
      if(claims.aud!==HOSTED_ORIGIN||!Number.isSafeInteger(claims.exp)||claims.exp*1000<=clock()+1000)throw Error();
    } catch { fail('HOSTED_OIDC_INVALID_RESPONSE'); }
    cached={token:value.value,expiresAt:claims.exp*1000};return cached.token;
  }
  async function request(path,{method='GET',body,allow404=false,limit=MAX_REPORT_BUNDLE_BYTES,requestSignal,fetchImpl:requestFetch}={}) {
    const archived = archiveEndpointPattern.test(path);
    if(!archived&&!['/internal/publications','/internal/observations','/internal/report-status','/internal/state','/internal/notifications','/internal/observation-notifications','/internal/research-daily'].includes(path))fail('HOSTED_INVALID_ENDPOINT');
    if(path==='/internal/observation-notifications'&&method!=='POST')fail('HOSTED_INVALID_ENDPOINT');
    const serialized=body===undefined?undefined:JSON.stringify(body);
    if(serialized && Buffer.byteLength(serialized)>(archived?ARCHIVE_LIMITS.shardBytes:path==='/internal/state'?STATE_LIMITS.jsonBytes:MAX_REPORT_BUNDLE_BYTES))fail('HOSTED_REQUEST_LIMIT_EXCEEDED');
    for(let attempt=0;attempt<2;attempt++){
      const token=await identity(attempt===1);let response;
      try { response=await (requestFetch||fetchImpl)(HOSTED_ORIGIN+path,{method,redirect:'error',signal:AbortSignal.any([signal,requestSignal,AbortSignal.timeout(HOSTED_REQUEST_TIMEOUT_MS)].filter(Boolean)),
        headers:{Accept:'application/json',Authorization:'Bearer '+token,...(serialized?{'Content-Type':'application/json'}:{})},...(serialized?{body:serialized}:{})}); }
      catch { fail('HOSTED_REQUEST_UNCONFIRMED'); }
      if(response.status===401&&attempt===0){await response.body?.cancel();continue;}
      if(response.status===404&&allow404){await response.body?.cancel();return null;}
      if(!response.ok){
        const status=response.status;
        // The isolated digest caller validates a strict receipt allowlist. Never
        // include the response body in error.message or in generic runner logs.
        if(path==='/internal/observation-notifications'){
          let detail;try{if(/application\/json/i.test(response.headers.get('content-type')||''))detail=await boundedJson(response,32000);else await response.body?.cancel();}catch{}
          const error=Error(`HOSTED_HTTP_${status}`);error.httpStatus=status;error.digestResponse=detail;throw error;
        }
        await response.body?.cancel();fail(status===409?(archived?'HOSTED_ARCHIVE_CONFLICT':path==='/internal/state'?'HOSTED_STATE_CONFLICT':'HOSTED_PUBLICATION_CONFLICT'):`HOSTED_HTTP_${status}`);
      }
      if(!/application\/json/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();fail('HOSTED_INVALID_RESPONSE');}
      const value=await boundedJson(response,limit);
      if(path==='/internal/state'&&value===null)fail('HOSTED_STATE_INVALID');
      return value;
    }
  }
  return { request };
}

export async function createStateSession(root, client, { limits=STATE_LIMITS, archiveLimits=ARCHIVE_LIMITS, partitioned=false, restoreArchive=true }={}) {
  if(typeof partitioned!=='boolean'||typeof restoreArchive!=='boolean')fail('HOSTED_STATE_INVALID_OPTIONS');
  const remote=await client.request('/internal/state',{allow404:true,limit:limits.jsonBytes});
  if(remote!==null&&(!object(remote)||!Number.isSafeInteger(remote.revision)||remote.revision<1))fail('HOSTED_STATE_INVALID');
  if(remote?.version!==undefined&&![1,2].includes(remote.version))fail('HOSTED_STATE_INVALID');
  const restored=remote?.version===2?await restorePartitionedState(root,remote,client,{limits,archiveLimits,restoreArchive}):null;
  let revision=restored?.revision??await restoreState(root,remote===null?{revision:0,files:[]}:remote,limits), blocked=null;
  let archive=restored?.archive||emptyArchive(createArchiveEpoch(HOSTED_ORIGIN,revision)), known=restored?restored.known:new Map();
  const useArchive=partitioned||remote?.version===2;
  return {
    get revision(){return revision;}, get blocked(){return blocked;},
    stop(code){blocked=/^HOSTED_[A-Z0-9_]+$/.test(code)?code:'HOSTED_OPERATION_FAILED';},
    async checkpoint(){
      if(blocked)fail(blocked);
      try {
        let body,added;
        if(useArchive){const captured=await capturePartitionedState(root,revision,client,archive,known,{limits,archiveLimits});body=captured.snapshot;added=captured.added;}
        else {const snapshot=await captureState(root,revision,limits);body={expectedRevision:revision,files:snapshot.files};}
        if(Buffer.byteLength(JSON.stringify(body))>limits.jsonBytes)fail('HOSTED_STATE_LIMIT_EXCEEDED');
        const result=await client.request('/internal/state',{method:'PUT',body});
        if(!Number.isSafeInteger(result?.revision)||result.revision!==revision+1)fail('HOSTED_STATE_WRITE_UNCONFIRMED');
        revision=result.revision;
        if(useArchive){archive=body.archive;if(known)for(const [path,hash]of added)known.set(path,hash);}
        return revision;
      } catch(error){blocked=safeCode(error);throw Error(blocked);}
    },
  };
}

async function localReceipt(directory, receipt) {
  await atomicJson(resolve(directory,'publication.json'),receipt);
  await persistReportReceipt(directory,receipt);
}
function channelReceipt(receipt, channel, result) {
  return { ...receipt,channels:{...receipt.channels,[channel]:result},events:[...(receipt.events||[]),{channel,...result}] };
}
async function retainedBundle(directory, expectedReportId, clock) {
  const receipt=await readJson(resolve(directory,'publication.json'));
  if(expectedReportId&&receipt.reportId!==expectedReportId)fail('HOSTED_REPORT_ID_MISMATCH');
  let stored;
  try { stored=await loadReportBundle(directory,{reportId:receipt.reportId}); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  if(stored){
    const report=await readJson(resolve(directory,'predictions.json'));
    if(reportHash(report)!==stored.reportHash)fail('HOSTED_REPORT_CONTENT_CHANGED');
    return { ...stored,receipt:mergePublicationReceipts(stored.receipt,receipt) };
  }
  await persistReport(directory,{nowISO:clock()});return loadReportBundle(directory);
}
export function createHostedPublisher({ client, session, clock=stamp }) {
  return async (directory,{expectedReportId,fetchImpl}={})=>{
    // The bounded orchestration transport is used only for these fixed Site paths.
    const request=(path,options={})=>client.request(path,{...options,fetchImpl});
    let bundle=await retainedBundle(directory,expectedReportId,clock),receipt=bundle.receipt;
    validateBundle(bundle);
    try { await requireGreenForecastDelivery(directory,Date.parse(clock())); }
    catch(error){
      receipt=channelReceipt(receipt,'releaseGate',{status:'failed',decision:'BLOCKED',code:'RELEASE_GATE_BLOCKED',checkedAt:clock(),
        reportId:bundle.reportId,reportHash:reportHash(bundle.report),...(error.releaseGate?{diagnostic:error.releaseGate}:{})});
      await localReceipt(directory,receipt);fail('RELEASE_GATE_BLOCKED');
    }
    await session.checkpoint(); // No report can be exposed before its model state is durable.
    try {
      await request('/internal/publications',{method:'POST',body:bundle});
      const probe=await request('/internal/report-status');
      if(probe.reportId!==bundle.reportId||probe.reportHash!==reportHash(bundle.report)||probe.generatedAt!==bundle.report.generatedAt
        ||probe.mode!=='hosted'||probe.health!=='available')fail('HOSTED_REPORT_READBACK_MISMATCH');
      receipt=channelReceipt(receipt,'externalWebsite',{status:'published',checkedAt:clock(),url:HOSTED_ORIGIN,servedVerified:true,
        reportId:bundle.reportId,reportHash:probe.reportHash,mode:'hosted',meaning:'same-report-served-by-site-not-user-read'});
      await localReceipt(directory,receipt);
      bundle={...bundle,receipt};
      await request('/internal/publications',{method:'POST',body:bundle});
    } catch(error){
      if(error.message==='HOSTED_PUBLICATION_CONFLICT')session.stop(error.message);
      receipt=channelReceipt(receipt,'externalWebsite',{status:'failed',checkedAt:clock(),servedVerified:false,code:safeCode(error)});
      await localReceipt(directory,receipt);return receipt;
    }
    try {
      const result=await request('/internal/notifications',{method:'POST',body:{reportId:bundle.reportId}}),remote=result?.receipt||result;
      try { validateReceipt(remote,bundle.report); } catch { fail('HOSTED_NOTIFICATION_RECEIPT_MISMATCH'); }
      if(!['accepted','unknown','failed','skipped','not_configured'].includes(remote.channels.notifications.status))fail('HOSTED_NOTIFICATION_RECEIPT_MISMATCH');
      receipt=mergePublicationReceipts(receipt,remote);
    } catch(error){
      if(!['accepted','unknown'].includes(receipt.channels.notifications?.status)) receipt=channelReceipt(receipt,'notifications',{
        status:'unknown',checkedAt:clock(),channel:'telegram',code:safeCode(error)});
    }
    await localReceipt(directory,receipt);return receipt;
  };
}

function due(scheduler,lane,interval,now) { const last=Date.parse(scheduler.lanes[lane]?.startedAt);return !Number.isFinite(last)||now-last>=interval; }
async function hasMarketTargets(out,nowISO) {
  const input=await optionalJson(resolve(out,'public-fixtures.json'));
  if(!input)return false;
  let snapshot;try{snapshot=verifyAcquisitionSnapshot(input,{nowISO});}catch{return false;}
  const now=Date.parse(nowISO);return snapshot.fixtures.some(row=>['SCHEDULED','TIMED'].includes(row.status)&&Date.parse(row.kickoff)>now&&Date.parse(row.kickoff)<=now+86400000);
}
export async function runHosted({ root,env=process.env,fetchImpl=fetch,clock=stamp,monotonic=()=>performance.now(),budgetMs=180000,
  signal,stdout=text=>process.stdout.write(text),runOrchestrationImpl=runOrchestration,client:providedClient,privateResearch=false }={}) {
  if(!root||!Number.isFinite(budgetMs)||budgetMs<1000||budgetMs>180000||!Number.isFinite(Date.parse(clock())))fail('HOSTED_INVALID_ARGUMENT');
  if(!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))fail('HOSTED_COMMIT_REQUIRED');
  root=resolve(root);const started=monotonic(),remaining=()=>Math.max(0,budgetMs-(monotonic()-started));
  const overall=AbortSignal.any([signal,AbortSignal.timeout(budgetMs)].filter(Boolean));
  const client=providedClient||createHostedClient({env,fetchImpl,clock:()=>Date.parse(clock()),signal:overall});
  if(typeof privateResearch!=='boolean')fail('HOSTED_INVALID_ARGUMENT');
  const session=await createStateSession(root,client,{partitioned:privateResearch}),out=resolve(root,'reports'),schedulerPath=resolve(root,privateResearch?'state/hosted-research-scheduler.json':'state/hosted-scheduler.json');
  const scheduler=await optionalJson(schedulerPath)||{version:1,lanes:{}};
  if(scheduler.version!==1||!object(scheduler.lanes))fail('HOSTED_SCHEDULER_INVALID');
  const publisher=privateResearch?async()=>fail('HOSTED_PRIVATE_RESEARCH_DELIVERY_FORBIDDEN'):createHostedPublisher({client,session,clock}),outcomes=[];let failure=null;
  const common={env:{...env,COLLECTOR_COMMIT:env.GITHUB_SHA},cwd:root,clock,fetchImpl,stdout:()=>{},dependencies:{publishAll:publisher}};
  async function execute(lane,maxMs){
    const workMs=Math.min(maxMs,remaining()-20000);if(workMs<1000)return false;
    scheduler.lanes[lane]={...scheduler.lanes[lane],startedAt:clock(),status:'active'};await atomicJson(schedulerPath,scheduler);
    const workSignal=AbortSignal.any([overall,AbortSignal.timeout(Math.ceil(workMs))]);
    const outcome=await runOrchestrationImpl(['--lane',lane,...(privateResearch?['--mode','private-research']:[]),'--state',resolve(root,'state/state.json'),'--out',out,'--budget-minutes',String(workMs/60000)],{...common,signal:workSignal});
    if(session.blocked)fail(session.blocked);
    scheduler.lanes[lane]={startedAt:scheduler.lanes[lane].startedAt,finishedAt:clock(),status:outcome.status,
      ...(outcome.code?{code:/^[A-Z0-9_]+$/.test(outcome.code)?outcome.code:'LANE_FAILED'}:{}),...(ID.test(outcome.reportId||'')?{reportId:outcome.reportId}:{})};
    await atomicJson(schedulerPath,scheduler);outcomes.push({lane,status:outcome.status,exitCode:outcome.exitCode,
      ...(scheduler.lanes[lane].code?{code:scheduler.lanes[lane].code}:{}),...(outcome.reportId?{reportId:outcome.reportId}:{})});return true;
  }
  try {
    const now=Date.parse(clock()),receipt=await optionalJson(resolve(out,'publication.json'));
    const retryFixtures=['failed','blocked'].includes(scheduler.lanes.fixtures?.status)&&due(scheduler,'fixtures',300000,now);
    if(privateResearch){
      // Results have their own cadence and budget priority: a failing collection
      // must not indefinitely starve settlement of already frozen predictions.
      if(due(scheduler,'results',3600000,now))await execute('results',60000);
      if(!session.blocked&&(due(scheduler,'fixtures',900000,now)||retryFixtures))await execute('fixtures',140000);
    } else if(due(scheduler,'fixtures',900000,now)||retryFixtures){await execute('fixtures',140000);}
    else {
      const pending=receipt?.channels?.files?.status==='published'&&(receipt.channels.externalWebsite?.servedVerified!==true||receipt.channels.receiptSync?.status==='failed');
      if(pending)await execute('delivery',60000);
      else if(due(scheduler,'markets',300000,now)&&await hasMarketTargets(out,clock()))await execute('markets',90000);
      if(!session.blocked&&due(scheduler,'results',3600000,now)&&remaining()>45000)await execute('results',Math.max(1000,remaining()-20000));
    }
  } catch(error){failure=safeCode(error);}
  finally {
    if(!session.blocked){try{await session.checkpoint();}catch(error){failure=safeCode(error);}}
    else failure=session.blocked;
  }
  const result={version:1,status:failure?'blocked':outcomes.some(row=>row.exitCode||['partial','failed','blocked'].includes(row.status))?'partial':outcomes.length?'complete':'idle',
    ...(privateResearch?{mode:'private-research',RELEASE_GATE:'BLOCKED',forecastPublished:false,publicationStatus:'not_attempted'}:{}),
    ...(failure?{code:failure}:{}),checkedAt:clock(),revision:session.revision,outcomes,
    meaning:privateResearch?'Private research only; frozen and settled records are not public delivery evidence; automatic research scheduling is not enabled.':'scheduled-target-five-minutes-github-may-delay; notifications-owned-by-site'};
  await atomicJson(resolve(root,'hosted-run.json'),result);
  stdout(JSON.stringify(result)+'\n');return {...result,exitCode:failure||outcomes.some(row=>row.exitCode)?1:0};
}

// Observation collection is deliberately separate from research orchestration:
// it never creates forecasts, opportunities, prediction ledgers or replay files.
export function observationBundle(manifest,{commit,nowISO=stamp(),marketObservation}={}) {
  if(manifest?.version!==1||manifest.kind!=='public-fixture-sample'||manifest.dataSchemaVersion!==2||manifest.simulated!==false
    ||!Array.isArray(manifest.fixtures)||!manifest.fixtures.length||!Array.isArray(manifest.sources)||!Array.isArray(manifest.diagnostics)
    ||!Array.isArray(manifest.coverage)||!/^[a-f0-9]{40}$/.test(commit||''))fail('HOSTED_OBSERVATION_INPUT_INVALID');
  let snapshot;
  try {
    snapshot=createAcquisitionSnapshot({fixtures:manifest.fixtures,history:[],checkedAt:manifest.checkedAt,diagnostics:manifest.diagnostics,
      coverage:manifest.coverage,poolComplete:false,policy:DEFAULT_POLICY});
    verifyAcquisitionSnapshot(snapshot,{nowISO,policy:DEFAULT_POLICY});
  } catch { fail('HOSTED_OBSERVATION_INPUT_STALE_OR_INVALID'); }
  if(!snapshot.fixtures.length)fail('HOSTED_OBSERVATION_INPUT_INVALID');
  if(marketObservation!==undefined&&(!object(marketObservation)||marketObservation.releaseGate!=='BLOCKED'
    ||!Number.isFinite(Date.parse(marketObservation.checkedAt))||Date.parse(marketObservation.checkedAt)<Date.parse(snapshot.checkedAt)
    ||Date.parse(marketObservation.checkedAt)>Date.parse(nowISO)||!Number.isSafeInteger(marketObservation.fixtureCount)
    ||marketObservation.fixtureCount<0||marketObservation.fixtureCount>snapshot.fixtures.length))fail('HOSTED_MARKET_OBSERVATION_INVALID');
  const reportId=reportHash({version:1,kind:'collection-observation',snapshot,commit,attribution:manifest.sources,
    ...(marketObservation===undefined?{}:{marketObservation})});
  const generatedAt=marketObservation?.checkedAt||snapshot.checkedAt,blocked={status:'skipped',checkedAt:generatedAt,code:'RELEASE_GATE_BLOCKED'};
  const report={version:1,kind:'prematch-forecast-report',publicationKind:'collection-observation',generatedAt,simulated:false,
    publication:{reportId,forecastPublished:false,releaseGate:'BLOCKED'},model:null,
    summary:{fixtures:snapshot.fixtures.length,forecasts:0,unavailable:snapshot.fixtures.length,strictCandidates:0},
    fixtures:snapshot.fixtures.map(fixture=>({fixture,forecast:{status:'unavailable',reasons:['RELEASE_GATE_BLOCKED']},
      marketCandidate:{status:'source_insufficient',reasons:['RELEASE_GATE_BLOCKED'],candidate:null,readiness:null}})),
    backtests:[],coverage:manifest.coverage,diagnostics:manifest.diagnostics,attribution:manifest.sources,
    acquisition:{snapshotHash:snapshot.snapshotHash,checkedAt:snapshot.checkedAt,commit},
    ...(marketObservation===undefined?{}:{marketObservation}),
    categories:{analysis:[],strictCandidates:[],unassessable:snapshot.fixtures.map(fixture=>fixture.id)}};
  const receipt={version:1,reportId,generatedAt,simulated:false,
    channels:{files:{status:'not_attempted'},githubArtifact:{status:'not_attempted'},externalWebsite:{...blocked,servedVerified:false},
      notifications:{...blocked},releaseGate:{status:'failed',decision:'BLOCKED',checkedAt:generatedAt,code:'RELEASE_GATE_BLOCKED'}},events:[]};
  const sourceData={};
  if(snapshot.fixtures.some(fixture=>fixture.source==='openligadb')){
    const attribution=manifest.sources.find(source=>/openligadb/i.test(source.name||'')||/openligadb\.de/.test(source.url||''));
    if(!attribution)fail('HOSTED_OBSERVATION_ATTRIBUTION_REQUIRED');
    sourceData.openligadb={reportId,checkedAt:manifest.checkedAt,attribution,
      fixtures:snapshot.fixtures.filter(fixture=>fixture.source==='openligadb'),history:[]};
  }
  const bundle={version:1,reportId,report,receipt,sourceData};validateBundle(bundle);return bundle;
}
function observationStatus(value,bundle) {
  return object(value)&&value.version===1&&ID.test(value.reportId||'')&&value.reportId!==bundle.reportId&&ID.test(value.reportHash||'')
    &&value.originReportId===bundle.reportId&&value.generatedAt===bundle.report.generatedAt&&value.mode==='hosted'&&value.health==='available'
    &&value.publicationKind==='observations'&&value.forecastPublished===false;
}
function manifestFromObservation(report) {
  return {version:1,kind:'public-fixture-sample',dataSchemaVersion:2,simulated:false,checkedAt:report.acquisition?.checkedAt,
    fixtures:report.fixtures.map(row=>row.fixture),sources:report.attribution,diagnostics:report.diagnostics,coverage:report.coverage};
}
function validateObservationAcquisition(report,nowISO) {
  const acquisition=report.acquisition;
  if(!object(acquisition)||!ID.test(acquisition.snapshotHash||'')||!/^[a-f0-9]{40}$/.test(acquisition.commit||''))fail('HOSTED_OBSERVATION_STATE_INVALID');
  const manifest=manifestFromObservation(report);
  let snapshot;
  try{
    snapshot=createAcquisitionSnapshot({fixtures:manifest.fixtures,history:[],checkedAt:manifest.checkedAt,diagnostics:manifest.diagnostics,
      coverage:manifest.coverage,poolComplete:false,policy:DEFAULT_POLICY});
    verifyAcquisitionSnapshot(snapshot,{nowISO,policy:DEFAULT_POLICY});
  }catch{fail('HOSTED_OBSERVATION_INPUT_STALE_OR_INVALID');}
  if(snapshot.snapshotHash!==acquisition.snapshotHash)fail('HOSTED_OBSERVATION_STATE_INVALID');
}
function validateObservationRecord(record,nowISO) {
  if(!object(record)||record.version!==1||record.bundleHash!==reportHash(record.bundle)
    ||!['pending','verified'].includes(record.delivery?.status))fail('HOSTED_OBSERVATION_STATE_INVALID');
  validateBundle(record.bundle);
  const {report}=record.bundle,age=Date.parse(nowISO)-Date.parse(report.generatedAt);
  if(report.publicationKind!=='collection-observation'||report.summary.forecasts!==0||report.summary.strictCandidates!==0
    ||report.fixtures.some(row=>row.forecast.status!=='unavailable'||row.marketCandidate.candidate!==null)
    ||!Number.isFinite(age)||age<0||age>1200000)fail('HOSTED_OBSERVATION_INPUT_STALE_OR_INVALID');
  if(record.delivery.status==='verified'&&!observationStatus(record.delivery,record.bundle))fail('HOSTED_OBSERVATION_STATE_INVALID');
  if(report.marketObservation!==undefined){
    const acquisition=report.acquisition,market=report.marketObservation;
    if(market?.checkedAt!==report.generatedAt||Date.parse(acquisition?.checkedAt)>Date.parse(report.generatedAt))fail('HOSTED_OBSERVATION_STATE_INVALID');
    validateObservationAcquisition(report,nowISO);
  }
  return record;
}
function marketTargets(report,nowISO){
  const now=Date.parse(nowISO);
  return report.fixtures.map(row=>row.fixture).filter(fixture=>['SCHEDULED','TIMED'].includes(fixture.status)
    &&Date.parse(fixture.kickoff)>now&&Date.parse(fixture.kickoff)<=now+86400000);
}
function marketTargetHash(fixtures){
  return reportHash(fixtures.map(row=>({id:row.id,source:row.source,league:row.league,home:row.home,away:row.away,
    homeTeamId:row.homeTeamId??null,awayTeamId:row.awayTeamId??null,kickoff:row.kickoff,status:row.status})).sort((a,b)=>a.id.localeCompare(b.id)));
}
function assertMarketPublishable(bundle,nowISO){
  const summary=bundle.report.marketObservation;
  if(summary?.sources?.some(source=>source.quoteCount>0)&&Date.parse(summary.expiresAt)<=Date.parse(nowISO))fail('HOSTED_MARKET_OBSERVATION_EXPIRED');
}
export async function runShadow({root,env=process.env,fetchImpl=fetch,clock=stamp,monotonic=()=>performance.now(),budgetMs=180000,
  signal,stdout=text=>process.stdout.write(text),runPublicImpl=runPublic,collectMarketImpl,client:providedClient}={}) {
  if(!root||!Number.isFinite(budgetMs)||budgetMs<1000||budgetMs>180000||!Number.isFinite(Date.parse(clock())))fail('HOSTED_INVALID_ARGUMENT');
  if(!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA||''))fail('HOSTED_COMMIT_REQUIRED');
  root=resolve(root);const started=monotonic(),remaining=()=>Math.max(0,budgetMs-(monotonic()-started));
  const overall=AbortSignal.any([signal,AbortSignal.timeout(budgetMs)].filter(Boolean));
  const client=providedClient||createHostedClient({env,fetchImpl,clock:()=>Date.parse(clock()),signal:overall});
  const session=await createStateSession(root,client,{restoreArchive:false}),out=resolve(root,'reports'),schedulerPath=resolve(root,'state/hosted-scheduler.json');
  const recordPath=resolve(root,'state/hosted-observation.json'),scheduler=await optionalJson(schedulerPath)||{version:1,lanes:{}};
  if(scheduler.version!==1||!object(scheduler.lanes))fail('HOSTED_SCHEDULER_INVALID');
  const marketsEnabled=env.HOSTED_MARKET_OBSERVATIONS==='true',marketPath=resolve(root,'state/hosted-market-observation.json');
  let marketRecord=marketsEnabled?await optionalJson(marketPath):null,marketObserved=false,marketStatus=null;
  let record=await optionalJson(recordPath),failure=null,collected=false,published=false;
  try {
    if(overall.aborted)fail('HOSTED_OBSERVATION_CANCELLED');
    const now=Date.parse(clock()),retry=['failed','blocked'].includes(scheduler.lanes.observations?.status)&&due(scheduler,'observations',300000,now);
    let candidate=record?.bundle;
    if(due(scheduler,'observations',900000,now)||retry){
      const workMs=Math.min(marketsEnabled?90000:135000,remaining()-(marketsEnabled?60000:40000));if(workMs<1000)fail('HOSTED_OBSERVATION_BUDGET_EXHAUSTED');
      scheduler.lanes.observations={startedAt:clock(),status:'active'};await atomicJson(schedulerPath,scheduler);
      const workSignal=AbortSignal.any([overall,AbortSignal.timeout(Math.ceil(workMs))]);
      const result=await runPublicImpl(['--state',resolve(root,'state/state.json'),'--out',out,'--budget-minutes',String(workMs/60000)],{
        env:{...env,COLLECTOR_COMMIT:env.GITHUB_SHA},cwd:root,clock,fetchImpl,stdout:()=>{},signal:workSignal,collectMode:'public'});
      if(result.exitCode!==0||result.collection!==null)fail('HOSTED_OBSERVATION_COLLECTION_FAILED');
      candidate=observationBundle(result.manifest,{commit:env.GITHUB_SHA,nowISO:clock()});collected=true;
      scheduler.lanes.observations={...scheduler.lanes.observations,finishedAt:clock(),status:'collected'};
      await atomicJson(schedulerPath,scheduler);
    }
    if(candidate)validateObservationRecord(candidate===record?.bundle?record:{version:1,bundle:candidate,bundleHash:reportHash(candidate),delivery:{status:'pending'}},clock());
    if(marketsEnabled&&candidate){
      // Check original acquisition/fixture times even when upgrading an older
      // observation that has not contained a market summary before.
      validateObservationAcquisition(candidate.report,clock());
      // The 20-minute acquisition check happens before any market request.
      // New quote observations never renew the cached schedule timestamp.
      const {collectMarketObservation,summarizeMarketObservation}=await import('./market-observation.mjs');
      const fixtures=marketTargets(candidate.report,clock()),targetHash=marketTargetHash(fixtures),acquisitionHash=candidate.report.acquisition.snapshotHash;
      if(marketRecord&&(!object(marketRecord)||marketRecord.version!==1||!ID.test(marketRecord.targetHash||'')||!ID.test(marketRecord.acquisitionHash||'')
        ||!['complete','no_targets','unavailable','budget_exhausted'].includes(marketRecord.status)
        ||marketRecord.evidenceHash!==reportHash(marketRecord.privateEvidence)||marketRecord.summaryHash!==reportHash(marketRecord.summary)
        ||!Number.isFinite(Date.parse(marketRecord.summary?.checkedAt))||Date.parse(marketRecord.summary.checkedAt)>Date.parse(clock())))fail('HOSTED_MARKET_OBSERVATION_STATE_INVALID');
      const sameContext=marketRecord?.targetHash===targetHash&&marketRecord?.acquisitionHash===acquisitionHash;
      // Source time and kickoff can expire positive quotes before five minutes
      // have elapsed since collection. A runner that already woke up must not
      // skip the whole cycle merely because its previous request ended later.
      const marketNow=Date.parse(clock()),positiveExpired=marketRecord?.summary?.sources?.some(source=>source.quoteCount>0)
        &&Date.parse(marketRecord.summary.expiresAt)<=marketNow;
      const dueMarket=!sameContext||(fixtures.length>0&&(positiveExpired||marketNow-Date.parse(marketRecord.summary.checkedAt)>=300000));
      if(dueMarket){
        const workMs=Math.min(90000,remaining()-30000),startedAt=clock(),marketStarted=monotonic();
        const marketSignal=AbortSignal.any([overall,...(workMs>=1000?[AbortSignal.timeout(Math.ceil(workMs))]:[])]);
        const marketRemaining=()=>Math.max(0,Math.min(remaining()-30000,workMs-(monotonic()-marketStarted)));
        let evidence,summary;
        marketStatus=fixtures.length?'complete':'no_targets';
        scheduler.lanes.marketObservations={startedAt,status:'active',targetHash};await atomicJson(schedulerPath,scheduler);
        try{
          if(overall.aborted)fail('HOSTED_OBSERVATION_CANCELLED');
          if(!fixtures.length){evidence={};summary=summarizeMarketObservation({fixtures,evidence,checkedAt:clock()});}
          else{
            if(workMs<1000)fail('HOSTED_MARKET_OBSERVATION_BUDGET_EXHAUSTED');
            const result=await (collectMarketImpl||collectMarketObservation)({fixtures,
              statePath:resolve(root,'state/market-observation-crawler.json'),providerStatePath:resolve(root,'state/market-observation-providers.json'),
              env,clock,remaining:marketRemaining,signal:marketSignal,
              fetchImpl:(url,init={})=>fetchImpl(url,{...init,signal:AbortSignal.any([init.signal,marketSignal].filter(Boolean))})});
            if(overall.aborted)fail('HOSTED_OBSERVATION_CANCELLED');
            if(marketSignal.aborted||marketRemaining()<=0)fail('HOSTED_MARKET_OBSERVATION_BUDGET_EXHAUSTED');
            if(!Number.isFinite(Date.parse(result?.summary?.checkedAt))||Date.parse(result.summary.checkedAt)<Date.parse(startedAt)
              ||Date.parse(result.summary.checkedAt)>Date.parse(clock()))fail('HOSTED_MARKET_OBSERVATION_TIME_INVALID');
            evidence=result.privateEvidence;
            summary=summarizeMarketObservation({fixtures,evidence,checkedAt:result.summary.checkedAt});
            if(reportHash(summary)!==reportHash(result.summary))fail('HOSTED_MARKET_OBSERVATION_SUMMARY_MISMATCH');
            marketStatus=summary.sources.some(source=>source.quoteCount>0)?'complete':'unavailable';
          }
        }catch{
          if(overall.aborted)fail('HOSTED_OBSERVATION_CANCELLED');
          marketStatus=workMs<1000||marketSignal.aborted||marketRemaining()<=0?'budget_exhausted':'unavailable';
          const checkedAt=clock();
          evidence={quotes:[],marketStates:[],signals:[],fixtureDiagnostics:[],diagnostics:['hkjc','macauslot','titan007'].map(id=>({id,status:'unavailable',
            code:marketStatus==='budget_exhausted'?'COLLECTION_BUDGET_EXHAUSTED':'COLLECTION_FAILED',checkedAt}))};
          summary=summarizeMarketObservation({fixtures,evidence,checkedAt});
        }
        marketRecord={version:1,targetHash,acquisitionHash,summary,summaryHash:reportHash(summary),privateEvidence:evidence,evidenceHash:reportHash(evidence),status:marketStatus};
        await atomicJson(marketPath,marketRecord);marketObserved=true;
        scheduler.lanes.marketObservations={startedAt,finishedAt:clock(),checkedAt:summary.checkedAt,status:marketStatus,targetHash};await atomicJson(schedulerPath,scheduler);
      }else{
        const checked=summarizeMarketObservation({fixtures,evidence:marketRecord.privateEvidence,checkedAt:marketRecord.summary.checkedAt});
        if(reportHash(checked)!==marketRecord.summaryHash)fail('HOSTED_MARKET_OBSERVATION_STATE_INVALID');
        marketStatus=marketRecord.status;
      }
      candidate=observationBundle(manifestFromObservation(candidate.report),{commit:candidate.report.acquisition.commit,nowISO:clock(),marketObservation:marketRecord.summary});
    }
    if(candidate&&candidate.reportId!==record?.bundle.reportId){
      record={version:1,bundle:candidate,bundleHash:reportHash(candidate),delivery:{status:'pending'}};await atomicJson(recordPath,record);
    }
    if(record)validateObservationRecord(record,clock());
    if(overall.aborted)fail('HOSTED_OBSERVATION_CANCELLED');
    if(record&&record.delivery?.status!=='verified'){
      assertMarketPublishable(record.bundle,clock());
      await session.checkpoint();
      assertMarketPublishable(record.bundle,clock());
      const posted=await client.request('/internal/observations',{method:'POST',body:record.bundle});
      if(!observationStatus(posted,record.bundle))fail('HOSTED_OBSERVATION_READBACK_MISMATCH');
      const probe=await client.request('/internal/report-status');
      if(!observationStatus(probe,record.bundle)||probe.reportId!==posted.reportId||probe.reportHash!==posted.reportHash)
        fail('HOSTED_OBSERVATION_READBACK_MISMATCH');
      record={...record,delivery:{status:'verified',checkedAt:clock(),...probe}};await atomicJson(recordPath,record);
      scheduler.lanes.observations={...scheduler.lanes.observations,status:'complete'};await atomicJson(schedulerPath,scheduler);published=true;
    }
  } catch(error){
    failure=safeCode(error);
    if(failure==='HOSTED_PUBLICATION_CONFLICT')session.stop(failure);
    if(scheduler.lanes.observations?.status==='active'){
      scheduler.lanes.observations={...scheduler.lanes.observations,status:'blocked',finishedAt:clock(),code:failure};
      await atomicJson(schedulerPath,scheduler);
    }
  } finally {
    if(!session.blocked){try{await session.checkpoint();}catch(error){failure=safeCode(error);}}
    else failure=session.blocked;
  }
  const result={version:1,mode:'observations',status:failure?'blocked':published?'complete':'idle',RELEASE_GATE:'BLOCKED',forecastPublished:false,
    ...(marketsEnabled?{marketObserved,marketStatus,marketFixtureCount:marketRecord?.summary?.fixtureCount??null,marketCheckedAt:marketRecord?.summary?.checkedAt??null}:{}),
    ...(failure?{code:failure}:{}),checkedAt:clock(),revision:session.revision,collected,observationServedVerified:!failure&&(published||record?.delivery?.status==='verified'),
    ...(record?{originReportId:record.bundle.reportId,observationGeneratedAt:record.bundle.report.generatedAt}:{}),
    ...(!failure&&record?.delivery?.status==='verified'?{servedReportId:record.delivery.reportId,servedReportHash:record.delivery.reportHash}:{}),
    meaning:'collection-only; fixtures-target-fifteen-minutes; github-may-delay; no-forecast-or-notification'};
  await atomicJson(resolve(root,'hosted-run.json'),result);stdout(JSON.stringify(result)+'\n');return {...result,exitCode:failure?1:0};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),options={};
  try {
    if(args.length===1&&args[0]==='--help')console.log('hosted.mjs --root EMPTY_RUN_DIRECTORY [--budget-minutes 3] [--mode observations|research]. Default observations never creates forecasts or sends notifications; research release stays BLOCKED.');
    else {
      for(let i=0;i<args.length;i+=2){if(!['--root','--budget-minutes','--mode'].includes(args[i])||!args[i+1]||options[args[i]])fail('HOSTED_INVALID_ARGUMENT');options[args[i]]=args[i+1];}
      if(options['--mode']&&!['observations','research'].includes(options['--mode']))fail('HOSTED_INVALID_ARGUMENT');
      configureEnvironmentProxy(process.env);
      const run=options['--mode']==='research'?runHosted:runShadow;
      process.exitCode=(await run({root:options['--root'],budgetMs:Number(options['--budget-minutes']||3)*60000,...(options['--mode']==='research'?{privateResearch:true}:{})})).exitCode;
    }
  }catch(error){console.error(JSON.stringify({status:'blocked',code:safeCode(error)}));process.exitCode=1;}
}
