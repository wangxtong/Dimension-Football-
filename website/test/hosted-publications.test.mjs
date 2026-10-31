import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadHostedProtocolModule } from './helpers/hosted-protocol.mjs';
import { MAX_REPORT_BUNDLE_BYTES } from '../report-schema.mjs';
import { NOW, ORIGIN, sampleBundle, sampleReport } from './fixtures.mjs';
import { MemoryBucket, fakeKeys, machineRequest, stateFile } from './hosted-fixtures.mjs';

const { handleHostedRequest, loadHostedBundle, updateHostedReceipt } = await loadHostedProtocolModule('../../hosted-publications.mjs');

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function setup() {
  const env = { DASHBOARD_ORIGIN: ORIGIN, BUCKET: new MemoryBucket() }, { fetchImpl } = fakeKeys();
  const call = (path, options = {}) => handleHostedRequest(machineRequest(path, options), env, { fetchImpl, now: NOW });
  const publish = bundle => call('/internal/publications', { method: 'POST', body: bundle });
  return { env, call, publish };
}
async function expectError(promise, status, code) {
  const response = await promise;
  assert.equal(response.status, status, JSON.stringify(await response.clone().json()));
  if (code) assert.equal((await response.json()).error, code);
}

test('authenticated publication stores immutable content and serves exact hashed hosted identity', async () => {
  const { env, call, publish } = setup(), bundle = sampleBundle();
  assert.equal((await call('/internal/state')).status, 404);
  assert.equal((await call('/internal/report-status')).status, 404);
  assert.equal((await publish(bundle)).status, 200);
  const status = await (await call('/internal/report-status')).json();
  assert.deepEqual(status, { version: 1, reportId: bundle.reportId, reportHash: hash(bundle.report), generatedAt: bundle.report.generatedAt, mode: 'hosted', health: 'available' });
  const loaded = await loadHostedBundle(env, { now: NOW + 86400000 });
  assert.deepEqual(loaded.report, bundle.report);
  assert.equal(loaded.freshness.mode, 'hosted');
  assert.equal(loaded.health.status, 'available');
  assert.equal(loaded.report.generatedAt, bundle.report.generatedAt);
  assert.equal(env.BUCKET.rows.size, 3);
  assert.equal((await call('/internal/state')).headers.get('cache-control'), 'no-store, private');
});

test('visitor cookies cannot read or mutate machine state and unowned routes stay delegated', async () => {
  const { env } = setup();
  for (const [path, method] of [['/internal/publications', 'POST'], ['/internal/report-status', 'GET'], ['/internal/state', 'GET'], ['/internal/state', 'PUT']]) {
    const request = new Request(`${ORIGIN}${path}`, { method, headers: { cookie: 'session=valid-visitor' } });
    assert.equal((await handleHostedRequest(request, env, { now: NOW, fetchImpl: () => { throw Error('unexpected network'); } })).status, 401);
  }
  assert.equal(await handleHostedRequest(new Request(`${ORIGIN}/internal/notifications`, { method: 'POST' }), env), null);
  assert.equal(env.BUCKET.rows.size, 0);
});

test('simulated, mismatched, future, stale, malformed and over-budget reports preserve last good pointer', async () => {
  const { env, publish } = setup(), good = sampleBundle();
  await publish(good);
  const before = env.BUCKET.rows.get('publications/current.json');
  const simulated = sampleBundle(sampleReport('b')); simulated.report.simulated = true;
  const mismatch = sampleBundle(sampleReport('b')); mismatch.receipt.reportId = 'c'.repeat(64);
  const malformed = sampleBundle(sampleReport('b')); malformed.report.fixtures[0].forecast.probabilities.home = -1;
  for (const bad of [simulated, mismatch, malformed, sampleBundle(sampleReport('b', 61000))]) await expectError(publish(bad), 400);
  await expectError(publish(sampleBundle(sampleReport('b', -3600001))), 409, 'REPORT_STALE');
  const large = sampleBundle(sampleReport('b')); large.sourceData = { excessive: 'x'.repeat(MAX_REPORT_BUNDLE_BYTES) };
  await expectError(publish(large), 413, 'BODY_TOO_LARGE');
  const nearLimit = sampleBundle(sampleReport('b')); nearLimit.sourceData = { padding: '' };
  nearLimit.sourceData.padding = 'x'.repeat(MAX_REPORT_BUNDLE_BYTES - Buffer.byteLength(JSON.stringify(nearLimit)));
  await expectError(publish(nearLimit), 413, 'REPORT_BUNDLE_TOO_LARGE');
  const wrongHash = sampleBundle(sampleReport('b')); wrongHash.reportHash = 'e'.repeat(64);
  await expectError(publish(wrongHash), 409, 'PUBLICATION_CONTENT_CHANGED');
  const missingSource = sampleBundle(sampleReport('b')); missingSource.report.fixtures[0].fixture.source = 'openligadb';
  await expectError(publish(missingSource), 400, 'SOURCE_SNAPSHOT_REQUIRED');
  const wrongSource = sampleBundle(sampleReport('b'));
  wrongSource.sourceData = { openligadb: { reportId: good.reportId, attribution: { name: 'OpenLigaDB' }, fixtures: [], history: [] } };
  await expectError(publish(wrongSource), 400, 'SOURCE_REPORT_MISMATCH');
  assert.deepEqual(env.BUCKET.rows.get('publications/current.json'), before);
  assert.equal((await loadHostedBundle(env)).reportId, good.reportId);
});

test('same ID accepts receipt updates but refuses changed report or raw source snapshot', async () => {
  const { env, publish } = setup(), bundle = sampleBundle();
  bundle.sourceData = { provider: { rows: [1] } };
  assert.equal((await publish(bundle)).status, 200);
  const changed = structuredClone(bundle); changed.report.backtests[0].evaluated++;
  await expectError(publish(changed), 409, 'IMMUTABLE_REPORT_CONFLICT');
  const changedSource = structuredClone(bundle); changedSource.sourceData.provider.rows = [2];
  await expectError(publish(changedSource), 409, 'IMMUTABLE_REPORT_CONFLICT');
  bundle.receipt.channels.externalWebsite = { status: 'published', servedVerified: true, reportId: bundle.reportId,
    reportHash: hash(bundle.report), mode: 'hosted', checkedAt: new Date(NOW).toISOString() };
  assert.equal((await publish(bundle)).status, 200);
  assert.equal((await loadHostedBundle(env)).receipt.channels.externalWebsite.servedVerified, true);
});

test('concurrent old and new publication CAS cannot roll the pointer backwards', async () => {
  const { env, publish } = setup();
  let release, arrived;
  const pause = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  let held = false;
  env.BUCKET.beforePut = async (key, text) => {
    if (key === 'publications/current.json' && JSON.parse(text).reportId === 'a'.repeat(64) && !held) {
      held = true; arrived(); await pause;
    }
  };
  const older = publish(sampleBundle(sampleReport('a', -1000)));
  await waiting;
  assert.equal((await publish(sampleBundle(sampleReport('b')))).status, 200);
  release();
  await expectError(older, 409, 'REPORT_ORDER_CONFLICT');
  assert.equal((await loadHostedBundle(env)).reportId, 'b'.repeat(64));
});

test('late receipt merges retain accepted/unknown notifications and never move current report', async () => {
  const { env, publish } = setup(), older = sampleBundle(sampleReport('a', -1000));
  await publish(older);
  const accepted = structuredClone(older.receipt);
  accepted.channels.notifications = { status: 'accepted', checkedAt: new Date(NOW - 200).toISOString(), messageId: 'offline-message' };
  await updateHostedReceipt(env, accepted);
  await publish(sampleBundle(sampleReport('b')));
  const retry = structuredClone(older.receipt); retry.channels.notifications = { status: 'failed', checkedAt: new Date(NOW).toISOString() };
  const merged = await updateHostedReceipt(env, retry);
  assert.equal(merged.channels.notifications.status, 'accepted');
  assert.equal(merged.channels.notifications.messageId, 'offline-message');
  assert.equal((await loadHostedBundle(env)).reportId, 'b'.repeat(64));
  const current = (await loadHostedBundle(env)).receipt;
  current.channels.notifications = { status: 'unknown', checkedAt: new Date(NOW).toISOString() };
  await updateHostedReceipt(env, current);
  current.channels.notifications = { status: 'not_attempted', checkedAt: new Date(NOW + 1).toISOString() };
  assert.equal((await updateHostedReceipt(env, current)).channels.notifications.status, 'unknown');
  current.channels.notifications = { status: 'accepted', checkedAt: new Date(NOW - 500).toISOString(), messageId: 'confirmed-before-observation' };
  assert.equal((await updateHostedReceipt(env, current)).channels.notifications.status, 'accepted');
});

test('receipt CAS races merge independent updates and fail closed after bounded contention', async () => {
  const { env, publish } = setup(), bundle = sampleBundle();
  await publish(bundle);
  let race = true;
  env.BUCKET.beforePut = async (key) => {
    if (key === `receipts/${bundle.reportId}.json` && race) {
      race = false;
      const other = structuredClone(bundle.receipt);
      other.channels.notifications = { status: 'accepted', checkedAt: new Date(NOW).toISOString() };
      await updateHostedReceipt(env, other);
    }
  };
  bundle.receipt.channels.externalWebsite = { status: 'published', servedVerified: true, checkedAt: new Date(NOW).toISOString() };
  const merged = await updateHostedReceipt(env, bundle.receipt);
  assert.equal(merged.channels.notifications.status, 'accepted');
  assert.equal(merged.channels.externalWebsite.servedVerified, true);
  env.BUCKET.beforePut = async key => {
    if (key.startsWith('receipts/')) env.BUCKET.rows.get(key).etag = `conflict-${++env.BUCKET.sequence}`;
  };
  await assert.rejects(updateHostedReceipt(env, bundle.receipt), { code: 'HOSTED_RECEIPT_CONFLICT' });
});

test('current pointer and immutable content are reverified on every read', async () => {
  const { env, publish } = setup(), bundle = sampleBundle();
  await publish(bundle);
  const key = `reports/${bundle.reportId}.json`, original = env.BUCKET.rows.get(key).text;
  const tampered = JSON.parse(original); tampered.content.report.fixtures[0].fixture.home = 'tampered';
  env.BUCKET.rows.get(key).text = JSON.stringify(tampered);
  await assert.rejects(loadHostedBundle(env), { code: 'HOSTED_STORAGE_CORRUPT' });
  env.BUCKET.rows.get(key).text = original;
  const pointer = env.BUCKET.json('publications/current.json'); pointer.reportHash = 'f'.repeat(64);
  env.BUCKET.rows.get('publications/current.json').text = JSON.stringify(pointer);
  await assert.rejects(loadHostedBundle(env), { code: 'HOSTED_STORAGE_CORRUPT' });
});

test('state initializes revision one, preserves exact files and rejects lost updates via ETag CAS', async () => {
  const { env, call } = setup();
  const files = [stateFile('state/state.json', { rows: [] }), stateFile('state/state.json.history.json', []),
    stateFile('state/hosted-scheduler.json', { lastRun: NOW }), stateFile(`reports/forecast-ledger/${'a'.repeat(64)}/scores/${'b'.repeat(64)}.json`, { score: .7 })];
  assert.deepEqual(await (await call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files } })).json(), { revision: 1 });
  assert.deepEqual(await (await call('/internal/state')).json(), { revision: 1, files });
  await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files: [] } }), 409, 'STATE_REVISION_CONFLICT');
  const replies = await Promise.all([1, 2].map(n => call('/internal/state', { method: 'PUT', body: { expectedRevision: 1, files: [stateFile('state/state.json', { n })] } })));
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
  assert.equal(env.BUCKET.json('checkpoints/state.json').revision, 2);
});

test('state rejects traversal, secrets, symlinks, lock files, noncanonical base64, invalid JSON and extra snapshots', async () => {
  const { call } = setup();
  for (const path of ['../state/x.json', '/state/x.json', 'state//x.json', 'state/../x.json', 'state\\x.json',
    'state/.env.json', 'state/api-token.json', 'state/secrets.json', 'state/state.lock.json', 'reports/latest.json',
    'reports/outbox.json', 'reports/collection.json', 'reports/.delivery/reports/../content.json']) {
    await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files: [stateFile(path, {})] } }), 400, 'STATE_FILE_INVALID');
  }
  const good = stateFile('state/state.json', {});
  for (const files of [[{ ...good, target: '/secret' }], [good, good], [{ ...good, content: 'e30' }], [{ ...good, content: 'e31=' }],
    [{ ...good, content: Buffer.from('not json').toString('base64') }], [stateFile(`reports/.delivery/reports/${'a'.repeat(64)}/content.json`, {})]]) {
    await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files } }), 400);
  }
  await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files: Array(10001).fill(good) } }), 400, 'STATE_FILES_INVALID');
  for (const expectedRevision of [null, '0', -1, 1.5, Number.MAX_SAFE_INTEGER]) {
    await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision, files: [] } }), 400, 'STATE_REVISION_INVALID');
  }
  await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files: [] },
    headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }), 413, 'BODY_TOO_LARGE');
});

test('restored publication snapshot validates hashes and bindings without excluded collection outputs', async () => {
  const { call } = setup(), bundle = sampleBundle();
  const content = { version: 1, reportId: bundle.reportId, report: bundle.report, sourceData: {} };
  const pointer = { version: 1, reportId: bundle.reportId, generatedAt: bundle.report.generatedAt, contentHash: hash(content), reportHash: hash(bundle.report) };
  const files = [stateFile('reports/.delivery/current.json', pointer), stateFile(`reports/.delivery/reports/${bundle.reportId}/content.json`, content),
    stateFile(`reports/.delivery/reports/${bundle.reportId}/receipt.json`, bundle.receipt)];
  assert.equal((await call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files } })).status, 200);
  pointer.reportHash = 'd'.repeat(64); files[0] = stateFile('reports/.delivery/current.json', pointer);
  await expectError(call('/internal/state', { method: 'PUT', body: { expectedRevision: 1, files } }), 400, 'STATE_PUBLICATION_INVALID');
  assert.equal((await (await call('/internal/state')).json()).revision, 1);
});

test('large state JSON and prospective opportunity records round-trip without regex stack exhaustion', async () => {
  const { call } = setup();
  const files = [stateFile('state/state.json', { evidence: 'x'.repeat(1024 * 1024) }),
    stateFile(`reports/forecast-ledger/${'a'.repeat(64)}/opportunities/${'b'.repeat(64)}.json`, { eligible: false })];
  assert.deepEqual(await (await call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files } })).json(), { revision: 1 });
  assert.deepEqual(await (await call('/internal/state')).json(), { revision: 1, files });
});
