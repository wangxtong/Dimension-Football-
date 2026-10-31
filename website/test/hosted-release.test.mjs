import test from 'node:test';
import assert from 'node:assert/strict';
import { requireHostedForecastRelease } from '../release-policy.mjs';
import { handleHostedRequest, loadHostedBundle } from '../hosted-publications.mjs';
import { NOW, ORIGIN, sampleBundle, sampleReport } from './fixtures.mjs';
import { MemoryBucket, fakeKeys, machineRequest } from './hosted-fixtures.mjs';

function setup() {
  const env = { DASHBOARD_ORIGIN: ORIGIN, BUCKET: new MemoryBucket() }, { fetchImpl } = fakeKeys();
  const call = (path, body) => handleHostedRequest(machineRequest(path, { method: body ? 'POST' : 'GET', body }), env, { fetchImpl, now: NOW });
  return { env, call, observe: bundle => call('/internal/observations', bundle) };
}

test('production forecast release cannot be opened by caller JSON, environment, authentication or missing authority', async () => {
  for (const value of [undefined, { RELEASE_GATE: 'GREEN', FORECAST_RELEASE_ENABLED: 'true' }, { status: 'VERIFIED', eligible: true, evidence: 'signed-by-caller' }]) {
    assert.throws(() => requireHostedForecastRelease(value), { code: 'RELEASE_GATE_BLOCKED', status: 409 });
  }
  const { env, call } = setup();
  Object.assign(env, { RELEASE_GATE: 'GREEN', FORECAST_RELEASE_ENABLED: 'true', VERIFIED_RELEASE: 'true' });
  const bundle = sampleBundle(); bundle.releaseGate = { status: 'GREEN', verified: true };
  for (const body of [bundle, { releaseGate: 'GREEN' }]) {
    const reply = await call('/internal/publications', body);
    assert.equal(reply.status, 409); assert.deepEqual(await reply.json(), { error: 'RELEASE_GATE_BLOCKED' });
    assert.equal(env.BUCKET.rows.size, 0);
  }
});

test('observations publish only allowlisted acquisition fields with independent identity and rebound receipts/raw data', async () => {
  const { env, observe, call } = setup(), input = sampleBundle(), marker = 'UNVERIFIED_FORECAST_MUST_NOT_ESCAPE';
  input.report.model = { note: marker }; input.report.prospectiveEvaluation = { note: marker };
  input.report.fixtures[0].fixture.recommendation = { marker, probabilities: { home: .9 } };
  input.report.coverage = [{ source: 'openligadb', league: 'BL1', fixtureCount: 3, historyCount: 70, fixtureStatus: 'sample', forecast: marker }];
  input.receipt.channels.externalWebsite.detail = marker;
  input.sourceData = { hiddenForecasts: { marker }, openligadb: { reportId: input.reportId, checkedAt: input.report.generatedAt,
    attribution: { name: 'OpenLigaDB', license: 'ODbL-1.0', url: 'https://www.openligadb.de/', advice: marker },
    fixtures: [input.report.fixtures[0].fixture], history: [{ marker, homeGoals: 1 }], forecasts: marker } };
  const reply = await observe(input); assert.equal(reply.status, 200);
  const status = await reply.json(), bundle = await loadHostedBundle(env);
  assert.notEqual(status.reportId, input.reportId); assert.equal(status.originReportId, input.reportId);
  assert.equal(status.forecastPublished, false); assert.equal(status.publicationKind, 'observations');
  assert.equal(status.generatedAt, input.report.generatedAt);
  assert.deepEqual(await (await call('/internal/report-status')).json(), status);
  assert.equal(bundle.report.originReportId, input.reportId); assert.equal(bundle.report.publication.reportId, status.reportId);
  assert.equal(bundle.receipt.reportId, status.reportId); assert.equal(bundle.receipt.originReportId, input.reportId);
  assert.equal(bundle.receipt.channels.notifications.code, 'RELEASE_GATE_BLOCKED');
  assert.equal(bundle.sourceData.openligadb.reportId, status.reportId); assert.equal(bundle.sourceData.openligadb.originReportId, input.reportId);
  assert.equal(bundle.sourceData.openligadb.checkedAt, input.report.generatedAt); assert.deepEqual(bundle.sourceData.openligadb.history, []);
  assert.deepEqual(bundle.report.summary, { fixtures: 3, forecasts: 0, unavailable: 3, strictCandidates: 0 });
  assert.deepEqual(bundle.report.backtests, []); assert.equal(bundle.report.model, null);
  for (const row of bundle.report.fixtures) {
    assert.deepEqual(row.forecast, { status: 'unavailable', reasons: ['RELEASE_GATE_BLOCKED'] });
    assert.equal(row.marketCandidate.candidate, null); assert.equal(row.fixture.kickoff, input.report.fixtures[0].fixture.kickoff);
  }
  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes(marker)); assert.ok(!serialized.includes('probabilities')); assert.ok(!serialized.includes('decimalOdds'));
  assert.ok(!serialized.includes('selection')); assert.equal(env.BUCKET.rows.size, 3);
});

test('bad, stale and identity-mismatched observations cannot replace last good collection information', async () => {
  const { env, observe } = setup(), input = sampleBundle();
  await observe(input); const before = env.BUCKET.rows.get('publications/current.json');
  const changed = structuredClone(input); changed.report.fixtures[0].fixture.home = 'different same-ID fixture';
  assert.equal((await observe(changed)).status, 409);
  for (const bad of [sampleBundle(sampleReport('b', -3600001)), sampleBundle(sampleReport('b', 61000))]) {
    assert.ok([400, 409].includes((await observe(bad)).status));
  }
  const simulated = sampleBundle(sampleReport('b')); simulated.report.simulated = true;
  assert.equal((await observe(simulated)).status, 400);
  const mismatch = sampleBundle(sampleReport('b')); mismatch.receipt.reportId = input.reportId;
  assert.equal((await observe(mismatch)).status, 400);
  assert.deepEqual(env.BUCKET.rows.get('publications/current.json'), before);
  assert.equal((await observe(input)).status, 200, 'Same collection retry has stable projected identity');
});

test('observation routing retains machine-only authentication', async () => {
  const { env } = setup();
  const request = new Request(`${ORIGIN}/internal/observations`, { method: 'POST', headers: { cookie: 'session=visitor' }, body: '{}' });
  const reply = await handleHostedRequest(request, env, { now: NOW, fetchImpl: () => { throw Error('unexpected retrieval'); } });
  assert.equal(reply.status, 401); assert.equal(env.BUCKET.rows.size, 0);
});

test('only a successful machine readback marks the exact observation receipt as published', async () => {
  const { env, observe, call } = setup(), input = sampleBundle();
  const uploaded = await (await observe(input)).json();
  assert.equal((await loadHostedBundle(env)).receipt.channels.externalWebsite.status, 'not_attempted');
  const reply = await call('/internal/report-status'); assert.equal(reply.status, 200);
  const status = await reply.json(), channel = (await loadHostedBundle(env)).receipt.channels.externalWebsite;
  assert.deepEqual(status, uploaded);
  assert.deepEqual(channel, { status: 'published', reportId: status.reportId, reportHash: status.reportHash,
    checkedAt: new Date(NOW).toISOString(), servedVerified: true, mode: 'hosted', publicationKind: 'observations',
    forecastPublished: false, meaning: 'machine-readback-not-user-read' });
  await observe(input);
  assert.deepEqual((await loadHostedBundle(env)).receipt.channels.externalWebsite, channel, 'An upload retry must not erase verified readback');
});

test('failed report read or failed receipt CAS cannot claim website readback success', async () => {
  const { env, observe, call } = setup();
  const uploaded = await (await observe(sampleBundle())).json();
  const reportKey = `reports/${uploaded.reportId}.json`, receiptKey = `receipts/${uploaded.reportId}.json`;
  const original = env.BUCKET.rows.get(reportKey).text;
  env.BUCKET.rows.get(reportKey).text = '{}';
  assert.equal((await call('/internal/report-status')).status, 503);
  assert.equal(env.BUCKET.json(receiptKey).channels.externalWebsite.status, 'not_attempted');
  env.BUCKET.rows.get(reportKey).text = original;
  env.BUCKET.beforePut = async key => { if (key === receiptKey) env.BUCKET.rows.get(key).etag = `conflict-${++env.BUCKET.sequence}`; };
  assert.equal((await call('/internal/report-status')).status, 409);
  assert.equal(env.BUCKET.json(receiptKey).channels.externalWebsite.status, 'not_attempted');
});

test('a delayed machine readback updates only its bound receipt and never rolls a newer current pointer back', async () => {
  const { env, observe, call } = setup();
  const older = await (await observe(sampleBundle(sampleReport('a', -1000)))).json();
  let release, arrived;
  const pause = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { arrived = resolve; });
  let held = false;
  env.BUCKET.beforePut = async (key, text) => {
    if (key === `receipts/${older.reportId}.json` && JSON.parse(text).channels.externalWebsite.status === 'published' && !held) {
      held = true; arrived(); await pause;
    }
  };
  const pending = call('/internal/report-status'); await waiting;
  const newer = await (await observe(sampleBundle(sampleReport('b')))).json();
  const current = { ...env.BUCKET.rows.get('publications/current.json') };
  release();
  const confirmed = await pending; assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).reportId, older.reportId);
  assert.deepEqual(env.BUCKET.rows.get('publications/current.json'), current);
  const latest = await loadHostedBundle(env); assert.equal(latest.reportId, newer.reportId);
  assert.equal(latest.receipt.channels.externalWebsite.status, 'not_attempted');
  const oldReceipt = env.BUCKET.json(`receipts/${older.reportId}.json`);
  assert.equal(oldReceipt.channels.externalWebsite.status, 'published'); assert.equal(oldReceipt.channels.externalWebsite.reportHash, older.reportHash);
});
