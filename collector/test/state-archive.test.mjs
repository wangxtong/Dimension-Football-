import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ARCHIVE_LIMITS, archiveHash, archivePath, createArchiveEpoch, emptyArchive, createArchiveShard, decodeArchiveShard, validateArchive, appendArchive } from '../state-archive.mjs';
import { createStateSession, captureState, STATE_LIMITS, HOSTED_ORIGIN } from '../hosted.mjs';

const hex = n => n.toString(16).padStart(64, '0');
const path = n => `reports/forecast-ledger/${hex(1)}/predictions/${hex(n)}.json`;
const file = (n, value = { value: n }) => ({ path: path(n), content: Buffer.from(JSON.stringify(value)).toString('base64') });
const epoch = createArchiveEpoch(HOSTED_ORIGIN, 0);
async function workspace(t) { const root = await mkdtemp(join(tmpdir(), 'state-archive-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function put(root, row) { const target = join(root, row.path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, Buffer.from(row.content, 'base64')); }
function backend(initial = null) {
  let state = initial; const objects = new Map(), calls = [];
  const api = { objects, calls, get state() { return state; }, set state(value) { state = value; }, async request(url, { method = 'GET', body } = {}) {
    calls.push({ url, method });
    if (url === '/internal/state') {
      if (method === 'GET') return structuredClone(state);
      if (body.expectedRevision !== (state?.revision || 0)) throw Error('HOSTED_STATE_CONFLICT');
      if (body.version === 2) {
        validateArchive(body.archive); assert.equal(body.archive.epoch, state?.archive?.epoch || createArchiveEpoch(HOSTED_ORIGIN, state?.revision || 0));
        assert.deepEqual(body.archive.shards.slice(0, state?.archive?.shards.length || 0), state?.archive?.shards || []);
        for (const shard of body.archive.shards) assert.ok(objects.has(`/internal/state/objects/${body.archive.epoch}/${shard.sha256}`));
      }
      state = { revision: body.expectedRevision + 1, files: structuredClone(body.files),
        ...(body.version === 2 ? { version: 2, archive: structuredClone(body.archive) } : {}) };
      return { revision: state.revision };
    }
    assert.match(url, /^\/internal\/state\/objects\/[a-f0-9]{64}\/[a-f0-9]{64}$/);
    const parts = url.split('/'), expectedEpoch = state?.archive?.epoch || createArchiveEpoch(HOSTED_ORIGIN, state?.revision || 0);
    assert.equal(parts.at(-2), expectedEpoch);
    if (method === 'GET') { if (!objects.has(url)) throw Error('HOSTED_HTTP_404'); return structuredClone(objects.get(url)); }
    assert.equal(method, 'PUT');
    const shard = createArchiveShard(body.epoch, body.files); assert.equal(parts.at(-1), shard.descriptor.sha256);
    if (objects.has(url)) assert.deepEqual(objects.get(url), body); else objects.set(url, structuredClone(body));
    return { version: 1, epoch: body.epoch, ...shard.descriptor };
  } }; return api;
}

// These fixtures validate storage transport and integrity, not football results.
test('archive contract rejects unsafe paths, duplicate content identities, malformed encoding and changed bytes', () => {
  const good = createArchiveShard(epoch, [file(1)]);
  assert.equal(decodeArchiveShard(good.body, good.descriptor, epoch)[0].bytes.toString(), JSON.stringify({ value: 1 }));
  for (const p of ['../escape.json', 'state/token.json', 'reports/.delivery/current.json', path(1).replace('predictions', '../predictions')])
    assert.equal(archivePath(p), false);
  assert.throws(() => createArchiveShard(epoch, [file(1), file(1)]), /DUPLICATE_PATH/);
  assert.throws(() => createArchiveShard(epoch, [{ path: path(1), content: 'e30' }]), /INVALID_FILE/);
  assert.throws(() => createArchiveShard(epoch, [{ path: path(1), content: Buffer.from('not-json').toString('base64') }]), /INVALID_JSON/);
  assert.throws(() => decodeArchiveShard({ ...good.body, epoch: hex(4) }, good.descriptor, epoch), /INVALID_SHARD/);
  assert.throws(() => decodeArchiveShard({ ...good.body, files: [file(2)] }, good.descriptor, epoch), /HASH_MISMATCH/);
  assert.throws(() => validateArchive({ ...appendArchive(emptyArchive(epoch), [good.descriptor]), fileCount: 5 }), /TOTAL_MISMATCH/);
  assert.throws(() => appendArchive(emptyArchive(epoch), [good.descriptor, good.descriptor]), /INVALID_DESCRIPTOR/);
});

test('legacy checkpoint migrates without losing files; later snapshots only append and restore exact bytes', async t => {
  const old = file(1), api = backend({ revision: 3, files: [old] }), root = await workspace(t);
  const session = await createStateSession(root, api, { partitioned: true });
  await put(root, { path: 'state/state.json', content: Buffer.from('{"revision":1}').toString('base64') });
  await session.checkpoint();
  assert.equal(api.state.version, 2); assert.equal(api.state.archive.epoch, createArchiveEpoch(HOSTED_ORIGIN, 3));
  assert.equal(api.state.archive.fileCount, 1); assert.equal(api.state.files.length, 1);
  const previous = structuredClone(api.state.archive), uploads = api.calls.filter(row => row.method === 'PUT' && row.url !== '/internal/state').length;
  await session.checkpoint(); assert.equal(api.calls.filter(row => row.method === 'PUT' && row.url !== '/internal/state').length, uploads);
  await put(root, file(2)); await session.checkpoint();
  assert.deepEqual(api.state.archive.shards.slice(0, previous.shards.length), previous.shards);
  assert.equal(api.state.archive.fileCount, 2); assert.equal(api.objects.size, 2);
  const restored = await workspace(t); await createStateSession(restored, api);
  assert.equal((await readFile(join(restored, old.path))).toString('base64'), old.content);
  assert.equal((await readFile(join(restored, path(2)))).toString('base64'), file(2).content);
  assert.equal(await readFile(join(restored, 'state/state.json'), 'utf8'), '{"revision":1}');
});

test('observation-only restore preserves archive references without downloading private history', async t => {
  const api = backend(), root = await workspace(t), full = await createStateSession(root, api, { partitioned: true });
  await put(root, file(1)); await full.checkpoint(); const saved = structuredClone(api.state.archive);
  api.calls.length = 0; const shadowRoot = await workspace(t), shadow = await createStateSession(shadowRoot, api, { restoreArchive: false });
  assert.deepEqual(await readdir(shadowRoot), []);
  await put(shadowRoot, { path: 'state/observations.json', content: Buffer.from('{}').toString('base64') }); await shadow.checkpoint();
  assert.deepEqual(api.state.archive, saved); assert.ok(api.calls.every(row => row.url === '/internal/state'));
  await put(shadowRoot, file(2)); const revision = api.state.revision;
  await assert.rejects(shadow.checkpoint(), /HOSTED_ARCHIVE_RESEARCH_REQUIRED/); assert.equal(api.state.revision, revision);
});

test('missing or corrupted shard fails restore with the working root still empty', async t => {
  for (const corrupt of [false, true]) {
    const api = backend(), root = await workspace(t), session = await createStateSession(root, api, { partitioned: true });
    await put(root, file(1)); await session.checkpoint(); const key = [...api.objects.keys()][0];
    if (corrupt) api.objects.get(key).files[0].content = file(2).content; else api.objects.delete(key);
    const target = await workspace(t);
    await assert.rejects(createStateSession(target, api), corrupt ? /HASH_MISMATCH/ : /HOSTED_HTTP_404/);
    assert.deepEqual(await readdir(target), []);
  }
});

test('previously archived files cannot be silently changed or removed', async t => {
  for (const change of ['delete', 'mutate']) {
    const api = backend(), root = await workspace(t), session = await createStateSession(root, api, { partitioned: true });
    await put(root, file(1)); await session.checkpoint(); const revision = api.state.revision;
    if (change === 'delete') await rm(join(root, path(1))); else await put(root, file(1, { changed: true }));
    await assert.rejects(session.checkpoint(), change === 'delete' ? /FILE_MISSING/ : /IMMUTABLE_CHANGED/);
    assert.equal(api.state.revision, revision); assert.equal(api.objects.size, 1);
  }
});

test('a CAS conflict leaves uploaded objects retained and blocks any second checkpoint', async t => {
  const api = backend(), root = await workspace(t), session = await createStateSession(root, api, { partitioned: true });
  await put(root, file(1)); await session.checkpoint();
  await put(root, file(2)); api.state = { ...api.state, revision: api.state.revision + 1 };
  await assert.rejects(session.checkpoint(), /STATE_CONFLICT/); assert.equal(api.state.archive.fileCount, 1); assert.equal(api.objects.size, 2);
  const count = api.calls.length; await assert.rejects(session.checkpoint(), /STATE_CONFLICT/); assert.equal(api.calls.length, count);
});

test('actual archive over 32 MiB persists in bounded shards while the hot checkpoint stays small', async t => {
  const api = backend(), root = await workspace(t), session = await createStateSession(root, api, { partitioned: true });
  for (let i = 1; i <= 44; i++) await put(root, file(i, { value: 'x'.repeat(800000), id: i }));
  await assert.rejects(captureState(root, 0), /STATE_LIMIT_EXCEEDED/);
  await session.checkpoint(); assert.ok(api.state.archive.decodedBytes > 32 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(api.state)) < 10000); assert.equal(api.state.files.length, 0);
  assert.equal(api.state.archive.fileCount, 44); assert.ok(api.state.archive.shards.every(row => row.wireBytes <= ARCHIVE_LIMITS.shardBytes));
  const restored = await workspace(t); await createStateSession(restored, api);
  for (const i of [1, 22, 44]) assert.equal(await readFile(join(root, path(i)), 'utf8'), await readFile(join(restored, path(i)), 'utf8'));
});

test('archived file counts are independent of the hot-state file cap; archive totals remain bounded', async t => {
  const api = backend(), root = await workspace(t), limits = { ...STATE_LIMITS, files: 1 };
  const session = await createStateSession(root, api, { partitioned: true, limits });
  for (let i = 1; i <= 4; i++) await put(root, file(i));
  await assert.rejects(captureState(root, 0, limits), /STATE_LIMIT_EXCEEDED/);
  await session.checkpoint(); assert.equal(api.state.archive.fileCount, 4);
  await createStateSession(await workspace(t), api, { limits });
  const bulk = Array.from({ length: 10001 }, (_, n) => file(n + 1));
  const a = createArchiveShard(epoch, bulk.slice(0, 10000)), b = createArchiveShard(epoch, bulk.slice(10000));
  assert.equal(appendArchive(emptyArchive(epoch), [a.descriptor, b.descriptor]).fileCount, 10001);
  assert.throws(() => appendArchive(emptyArchive(epoch), [a.descriptor, b.descriptor], { ...ARCHIVE_LIMITS, files: 10000 }), /LIMIT_EXCEEDED/);
});

test('upload budgets and unsafe filesystem inputs fail without committing incomplete state', async t => {
  const api = backend(), root = await workspace(t), archiveLimits = { ...ARCHIVE_LIMITS, shardBytes: 1024, newShards: 1 };
  const session = await createStateSession(root, api, { partitioned: true, archiveLimits });
  await put(root, file(1, { x: 'x'.repeat(400) })); await put(root, file(2, { x: 'x'.repeat(400) }));
  await assert.rejects(session.checkpoint(), /CHECKPOINT_BATCH_EXCEEDED/); assert.equal(api.state, null); assert.equal(api.objects.size, 1);
  const linked = await workspace(t), second = await createStateSession(linked, backend(), { partitioned: true });
  await mkdir(dirname(join(linked, path(1))), { recursive: true });
  await symlink('/etc/passwd', join(linked, path(1))); await assert.rejects(second.checkpoint(), /UNSAFE_FILE/);
});

test('unconfirmed successful CAS is never retried and the next runner can recover the committed archive', async t => {
  const api = backend(), original = api.request.bind(api); let puts = 0;
  api.request = async (url, options) => {
    const result = await original(url, options);
    if (url === '/internal/state' && options?.method === 'PUT') { puts++; throw Error('HOSTED_REQUEST_UNCONFIRMED'); }
    return result;
  };
  const root = await workspace(t), session = await createStateSession(root, api, { partitioned: true }); await put(root, file(1));
  await assert.rejects(session.checkpoint(), /REQUEST_UNCONFIRMED/);
  assert.equal(api.state.revision, 1); assert.equal(api.state.archive.fileCount, 1);
  await assert.rejects(session.checkpoint(), /REQUEST_UNCONFIRMED/); assert.equal(puts, 1);
  api.request = original; const restored = await workspace(t); await createStateSession(restored, api);
  assert.equal((await readFile(join(restored, path(1)))).toString('base64'), file(1).content);
});

test('unverified object readback never advances the root checkpoint', async t => {
  const api = backend(), original = api.request.bind(api);
  api.request = async (url, options) => {
    const value = await original(url, options);
    if (url.includes('/objects/') && (!options?.method || options.method === 'GET')) value.files[0].content = file(2).content;
    return value;
  };
  const root = await workspace(t), session = await createStateSession(root, api, { partitioned: true }); await put(root, file(1));
  await assert.rejects(session.checkpoint(), /HASH_MISMATCH/); assert.equal(api.state, null);
  assert.equal(api.calls.filter(row => row.url === '/internal/state' && row.method === 'PUT').length, 0);
});

test('archive integrity covers the received serialization without requiring file order or object-key order', () => {
  const body = { epoch, files: [file(2), { content: file(1).content, path: file(1).path }], kind: 'state-archive-shard', version: 1 };
  const wire = JSON.stringify(body), descriptor = { fileCount: 2, decodedBytes: Buffer.from(file(1).content, 'base64').length + Buffer.from(file(2).content, 'base64').length,
    wireBytes: Buffer.byteLength(wire), sha256: archiveHash(wire) };
  assert.deepEqual(decodeArchiveShard(body, descriptor, epoch).map(row => row.path), [path(2), path(1)]);
});
