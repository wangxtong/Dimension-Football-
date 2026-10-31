import test from 'node:test';
import assert from 'node:assert/strict';
import { demoInput } from '../demo.mjs';
import { evaluateFixture, validOpening } from '../policy.mjs';
import { reconcileMarketEvidence, marketReadiness } from '../market-evidence.mjs';

const NOW = '2026-10-31T05:00:00.000Z';
const setup = () => { const d = demoInput(NOW); return { fixture: d.fixtures[0], ...d.evidence }; };

test('true opening requires source/bookmaker/fixture identity, provenance and real timestamps', async t => {
  const changes = { firstSeen: o => ({ ...o, basis: 'first-seen' }), noTime: o => ({ ...o, observedAt: null }),
    noProof: o => ({ ...o, evidenceUrl: undefined }), wrongSource: o => ({ ...o, sourceId: 'oddspedia' }),
    wrongBook: o => ({ ...o, bookmaker: 'Other' }), wrongFixture: o => ({ ...o, fixtureId: 'other' }),
    wrongSide: o => ({ ...o, selection: 'away' }), futureCapture: o => ({ ...o, recordedAt: '2027-01-01T00:00:00Z' }),
    secretUrl: o => ({ ...o, evidenceUrl: `${o.evidenceUrl}${o.evidenceUrl.includes('?') ? '&' : '?'}key=private` }) };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const { fixture, quotes, signals } = setup();
    const changed = quotes.map(q => ({ ...q, opening: q.opening ? change(q.opening) : undefined }));
    assert.equal(evaluateFixture(fixture, { quotes: changed, signals }, NOW).status, 'source_insufficient');
    assert.equal(marketReadiness(fixture, changed, NOW).verifiedOpeningCount, 0);
  });
});

test('readiness exposes both missing second source and missing real opening, without manufactured votes', () => {
  const { fixture, quotes } = setup();
  const one = quotes.filter(q => q.sourceId === 'titan007').flatMap(q => ['M88', 'SBOBET'].map(bookmaker => ({ ...q, bookmaker, opening: undefined, independenceGroup: 'fake' })));
  const r = marketReadiness(fixture, one, NOW);
  assert.equal(r.quoteGroups.length, 1);
  assert.deepEqual(r.blockers, ['SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING', 'TRUE_OPENING_RECORD_MISSING']);
});

test('archived opening survives fresh snapshots but cannot supply current evidence or cross fixture boundaries', () => {
  const { fixture, quotes, signals } = setup();
  const first = reconcileMarketEvidence(fixture, quotes, [], NOW);
  assert.equal(first.records.length, 2);
  const next = quotes.map(q => ({ ...q, opening: undefined }));
  const replay = reconcileMarketEvidence(fixture, next, first.records, NOW);
  assert.equal(evaluateFixture(fixture, { quotes: replay.quotes, signals }, NOW).status, 'candidate');
  assert.equal(reconcileMarketEvidence(fixture, [], first.records, NOW).quotes.length, 0);
  const other = { ...fixture, away: 'different opponent' };
  assert.equal(reconcileMarketEvidence(other, next, first.records, NOW).records.length, 0);
  const expired = '2026-10-31T05:06:00.000Z';
  assert.equal(marketReadiness(fixture, replay.quotes, expired).pairedQuoteCount, 0);
});

test('conflicting openings stay blocked across repeated runs and do not fall back to an older claim', () => {
  const { fixture, quotes } = setup();
  const first = reconcileMarketEvidence(fixture, quotes, [], NOW);
  const changed = quotes.map(q => ({ ...q, opening: q.opening ? { ...q.opening, decimalOdds: 1.86 } : undefined }));
  const conflict = reconcileMarketEvidence(fixture, changed, first.records, NOW);
  assert.ok(conflict.records.every(r => r.conflict));
  assert.ok(conflict.quotes.every(q => !validOpening(q, fixture, NOW)));
  const again = reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, opening: undefined })), conflict.records, NOW);
  assert.ok(again.quotes.every(q => !q.opening));
});

test('unverified observations cannot create an opening archive; archive strips arbitrary fields', () => {
  const { fixture, quotes } = setup();
  assert.equal(reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, verified: false })), [], NOW).records.length, 0);
  const r = reconcileMarketEvidence(fixture, quotes.map(q => ({ ...q, opening: q.opening ? { ...q.opening, authorization: 'secret-marker' } : undefined })), [], NOW);
  assert.ok(!JSON.stringify(r.records).includes('secret-marker'));
});
