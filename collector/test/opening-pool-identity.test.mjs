import test from 'node:test';
import assert from 'node:assert/strict';
import { demoInput } from '../demo.mjs';
import { digest, validOpening, safeOpening, openingIdentity, evaluateFixture } from '../policy.mjs';
import { reconcileMarketEvidence } from '../market-evidence.mjs';

const NOW = '2026-11-01T10:43:02.066Z';
const setup = (pool = 'pool-1') => {
  const input = demoInput(NOW), fixture = input.fixtures[0];
  const quotes = input.evidence.quotes.map(q => ({ ...q, providerPoolId: pool,
    ...(q.opening ? { opening: { ...q.opening, providerPoolId: pool } } : {}) }));
  return { fixture, quotes, signals: input.evidence.signals };
};

test('a supplied supplier pool must match the opening exactly; absent or malformed IDs are not wildcards', () => {
  const { fixture, quotes } = setup(), q = quotes.find(q => q.opening);
  assert.equal(validOpening(q, fixture, NOW), true);
  for (const providerPoolId of [undefined, null, '', 'other-pool', 1, {}, 'bad/pool', 'a'.repeat(161)]) {
    assert.equal(validOpening({ ...q, opening: { ...q.opening, providerPoolId } }, fixture, NOW), false);
  }
  for (const providerPoolId of [null, '', 1, {}, 'bad/pool', 'a'.repeat(161)]) {
    assert.equal(validOpening({ ...q, providerPoolId, opening: { ...q.opening, providerPoolId } }, fixture, NOW), false);
  }
  assert.equal(validOpening({ ...q, providerPoolId: undefined }, fixture, NOW), false);
  const mismatched = { ...q, opening: { ...q.opening, providerPoolId: 'other-pool' } };
  assert.equal(reconcileMarketEvidence(fixture, [mismatched], [], NOW).records.length, 0);
});

test('safe opening, capture proof and identity digest retain the actual supplier pool', () => {
  const { fixture, quotes } = setup();
  const q = quotes.find(q => q.opening), clean = safeOpening(q.opening);
  assert.equal(clean.providerPoolId, 'pool-1');
  assert.notEqual(openingIdentity(clean), openingIdentity({ ...clean, providerPoolId: 'pool-2' }));
  const records = reconcileMarketEvidence(fixture, quotes, [], NOW).records;
  assert.equal(records.length, 2);
  assert.ok(records.every(r => r.opening.providerPoolId === 'pool-1' && r.captureProof.providerPoolId === 'pool-1'
    && r.hash === digest(r.opening) && r.captureProofHash === digest(r.captureProof)));
});

test('a restored opening cannot be borrowed by a different pool or an identity without that pool', () => {
  const { fixture, quotes } = setup(), saved = reconcileMarketEvidence(fixture, quotes, [], NOW).records;
  for (const providerPoolId of ['pool-2', undefined]) {
    const next = quotes.map(q => ({ ...q, providerPoolId, opening: undefined }));
    const restored = reconcileMarketEvidence(fixture, next, JSON.parse(JSON.stringify(saved)), NOW);
    assert.ok(restored.quotes.every(q => !q.opening));
    assert.deepEqual(restored.records, saved);
  }
  const restored = reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, opening: undefined })), saved, NOW);
  assert.ok(restored.quotes.filter(q => q.selection === 'home').every(q => q.opening?.providerPoolId === 'pool-1'));
});

test('separate matching provider pools archive independently and only reuse their own opening', () => {
  const first = setup('pool-1'), second = setup('pool-2');
  second.quotes.forEach(q => { if (q.opening) q.opening.decimalOdds = 1.86; });
  const saved = reconcileMarketEvidence(first.fixture, first.quotes, [], NOW).records;
  const next = reconcileMarketEvidence(first.fixture, second.quotes, saved, NOW);
  assert.equal(next.records.length, 4);
  assert.ok(next.records.every(r => r.archiveStatus === 'verified' && !r.conflict));
  const restored = reconcileMarketEvidence(first.fixture, second.quotes.map(q => ({ ...q, opening: undefined })), next.records, NOW);
  assert.ok(restored.quotes.filter(q => q.selection === 'home').every(q => q.opening?.providerPoolId === 'pool-2' && q.opening.decimalOdds === 1.86));
  assert.equal(evaluateFixture(first.fixture, { quotes: restored.quotes, signals: first.signals }, NOW).status, 'candidate');
});

test('altering an archived pool or its capture proof cannot evade sticky integrity failure by changing the lookup key', () => {
  const { fixture, quotes } = setup();
  for (const mutate of [
    r => { r.opening.providerPoolId = 'pool-tampered'; r.hash = digest(r.opening); },
    r => { r.captureProof.providerPoolId = 'pool-tampered'; r.captureProofHash = digest(r.captureProof); },
    r => { delete r.captureProof.providerPoolId; r.captureProofHash = digest(r.captureProof); },
  ]) {
    let saved = JSON.parse(JSON.stringify(reconcileMarketEvidence(fixture, quotes, [], NOW).records));
    mutate(saved[0]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const replay = reconcileMarketEvidence(fixture, quotes, saved, NOW);
      assert.ok(replay.quotes.every(q => !q.opening));
      assert.ok(replay.records.some(r => r.archiveStatus === 'integrity_failure' && r.conflict));
      saved = JSON.parse(JSON.stringify(replay.records));
    }
  }
});

test('sources that never supplied pool IDs retain genuine opening capture and JSON replay behavior', () => {
  const input = demoInput(NOW), fixture = input.fixtures[0], { quotes, signals } = input.evidence;
  const saved = reconcileMarketEvidence(fixture, quotes, [], NOW);
  assert.ok(saved.records.every(r => !Object.hasOwn(r.opening, 'providerPoolId') && !Object.hasOwn(r.captureProof, 'providerPoolId')));
  const replay = reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, opening: undefined })), JSON.parse(JSON.stringify(saved.records)), NOW);
  assert.equal(evaluateFixture(fixture, { quotes: replay.quotes, signals }, NOW).status, 'candidate');
});
