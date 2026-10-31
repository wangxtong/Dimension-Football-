import test from 'node:test';
import assert from 'node:assert/strict';
import { demoInput } from '../demo.mjs';
import { digest, fixtureKey, evaluateFixture, preparePool, safeOpening, validOpening } from '../policy.mjs';
import { reconcileMarketEvidence, marketReadiness } from '../market-evidence.mjs';

const NOW = '2026-10-31T05:00:00.000Z';
const at = offset => new Date(Date.parse(NOW) + offset).toISOString();
const setup = () => { const d = demoInput(NOW); return { fixture: d.fixtures[0], ...d.evidence }; };
const older = quotes => quotes.map(q => ({ ...q, observedAt: at(-60_000), sourceUpdatedAt: at(-60_000) }));
const evaluate = (fixture, quotes, signals) => evaluateFixture(fixture, { quotes, signals }, NOW);

test('opening requires the same full-time Asian market, provider event and fixture snapshot', async t => {
  for (const [name, change] of Object.entries({ otherMarket: { market: '1x2' }, halfTime: { period: 'first-half' },
    otherProviderEvent: { providerMatchId: 'different' }, missingProviderEvent: { providerMatchId: undefined },
    missingSnapshot: { fixtureSnapshot: undefined }, otherFixture: { fixtureSnapshot: { id: 'different' } } })) {
    await t.test(name, () => {
      const { fixture, quotes, signals } = setup();
      const rows = quotes.map(q => ({ ...q, opening: q.opening ? { ...q.opening, ...change } : undefined }));
      const r = reconcileMarketEvidence(fixture, rows, [], NOW);
      assert.equal(r.records.length, 0);
      assert.notEqual(evaluate(fixture, r.quotes, signals).status, 'candidate');
    });
  }
});

test('source-scoped canonical identity survives pool preparation and binds the opening revision', () => {
  const { fixture, quotes } = setup();
  const enriched = { ...fixture, canonicalMatchId: `evt_${'a'.repeat(64)}`, identityRevision: 'b'.repeat(64),
    revisionId: 'c'.repeat(64), recordHash: 'e'.repeat(64), identityScope: 'source', sourceFixtureId: '123', season: '2026', observedAt: NOW };
  const prepared = preparePool([enriched]).fixtures[0];
  for (const key of ['canonicalMatchId', 'identityRevision', 'revisionId', 'recordHash', 'identityScope', 'sourceFixtureId', 'season', 'observedAt']) assert.equal(prepared[key], enriched[key]);
  const quote = { ...quotes[0], opening: { ...quotes[0].opening, canonicalMatchId: enriched.canonicalMatchId, identityRevision: enriched.identityRevision } };
  assert.equal(validOpening(quote, prepared, NOW), true);
  assert.equal(validOpening(quote, { ...prepared, identityRevision: 'd'.repeat(64) }, NOW), false);
  const retained = safeOpening({ ...quote.opening, arbitraryPrivateField: 'discard' });
  assert.equal(retained.providerMatchId, quote.providerMatchId);
  assert.deepEqual(retained.fixtureSnapshot, quote.opening.fixtureSnapshot);
  assert.equal(retained.identityRevision, enriched.identityRevision);
  assert.equal(Object.hasOwn(retained, 'arbitraryPrivateField'), false);
});

test('new closed, incomplete, changed, out-of-band or expired snapshots cannot fall back to old prices', async t => {
  const changes = {
    closed: rows => rows.map(q => ({ ...q, closed: true })),
    inPlay: rows => rows.map(q => ({ ...q, inPlay: true })),
    incomplete: rows => rows.filter(q => q.selection === 'home'),
    outsidePolicy: rows => rows.map(q => ({ ...q, decimalOdds: q.selection === 'home' ? 1.5 : 2.5 })),
    changedLine: rows => rows.map(q => ({ ...q, handicap: q.selection === 'home' ? -.5 : .5, opening: undefined })),
    expired: rows => rows.map(q => ({ ...q, validUntil: NOW })),
    invalidTime: rows => rows.map(q => ({ ...q, sourceUpdatedAt: 'invalid' })),
    regressedOrigin: rows => rows.map(q => ({ ...q, sourceUpdatedAt: at(-120_000) })),
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const { fixture, quotes, signals } = setup(), rows = [...older(quotes), ...change(quotes)];
    const reconciled = reconcileMarketEvidence(fixture, rows, [], NOW);
    assert.notEqual(evaluate(fixture, reconciled.quotes, signals).status, 'candidate');
    assert.notEqual(evaluate(fixture, [...reconciled.quotes].reverse(), signals).status, 'candidate');
  });
});

test('same-time contradictions fail closed and an exact duplicate does not increase readiness counts', () => {
  const { fixture, quotes, signals } = setup();
  const rows = [...quotes, ...quotes.filter(q => q.selection === 'home').map(q => ({ ...q, decimalOdds: 1.95 }))];
  for (const ordered of [rows, [...rows].reverse()]) {
    const result = evaluate(fixture, ordered, signals);
    assert.notEqual(result.status, 'candidate');
    assert.ok(result.reasons.includes('CURRENT_MARKET_AMBIGUOUS'));
  }
  assert.equal(marketReadiness(fixture, [...quotes, ...structuredClone(quotes)], NOW).pairedQuoteCount, 4);
});

test('different provider event IDs cannot provide two sides of a market', () => {
  const { fixture, quotes, signals } = setup();
  const rows = quotes.map(q => q.selection === 'away' ? { ...q, providerMatchId: 'different-event' } : q);
  assert.notEqual(evaluate(fixture, rows, signals).status, 'candidate');
});

test('a newer verified negative market state suppresses imported old prices but cannot become a quotation', () => {
  const { fixture, quotes, signals } = setup();
  const states = quotes.filter(q => q.selection === 'home').map(q => ({ ...q, selection: undefined, handicap: undefined,
    decimalOdds: undefined, opening: undefined, marketState: 'unavailable', stateReason: 'incomplete_market' }));
  const r = marketReadiness(fixture, [...older(quotes), ...states], NOW);
  assert.equal(r.pairedQuoteCount, 0);
  assert.ok(r.blockers.includes('LATEST_MARKET_UNAVAILABLE'));
  assert.notEqual(evaluate(fixture, [...older(quotes), ...states], signals).status, 'candidate');
  assert.equal(evaluate(fixture, [...quotes, ...states.map(s => ({ ...s, verified: false }))], signals).status, 'candidate');
});

test('readiness requires a common eligible direction and line, with an opening trajectory for that market', () => {
  const { fixture, quotes } = setup();
  const differentLines = quotes.map(q => q.sourceId === 'oddstorm' ? { ...q, handicap: q.selection === 'home' ? -.5 : .5,
    opening: q.opening ? { ...q.opening, handicap: -.5 } : undefined } : q);
  const r = marketReadiness(fixture, differentLines, NOW);
  assert.equal(r.quoteGroups.length, 2);
  assert.ok(r.blockers.includes('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING'));
  assert.ok(r.matchingMarkets.every(m => !m.crossChecked));
  const changed = quotes.map(q => ({ ...q, opening: q.opening ? { ...q.opening, handicap: -.5 } : undefined }));
  assert.ok(marketReadiness(fixture, changed, NOW).blockers.includes('OPENING_TRAJECTORY_MISSING_OR_CHANGED'));
});

test('an unusable third source remains a diagnostic without blocking two complete independent markets', () => {
  const { fixture, quotes, signals } = setup();
  const third = { ...quotes[0], sourceId: 'oddspedia', bookmaker: 'Third', opening: undefined, evidenceUrl: 'https://www.oddspedia.com/' };
  const rows = [...quotes, third], readiness = marketReadiness(fixture, rows, NOW);
  assert.equal(evaluate(fixture, rows, signals).status, 'candidate');
  assert.deepEqual(readiness.blockers, []);
  assert.ok(readiness.sourceIssues.includes('LATEST_MARKET_INCOMPLETE'));
});

test('corrupt opening hashes remain blocked after repeated reconciliation', () => {
  const { fixture, quotes, signals } = setup();
  const first = reconcileMarketEvidence(fixture, quotes, [], NOW);
  let records = first.records.map(r => ({ ...r, opening: { ...r.opening, decimalOdds: 1.9 } }));
  for (let iteration = 0; iteration < 3; iteration++) {
    const result = reconcileMarketEvidence(fixture, quotes, records, NOW);
    assert.ok(result.records.every(r => r.conflict && r.archiveStatus === 'integrity_failure'));
    assert.notEqual(evaluate(fixture, result.quotes, signals).status, 'candidate');
    records = JSON.parse(JSON.stringify(result.records));
  }
});

test('duplicate archives cannot clear a conflict regardless of order or hash validity', () => {
  const { fixture, quotes, signals } = setup(), first = reconcileMarketEvidence(fixture, quotes, [], NOW);
  const conflicting = first.records.flatMap(r => [r, { ...r, conflict: true }]);
  for (const previous of [conflicting, [...conflicting].reverse()]) {
    const result = reconcileMarketEvidence(fixture, quotes, previous, NOW);
    assert.ok(result.records.every(r => r.conflict));
    assert.notEqual(evaluate(fixture, result.quotes, signals).status, 'candidate');
  }
});

test('legacy openings are retained for review without fabricating missing identity fields', () => {
  const { fixture, quotes, signals } = setup();
  const legacy = quotes.filter(q => q.opening).map(q => {
    const { market, period, providerMatchId, fixtureSnapshot, ...opening } = q.opening;
    return { fixtureKey: fixtureKey(fixture), opening, hash: digest(opening), firstRecordedAt: NOW, conflict: false };
  });
  const rows = quotes.map(q => ({ ...q, opening: undefined }));
  let result = reconcileMarketEvidence(fixture, rows, legacy, NOW);
  assert.equal(result.records.length, 2);
  assert.ok(result.records.every(r => r.archiveStatus === 'pending_verification' && !r.opening.market && !r.opening.providerMatchId));
  result = reconcileMarketEvidence(fixture, rows, JSON.parse(JSON.stringify(result.records)), NOW);
  assert.equal(result.records.length, 2);
  assert.notEqual(evaluate(fixture, result.quotes, signals).status, 'candidate');
});

test('archive capacity overflow cannot discard conflict blockers and revive openings', () => {
  const { fixture, quotes } = setup();
  const many = Array.from({ length: 201 }, (_, i) => ({ ...quotes[0], bookmaker: `Book-${i}`,
    opening: { ...quotes[0].opening, bookmaker: `Book-${i}` } }));
  const result = reconcileMarketEvidence(fixture, many, [], NOW);
  assert.equal(result.records.length, 200);
  assert.equal(result.records[0].archiveStatus, 'capacity_exceeded');
  assert.ok(result.quotes.every(q => !q.opening));
  const again = reconcileMarketEvidence(fixture, quotes, result.records, NOW);
  assert.ok(again.quotes.every(q => !q.opening));
  assert.equal(again.records[0].archiveStatus, 'capacity_exceeded');
});
