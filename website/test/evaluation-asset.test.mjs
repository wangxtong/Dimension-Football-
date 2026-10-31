import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { dataHash } from '../../collector/data/identity.mjs';
import { NOW, ORIGIN } from './fixtures.mjs';
import { token } from './hosted-fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const path = '/evaluation-evidence.json';
const password = 'offline-evaluation-asset-password', salt = 'a1'.repeat(16);
const auth = { username: 'evaluation-viewer', iterations: 100000, salt,
  hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex') };
const sha256 = value => createHash('sha256').update(value).digest('hex');
let output, createDashboard, assets, sourceAsset;
before(async () => {
  output = await mkdtemp(join(tmpdir(), 'dimension-evaluation-asset-'));
  await promisify(execFile)(process.execPath, [join(root, 'website/build.mjs'), output], { cwd: root });
  const source = await readFile(join(output, 'server/index.js'), 'utf8'), prefix = 'const EMBEDDED_ASSETS = ';
  assert.ok(source.startsWith(prefix)); assert.ok(!/^import\s/m.test(source));
  assets = JSON.parse(source.slice(prefix.length, source.indexOf(';\n')));
  sourceAsset = await readFile(join(root, 'website/evaluation-evidence.json'), 'utf8');
  assert.equal(assets[path], sourceAsset, 'The actual deployable Worker must embed the reviewed JSON bytes unchanged');
  ({ createDashboard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
});
after(async () => { if (output) await rm(output, { recursive: true, force: true }); });

function setup() {
  const clock = { now: NOW }, env = { DASHBOARD_AUTH: JSON.stringify(auth), DASHBOARD_SESSION_SECRET: 'a2'.repeat(32),
    DASHBOARD_ORIGIN: ORIGIN, HOSTED_PUBLICATION_ENABLED: 'true' };
  const app = createDashboard(assets, { clock: () => clock.now, fetchImpl: () => { throw Error('The embedded evidence route must not request external data'); } });
  const request = (route = path, { headers = {}, ...options } = {}) => app.fetch(new Request(`${ORIGIN}${route}`, { ...options, headers }), env);
  const login = async () => {
    const reply = await request('/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: auth.username, password }) });
    assert.equal(reply.status, 303);
    assert.match(reply.headers.get('set-cookie'), /; Secure; HttpOnly; SameSite=Lax;/);
    return reply.headers.get('set-cookie').split(';')[0];
  };
  return { env, clock, request, login };
}
function privateHeaders(reply) {
  const control = reply.headers.get('cache-control');
  assert.match(control, /\bprivate\b/); assert.match(control, /\bno-store\b/); assert.match(control, /\bmax-age=0\b/);
  assert.ok(!/\bpublic\b|s-maxage\s*=/.test(control));
  assert.equal(reply.headers.get('vary'), 'Cookie'); assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(reply.headers.get('access-control-allow-origin'), null);
}

test('built historical evidence requires a valid visitor session for GET and HEAD, including query and bearer requests', async () => {
  const { request } = setup();
  for (const options of [{}, { method: 'HEAD' }, { headers: { authorization: `Bearer ${token()}` } },
    { headers: { cookie: '__Host-dimension_session=forged' } }, { headers: { origin: 'https://untrusted.example' } }]) {
    const reply = await request(`${path}?view=analysis&cache=public`, options);
    assert.equal(reply.status, 401); privateHeaders(reply);
    const text = await reply.text();
    assert.ok(!text.includes('historical-evaluation-evidence')); assert.ok(!text.includes(JSON.parse(sourceAsset).binding.reportId));
  }
});

test('authenticated evidence has exact JSON bytes, JSON MIME and private cache controls; HEAD never returns the body', async () => {
  const { request, login } = setup(), cookie = await login();
  const reply = await request(path, { headers: { cookie } });
  assert.equal(reply.status, 200); assert.equal(reply.headers.get('content-type'), 'application/json; charset=utf-8'); privateHeaders(reply);
  const text = await reply.text(); assert.equal(text, sourceAsset); assert.equal(sha256(text), sha256(sourceAsset));
  const head = await request(path, { method: 'HEAD', headers: { cookie } });
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-type'), 'application/json; charset=utf-8');
  privateHeaders(head); assert.equal(await head.text(), '');
});

test('a previous authenticated response cannot authorize a subsequent anonymous or conditional request', async () => {
  const { request, login } = setup(), cookie = await login();
  assert.equal((await request(path, { headers: { cookie } })).status, 200);
  for (const headers of [{}, { 'if-none-match': '"previous-private-response"' }, { 'if-modified-since': 'Sat, 31 Oct 2026 12:00:00 GMT' },
    { 'cache-control': 'public, max-age=3600', range: 'bytes=0-255' }]) {
    const reply = await request(path, { headers });
    assert.equal(reply.status, 401); privateHeaders(reply); assert.ok(!(await reply.text()).includes('binding'));
  }
  const logout = await request('/logout', { method: 'POST', headers: { cookie, origin: ORIGIN } });
  assert.equal(logout.status, 303); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request()).status, 401);
});

test('expired, tampered, duplicate and credential-rotated sessions cannot read the new evidence asset', async () => {
  const { env, clock, request, login } = setup(), cookie = await login();
  assert.equal((await request(path, { headers: { cookie } })).status, 200);
  for (const invalid of [cookie.slice(0, -5) + 'abcde', `${cookie}; ${cookie}`]) {
    assert.equal((await request(path, { headers: { cookie: invalid } })).status, 401);
  }
  clock.now = NOW + 43200000;
  assert.equal((await request(path, { headers: { cookie } })).status, 401);
  clock.now = NOW;
  env.DASHBOARD_AUTH = JSON.stringify({ ...auth, hash: 'b3'.repeat(32) });
  assert.equal((await request(path, { headers: { cookie } })).status, 401);
  env.DASHBOARD_AUTH = JSON.stringify(auth); env.DASHBOARD_SESSION_SECRET = 'c4'.repeat(32);
  assert.equal((await request(path, { headers: { cookie } })).status, 401);
});

test('authenticated evidence retains inspectable provenance and historical limitations without current predictions', async () => {
  const { request, login } = setup(), cookie = await login();
  const evidence = await (await request(path, { headers: { cookie } })).json();
  assert.equal(evidence.kind, 'historical-evaluation-evidence'); assert.equal(evidence.historicalOnly, true);
  assert.equal(evidence.releaseGate, 'BLOCKED'); assert.equal(evidence.canRelease, false); assert.equal(evidence.model.calibrated, false);
  for (const key of ['reportId', 'manifestHash', 'inputsHash', 'modelHash', 'reportSha256', 'documentSha256', 'backtestsSha256']) {
    assert.match(evidence.binding[key], /^[a-f0-9]{64}$/, key);
  }
  assert.match(evidence.binding.codeVersion, /^[a-f0-9]{40}$/); assert.match(evidence.binding.hashEncoding, /source files: UTF-8 bytes/);
  assert.match(evidence.binding.hashEncoding, /manifest: canonical JSON/);
  assert.ok(Date.parse(evidence.generatedAt) <= Date.parse(evidence.exportedAt));
  assert.ok(evidence.limitations.length > 0); assert.deepEqual(evidence.improvement.series, []);
  const inspect = value => {
    if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.ok(!['probabilities', 'fixtures', 'selection', 'candidates', 'recommendations'].includes(key), `Unexpected live prediction field: ${key}`);
      inspect(child);
    }
  };
  inspect(evidence);
  for (const group of evidence.groups) {
    assert.match(group.evaluationSetHash, /^[a-f0-9]{64}$/); assert.match(group.detailsHash, /^[a-f0-9]{64}$/);
  }
});

test('built evidence hashes independently match the preserved original collector files', { skip: !process.env.EVALUATION_TEST_REPORT_DIRECTORY }, async () => {
  const { request, login } = setup(), cookie = await login();
  const evidence = await (await request(path, { headers: { cookie } })).json(), directory = process.env.EVALUATION_TEST_REPORT_DIRECTORY;
  const [reportText, documentText, manifestText, inputsText] = await Promise.all([
    'latest.json', 'predictions.json', 'run-manifest.json', `replays/${evidence.binding.reportId}/run-inputs.json`,
  ].map(file => readFile(join(directory, file), 'utf8')));
  const report = JSON.parse(reportText), document = JSON.parse(documentText), manifest = JSON.parse(manifestText), inputs = JSON.parse(inputsText);
  assert.equal(sha256(reportText), evidence.binding.reportSha256); assert.equal(sha256(documentText), evidence.binding.documentSha256);
  const { manifestHash, ...manifestBody } = manifest;
  assert.equal(dataHash(manifestBody), manifestHash); assert.equal(manifestHash, evidence.binding.manifestHash);
  assert.equal(dataHash(inputs), evidence.binding.inputsHash); assert.equal(dataHash(report.forecasts.model), evidence.binding.modelHash);
  assert.equal(sha256(JSON.stringify(report.forecasts.backtests)), evidence.binding.backtestsSha256);
  for (const reportId of [report.publication.reportId, document.publication.reportId, manifest.reportId, inputs.reportId]) assert.equal(reportId, evidence.binding.reportId);
  assert.equal(manifest.codeVersion, evidence.binding.codeVersion); assert.equal(manifest.generatedAt, evidence.generatedAt);
  for (const group of evidence.groups) {
    const original = report.forecasts.backtests.find(row => row.source === group.source && row.league === group.league
      && row.horizonHours === group.horizonHours && row.visibility === group.visibility && row.purpose === group.purpose);
    assert.ok(original); assert.equal(sha256(JSON.stringify(original)), group.detailsHash);
    assert.equal(dataHash(original.evaluations.map(row => [row.source, row.fixtureId, row.kickoff, row.actual])), group.evaluationSetHash);
  }
});
