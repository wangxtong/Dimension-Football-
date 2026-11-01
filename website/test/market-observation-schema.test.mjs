import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMarketObservation, assertMarketObservationFreshness } from '../market-observation-schema.mjs';
import { handleHostedRequest, loadHostedBundle } from '../hosted-publications.mjs';
import { NOW, ORIGIN, sampleBundle } from './fixtures.mjs';
import { MemoryBucket, fakeKeys, machineRequest } from './hosted-fixtures.mjs';

const at = offset => new Date(NOW + offset).toISOString();
function input() {
  const bundle = sampleBundle();
  for (const row of bundle.report.fixtures) row.fixture.fetchedAt = at(-30000);
  bundle.report.acquisition = { snapshotHash: 'a'.repeat(64), checkedAt: at(-60000), commit: 'b'.repeat(40) };
  bundle.report.marketObservation = { version: 1, checkedAt: bundle.report.generatedAt, expiresAt: at(120000), fixtureCount: 1,
    sources: [
      { id: 'hkjc', group: 'hkjc-first-party', status: 'available', quoteCount: 2, pairedFixtureCount: 1, openingCount: 0, latestSourceUpdatedAt: at(-86400000) },
      { id: 'macauslot', group: 'macauslot-official', status: 'available', quoteCount: 2, pairedFixtureCount: 1, openingCount: 0, latestSourceUpdatedAt: at(-60000) },
      { id: 'titan007', group: 'titan007', status: 'missing', quoteCount: 0, pairedFixtureCount: 0, openingCount: 0, latestSourceUpdatedAt: null }],
    dualSourceFixtureCount: 1, alignedEligibleFixtureCount: 1, trueOpeningFixtureCount: 0, releaseGate: 'BLOCKED' };
  return bundle;
}
const validate = report => validateMarketObservation(report.marketObservation,
  { fixtureCount: report.fixtures.length, generatedAt: report.generatedAt, acquisition: report.acquisition });

test('a bounded subset and an old HKJC update time do not imply stale snapshot or model release', () => {
  const { report } = input();
  const result = validate(report);
  assert.deepEqual(result, report.marketObservation);
  assert.notEqual(result, report.marketObservation);
  assertMarketObservationFreshness(report, NOW);
  report.marketObservation.fixtureCount = 0;
  for (const row of report.marketObservation.sources) Object.assign(row, { status: 'missing', quoteCount: 0, pairedFixtureCount: 0 });
  report.marketObservation.dualSourceFixtureCount = report.marketObservation.alignedEligibleFixtureCount = 0;
  assert.equal(validate(report).fixtureCount, 0);
});

test('public aggregate rejects forged origins, private fields and impossible count relationships', () => {
  const mutate = [
    r => { r.marketObservation.quotes = [{ odds: 1.8 }]; },
    r => { r.marketObservation.sources[0].probabilities = { home: .9 }; },
    r => { r.marketObservation.sources[1].id = 'hkjc'; },
    r => { r.marketObservation.sources[1].group = 'owner-claimed-independent'; },
    r => { r.marketObservation.sources[0].quoteCount = 3; },
    r => { r.marketObservation.sources[0].pairedFixtureCount = 2; },
    r => { r.marketObservation.sources[0].openingCount = 3; },
    r => { r.marketObservation.sources[0].status = 'missing'; },
    r => { r.marketObservation.alignedEligibleFixtureCount = 2; },
    r => { r.marketObservation.trueOpeningFixtureCount = 1; },
    r => { r.marketObservation.releaseGate = 'GREEN'; },
    r => { r.marketObservation.fixtureCount = r.fixtures.length + 1; },
    r => { r.marketObservation.checkedAt = at(1); },
    r => { r.marketObservation.sources[0].latestSourceUpdatedAt = at(1); },
    r => { r.marketObservation.sources[0].latestSourceUpdatedAt = null; },
    r => { r.marketObservation.sources[1].latestSourceUpdatedAt = null; },
    r => { r.marketObservation.sources[1].latestSourceUpdatedAt = at(-86400000); },
    r => { r.marketObservation.sources[1].latestSourceUpdatedAt = at(-200000); },
    r => { r.marketObservation.expiresAt = at(300001); },
    r => { r.acquisition.checkedAt = at(1); },
    r => { r.acquisition.privateEvidence = {}; },
  ];
  for (const change of mutate) {
    const { report } = input(); change(report);
    assert.throws(() => validate(report), { code: 'MARKET_OBSERVATION_SCHEMA_INVALID' });
  }
});

test('a new market timestamp cannot freshen old acquisition or fixture times', () => {
  const staleAcquisition = input().report; staleAcquisition.acquisition.checkedAt = at(-1200001);
  assert.throws(() => assertMarketObservationFreshness(staleAcquisition, NOW), { code: 'MARKET_OBSERVATION_STALE' });
  const staleFixture = input().report; staleFixture.fixtures[0].fixture.fetchedAt = at(-1200001);
  assert.throws(() => assertMarketObservationFreshness(staleFixture, NOW), { code: 'MARKET_FIXTURE_STALE' });
  const futureFixture = input().report; futureFixture.fixtures[0].fixture.fetchedAt = at(1);
  assert.throws(() => assertMarketObservationFreshness(futureFixture, NOW), { code: 'MARKET_FIXTURE_STALE' });
  assert.throws(() => assertMarketObservationFreshness(input().report, NOW + 120001), { code: 'MARKET_OBSERVATION_EXPIRED' });
  assertMarketObservationFreshness(sampleBundle().report, NOW + 86400000);
});

test('actual observation endpoint publishes only validated aggregates and preserves original schedule time', async () => {
  const env = { DASHBOARD_ORIGIN: ORIGIN, BUCKET: new MemoryBucket() }, { fetchImpl } = fakeKeys();
  const bundle = input();
  const publish = value => handleHostedRequest(machineRequest('/internal/observations', { method: 'POST', body: value }), env, { fetchImpl, now: NOW });
  const reply = await publish(bundle);
  assert.equal(reply.status, 200, JSON.stringify(await reply.clone().json()));
  const loaded = await loadHostedBundle(env, { now: NOW + 86400000 });
  assert.deepEqual(loaded.report.marketObservation, bundle.report.marketObservation);
  assert.deepEqual(loaded.report.acquisition, bundle.report.acquisition);
  assert.equal(loaded.report.summary.forecasts, 0);
  assert.equal(loaded.report.summary.strictCandidates, 0);
  assert.ok(loaded.report.fixtures.every(row => !row.forecast.probabilities && row.marketCandidate.candidate === null));
  assert.equal(loaded.report.marketObservation.checkedAt, bundle.report.generatedAt);
  const bad = input(); bad.report.marketObservation.sources[0].selection = 'home';
  assert.equal((await publish(bad)).status, 400);
  const oldSource = input(); oldSource.report.marketObservation.sources[1].latestSourceUpdatedAt = at(-86400000);
  assert.equal((await publish(oldSource)).status, 400);
  assert.equal((await loadHostedBundle(env)).reportId, loaded.reportId);
  const stale = input(); stale.report.acquisition.checkedAt = at(-1200001);
  assert.equal((await publish(stale)).status, 409);
  assert.equal((await loadHostedBundle(env)).reportId, loaded.reportId);
  const formal = await handleHostedRequest(machineRequest('/internal/publications', { method: 'POST', body: bundle }), env, { fetchImpl, now: NOW });
  assert.equal(formal.status, 409);
  assert.equal((await formal.json()).error, 'RELEASE_GATE_BLOCKED');
});
