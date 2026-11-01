import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { MemoryBucket, fakeKeys, machineRequest, stateFile } from './hosted-fixtures.mjs';
import { NOW, ORIGIN, sampleBundle } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url)), STATE = 'checkpoints/state.json';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const epoch = hash({ version: 1, kind: 'state-archive-epoch', origin: ORIGIN, baseRevision: 1 });
let output, createDashboard;
before(async () => {
  output = await mkdtemp(join(tmpdir(), 'dimension-state-archive-build-'));
  await promisify(execFile)(process.execPath, [join(root, 'website/build.mjs'), output], { cwd: root });
  const source = await readFile(join(output, 'server/index.js'), 'utf8');
  assert.ok(!/^import\s/m.test(source), 'Actual production artifact resolves every dependency');
  assert.ok(!/registerHooks|hosted-protocol|helpers\/release/.test(source), 'Production artifact contains no gate bypass');
  ({ createDashboard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

class Bucket extends MemoryBucket {
  reads = []; activeReads = 0; peakReads = 0;
  async get(key) {
    this.activeReads++; this.peakReads = Math.max(this.peakReads, this.activeReads); this.reads.push(key);
    try { await Promise.resolve(); return await super.get(key); } finally { this.activeReads--; }
  }
  async head(key) { const row = this.rows.get(key); return row ? { etag: row.etag, customMetadata: row.metadata } : null; }
  async put(key, text, options) {
    const result = await super.put(key, text, options);
    if (result) this.rows.get(key).metadata = options?.customMetadata;
    return result;
  }
}
function setup() {
  const env = { DASHBOARD_ORIGIN: ORIGIN, HOSTED_PUBLICATION_ENABLED: 'true', BUCKET: new Bucket(),
    DASHBOARD_SESSION_SECRET: 'ab'.repeat(32), DASHBOARD_AUTH: JSON.stringify({ username: 'offline', iterations: 100000, salt: 'ab'.repeat(16), hash: 'cd'.repeat(32) }) };
  const { fetchImpl } = fakeKeys(), worker = createDashboard({}, { clock: () => NOW, fetchImpl });
  return { env, call: (path, options) => worker.fetch(machineRequest(path, options), env) };
}

test('actual built Worker migrates a 31 MiB legacy checkpoint using sequential verified shards, then restores every byte', async () => {
  const { env, call } = setup();
  const files = Array.from({ length: 24 }, (_, n) => stateFile(`reports/forecast-ledger/${'a'.repeat(64)}/predictions/${n.toString(16).padStart(64, '0')}.json`,
    { n, evidence: 'x'.repeat(1040000) }));
  const input = { expectedRevision: 0, files }, wireBytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(wireBytes > 31 * 1024 * 1024 && wireBytes < 32 * 1024 * 1024, `Legacy payload ${wireBytes} bytes`);
  assert.deepEqual(await (await call('/internal/state', { method: 'PUT', body: input })).json(), { revision: 1 });
  const shards = [];
  for (let offset = 0; offset < files.length; offset += 3) {
    const body = { version: 1, kind: 'state-archive-shard', epoch, files: files.slice(offset, offset + 3) };
    const response = await call(`/internal/state/objects/${epoch}/${hash(body)}`, { method: 'PUT', body });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const { version, epoch: receivedEpoch, ...descriptor } = await response.json();
    assert.equal(version, 1); assert.equal(receivedEpoch, epoch); shards.push(descriptor);
  }
  const archive = { version: 1, epoch, shards, fileCount: files.length, decodedBytes: shards.reduce((n, s) => n + s.decodedBytes, 0) };
  env.BUCKET.reads = []; env.BUCKET.peakReads = 0;
  const committed = await call('/internal/state', { method: 'PUT', body: { version: 2, expectedRevision: 1, files: [], archive } });
  assert.deepEqual(await committed.json(), { revision: 2 });
  assert.equal(env.BUCKET.peakReads, 1, 'The Worker never reads multiple 4 MiB objects concurrently');
  assert.deepEqual(env.BUCKET.reads.filter(key => key.startsWith('checkpoints/objects/')), shards.map(s => `checkpoints/objects/${epoch}/${s.sha256}.json`));
  const state = await (await call('/internal/state')).json();
  assert.ok(Buffer.byteLength(JSON.stringify(state)) < 5000, 'Checkpoint now carries bounded descriptors instead of archive bodies');
  let restoredFiles = 0, restoredBytes = 0;
  for (const descriptor of state.archive.shards) {
    const response = await call(`/internal/state/objects/${epoch}/${descriptor.sha256}`), body = await response.json();
    assert.equal(response.status, 200); assert.equal(hash(body), descriptor.sha256);
    for (const file of body.files) { assert.deepEqual(file, files[restoredFiles++]); restoredBytes += Buffer.from(file.content, 'base64').length; }
  }
  assert.equal(restoredFiles, 24); assert.equal(restoredBytes, archive.decodedBytes);
  // A hot-only collection checkpoint need not reread every old immutable shard.
  env.BUCKET.reads = [];
  assert.equal((await call('/internal/state', { method: 'PUT', body: { version: 2, expectedRevision: 2,
    files: [stateFile('state/hosted-observation.json', { checkedAt: new Date(NOW).toISOString() })], archive } })).status, 200);
  assert.equal(env.BUCKET.reads.some(key => key.startsWith('checkpoints/objects/')), false);
  assert.equal(env.BUCKET.json(STATE).revision, 3);
});

test('built archive routes keep machine identity separate from cookies and formal forecast publication blocked', async () => {
  const { env, call } = setup(), objectPath = `/internal/state/objects/${epoch}/${'b'.repeat(64)}`;
  for (const path of ['/internal/state', objectPath]) {
    const response = await call(path, { headers: { authorization: '', cookie: '__Host-dimension_session=visitor' } });
    assert.equal(response.status, 401); assert.match(response.headers.get('cache-control'), /no-store/);
  }
  const blocked = await call('/internal/publications', { method: 'POST', body: sampleBundle() });
  assert.equal(blocked.status, 409); assert.deepEqual(await blocked.json(), { error: 'RELEASE_GATE_BLOCKED' });
  assert.equal(env.BUCKET.rows.size, 0);
});
