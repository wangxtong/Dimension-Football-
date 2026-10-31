import test from 'node:test';
import assert from 'node:assert/strict';
import { demoInput } from '../demo.mjs';
import { DEFAULT_POLICY, readPolicy, preparePool, basicScreen, evaluateFixture } from '../policy.mjs';

const NOW = '2026-10-29T08:00:00.000Z';
const at = milliseconds => new Date(Date.parse(NOW) + milliseconds).toISOString();
const evidenceCase = () => {
  const input = demoInput(NOW);
  return { fixture: input.fixtures[0], evidence: input.evidence };
};

test('the complete synthetic evidence case passes with explicitly unknown Asian win probability', () => {
  const { fixture, evidence } = evidenceCase();
  const result = evaluateFixture(fixture, evidence, NOW);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.requiresReview, true);
  assert.equal(result.candidate.asianWinProbability, null);
  assert.equal(result.candidate.totalGoals, null);
  assert.equal(result.candidate.scorePrediction, null);
  assert.deepEqual(result.candidate.quoteGroups.sort(), ['oddstorm', 'titan007']);
});

test('three bookmakers displayed by Titan remain one independent quotation source', () => {
  const { fixture, evidence } = evidenceCase();
  const titan = evidence.quotes.filter(row => row.sourceId === 'titan007');
  evidence.quotes = ['M88', '12Bet', 'SBOBET'].flatMap(bookmaker => titan.map(row => ({ ...row, bookmaker })));
  const result = evaluateFixture(fixture, evidence, NOW);
  assert.equal(result.status, 'source_insufficient');
  assert.ok(result.reasons.includes('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING'));
});

test('expired or unverifiable quote evidence cannot pass', async t => {
  const mutations = {
    expired: row => ({ ...row, validUntil: NOW }),
    stale: row => ({ ...row, observedAt: at(-300_001) }),
    staleSource: row => ({ ...row, sourceUpdatedAt: at(-300_001) }),
    futureSource: row => ({ ...row, sourceUpdatedAt: at(1) }),
    futureObservation: row => ({ ...row, observedAt: at(1) }),
    unverified: row => ({ ...row, verified: false }),
    wrongIdentity: row => ({ ...row, fixtureSnapshot: { ...row.fixtureSnapshot, home: 'Different club' } }),
    wrongFixtureId: row => ({ ...row, fixtureId: 'other-id' }),
    unrelatedHost: row => ({ ...row, evidenceUrl: 'https://example.com/odds' }),
    secretQuery: row => ({ ...row, evidenceUrl: `${row.evidenceUrl}${row.evidenceUrl.includes('?') ? '&' : '?'}token=private` }),
    closed: row => ({ ...row, closed: true }),
    inPlay: row => ({ ...row, inPlay: true }),
    crown: row => ({ ...row, bookmaker: 'Crown' }),
  };
  for (const [name, change] of Object.entries(mutations)) await t.test(name, () => {
    const { fixture, evidence } = evidenceCase();
    evidence.quotes = evidence.quotes.map(change);
    const result = evaluateFixture(fixture, evidence, NOW);
    assert.equal(result.status, 'source_insufficient');
    assert.ok(result.reasons.includes('NO_FRESH_COMPLETE_ASIAN_MARKET'));
  });
});

test('a quotation must include the other side at the same handicap and snapshot time', async t => {
  const cases = {
    oneSide: rows => rows.filter(row => row.selection === 'home'),
    unequalHandicap: rows => rows.map(row => row.selection === 'away' ? { ...row, handicap: .5 } : row),
    unequalTimestamp: rows => rows.map(row => row.selection === 'away' ? { ...row, observedAt: at(-1000) } : row),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const { fixture, evidence } = evidenceCase();
    evidence.quotes = change(evidence.quotes);
    assert.equal(evaluateFixture(fixture, evidence, NOW).status, 'source_insufficient');
  });
});

test('opening evidence is required and cannot disagree on handicap, movement or time', async t => {
  const cases = {
    absent: () => undefined,
    handicapChanged: row => ({ ...row.opening, handicap: -.5 }),
    largeMovement: row => ({ ...row.opening, decimalOdds: 1.7 }),
    sameTime: row => ({ ...row.opening, observedAt: NOW }),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, () => {
    const { fixture, evidence } = evidenceCase();
    evidence.quotes = evidence.quotes.map(row => ({ ...row, opening: row.opening ? change(row) : undefined }));
    const result = evaluateFixture(fixture, evidence, NOW);
    assert.notEqual(result.status, 'candidate');
    assert.equal(result.status, 'source_insufficient', 'opposite-direction conflict must not mask missing opening evidence');
    assert.ok(result.reasons.includes('OPENING_TRAJECTORY_MISSING_OR_CHANGED'));
  });
});

test('the selected highest price cannot borrow another source opening trajectory', () => {
  const { fixture, evidence } = evidenceCase();
  evidence.quotes = evidence.quotes.map(row => row.sourceId === 'oddstorm' && row.selection === 'home'
    ? { ...row, decimalOdds: 1.94, opening: { ...row.opening, decimalOdds: 1.2 } } : row);
  const result = evaluateFixture(fixture, evidence, NOW);
  assert.equal(result.status, 'candidate');
  assert.equal(result.candidate.decimalOdds, 1.9);
  assert.equal(result.candidate.opening.decimalOdds, 1.85);
});

test('a forecast from a quotation source is not independent and an opposing forecast vetoes a candidate', () => {
  const { fixture, evidence } = evidenceCase();
  evidence.signals = evidence.signals.map(row => ({ ...row, sourceId: 'oddstorm', evidenceUrl: 'https://www.oddstorm.com/' }));
  const related = evaluateFixture(fixture, evidence, NOW);
  assert.equal(related.status, 'source_insufficient');
  assert.ok(related.reasons.includes('INDEPENDENT_FORECAST_MISSING'));
  const fresh = evidenceCase().evidence;
  fresh.signals.push({ ...fresh.signals[0], sourceId: 'forebet', evidenceUrl: 'https://www.forebet.com/', selection: 'away' });
  const conflict = evaluateFixture(fixture, fresh, NOW);
  assert.equal(conflict.status, 'avoid');
  assert.ok(conflict.reasons.includes('FORECAST_CONFLICT'));
});

test('hard policy limits can be tightened but cannot be widened through configuration', () => {
  assert.equal(readPolicy({ priceMin: 1.7, priceMax: 1.9 }).priceMin, 1.7);
  for (const input of [{ priceMin: 1.64 }, { priceMax: 1.96 }, { priceMin: 1.9, priceMax: 1.8 },
    { minimumQuoteGroups: 1 }, { requireOpening: false }, { maxAbsHandicap: 1.25 },
    { maxPriceMovement: .16 }, { maxQuoteAgeMs: 300_001 }, { budgetMs: 1_200_001 }, { unknown: true }]) {
    assert.throws(() => readPolicy(input), { message: 'INVALID_POLICY' });
  }
});

test('out-of-range prices do not yield candidates even when both sources agree', () => {
  for (const price of [1.64, 1.96]) {
    const { fixture, evidence } = evidenceCase();
    evidence.quotes = evidence.quotes.map(row => ({ ...row, decimalOdds: price }));
    const result = evaluateFixture(fixture, evidence, NOW);
    assert.equal(result.status, 'avoid');
    assert.deepEqual(result.reasons, ['PRICE_OR_HANDICAP_OUTSIDE_POLICY']);
  }
});

test('stale, already-started and out-of-window fixtures are screened before evidence', () => {
  const { fixture, evidence } = evidenceCase();
  assert.deepEqual(basicScreen({ ...fixture, updatedAt: at(-86_400_001) }, NOW), {
    status: 'source_insufficient', reasons: ['FIXTURE_FRESHNESS_UNVERIFIED'],
  });
  assert.equal(evaluateFixture({ ...fixture, kickoff: NOW }, evidence, NOW).status, 'avoid');
  assert.deepEqual(basicScreen({ ...fixture, kickoff: at(8 * 86_400_000) }, NOW, DEFAULT_POLICY), {
    status: 'avoid', reasons: ['OUTSIDE_WINDOW'],
  });
});

test('fixture pools reject fictional identities and conflicting duplicate IDs while counting exact duplicates', () => {
  const { fixture } = evidenceCase();
  assert.equal(preparePool([fixture, structuredClone(fixture)]).duplicates, 1);
  assert.equal(preparePool([fixture, structuredClone(fixture)]).fixtures.length, 1);
  for (const mutation of [{ home: 'Another club' }, { kickoff: at(10_800_000) }, { status: 'IN_PLAY' }, { updatedAt: at(-1000) }]) {
    assert.throws(() => preparePool([fixture, { ...fixture, ...mutation }]), { message: 'CONFLICTING_FIXTURE_ID' });
  }
  for (const mutation of [{ demo: true }, { source: 'fictional-demo' }, { home: fixture.away }, { kickoff: '2026-02-30T08:00:00Z' }]) {
    assert.throws(() => preparePool([{ ...fixture, ...mutation }]), { message: 'INVALID_FIXTURE' });
  }
});
