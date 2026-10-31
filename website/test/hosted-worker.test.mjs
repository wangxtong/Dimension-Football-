import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pbkdf2Sync, createHash } from 'node:crypto';
import { loadReportBundle } from '../../collector/report-store.mjs';
import { NOW, ORIGIN, sampleBundle } from './fixtures.mjs';
import { MemoryBucket, fakeKeys, machineRequest, stateFile, token } from './hosted-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const password = 'offline-built-worker-password', salt = 'a1'.repeat(16);
const auth = { username: 'offline-viewer', iterations: 100000, salt,
  hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex') };
let output, createDashboard, assets;
before(async () => {
  output = await mkdtemp(join(tmpdir(), 'dimension-hosted-build-'));
  await promisify(execFile)(process.execPath, [join(root, 'website/build.mjs'), output], { cwd: root });
  const source = await readFile(join(output, 'server/index.js'), 'utf8');
  const prefix = 'const EMBEDDED_ASSETS = ';
  assert.ok(source.startsWith(prefix));
  assert.ok(!/^import\s/m.test(source), 'The deployable Worker must have no unresolved local imports');
  assets = JSON.parse(source.slice(prefix.length, source.indexOf(';\n')));
  ({ createDashboard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  const manifest = JSON.parse(await readFile(join(output, '.openai/hosting.json'), 'utf8'));
  assert.equal(manifest.r2, 'BUCKET');
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

function setup(now = NOW) {
  const env = { DASHBOARD_AUTH: JSON.stringify(auth), DASHBOARD_SESSION_SECRET: 'a2'.repeat(32), DASHBOARD_ORIGIN: ORIGIN,
    HOSTED_PUBLICATION_ENABLED: 'true', BUCKET: new MemoryBucket(), REPORTS_PROBE_TOKEN: 'c3'.repeat(32) };
  const keys = fakeKeys();
  const app = createDashboard(assets, { clock: () => now, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://token.actions.githubusercontent.com/.well-known/jwks', 'No report or notification may use real network access in this test');
    return keys.fetchImpl(url, init);
  } });
  const call = (path, options = {}) => app.fetch(machineRequest(path, { bearer: token({ iat: Math.floor(now / 1000) - 1,
    nbf: Math.floor(now / 1000) - 1, exp: Math.floor(now / 1000) + 299 }), ...options }), env);
  const publish = bundle => call('/internal/publications', { method: 'POST', body: bundle });
  const visit = (path, cookie, headers = {}) => app.fetch(new Request(`${ORIGIN}${path}`, { headers: { ...(cookie ? { cookie } : {}), ...headers } }), env);
  const login = async () => {
    const response = await app.fetch(new Request(`${ORIGIN}/login`, { method: 'POST', headers: { origin: ORIGIN,
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: auth.username, password }) }), env);
    assert.equal(response.status, 303);
    return response.headers.get('set-cookie').split(';')[0];
  };
  return { env, app, keys, call, publish, visit, login };
}
async function seedExisting(env, bundle) {
  // An already persisted snapshot is a read fixture, never a publication-gate bypass.
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const content = { version: 1, reportId: bundle.reportId, report: bundle.report, sourceData: bundle.sourceData || {} };
  const pointer = { version: 1, reportId: bundle.reportId, contentHash: hash(content), reportHash: hash(content.report), generatedAt: content.report.generatedAt };
  await env.BUCKET.put(`reports/${bundle.reportId}.json`, JSON.stringify({ content, contentHash: pointer.contentHash, reportHash: pointer.reportHash, initialReceipt: bundle.receipt }));
  await env.BUCKET.put(`receipts/${bundle.reportId}.json`, JSON.stringify(bundle.receipt));
  await env.BUCKET.put('publications/current.json', JSON.stringify(pointer));
}

test('built Worker blocks forecast writes while existing hashed reports remain readable only to authenticated visitors', async () => {
  const { env, publish, call, visit, login } = setup(), bundle = sampleBundle();
  bundle.sourceData = { openligadb: { reportId: bundle.reportId, attribution: { name: 'OpenLigaDB' }, fixtures: [], history: [] } };
  const rejected = await publish(bundle); assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), { error: 'RELEASE_GATE_BLOCKED' }); assert.equal(env.BUCKET.rows.size, 0);
  await seedExisting(env, bundle);
  const status = await (await call('/internal/report-status')).json();
  assert.equal(status.reportId, bundle.reportId); assert.equal(status.mode, 'hosted'); assert.equal(status.health, 'available');
  assert.equal((await visit('/api/report')).status, 401);
  assert.equal((await call('/api/report')).status, 401, 'Actions bearer cannot become a visitor session');
  const cookie = await login(), api = await visit('/api/report', cookie), served = await api.json();
  assert.equal(api.status, 200); assert.equal(api.headers.get('x-report-id'), bundle.reportId);
  assert.equal(served.reportHash, status.reportHash); assert.equal(served.freshness.mode, 'hosted'); assert.equal(served.health.status, 'available');
  assert.deepEqual(served.report, bundle.report);
  assert.deepEqual(await (await visit('/api/openligadb-fixtures.json', cookie)).json(), bundle.sourceData.openligadb);
  env.RELEASE_GATE = 'GREEN'; bundle.releaseGate = { status: 'GREEN', verified: true };
  assert.equal((await publish(bundle)).status, 409);
  assert.deepEqual(await (await visit('/api/publication.json', cookie)).json(), bundle.receipt);
  assert.equal(env.BUCKET.rows.size, 3);
});

test('built Worker keeps machine OIDC, legacy probes and login cookies isolated and restores state by revision', async () => {
  const { call, visit, login } = setup(), cookie = await login();
  for (const path of ['/internal/report-status', '/internal/state']) {
    assert.equal((await visit(path, cookie)).status, 401);
    assert.equal((await visit(path, null, { authorization: `Bearer ${'c3'.repeat(32)}` })).status, 401);
  }
  assert.equal((await call('/internal/state', { bearer: token({ workflow_ref: 'wrong-workflow' }) })).status, 401);
  assert.equal((await call('/internal/notifications', { method: 'POST', body: { reportId: 'a'.repeat(64) }, headers: { authorization: '', cookie } })).status, 401);
  assert.equal((await call('/internal/state')).status, 404);
  const files = [stateFile('state/hosted-scheduler.json', { hour: '2026-10-31T12' }),
    stateFile('reports/public-source-fixtures.json', { sources: [], fixtures: [], history: [] })];
  assert.deepEqual(await (await call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files } })).json(), { revision: 1 });
  assert.deepEqual(await (await call('/internal/state')).json(), { revision: 1, files });
  assert.equal((await call('/internal/state', { method: 'PUT', body: { expectedRevision: 0, files } })).status, 409);
});

test('built notification route cannot turn OIDC or a claimed GREEN flag into forecast release authority', async () => {
  const { env, call, keys } = setup(); env.RELEASE_GATE = 'GREEN';
  const reply = await call('/internal/notifications', { method: 'POST', body: { reportId: 'a'.repeat(64), releaseGate: 'GREEN' } });
  assert.equal(reply.status, 409); assert.deepEqual(await reply.json(), { error: 'RELEASE_GATE_BLOCKED' });
  assert.equal(env.BUCKET.rows.size, 0, 'The release gate runs before notification claims or receipt writes');
  assert.equal(keys.calls.length, 1, 'Only synthetic JWKS retrieval ran; Telegram was not called');
});

test('built feed labels bootstrap fallback after R2 corruption and never reports fallback as hosted availability', async () => {
  const { env, call, visit, login } = setup(), bundle = sampleBundle();
  await seedExisting(env, bundle);
  env.BUCKET.rows.get(`reports/${bundle.reportId}.json`).text = '{}';
  const cookie = await login();
  assert.equal((await call('/internal/report-status')).status, 503);
  assert.equal((await visit('/api/report', cookie)).status, 502);
  env.DASHBOARD_BOOTSTRAP_REPORT = JSON.stringify(bundle);
  const fallback = await (await visit('/api/report', cookie)).json();
  assert.equal(fallback.reportId, bundle.reportId); assert.equal(fallback.freshness.mode, 'bootstrap');
  assert.equal(fallback.health.status, 'upstream_unavailable'); assert.equal(fallback.report.generatedAt, bundle.report.generatedAt);
  assert.equal((await call('/internal/report-status')).status, 503);
});

test('built observations publish a redacted schedule with one independently hashed projection identity', async () => {
  const { env, call, login, visit } = setup(), bundle = sampleBundle();
  const publication = await call('/internal/observations', { method: 'POST', body: bundle });
  assert.equal(publication.status, 200); const expected = await publication.json();
  assert.notEqual(expected.reportId, bundle.reportId); assert.equal(expected.originReportId, bundle.reportId); assert.equal(expected.forecastPublished, false);
  const cookie = await login(), sequence = env.BUCKET.sequence;
  const before = await (await visit('/api/publication.json', cookie)).json();
  assert.equal(before.channels.externalWebsite.status, 'not_attempted');
  await visit('/api/report', cookie);
  assert.equal(env.BUCKET.sequence, sequence, 'Ordinary visitor reads must not write a machine verification receipt');
  assert.deepEqual(await (await call('/internal/report-status')).json(), expected);
  const served = await (await visit('/api/report', cookie)).json();
  assert.equal(served.reportHash, expected.reportHash); assert.equal(served.report.generatedAt, bundle.report.generatedAt);
  assert.equal(served.receipt.reportId, expected.reportId); assert.equal(served.receipt.channels.notifications.code, 'RELEASE_GATE_BLOCKED');
  assert.equal(served.receipt.channels.externalWebsite.status, 'published');
  assert.equal(served.receipt.channels.externalWebsite.reportHash, expected.reportHash); assert.equal(served.receipt.channels.externalWebsite.servedVerified, true);
  assert.equal(served.receipt.channels.externalWebsite.meaning, 'machine-readback-not-user-read');
  assert.ok(served.report.fixtures.every(row => row.forecast.status === 'unavailable' && row.marketCandidate.candidate === null));
});

test('observations may redact the exact current report at its original timestamp without renewing it', async () => {
  const { env, call, visit, login } = setup(), bundle = sampleBundle();
  await seedExisting(env, bundle);
  const response = await call('/internal/observations', { method: 'POST', body: bundle });
  assert.equal(response.status, 200);
  const projected = await response.json(); assert.equal(projected.generatedAt, bundle.report.generatedAt);
  const served = await (await visit('/api/report', await login())).json();
  assert.equal(served.originReportId, bundle.reportId); assert.equal(served.report.summary.forecasts, 0);
});

test('built Worker blocks actual collector forecasts but permits their redacted acquisition projection', { skip: !process.env.HOSTED_TEST_REPORT_DIRECTORY }, async () => {
  const bundle = await loadReportBundle(process.env.HOSTED_TEST_REPORT_DIRECTORY);
  assert.equal(bundle.sourceData.openligadb.reportId, bundle.reportId);
  const { publish, call, login, visit } = setup(Date.parse(bundle.report.generatedAt) + 1000);
  const publication = await publish(bundle);
  assert.equal(publication.status, 409); assert.equal((await publication.json()).error, 'RELEASE_GATE_BLOCKED');
  const observation = await call('/internal/observations', { method: 'POST', body: bundle });
  assert.equal(observation.status, 200, JSON.stringify(await observation.clone().json()));
  const projected = await observation.json();
  const status = await (await call('/internal/report-status')).json();
  assert.equal(status.originReportId, bundle.reportId); assert.deepEqual(status, projected);
  const served = await (await visit('/api/report', await login())).json();
  assert.equal(served.reportHash, projected.reportHash); assert.equal(served.report.summary.forecasts, 0);
  assert.equal(served.report.summary.strictCandidates, 0); assert.equal(served.report.generatedAt, bundle.report.generatedAt);
  assert.equal(served.sourceData.openligadb.reportId, projected.reportId); assert.deepEqual(served.sourceData.openligadb.history, []);
});
