import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createModelExperimentLoader, createSnapshotLoader, marketObservationState, scheduleAcquisitionTime, validateMarketObservation, validateModelExperimentEvidence } from '../app.mjs';
import { NOW, sampleBundle } from './fixtures.mjs';

export function marketSummary() {
  const time = offset => new Date(NOW + offset).toISOString();
  return { version: 1, checkedAt: time(0), expiresAt: time(240000), fixtureCount: 3,
    sources: [
      { id: 'hkjc', group: 'hkjc-first-party', status: 'available', quoteCount: 2, pairedFixtureCount: 1, openingCount: 0, latestSourceUpdatedAt: time(-60000) },
      { id: 'macauslot', group: 'macauslot-official', status: 'available', quoteCount: 2, pairedFixtureCount: 1, openingCount: 0, latestSourceUpdatedAt: time(-30000) },
      { id: 'titan007', group: 'titan007', status: 'unavailable', quoteCount: 0, pairedFixtureCount: 0, openingCount: 0, latestSourceUpdatedAt: null },
    ], dualSourceFixtureCount: 1, alignedEligibleFixtureCount: 1, trueOpeningFixtureCount: 0, releaseGate: 'BLOCKED' };
}
const model = async () => JSON.parse(await readFile(new URL('../model-experiment-evidence.json', import.meta.url)));

test('market summary counts valid zero, separates current/expired and rejects invalid channel or stale claims', () => {
  const summary = marketSummary();
  assert.equal(validateMarketObservation(summary), summary);
  assert.equal(marketObservationState(summary, NOW).status, 'current');
  assert.equal(marketObservationState(summary, NOW + 240000).status, 'expired');
  assert.equal(marketObservationState(undefined, NOW).status, 'unverified');
  for (const mutate of [v => { v.releaseGate = 'GREEN'; }, v => { v.sources[1].group = 'hkjc-first-party'; },
    v => { v.sources[1].id = 'hkjc'; }, v => { v.sources[0].quoteCount = -1; },
    v => { v.sources[0].status = 'stale'; }, v => { v.sources[0].latestSourceUpdatedAt = new Date(NOW + 1).toISOString(); },
    v => { v.sources[0].openingCount = 3; }, v => { v.alignedEligibleFixtureCount = 2; },
    v => { v.trueOpeningFixtureCount = 1; }, v => { v.sources[0].quoteCount = 1; },
    v => { v.decimalOdds = 1.9; }, v => { v.sources[0].probability = .99; },
    v => { v.expiresAt = new Date(NOW + 300001).toISOString(); }]) {
    const changed = structuredClone(summary); mutate(changed);
    assert.equal(marketObservationState(changed, NOW).status, 'unverified');
  }
  const empty = marketSummary(); empty.fixtureCount = empty.dualSourceFixtureCount = empty.alignedEligibleFixtureCount = 0;
  for (const row of empty.sources) Object.assign(row, { status: 'missing', quoteCount: 0, pairedFixtureCount: 0, latestSourceUpdatedAt: null });
  assert.equal(marketObservationState(empty, NOW).status, 'current');
});

test('bad optional observation summary does not reject the independent valid schedule bundle', async () => {
  const bundle = sampleBundle(); bundle.report.marketObservation = { version: 99, recommendations: ['injected'] };
  const loader = createSnapshotLoader({ now: () => NOW, fetchImpl: async () => Response.json(bundle) });
  const loaded = await loader.load();
  assert.equal(loaded.report.fixtures.length, 3);
  assert.equal(marketObservationState(loaded.report.marketObservation, NOW).status, 'unverified');
});

test('market subset may be smaller than the full schedule or zero, but cannot exceed it', () => {
  const value = marketSummary(); value.fixtureCount = 1;
  assert.equal(marketObservationState(value, NOW, 3).status, 'current');
  assert.equal(marketObservationState(value, NOW, 0).status, 'unverified');
  value.fixtureCount = value.dualSourceFixtureCount = value.alignedEligibleFixtureCount = 0;
  value.sources.forEach(row => Object.assign(row, { status: 'missing', quoteCount: 0, pairedFixtureCount: 0, openingCount: 0, latestSourceUpdatedAt: null }));
  assert.equal(marketObservationState(value, NOW, 3).status, 'current');
});

test('fresh market report never refreshes an older or unknown schedule acquisition time', () => {
  const checkedAt = new Date(NOW - 3600000).toISOString();
  const report = { generatedAt: new Date(NOW).toISOString(), acquisition: { checkedAt } };
  assert.equal(scheduleAcquisitionTime(report, NOW), checkedAt);
  report.generatedAt = new Date(NOW + 60000).toISOString();
  assert.equal(scheduleAcquisitionTime(report, NOW + 60000), checkedAt);
  for (const acquisition of [undefined, {}, { checkedAt: 'bad' }, { checkedAt: new Date(NOW + 120000).toISOString() }]) {
    assert.equal(scheduleAcquisitionTime({ ...report, acquisition }, NOW + 60000), null);
  }
});

test('frozen experiment displays the 982 input/182 holdout with genuine score deterioration and no adoption', async () => {
  const evidence = await model();
  assert.equal(validateModelExperimentEvidence(evidence), evidence);
  assert.equal(evidence.samples.input, 982); assert.equal(evidence.samples.holdout.evaluated, 182);
  assert.equal(evidence.samples.asObserved.holdout, 0);
  assert.ok(evidence.holdout.candidateMinusBaseline.brier > 0);
  assert.ok(evidence.holdout.candidateMinusBaseline.logLoss > 0);
  assert.equal(evidence.binding.experimentCodeHash, '1b4a43bd1a2704e361724f22edba29992689bf155858225caec887d16ae3a53e');
  for (const mutate of [v => { v.releaseGate = 'GREEN'; }, v => { v.calibrated = true; }, v => { v.independentEvidence = true; },
    v => { v.samples.holdout.evaluated = 982; }, v => { v.samples.holdout.skipped = 0; },
    v => { v.holdout.candidateMinusBaseline.brier = -.1; }, v => { v.binding.experimentCodeHash = 'current'; },
    v => { v.models.candidate.id = 'unverified-model'; }, v => { v.decision.candidateAdopted = true; },
    v => { v.holdout.pairedIntervals.brier.lower = 100; }]) {
    const changed = structuredClone(evidence); mutate(changed);
    assert.throws(() => validateModelExperimentEvidence(changed), /MODEL_EXPERIMENT_INVALID/);
  }
});

test('experiment loader shares in-flight requests and recovers after absent, oversized or corrupt assets', async () => {
  const evidence = await model(); let release, calls = 0;
  const loader = createModelExperimentLoader({ fetchImpl: (url, options) => {
    assert.equal(url, '/model-experiment-evidence.json'); assert.equal(options.credentials, 'same-origin');
    calls++; return new Promise(resolve => { release = resolve; });
  } });
  const initial = loader.load(); assert.equal(loader.load(), initial); assert.equal(calls, 1);
  release(Response.json(evidence)); assert.equal((await initial).samples.input, 982);
  for (const response of [new Response(null, { status: 404 }), new Response('x'.repeat(20001)), Response.json({ kind: 'unknown' })]) {
    const attempt = loader.load(); release(response); await assert.rejects(attempt);
  }
  const recovered = loader.load(); release(Response.json(evidence)); assert.equal((await recovered).decision.status, 'NOT_ADOPTED');
});
