import { validateBundle, validateReceipt, MAX_REPORT_BUNDLE_BYTES } from './report-schema.mjs';
import { verifyActionsIdentity } from './github-oidc.mjs';
import { requireHostedForecastRelease } from './release-policy.mjs';

const CURRENT = 'publications/current.json';
const STATE = 'checkpoints/state.json';
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = value => encoder.encode(JSON.stringify(value));
function problem(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function response(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', ...headers } });
}
async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))].map(n => n.toString(16).padStart(2, '0')).join('');
}
async function readBytes(stream, max) {
  if (!stream) throw problem('INVALID_JSON');
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw problem('BODY_TOO_LARGE', 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
async function readJsonBody(request, max) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw problem('JSON_REQUIRED', 415);
  if (Number(request.headers.get('content-length') || 0) > max) throw problem('BODY_TOO_LARGE', 413);
  const data = await readBytes(request.body, max);
  try { return JSON.parse(decoder.decode(data)); } catch { throw problem('INVALID_JSON'); }
}
function bucket(env) {
  if (!env.BUCKET || typeof env.BUCKET.get !== 'function' || typeof env.BUCKET.put !== 'function') throw problem('HOSTED_STORAGE_UNAVAILABLE', 503);
  return env.BUCKET;
}
async function stored(env, key, max = MAX_REPORT_BUNDLE_BYTES + 2048) {
  const result = await bucket(env).get(key);
  if (!result) return null;
  if (result.size > max || typeof result.etag !== 'string') throw problem('HOSTED_STORAGE_CORRUPT', 503);
  try {
    const raw = result.body ? await readBytes(result.body, max) : encoder.encode(await result.text());
    if (raw.byteLength > max) throw Error();
    return { value: JSON.parse(decoder.decode(raw)), etag: result.etag };
  } catch { throw problem('HOSTED_STORAGE_CORRUPT', 503); }
}
// R2 returns null when an HTTP precondition fails. Never fall back to an unconditional write.
export async function bucketPutCAS(env, key, value, etag = null) {
  return bucket(env).put(key, JSON.stringify(value), { onlyIf: etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: etag },
    httpMetadata: { contentType: 'application/json' } });
}
function checkContent(content, receipt) {
  validateBundle({ ...content, receipt });
  if (!receipt || !object(content.sourceData)) throw problem('SOURCE_SNAPSHOT_INVALID');
  const raw = content.sourceData.openligadb;
  if ((content.report.fixtures.some(row => row.fixture.source === 'openligadb') || raw !== undefined)
    && (!object(raw) || !object(raw.attribution) || !Array.isArray(raw.fixtures) || !Array.isArray(raw.history))) throw problem('SOURCE_SNAPSHOT_REQUIRED');
  if (raw?.reportId !== undefined && raw.reportId !== content.reportId) throw problem('SOURCE_REPORT_MISMATCH');
}
function served(content, receipt, reportHash) {
  checkContent(content, receipt);
  const observation = content.report.publicationKind === 'observations' ? { publicationKind: 'observations',
    originReportId: content.report.originReportId, forecastPublished: false } : {};
  const result = { ...content, ...observation, receipt, reportHash, freshness: { mode: 'hosted', generatedAt: content.report.generatedAt }, health: { status: 'available' } };
  // Revalidate against the actual content digest before a readback or receipt write
  // can claim that a particular site report was delivered.
  validateBundle(result);
  if (bytes(result).byteLength > MAX_REPORT_BUNDLE_BYTES) throw problem('REPORT_BUNDLE_TOO_LARGE', 413);
  return result;
}
async function record(env, reportId) {
  const row = await stored(env, `reports/${reportId}.json`);
  if (!row) throw problem('HOSTED_REPORT_NOT_FOUND', 404);
  const value = row.value;
  try {
    if (value.content?.reportId !== reportId || value.content.version !== 1
      || !id(value.contentHash) || !id(value.reportHash) || await hash(value.content) !== value.contentHash
      || await hash(value.content.report) !== value.reportHash) throw Error();
    checkContent(value.content, value.initialReceipt);
  } catch { throw problem('HOSTED_STORAGE_CORRUPT', 503); }
  return value;
}
function mergeReceipts(previous, incoming) {
  if (!previous) return incoming;
  if (previous.reportId !== incoming.reportId || previous.generatedAt !== incoming.generatedAt) throw problem('PUBLICATION_REPORT_MISMATCH');
  const channels = Object.assign(Object.create(null), previous.channels);
  for (const [name, next] of Object.entries(incoming.channels)) {
    const old = channels[name];
    if (name === 'notifications') {
      // A durable send outcome outranks a later observation of an incomplete claim.
      // In particular, accepted recovery must supersede unknown even with an older timestamp.
      const rank = value => value === 'accepted' ? 2 : value === 'unknown' ? 1 : 0;
      if (rank(next.status) < rank(old?.status)) continue;
      if (rank(next.status) > rank(old?.status)) { channels[name] = next; continue; }
    }
    if (!old || (Date.parse(next.checkedAt) || 0) >= (Date.parse(old.checkedAt) || 0)) channels[name] = next;
  }
  const events = [...new Map([...(previous.events || []), ...(incoming.events || [])].map(event => [JSON.stringify(event), event])).values()];
  return { ...incoming, channels, events };
}
export async function updateHostedReceipt(env, receipt) {
  if (!id(receipt?.reportId)) throw problem('INVALID_RECEIPT');
  const snapshot = await record(env, receipt.reportId);
  validateReceipt(receipt, snapshot.content.report);
  if (receipt.events !== undefined && !Array.isArray(receipt.events)) throw problem('INVALID_RECEIPT');
  const key = `receipts/${receipt.reportId}.json`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const old = await stored(env, key);
    if (old) validateReceipt(old.value, snapshot.content.report);
    const merged = mergeReceipts(old?.value || snapshot.initialReceipt, receipt);
    served(snapshot.content, merged, snapshot.reportHash);
    if (await bucketPutCAS(env, key, merged, old?.etag ?? null)) return merged;
  }
  throw problem('HOSTED_RECEIPT_CONFLICT', 409);
}
export async function loadHostedBundle(env, { now = Date.now() } = {}) {
  const current = await stored(env, CURRENT, 2048);
  if (!current) return null;
  const pointer = current.value;
  if (pointer.version !== 1 || !id(pointer.reportId) || !id(pointer.contentHash) || !id(pointer.reportHash)) throw problem('HOSTED_STORAGE_CORRUPT', 503);
  const snapshot = await record(env, pointer.reportId), receipt = await stored(env, `receipts/${pointer.reportId}.json`);
  if (snapshot.contentHash !== pointer.contentHash || snapshot.reportHash !== pointer.reportHash
    || snapshot.content.report.generatedAt !== pointer.generatedAt) throw problem('HOSTED_STORAGE_CORRUPT', 503);
  // Reading a stored report never renews its observation or expiry timestamps.
  return served(snapshot.content, receipt?.value || snapshot.initialReceipt, snapshot.reportHash);
}
async function publish(env, input, now) {
  validateBundle(input);
  const content = { version: 1, reportId: input.reportId, report: input.report, sourceData: input.sourceData ?? {} };
  checkContent(content, input.receipt);
  if (input.receipt.events !== undefined && !Array.isArray(input.receipt.events)) throw problem('INVALID_RECEIPT');
  const generated = Date.parse(content.report.generatedAt);
  if (generated > now + 60000) throw problem('REPORT_FROM_FUTURE');
  if (now - generated > 3600000) throw problem('REPORT_STALE', 409);
  const contentHash = await hash(content), reportHash = await hash(content.report);
  if (input.reportHash !== undefined && input.reportHash !== reportHash) throw problem('PUBLICATION_CONTENT_CHANGED', 409);
  served(content, input.receipt, reportHash);
  const snapshot = { content, contentHash, reportHash, initialReceipt: input.receipt };
  await bucketPutCAS(env, `reports/${input.reportId}.json`, snapshot);
  const verified = await record(env, input.reportId);
  if (verified.contentHash !== contentHash) throw problem('IMMUTABLE_REPORT_CONFLICT', 409);
  await updateHostedReceipt(env, input.receipt);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await stored(env, CURRENT, 2048);
    if (current) {
      if (!id(current.value.reportId) || !id(current.value.contentHash) || !Number.isFinite(Date.parse(current.value.generatedAt))) throw problem('HOSTED_STORAGE_CORRUPT', 503);
      if (current.value.reportId === input.reportId) {
        if (current.value.contentHash !== contentHash || current.value.reportHash !== reportHash) throw problem('IMMUTABLE_REPORT_CONFLICT', 409);
        return loadHostedBundle(env, { now });
      }
      const redactsCurrent = input.report.publicationKind === 'observations' && input.report.originReportId === current.value.reportId
        && input.report.originReportHash === current.value.reportHash && Date.parse(current.value.generatedAt) === generated;
      if (Date.parse(current.value.generatedAt) >= generated && !redactsCurrent) throw problem('REPORT_ORDER_CONFLICT', 409);
    }
    const pointer = { version: 1, reportId: input.reportId, contentHash, reportHash, generatedAt: content.report.generatedAt };
    if (await bucketPutCAS(env, CURRENT, pointer, current?.etag ?? null)) return loadHostedBundle(env, { now });
  }
  throw problem('HOSTED_PUBLICATION_CONFLICT', 409);
}
function pickScalars(row, fields) {
  const result = {};
  if (!object(row)) return result;
  for (const key of fields) {
    const value = row[key];
    if (typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u001f]/u.test(value)
      || typeof value === 'boolean' || Number.isFinite(value)) result[key] = value;
  }
  return result;
}
const fixtureFields = ['id', 'league', 'home', 'away', 'kickoff', 'status', 'source', 'sourceFixtureId', 'sourceEventId',
  'homeTeamId', 'awayTeamId', 'season', 'canonicalMatchId', 'identityRevision', 'revisionId', 'recordHash', 'identityScope',
  'updatedAt', 'observedAt', 'fetchedAt', 'sourceUpdatedAt', 'firstSeenAt'];
const attributionFields = ['id', 'name', 'url', 'license', 'licenseUrl'];
async function observationProjection(input) {
  validateBundle(input);
  checkContent({ version: 1, reportId: input.reportId, report: input.report, sourceData: input.sourceData ?? {} }, input.receipt);
  const originReportHash = await hash(input.report);
  if (input.reportHash !== undefined && input.reportHash !== originReportHash) throw problem('PUBLICATION_CONTENT_CHANGED', 409);
  const reportId = await hash({ version: 1, publicationKind: 'observations', originReportId: input.reportId });
  const origin = { originReportId: input.reportId, originReportHash, publicationKind: 'observations', forecastPublished: false };
  const fixtures = input.report.fixtures.map(row => ({ fixture: pickScalars(row.fixture, fixtureFields),
    forecast: { status: 'unavailable', reasons: ['RELEASE_GATE_BLOCKED'] },
    marketCandidate: { status: 'source_insufficient', reasons: ['RELEASE_GATE_BLOCKED'], candidate: null,
      readiness: { quoteGroups: [], verifiedOpeningCount: 0, blockers: ['RELEASE_GATE_BLOCKED'] } } }));
  const report = { version: 1, kind: 'prematch-forecast-report', generatedAt: input.report.generatedAt, simulated: false, ...origin,
    releaseGate: { status: 'BLOCKED', code: 'RELEASE_GATE_BLOCKED' }, publication: { reportId, ...origin },
    summary: { fixtures: fixtures.length, forecasts: 0, unavailable: fixtures.length, strictCandidates: 0 },
    model: null, backtests: [], fixtures, attribution: input.report.attribution.map(row => pickScalars(row, attributionFields)),
    coverage: Array.isArray(input.report.coverage) ? input.report.coverage.filter(object).map(row => pickScalars(row,
      ['source', 'league', 'fixtureStatus', 'historyStatus', 'status', 'fixtureCount', 'historyCount', 'receivedCount', 'rejectedCount',
        'expectedFixtureCount', 'complete', 'historyFrom', 'historyTo', 'checkedAt', 'observedAt', 'fetchedAt', 'sourceUpdatedAt'])) : [],
    categories: { analysis: [], strictCandidates: [], unassessable: fixtures.map(row => row.fixture.id) } };
  const sourceData = {}, raw = input.sourceData?.openligadb;
  if (raw) sourceData.openligadb = { ...pickScalars(raw, ['checkedAt', 'observedAt', 'fetchedAt', 'sourceUpdatedAt']),
    reportId, originReportId: input.reportId, publicationKind: 'observations', forecastPublished: false,
    attribution: pickScalars(raw.attribution, attributionFields),
    fixtures: raw.fixtures.filter(object).map(row => pickScalars(row, fixtureFields)), history: [], historyOmitted: true };
  const receipt = { version: 1, reportId, generatedAt: report.generatedAt, simulated: false, ...origin,
    channels: { files: { status: 'published', reportId, publicationKind: 'observations', forecastPublished: false },
      githubArtifact: { status: 'not_attempted' },
      externalWebsite: { status: 'not_attempted', reportId, mode: 'hosted', publicationKind: 'observations', forecastPublished: false },
      notifications: { status: 'skipped', reportId, code: 'RELEASE_GATE_BLOCKED' } }, files: [], events: [] };
  return { version: 1, reportId, report, sourceData, receipt };
}
const topLevel = new Set(['predictions.json', 'publication.json', 'public-fixtures.json', 'public-source-fixtures.json', 'openligadb-fixtures.json', 'run-inputs.json', 'run-manifest.json', 'prospective-evaluation.json']);
function allowedPath(path) {
  if (typeof path !== 'string' || path.length > 300 || !/^[A-Za-z0-9_./-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')
    || /(?:^|[\/._-])(?:secrets?|credentials?|tokens?|env|locks?|symlinks?|private[-_]?key)(?:[\/._-]|$)/i.test(path)) return false;
  return /^state\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(path)
    || (path.startsWith('reports/') && topLevel.has(path.slice(8)))
    || /^reports\/forecast-ledger\/[a-f0-9]{64}\/(?:predictions|results|scores|opportunities)\/[a-f0-9]{64}\.json$/.test(path)
    || /^reports\/replays\/[a-f0-9]{64}\/(?:run-inputs|run-manifest)\.json$/.test(path)
    || path === 'reports/.delivery/current.json'
    || /^reports\/\.delivery\/reports\/[a-f0-9]{64}\/(?:content|receipt)\.json$/.test(path);
}
async function validateFiles(files) {
  if (!Array.isArray(files) || files.length > 10000) throw problem('STATE_FILES_INVALID');
  const decoded = new Map();
  let total = 0;
  for (const file of files) {
    if (!object(file) || Object.keys(file).sort().join(',') !== 'content,path' || !allowedPath(file.path) || decoded.has(file.path)
      || typeof file.content !== 'string' || file.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.content)) throw problem('STATE_FILE_INVALID');
    total += file.content.length / 4 * 3 - (file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0);
    if (total > 64 * 1024 * 1024) throw problem('STATE_TOO_LARGE', 413);
    try {
      const binary = atob(file.content);
      if (btoa(binary) !== file.content) throw Error();
      decoded.set(file.path, JSON.parse(decoder.decode(Uint8Array.from(binary, c => c.charCodeAt(0)))));
    } catch { throw problem('STATE_JSON_INVALID'); }
  }
  const pointer = decoded.get('reports/.delivery/current.json');
  const snapshots = [...decoded.keys()].filter(path => path.startsWith('reports/.delivery/reports/'));
  if (pointer !== undefined || snapshots.length) {
    if (!object(pointer) || !id(pointer.reportId) || !id(pointer.contentHash) || !id(pointer.reportHash)) throw problem('STATE_PUBLICATION_INVALID');
    const prefix = `reports/.delivery/reports/${pointer.reportId}/`;
    if (snapshots.length !== 2 || snapshots.some(path => path !== `${prefix}content.json` && path !== `${prefix}receipt.json`)) throw problem('STATE_PUBLICATION_INVALID');
    const content = decoded.get(`${prefix}content.json`), receipt = decoded.get(`${prefix}receipt.json`);
    try {
      checkContent(content, receipt);
      if (content.reportId !== pointer.reportId || content.report.generatedAt !== pointer.generatedAt
        || await hash(content) !== pointer.contentHash || await hash(content.report) !== pointer.reportHash) throw Error();
      served(content, receipt, pointer.reportHash);
    } catch { throw problem('STATE_PUBLICATION_INVALID'); }
  }
  return files;
}
async function state(env) {
  const current = await stored(env, STATE, MAX_STATE_BYTES);
  if (!current) return null;
  if (!Number.isSafeInteger(current.value.revision) || current.value.revision < 1) throw problem('HOSTED_STORAGE_CORRUPT', 503);
  try { await validateFiles(current.value.files); } catch { throw problem('HOSTED_STORAGE_CORRUPT', 503); }
  return current;
}
function status(bundle) {
  return { version: 1, reportId: bundle.reportId, reportHash: bundle.reportHash, generatedAt: bundle.report.generatedAt, mode: 'hosted', health: 'available',
    ...(bundle.publicationKind === 'observations' ? { originReportId: bundle.originReportId, publicationKind: 'observations', forecastPublished: false } : {}) };
}
export async function handleHostedRequest(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const path = new URL(request.url).pathname;
  const methods = { '/internal/publications': ['POST'], '/internal/observations': ['POST'], '/internal/report-status': ['GET'], '/internal/state': ['GET', 'PUT'] };
  if (!Object.hasOwn(methods, path)) return null;
  try {
    await verifyActionsIdentity(request, env, { fetchImpl, now });
    if (!methods[path].includes(request.method)) return response({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: methods[path].join(', ') });
    if (path === '/internal/publications') {
      requireHostedForecastRelease();
      return response(status(await publish(env, await readJsonBody(request, MAX_REPORT_BUNDLE_BYTES), now)));
    }
    if (path === '/internal/observations') return response(status(await publish(env, await observationProjection(await readJsonBody(request, MAX_REPORT_BUNDLE_BYTES)), now)));
    if (path === '/internal/report-status') {
      const bundle = await loadHostedBundle(env, { now });
      if (!bundle) return response({ error: 'HOSTED_REPORT_NOT_FOUND' }, 404);
      if (bundle.publicationKind === 'observations') {
        await updateHostedReceipt(env, { ...bundle.receipt, channels: { ...bundle.receipt.channels,
          externalWebsite: { status: 'published', reportId: bundle.reportId, reportHash: bundle.reportHash,
            checkedAt: new Date(now).toISOString(), servedVerified: true, mode: 'hosted',
            publicationKind: 'observations', forecastPublished: false, meaning: 'machine-readback-not-user-read' } } });
      }
      return response(status(bundle));
    }
    if (request.method === 'GET') {
      const current = await state(env);
      return current ? response(current.value) : response({ error: 'HOSTED_STATE_NOT_FOUND' }, 404);
    }
    const input = await readJsonBody(request, MAX_STATE_BYTES);
    if (!object(input) || Object.keys(input).sort().join(',') !== 'expectedRevision,files'
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER) throw problem('STATE_REVISION_INVALID');
    await validateFiles(input.files);
    const current = await state(env);
    if ((current?.value.revision || 0) !== input.expectedRevision) throw problem('STATE_REVISION_CONFLICT', 409);
    const value = { revision: input.expectedRevision + 1, files: input.files };
    if (bytes(value).byteLength > MAX_STATE_BYTES) throw problem('STATE_TOO_LARGE', 413);
    if (!await bucketPutCAS(env, STATE, value, current?.etag ?? null)) throw problem('STATE_REVISION_CONFLICT', 409);
    return response({ revision: value.revision });
  } catch (error) {
    const schema = ['REPORT_SCHEMA_INVALID', 'RECEIPT_SCHEMA_INVALID', 'SNAPSHOT_SCHEMA_INVALID'].includes(error.message);
    return response({ error: error.code || (schema ? error.message : 'HOSTED_REQUEST_FAILED') }, error.status || (schema ? 400 : 503));
  }
}
