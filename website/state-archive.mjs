import { verifyActionsIdentity } from './github-oidc.mjs';

export const STATE_ARCHIVE_LIMITS = Object.freeze({ shardBytes: 4 * 1024 * 1024, shardFiles: 10000, newShards: 32,
  shards: 2048, archiveBytes: 256 * 1024 * 1024, archiveFiles: 200000, hotBytes: 32 * 1024 * 1024 });
const STATE = 'checkpoints/state.json', INDEX_BYTES = 15 * 1024 * 1024;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const json = value => JSON.stringify(value);
const encoded = value => encoder.encode(json(value));
const archivePath = path => typeof path === 'string' && (/^reports\/forecast-ledger\/[a-f0-9]{64}\/(?:predictions|results|scores|opportunities)\/[a-f0-9]{64}\.json$/.test(path)
  || /^reports\/replays\/[a-f0-9]{64}\/(?:run-inputs|run-manifest)\.json$/.test(path));
function failure(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function reply(value, status = 200, extra = {}) {
  return new Response(json(value), { status, headers: { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', ...extra } });
}
async function hashBytes(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}
async function hash(value) { return hashBytes(encoded(value)); }
async function streamBytes(stream, max) {
  if (!stream) throw failure('STATE_BODY_MISSING');
  const reader = stream.getReader(), chunks = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      if (total > max) { await reader.cancel(); throw failure('BODY_TOO_LARGE', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data;
}
async function body(request, max) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw failure('JSON_REQUIRED', 415);
  if (Number(request.headers.get('content-length') || 0) > max) throw failure('BODY_TOO_LARGE', 413);
  const bytes = await streamBytes(request.body, max);
  try { return JSON.parse(decoder.decode(bytes)); } catch { throw failure('STATE_JSON_INVALID'); }
}
function bucket(env) {
  if (!env.BUCKET?.get || !env.BUCKET?.put) throw failure('HOSTED_STORAGE_UNAVAILABLE', 503);
  return env.BUCKET;
}
async function read(env, key, max, keepBytes = true) {
  const row = await bucket(env).get(key); if (!row) return null;
  try {
    if (row.size > max || typeof row.etag !== 'string') throw Error();
    const bytes = row.body ? await streamBytes(row.body, max) : encoder.encode(await row.text());
    if (bytes.length > max) throw Error();
    return { value: JSON.parse(decoder.decode(bytes)), etag: row.etag, ...(keepBytes ? { bytes } : {}) };
  } catch { throw failure('HOSTED_STORAGE_CORRUPT', 503); }
}
async function put(env, key, value, etag = null, customMetadata) {
  return bucket(env).put(key, json(value), { onlyIf: etag === null ? { etagDoesNotMatch: '*' } : { etagMatches: etag },
    httpMetadata: { contentType: 'application/json' }, ...(customMetadata ? { customMetadata } : {}) });
}
function manifest(value) {
  const limits = STATE_ARCHIVE_LIMITS;
  if (!exact(value, ['version', 'epoch', 'shards', 'fileCount', 'decodedBytes']) || value.version !== 1 || !id(value.epoch)
    || !Array.isArray(value.shards) || value.shards.length > limits.shards
    || !integer(value.fileCount, limits.archiveFiles) || !integer(value.decodedBytes, limits.archiveBytes)) throw failure('STATE_ARCHIVE_INVALID');
  const seen = new Set(); let files = 0, bytes = 0;
  for (const shard of value.shards) {
    if (!exact(shard, ['sha256', 'wireBytes', 'decodedBytes', 'fileCount']) || !id(shard.sha256) || seen.has(shard.sha256)
      || !integer(shard.wireBytes, limits.shardBytes) || !shard.wireBytes
      || !integer(shard.decodedBytes, limits.shardBytes) || !integer(shard.fileCount, limits.shardFiles) || !shard.fileCount) throw failure('STATE_ARCHIVE_INVALID');
    seen.add(shard.sha256); files += shard.fileCount; bytes += shard.decodedBytes;
  }
  if (files !== value.fileCount || bytes !== value.decodedBytes) throw failure('STATE_ARCHIVE_TOTAL_MISMATCH');
  return value;
}
async function validateHot(files, validateFiles, archived = false) {
  if (!Array.isArray(files) || archived && files.some(file => archivePath(file?.path))) throw failure('STATE_ARCHIVE_PATH_IN_HOT_STATE');
  if (typeof validateFiles !== 'function') throw failure('STATE_VALIDATOR_UNAVAILABLE', 503);
  await validateFiles(files);
}
async function current(env, validateFiles) {
  // The root has ETag CAS, not a content address. Do not retain its 32 MiB
  // transport buffer alongside the parsed legacy checkpoint during migration.
  const row = await read(env, STATE, STATE_ARCHIVE_LIMITS.hotBytes + 2048, false); if (!row) return null;
  try {
    const value = row.value;
    if (!integer(value.revision, Number.MAX_SAFE_INTEGER) || value.revision < 1) throw Error();
    if (value.version === 2) {
      if (!exact(value, ['version', 'revision', 'files', 'archive', 'archiveIndexHash']) || !id(value.archiveIndexHash)) throw Error();
      manifest(value.archive); await validateHot(value.files, validateFiles, true);
    } else {
      if (value.version !== undefined && value.version !== 1 || !exact(value, value.version === 1 ? ['version', 'revision', 'files'] : ['revision', 'files'])) throw Error();
      await validateHot(value.files, validateFiles);
    }
  } catch { throw failure('HOSTED_STORAGE_CORRUPT', 503); }
  return row;
}
async function derivedEpoch(origin, baseRevision) {
  return hash({ version: 1, kind: 'state-archive-epoch', origin, baseRevision });
}
async function epoch(env, validateFiles) {
  // Metadata is written only with the same conditional root update. R2 HEAD
  // avoids rereading a large hot checkpoint for every immutable object fetch.
  if (typeof bucket(env).head === 'function') {
    const head = await bucket(env).head(STATE);
    if (!head) return derivedEpoch(env.DASHBOARD_ORIGIN, 0);
    const metadata = head.customMetadata;
    if (metadata && ['1', '2'].includes(metadata.stateVersion) && /^[1-9][0-9]*$/.test(metadata.revision || '')
      && Number.isSafeInteger(Number(metadata.revision))) {
      if (metadata.stateVersion === '2' && id(metadata.epoch)) return metadata.epoch;
      if (metadata.stateVersion === '1') return derivedEpoch(env.DASHBOARD_ORIGIN, Number(metadata.revision));
    }
  }
  const row = await current(env, validateFiles);
  return row?.value.version === 2 ? row.value.archive.epoch : derivedEpoch(env.DASHBOARD_ORIGIN, row?.value.revision || 0);
}
function objectKey(epoch, sha256) { return `checkpoints/objects/${epoch}/${sha256}.json`; }
function indexKey(epoch, sha256) { return `checkpoints/path-indexes/${epoch}/${sha256}.json`; }
async function shard(value, expectedEpoch, expectedHash) {
  if (!exact(value, ['version', 'kind', 'epoch', 'files']) || value.version !== 1 || value.kind !== 'state-archive-shard'
    || value.epoch !== expectedEpoch || !Array.isArray(value.files) || !value.files.length || value.files.length > STATE_ARCHIVE_LIMITS.shardFiles) throw failure('STATE_OBJECT_INVALID');
  let decodedBytes = 0; const seen = new Set();
  for (const file of value.files) {
    if (!exact(file, ['path', 'content']) || !archivePath(file.path) || seen.has(file.path) || typeof file.content !== 'string'
      || file.content.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(file.content)) throw failure('STATE_OBJECT_FILE_INVALID');
    try {
      const binary = atob(file.content); if (btoa(binary) !== file.content) throw Error();
      decodedBytes += binary.length;
      JSON.parse(decoder.decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
    } catch { throw failure('STATE_OBJECT_JSON_INVALID'); }
    seen.add(file.path);
  }
  const wire = encoded(value);
  if (wire.byteLength > STATE_ARCHIVE_LIMITS.shardBytes) throw failure('STATE_OBJECT_TOO_LARGE', 413);
  const sha256 = await hashBytes(wire);
  if (sha256 !== expectedHash) throw failure('STATE_OBJECT_HASH_MISMATCH', 409);
  return { value, descriptor: { sha256, wireBytes: wire.byteLength, decodedBytes, fileCount: value.files.length } };
}
function sameDescriptor(a, b) {
  return ['sha256', 'wireBytes', 'decodedBytes', 'fileCount'].every(key => a[key] === b[key]);
}
async function loadShard(env, expectedEpoch, descriptor) {
  const row = await read(env, objectKey(expectedEpoch, descriptor.sha256), STATE_ARCHIVE_LIMITS.shardBytes);
  if (!row) throw failure('STATE_ARCHIVE_OBJECT_MISSING', 409);
  const result = await shard(row.value, expectedEpoch, descriptor.sha256);
  // Bytes stored under a content address must themselves be canonical.
  if (await hashBytes(row.bytes) !== descriptor.sha256 || !sameDescriptor(result.descriptor, descriptor)) throw failure('STATE_ARCHIVE_OBJECT_MISMATCH', 409);
  return result.value;
}
async function oldPaths(env, value) {
  if (value?.version !== 2) return [];
  const row = await read(env, indexKey(value.archive.epoch, value.archiveIndexHash), INDEX_BYTES);
  if (!row || await hashBytes(row.bytes) !== value.archiveIndexHash) throw failure('STATE_ARCHIVE_INDEX_CORRUPT', 503);
  const index = row.value;
  if (!exact(index, ['version', 'kind', 'epoch', 'paths']) || index.version !== 1 || index.kind !== 'state-archive-path-index'
    || index.epoch !== value.archive.epoch || !Array.isArray(index.paths) || index.paths.length !== value.archive.fileCount
    || index.paths.length > STATE_ARCHIVE_LIMITS.archiveFiles || index.paths.some((path, n) => !id(path) || n && path <= index.paths[n - 1])) throw failure('STATE_ARCHIVE_INDEX_CORRUPT', 503);
  return index.paths;
}
function publicState(value) {
  return value.version === 2 ? { version: 2, revision: value.revision, files: value.files, archive: value.archive } : value;
}
async function commitV2(env, input, previous, validateFiles) {
  if (!exact(input, ['version', 'expectedRevision', 'files', 'archive']) || input.version !== 2) throw failure('STATE_VERSION_INVALID');
  const archive = manifest(input.archive);
  const expectedEpoch = previous?.value.version === 2 ? previous.value.archive.epoch : await derivedEpoch(env.DASHBOARD_ORIGIN, input.expectedRevision);
  if (archive.epoch !== expectedEpoch) throw failure('STATE_ARCHIVE_EPOCH_MISMATCH', 409);
  await validateHot(input.files, validateFiles, true);
  const priorShards = previous?.value.version === 2 ? previous.value.archive.shards : [];
  if (archive.shards.length < priorShards.length || priorShards.some((value, n) => !sameDescriptor(value, archive.shards[n]))) throw failure('STATE_ARCHIVE_REMOVAL_FORBIDDEN', 409);
  const added = archive.shards.slice(priorShards.length);
  if (added.length > STATE_ARCHIVE_LIMITS.newShards) throw failure('STATE_ARCHIVE_COMMIT_TOO_LARGE', 413);
  let archiveIndexHash = previous?.value.archiveIndexHash;
  if (previous?.value.version === 2 && added.length === 0) {
    // Hot-only observations retain the immutable index without rewriting it.
    await oldPaths(env, previous.value);
  } else {
    const paths = new Set(await oldPaths(env, previous?.value));
    const migrating = new Map(previous?.value.version === 2 ? [] : (previous?.value.files || []).filter(file => archivePath(file.path)).map(file => [file.path, file.content]));
    for (const descriptor of added) {
      const object = await loadShard(env, archive.epoch, descriptor);
      for (const file of object.files) {
        const pathHash = await hashBytes(encoder.encode(file.path));
        if (paths.has(pathHash)) throw failure('STATE_ARCHIVE_DUPLICATE_PATH', 409);
        paths.add(pathHash);
        if (migrating.has(file.path)) {
          if (migrating.get(file.path) !== file.content) throw failure('STATE_ARCHIVE_MIGRATION_CHANGED', 409);
          migrating.delete(file.path);
        }
      }
    }
    if (migrating.size) throw failure('STATE_ARCHIVE_MIGRATION_INCOMPLETE', 409);
    if (paths.size !== archive.fileCount) throw failure('STATE_ARCHIVE_TOTAL_MISMATCH');
    const index = { version: 1, kind: 'state-archive-path-index', epoch: archive.epoch, paths: [...paths].sort() };
    if (encoded(index).length > INDEX_BYTES) throw failure('STATE_ARCHIVE_INDEX_TOO_LARGE', 413);
    archiveIndexHash = await hash(index);
    const key = indexKey(archive.epoch, archiveIndexHash);
    await put(env, key, index);
    const verified = await read(env, key, INDEX_BYTES);
    if (!verified || await hashBytes(verified.bytes) !== archiveIndexHash) throw failure('STATE_ARCHIVE_INDEX_CORRUPT', 503);
  }
  const value = { version: 2, revision: input.expectedRevision + 1, files: input.files, archive, archiveIndexHash };
  if (encoded(publicState(value)).length > STATE_ARCHIVE_LIMITS.hotBytes) throw failure('BODY_TOO_LARGE', 413);
  if (!await put(env, STATE, value, previous?.etag ?? null, { stateVersion: '2', revision: String(value.revision), epoch: archive.epoch })) throw failure('STATE_REVISION_CONFLICT', 409);
  return reply({ revision: value.revision });
}

// This handler owns only state routes and performs its own machine authentication.
// The shared report validator is supplied by the publications module to retain v1 semantics.
export async function handleStateArchiveRequest(request, env, { fetchImpl = fetch, now = Date.now(), validateFiles } = {}) {
  const path = new URL(request.url).pathname, objectRoute = /^\/internal\/state\/objects\/([a-f0-9]{64})\/([a-f0-9]{64})$/.exec(path);
  if (path !== '/internal/state' && !path.startsWith('/internal/state/objects/')) return null;
  try {
    await verifyActionsIdentity(request, env, { fetchImpl, now });
    if (!['GET', 'PUT'].includes(request.method)) return reply({ error: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'GET, PUT' });
    if (path !== '/internal/state') {
      if (!objectRoute) throw failure('STATE_OBJECT_PATH_INVALID');
      const [, objectEpoch, sha256] = objectRoute;
      if (objectEpoch !== await epoch(env, validateFiles)) throw failure('STATE_ARCHIVE_EPOCH_MISMATCH', 409);
      if (request.method === 'PUT') {
        const object = await shard(await body(request, STATE_ARCHIVE_LIMITS.shardBytes), objectEpoch, sha256);
        await put(env, objectKey(objectEpoch, sha256), object.value);
        await loadShard(env, objectEpoch, object.descriptor);
        return reply({ version: 1, epoch: objectEpoch, ...object.descriptor });
      }
      const row = await read(env, objectKey(objectEpoch, sha256), STATE_ARCHIVE_LIMITS.shardBytes);
      if (!row) return reply({ error: 'STATE_ARCHIVE_OBJECT_MISSING' }, 404);
      const object = await shard(row.value, objectEpoch, sha256);
      if (await hashBytes(row.bytes) !== sha256) throw failure('STATE_OBJECT_HASH_MISMATCH', 409);
      return reply(object.value);
    }
    const previous = await current(env, validateFiles);
    if (request.method === 'GET') {
      if (previous?.value.version === 2) await oldPaths(env, previous.value);
      return previous ? reply(publicState(previous.value)) : reply({ error: 'HOSTED_STATE_NOT_FOUND' }, 404);
    }
    const input = await body(request, STATE_ARCHIVE_LIMITS.hotBytes);
    if (!object(input) || !integer(input.expectedRevision, Number.MAX_SAFE_INTEGER - 1)) throw failure('STATE_REVISION_INVALID');
    if ((previous?.value.revision || 0) !== input.expectedRevision) throw failure('STATE_REVISION_CONFLICT', 409);
    if (input.version === 2) return await commitV2(env, input, previous, validateFiles);
    if (input.version !== undefined && input.version !== 1 || !exact(input, input.version === 1 ? ['version', 'expectedRevision', 'files'] : ['expectedRevision', 'files'])) throw failure('STATE_VERSION_INVALID');
    if (previous?.value.version === 2) throw failure('STATE_VERSION_DOWNGRADE_FORBIDDEN', 409);
    await validateHot(input.files, validateFiles);
    const value = { revision: input.expectedRevision + 1, files: input.files };
    if (encoded(value).length > STATE_ARCHIVE_LIMITS.hotBytes) throw failure('BODY_TOO_LARGE', 413);
    if (!await put(env, STATE, value, previous?.etag ?? null, { stateVersion: '1', revision: String(value.revision) })) throw failure('STATE_REVISION_CONFLICT', 409);
    return reply({ revision: value.revision });
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'HOSTED_STATE_FAILED';
    return reply({ error: code }, error.status || 400);
  }
}
