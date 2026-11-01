import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handleHostedRequest } from '../hosted-publications.mjs';
import { STATE_ARCHIVE_LIMITS } from '../state-archive.mjs';
import { NOW, ORIGIN, sampleBundle } from './fixtures.mjs';
import { MemoryBucket, fakeKeys, machineRequest, stateFile, token } from './hosted-fixtures.mjs';

const STATE = 'checkpoints/state.json';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = n => n.toString(16).padStart(64, '0');
const epochFor = revision => digest({ version: 1, kind: 'state-archive-epoch', origin: ORIGIN, baseRevision: revision });
const ledger = (n, value = { n }) => stateFile(`reports/forecast-ledger/${identity(1)}/predictions/${identity(n)}.json`, value);
const replay = n => stateFile(`reports/replays/${identity(n)}/run-inputs.json`, { n });
const hot = n => [stateFile('state/hosted-scheduler.json', { n })];
const objectKey = (epoch, sha256) => `checkpoints/objects/${epoch}/${sha256}.json`;
const route = (epoch, sha256) => `/internal/state/objects/${epoch}/${sha256}`;
class HeadBucket extends MemoryBucket {
  reads = [];
  async get(key) { this.reads.push(key); return super.get(key); }
  async head(key) {
    const row = this.rows.get(key);
    return row ? { etag: row.etag, customMetadata: row.customMetadata, size: Buffer.byteLength(row.text) } : null;
  }
  async put(key, text, options) {
    const result = await super.put(key, text, options);
    if (result) this.rows.get(key).customMetadata = options?.customMetadata;
    return result;
  }
}
function setup(bucket = new HeadBucket()) {
  const env = { DASHBOARD_ORIGIN: ORIGIN, BUCKET: bucket }, { fetchImpl } = fakeKeys();
  const call = (path, options = {}) => handleHostedRequest(machineRequest(path, options), env, { fetchImpl, now: NOW });
  const put = body => call('/internal/state', { method: 'PUT', body });
  return { env, call, put };
}
function shard(epoch, files) {
  const body = { version: 1, kind: 'state-archive-shard', epoch, files };
  const descriptor = { sha256: digest(body), wireBytes: Buffer.byteLength(JSON.stringify(body)),
    decodedBytes: files.reduce((n, file) => n + Buffer.from(file.content, 'base64').length, 0), fileCount: files.length };
  return { body, descriptor };
}
function archive(epoch, descriptors) {
  return { version: 1, epoch, shards: descriptors, fileCount: descriptors.reduce((n, d) => n + d.fileCount, 0),
    decodedBytes: descriptors.reduce((n, d) => n + d.decodedBytes, 0) };
}
function checkpoint(expectedRevision, epoch, descriptors, files = hot(expectedRevision)) {
  return { version: 2, expectedRevision, files, archive: archive(epoch, descriptors) };
}
async function upload(call, value) {
  const response = await call(route(value.body.epoch, value.descriptor.sha256), { method: 'PUT', body: value.body });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  assert.deepEqual(await response.json(), { version: 1, epoch: value.body.epoch, ...value.descriptor });
}
async function error(response, status, code) {
  response = await response;
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  if (code) assert.equal(body.error, code);
}

test('v1 checkpoint restores unchanged and migrates every immutable file to verified v2 shards', async () => {
  const { call, put, env } = setup(), prior = [...hot(1), ledger(2), replay(3)];
  assert.deepEqual(await (await put({ expectedRevision: 0, files: prior })).json(), { revision: 1 });
  assert.deepEqual(await (await call('/internal/state')).json(), { revision: 1, files: prior });
  const epoch = epochFor(1), first = shard(epoch, [ledger(2)]), second = shard(epoch, [replay(3)]);
  await upload(call, first); await upload(call, second);
  const input = checkpoint(1, epoch, [first.descriptor, second.descriptor]);
  assert.deepEqual(await (await put(input)).json(), { revision: 2 });
  const state = await (await call('/internal/state')).json();
  assert.deepEqual(state, { version: 2, revision: 2, files: input.files, archive: input.archive });
  assert.equal(Object.hasOwn(state, 'archiveIndexHash'), false);
  assert.match(env.BUCKET.json(STATE).archiveIndexHash, /^[a-f0-9]{64}$/);
  const restored = [...state.files];
  for (const descriptor of state.archive.shards) {
    const response = await call(route(epoch, descriptor.sha256));
    assert.equal(response.headers.get('cache-control'), 'no-store, private');
    const object = await response.json(); assert.equal(digest(object), descriptor.sha256);
    restored.push(...object.files);
  }
  assert.deepEqual(restored, prior);
  assert.equal(env.BUCKET.rows.has('publications/current.json'), false);
  await error(call('/internal/publications', { method: 'POST', body: sampleBundle() }), 409, 'RELEASE_GATE_BLOCKED');
});

test('legacy R2 roots without HEAD metadata remain migratable and changed or missing old files fail closed', async () => {
  const { call, put, env } = setup(new MemoryBucket());
  await put({ expectedRevision: 0, files: [ledger(2), replay(3)] });
  const before = env.BUCKET.rows.get(STATE), epoch = epochFor(1);
  const first = shard(epoch, [ledger(2)]); await upload(call, first);
  await error(put(checkpoint(1, epoch, [first.descriptor])), 409, 'STATE_ARCHIVE_MIGRATION_INCOMPLETE');
  const changed = shard(epoch, [ledger(2, { changed: true }), replay(3)]); await upload(call, changed);
  await error(put(checkpoint(1, epoch, [changed.descriptor])), 409, 'STATE_ARCHIVE_MIGRATION_CHANGED');
  assert.deepEqual(env.BUCKET.rows.get(STATE), before);
  const correct = shard(epoch, [ledger(2), replay(3)]); await upload(call, correct);
  assert.equal((await put(checkpoint(1, epoch, [correct.descriptor]))).status, 200);
});

test('uncommitted partial uploads do not advance state and missing references never replace last good state', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0);
  const first = shard(epoch, [ledger(2)]), missing = shard(epoch, [replay(3)]);
  await upload(call, first);
  await error(call('/internal/state'), 404, 'HOSTED_STATE_NOT_FOUND');
  await error(put(checkpoint(0, epoch, [first.descriptor, missing.descriptor])), 409, 'STATE_ARCHIVE_OBJECT_MISSING');
  assert.equal(env.BUCKET.rows.has(STATE), false);
  assert.equal((await put(checkpoint(0, epoch, [first.descriptor]))).status, 200);
  const before = structuredClone(env.BUCKET.rows.get(STATE));
  await error(put(checkpoint(1, epoch, [first.descriptor, missing.descriptor])), 409, 'STATE_ARCHIVE_OBJECT_MISSING');
  assert.deepEqual(env.BUCKET.rows.get(STATE), before);
  await upload(call, missing);
  assert.equal((await put(checkpoint(1, epoch, [first.descriptor, missing.descriptor]))).status, 200);
});

test('object hashes, metadata, cross-chunk duplicate paths and stored corruption are reverified', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0), original = shard(epoch, [ledger(2)]);
  await upload(call, original);
  const altered = { ...original.body, files: [ledger(2, { changed: true })] };
  await error(call(route(epoch, original.descriptor.sha256), { method: 'PUT', body: altered }), 409, 'STATE_OBJECT_HASH_MISMATCH');
  const duplicate = shard(epoch, [ledger(2, { changed: true })]); await upload(call, duplicate);
  await error(put(checkpoint(0, epoch, [original.descriptor, duplicate.descriptor])), 409, 'STATE_ARCHIVE_DUPLICATE_PATH');
  await error(put(checkpoint(0, epoch, [{ ...original.descriptor, wireBytes: original.descriptor.wireBytes + 1 }])), 409, 'STATE_ARCHIVE_OBJECT_MISMATCH');
  assert.equal((await put(checkpoint(0, epoch, [original.descriptor]))).status, 200);
  const before = structuredClone(env.BUCKET.rows.get(STATE));
  await error(put(checkpoint(1, epoch, [original.descriptor, duplicate.descriptor])), 409, 'STATE_ARCHIVE_DUPLICATE_PATH');
  env.BUCKET.rows.get(objectKey(epoch, original.descriptor.sha256)).text = JSON.stringify(altered);
  await error(call(route(epoch, original.descriptor.sha256)), 409, 'STATE_OBJECT_HASH_MISMATCH');
  assert.deepEqual(env.BUCKET.rows.get(STATE), before);
});

test('only append preserves old archive references; unknown versions, downgrade and hot archive paths are rejected', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0), first = shard(epoch, [ledger(2)]);
  await upload(call, first); await put(checkpoint(0, epoch, [first.descriptor]));
  const before = structuredClone(env.BUCKET.rows.get(STATE));
  await error(put(checkpoint(1, epoch, [])), 409, 'STATE_ARCHIVE_REMOVAL_FORBIDDEN');
  await error(put({ version: 3, expectedRevision: 1, files: [] }), 400, 'STATE_VERSION_INVALID');
  await error(put({ expectedRevision: 1, files: [] }), 409, 'STATE_VERSION_DOWNGRADE_FORBIDDEN');
  await error(put(checkpoint(1, epoch, [first.descriptor], [ledger(2)])), 400, 'STATE_ARCHIVE_PATH_IN_HOT_STATE');
  assert.deepEqual(env.BUCKET.rows.get(STATE), before);
});

test('epoch binds staged objects to the original checkpoint revision and persists across v2 revisions', async () => {
  const { call, put, env } = setup(), staged = shard(epochFor(0), [ledger(2)]);
  await upload(call, staged); await put({ expectedRevision: 0, files: hot(1) });
  await error(call(route(epochFor(0), staged.descriptor.sha256)), 409, 'STATE_ARCHIVE_EPOCH_MISMATCH');
  await error(put(checkpoint(1, epochFor(0), [staged.descriptor])), 409, 'STATE_ARCHIVE_EPOCH_MISMATCH');
  const active = shard(epochFor(1), [ledger(2)]); await upload(call, active);
  await put(checkpoint(1, epochFor(1), [active.descriptor]));
  assert.equal((await put(checkpoint(2, epochFor(1), [active.descriptor]))).status, 200);
  env.BUCKET.reads = [];
  assert.equal((await call(route(epochFor(1), active.descriptor.sha256))).status, 200);
  assert.equal(env.BUCKET.reads.includes(STATE), false, 'R2 HEAD metadata avoids reading hot payload on each object GET');
  await error(call(route(epochFor(1), identity(999))), 404, 'STATE_ARCHIVE_OBJECT_MISSING');
});

test('concurrent out-of-order root updates use R2 ETag CAS and cannot replace the winner', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0), first = shard(epoch, [ledger(2)]), second = shard(epoch, [ledger(3)]);
  await upload(call, first); await put(checkpoint(0, epoch, [first.descriptor])); await upload(call, second);
  let release, arrived, held = false;
  const pause = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  env.BUCKET.beforePut = async (key, text) => {
    if (key === STATE && JSON.parse(text).files[0].content === hot(10)[0].content && !held) { held = true; arrived(); await pause; }
  };
  const older = put(checkpoint(1, epoch, [first.descriptor], hot(10))); await waiting;
  assert.equal((await put(checkpoint(1, epoch, [first.descriptor, second.descriptor], hot(20)))).status, 200);
  const winner = structuredClone(env.BUCKET.rows.get(STATE)); release();
  await error(older, 409, 'STATE_REVISION_CONFLICT');
  assert.deepEqual(env.BUCKET.rows.get(STATE), winner);
  await error(put(checkpoint(1, epoch, [first.descriptor])), 409, 'STATE_REVISION_CONFLICT');
});

test('private path index corruption blocks reads and commits instead of losing duplicate protection', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0), value = shard(epoch, [ledger(2)]);
  await upload(call, value); await put(checkpoint(0, epoch, [value.descriptor]));
  const before = structuredClone(env.BUCKET.rows.get(STATE)), index = env.BUCKET.json(STATE).archiveIndexHash;
  env.BUCKET.rows.get(`checkpoints/path-indexes/${epoch}/${index}.json`).text = '{}';
  await error(call('/internal/state'), 503, 'STATE_ARCHIVE_INDEX_CORRUPT');
  await error(put(checkpoint(1, epoch, [value.descriptor])), 503, 'STATE_ARCHIVE_INDEX_CORRUPT');
  assert.deepEqual(env.BUCKET.rows.get(STATE), before);
});

test('object routes require exact machine identity and cannot expose hot files, secrets or arbitrary bucket paths', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0), value = shard(epoch, [ledger(2)]);
  for (const method of ['GET', 'PUT']) {
    await error(call(route(epoch, value.descriptor.sha256), { method, body: method === 'PUT' ? value.body : undefined,
      headers: { authorization: '', cookie: 'session=visitor' } }), 401, 'ACTIONS_IDENTITY_INVALID');
  }
  await error(call(route(epoch, value.descriptor.sha256), { method: 'PUT', body: value.body, bearer: token({ repository_id: 'wrong' }) }), 401);
  for (const path of ['state/state.json', 'state/.env.json', 'reports/.delivery/current.json', `reports/replays/${identity(2)}/secret.json`]) {
    const bad = shard(epoch, [stateFile(path, {})]);
    await error(call(route(epoch, bad.descriptor.sha256), { method: 'PUT', body: bad.body }), 400, 'STATE_OBJECT_FILE_INVALID');
  }
  const bad = shard(epoch, [{ ...ledger(2), target: '/etc/passwd' }]);
  await error(call(route(epoch, bad.descriptor.sha256), { method: 'PUT', body: bad.body }), 400, 'STATE_OBJECT_FILE_INVALID');
  await error(call('/internal/state/objects/not-an-object'), 400, 'STATE_OBJECT_PATH_INVALID');
  await error(put(checkpoint(0, epoch, [], [stateFile('state/secrets.json', {})])), 400, 'STATE_FILE_INVALID');
  assert.equal(env.BUCKET.rows.size, 0);
});

test('bounded shard/root/manifest budgets reject excess without truncation or advancing revision', async () => {
  const { call, put, env } = setup(), epoch = epochFor(0), value = shard(epoch, [ledger(2)]);
  await error(call(route(epoch, value.descriptor.sha256), { method: 'PUT', body: value.body,
    headers: { 'content-length': String(STATE_ARCHIVE_LIMITS.shardBytes + 1) } }), 413, 'BODY_TOO_LARGE');
  await error(put({ ...checkpoint(0, epoch, []), archive: { ...archive(epoch, []), fileCount: 200001 } }), 400, 'STATE_ARCHIVE_INVALID');
  const refs = Array.from({ length: 33 }, (_, n) => ({ ...value.descriptor, sha256: identity(n + 1) }));
  await error(put(checkpoint(0, epoch, refs)), 413, 'STATE_ARCHIVE_COMMIT_TOO_LARGE');
  await error(call('/internal/state', { method: 'PUT', body: checkpoint(0, epoch, []),
    headers: { 'content-length': String(STATE_ARCHIVE_LIMITS.hotBytes + 1) } }), 413, 'BODY_TOO_LARGE');
  assert.equal(env.BUCKET.rows.has(STATE), false);
});

test('large shards and non-sorted files retain original JSON key order and exact digest', async () => {
  const { call, put } = setup(), epoch = epochFor(0);
  const files = [ledger(9, { data: 'x'.repeat(1024 * 1024) }), ledger(2)];
  const body = { files: files.map(({ path, content }) => ({ content, path })), epoch, kind: 'state-archive-shard', version: 1 };
  const descriptor = { ...shard(epoch, files).descriptor, sha256: digest(body), wireBytes: Buffer.byteLength(JSON.stringify(body)) };
  await upload(call, { body, descriptor });
  assert.deepEqual(await (await call(route(epoch, descriptor.sha256))).json(), body);
  const reordered = { fileCount: descriptor.fileCount, decodedBytes: descriptor.decodedBytes, wireBytes: descriptor.wireBytes, sha256: descriptor.sha256 };
  assert.equal((await put(checkpoint(0, epoch, [reordered]))).status, 200);
  assert.equal((await put(checkpoint(1, epoch, [descriptor]))).status, 200);
});
