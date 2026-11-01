import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { collectMarketObservation, summarizeMarketObservation } from '../market-observation.mjs';
import { parseMacauslot } from '../sources/macauslot.mjs';

const now = '2026-10-31T10:06:00.000Z';
const at = milliseconds => new Date(Date.parse(now) + milliseconds).toISOString();
const fixture = { id: 'fixture-1', league: 'PL', home: 'Test home', away: 'Test away', source: 'test-provider',
  kickoff: at(7200000), updatedAt: now, status: 'SCHEDULED' };
const origins = {
  titan007: { bookmaker: 'M88', provider: 'titan007-public-market', companyId: 17, evidenceUrl: 'https://live.titan007.com/index2in1.aspx?id=17' },
  macauslot: { bookmaker: 'Macau SLOT', provider: 'macauslot-official', evidenceUrl: 'https://www.macauslot.com/soccer/json/realtime/threeinone_odds_cn_fb.json' },
  hkjc: { bookmaker: 'HKJC', provider: 'hkjc-first-party', evidenceUrl: 'https://bet.hkjc.com/en/football/hdc',
    freshnessBasis: 'publisher-live-snapshot', sourceAsOf: at(-10000), cacheMaxAgeSeconds: 15, providerPoolUpdatedAt: at(-20000) },
};
function pair(sourceId, extra = {}) {
  return ['home', 'away'].map(selection => ({ sourceId, ...origins[sourceId], fixtureId: fixture.id, fixtureSnapshot: { ...fixture },
    verified: true, verificationMethod: 'automatic', observedAt: at(-10000), sourceUpdatedAt: at(-20000), validUntil: at(280000),
    market: 'asian-handicap', period: 'full-time', providerMatchId: `${sourceId}-1`, providerPoolId: 'pool-1',
    inPlay: false, closed: false, selection, handicap: selection === 'home' ? -.25 : .25, decimalOdds: 1.9, ...extra }));
}
function opening(quote, extra = {}) {
  return { basis: 'provider-opening', sourceId: quote.sourceId, bookmaker: quote.bookmaker, fixtureId: fixture.id,
    fixtureSnapshot: { ...fixture }, providerMatchId: quote.providerMatchId, market: quote.market, period: quote.period,
    selection: quote.selection, handicap: quote.handicap, decimalOdds: 1.85, observedAt: at(-3600000), recordedAt: at(-600000),
    evidenceUrl: quote.evidenceUrl, ...extra };
}
const summarize = (quotes = [], extra = {}, checkedAt = now, fixtures = [fixture]) => summarizeMarketObservation({
  fixtures, evidence: { quotes, ...extra }, checkedAt,
});
const source = (summary, id) => summary.sources.find(row => row.id === id);

test('aligned independent complete markets count readiness, never release or prediction', () => {
  const summary = summarize([...pair('macauslot'), ...pair('hkjc')]);
  assert.equal(summary.dualSourceFixtureCount, 1);
  assert.equal(summary.alignedEligibleFixtureCount, 1);
  assert.equal(summary.trueOpeningFixtureCount, 0);
  assert.equal(summary.releaseGate, 'BLOCKED');
  assert.equal(summary.expiresAt, at(280000));
  assert.deepEqual(source(summary, 'macauslot'), { id: 'macauslot', group: 'macauslot-official', status: 'available',
    quoteCount: 2, pairedFixtureCount: 1, latestSourceUpdatedAt: at(-20000), openingCount: 0 });
});

test('same-fixture dual sources with different lines do not pass aligned eligibility', () => {
  const macau = pair('macauslot').map(row => ({ ...row, handicap: row.handicap * 2 }));
  const summary = summarize([...macau, ...pair('hkjc')]);
  assert.equal(summary.dualSourceFixtureCount, 1);
  assert.equal(summary.alignedEligibleFixtureCount, 0);
});

test('out-of-policy prices stay observable but cannot manufacture eligible markets', () => {
  const summary = summarize([...pair('macauslot', { decimalOdds: 2.1 }), ...pair('hkjc')]);
  assert.equal(summary.dualSourceFixtureCount, 1);
  assert.equal(summary.alignedEligibleFixtureCount, 0);
  assert.equal(source(summary, 'macauslot').quoteCount, 2);
});

test('several bookmakers delivered by Titan remain one independent source', () => {
  const summary = summarize([...pair('titan007'), ...pair('titan007', { bookmaker: '12Bet', companyId: 24,
    providerMatchId: 'titan007-2', independenceGroup: 'invented-second-source' })]);
  assert.equal(source(summary, 'titan007').quoteCount, 4);
  assert.equal(source(summary, 'titan007').pairedFixtureCount, 1);
  assert.equal(summary.dualSourceFixtureCount, 0);
});

test('registered bookmakers bound source counts and an invented fourth company adds no coverage', () => {
  const quotes = [...pair('titan007'), ...pair('titan007', { bookmaker: '12Bet', companyId: 24 }),
    ...pair('titan007', { bookmaker: 'SBOBET', companyId: 31 }),
    ...pair('titan007', { bookmaker: 'Invented bookmaker', companyId: 99 })];
  const summary = summarize(quotes);
  assert.equal(source(summary, 'titan007').quoteCount, 6);
  assert.equal(source(summary, 'titan007').pairedFixtureCount, 1);
  assert.equal(summary.dualSourceFixtureCount, 0);
});

test('forged channel identity, unmatched fixture and future timestamp produce no valid votes', () => {
  const bogus = pair('macauslot', { provider: 'titan007-public-market' });
  const mismatch = pair('hkjc').map(row => ({ ...row, fixtureSnapshot: { ...fixture, home: 'Other home' } }));
  const future = pair('titan007', { observedAt: at(1000), sourceUpdatedAt: at(1000) });
  const summary = summarize([...bogus, ...mismatch, ...future]);
  assert.equal(summary.dualSourceFixtureCount, 0);
  assert.ok(summary.sources.every(row => row.quoteCount === 0));
  assert.equal(source(summary, 'titan007').latestSourceUpdatedAt, null);
});

test('one-sided or invalid opposing prices cannot count as a complete market', () => {
  const quotes = pair('macauslot'); quotes[1].decimalOdds = 0;
  const summary = summarize([...quotes, pair('hkjc')[0]]);
  assert.equal(source(summary, 'macauslot').quoteCount, 1);
  assert.equal(source(summary, 'macauslot').status, 'partial');
  assert.equal(source(summary, 'macauslot').pairedFixtureCount, 0);
  assert.equal(source(summary, 'hkjc').quoteCount, 0);
  assert.equal(summary.dualSourceFixtureCount, 0);
});

test('a valid opening on an unpaired direction cannot increase opening readiness', () => {
  for (const change of [{ decimalOdds: 0 }, { handicap: .5 }]) {
    const quotes = pair('macauslot');
    quotes[0].opening = opening(quotes[0]);
    Object.assign(quotes[1], change);
    const summary = summarize([...quotes, ...pair('hkjc')]);
    assert.equal(source(summary, 'macauslot').pairedFixtureCount, 0);
    assert.equal(source(summary, 'macauslot').openingCount, 0);
    assert.equal(summary.trueOpeningFixtureCount, 0);
  }
});

test('a newer unavailable state suppresses old valid paired quotes', () => {
  const old = pair('macauslot');
  const state = { ...old[0], marketState: 'unavailable', observedAt: at(-1000), sourceUpdatedAt: at(-1000) };
  delete state.selection; delete state.handicap; delete state.decimalOdds;
  const summary = summarize([...old, ...pair('hkjc')], { marketStates: [state] });
  assert.equal(source(summary, 'macauslot').quoteCount, 0);
  assert.equal(source(summary, 'macauslot').status, 'unavailable');
  assert.equal(source(summary, 'macauslot').latestSourceUpdatedAt, at(-1000));
  assert.equal(summary.dualSourceFixtureCount, 0);
});

test('conflicting same-time prices do not revive a previous valid market', () => {
  const quotes = pair('macauslot');
  const summary = summarize([...quotes, { ...quotes[0], decimalOdds: 1.8 }, ...pair('hkjc')]);
  assert.equal(source(summary, 'macauslot').quoteCount, 0);
  assert.equal(summary.dualSourceFixtureCount, 0);
});

test('opposing sides bound to different events or pools never become a complete market', () => {
  for (const change of [{ providerMatchId: 'other-event' }, { providerPoolId: 'other-pool' }]) {
    const quotes = pair('macauslot'); Object.assign(quotes[1], change);
    const summary = summarize([...quotes, ...pair('hkjc')]);
    assert.equal(source(summary, 'macauslot').quoteCount, 0);
    assert.equal(source(summary, 'macauslot').pairedFixtureCount, 0);
    assert.equal(summary.dualSourceFixtureCount, 0);
  }
});

test('future publication times cannot revive an older usable source snapshot', () => {
  for (const id of ['macauslot', 'hkjc']) {
    const future = pair(id, { observedAt: at(-1000), sourceUpdatedAt: at(1000),
      ...(id === 'hkjc' ? { sourceAsOf: at(1000), providerPoolUpdatedAt: at(1000) } : {}) });
    const summary = summarize([...pair(id), ...future]);
    assert.equal(source(summary, id).quoteCount, 0);
    assert.equal(source(summary, id).openingCount, 0);
    assert.equal(summary.dualSourceFixtureCount, 0);
  }
});

test('expired observations become stale without refreshing genuine source timestamps', () => {
  const summary = summarize([...pair('macauslot'), ...pair('hkjc')], {}, at(300001));
  assert.equal(summary.dualSourceFixtureCount, 0);
  assert.equal(source(summary, 'macauslot').status, 'stale');
  assert.equal(source(summary, 'macauslot').latestSourceUpdatedAt, at(-20000));
  assert.equal(source(summary, 'hkjc').status, 'stale');
  assert.equal(summary.checkedAt, at(300001));
});

test('fresh HKJC publication snapshot preserves its old pool modification time', () => {
  const summary = summarize(pair('hkjc', { sourceUpdatedAt: at(-3600000), providerPoolUpdatedAt: at(-3600000) }));
  assert.equal(source(summary, 'hkjc').quoteCount, 2);
  assert.equal(source(summary, 'hkjc').latestSourceUpdatedAt, at(-3600000));
  assert.equal(summary.expiresAt, at(280000));
});

test('aggregate expiry is bounded by quote freshness, explicit expiry and fixture freshness', () => {
  assert.equal(summarize(pair('macauslot', { sourceUpdatedAt: at(-300000) })).expiresAt, now);
  assert.equal(summarize(pair('macauslot', { validUntil: at(1) })).expiresAt, at(1));
  const oldFixture = { ...fixture, updatedAt: at(-86400000 + 2000) };
  assert.equal(summarize(pair('macauslot'), {}, now, [oldFixture]).expiresAt, at(2000));
});

test('true provider opening counts only aligned fixtures and first-observed is never an opening', () => {
  const macau = pair('macauslot'); macau[0].opening = opening(macau[0]);
  let summary = summarize([...macau, ...pair('hkjc')]);
  assert.equal(source(summary, 'macauslot').openingCount, 1);
  assert.equal(summary.trueOpeningFixtureCount, 1);
  assert.equal(summary.releaseGate, 'BLOCKED');
  summary = summarize(macau);
  assert.equal(source(summary, 'macauslot').openingCount, 1);
  assert.equal(summary.trueOpeningFixtureCount, 0);
  macau[0].opening.basis = 'first-observed';
  summary = summarize([...macau, ...pair('hkjc')]);
  assert.equal(source(summary, 'macauslot').openingCount, 0);
  assert.equal(summary.trueOpeningFixtureCount, 0);
});

test('changed opening market or line does not satisfy genuine opening trajectory', () => {
  for (const change of [{ period: 'first-half' }, { market: 'totals' }, { providerMatchId: 'different-event' }, { handicap: -.5 },
    { observedAt: at(-10000) }, { observedAt: at(-15000) }, { recordedAt: at(1) }, { recordedAt: at(-7200000) }]) {
    const macau = pair('macauslot'); macau[0].opening = opening(macau[0], change);
    const summary = summarize([...macau, ...pair('hkjc')]);
    assert.equal(summary.trueOpeningFixtureCount, 0);
    assert.equal(source(summary, 'macauslot').openingCount, 0);
  }
});

test('opening evidence from a previous canonical revision cannot qualify after rescheduling', () => {
  const revised = { ...fixture, canonicalMatchId: `evt_${'a'.repeat(64)}`, identityRevision: 'b'.repeat(64) };
  const quotes = [...pair('macauslot'), ...pair('hkjc')];
  quotes[0].opening = opening(quotes[0], { canonicalMatchId: revised.canonicalMatchId, identityRevision: 'c'.repeat(64) });
  const summary = summarize(quotes, {}, now, [revised]);
  assert.equal(summary.alignedEligibleFixtureCount, 1);
  assert.equal(source(summary, 'macauslot').openingCount, 0);
  assert.equal(summary.trueOpeningFixtureCount, 0);
});

test('real Macau historical excerpt remains 12 pairs only at capture time and zero fresh pairs on replay', async () => {
  const frozen = JSON.parse(await readFile(new URL('../sources/test/fixtures/macauslot-20261031.json', import.meta.url), 'utf8'));
  const original = JSON.stringify(frozen);
  assert.equal(frozen.provenance.simulation, false);
  const evidence = parseMacauslot(frozen.events, frozen.odds, { ...frozen.options, fixtures: frozen.fixtures });
  const before = JSON.stringify(evidence);
  assert.equal(evidence.quotes.length, 24);
  assert.equal(new Set(evidence.quotes.map(row => row.fixtureId)).size, 12);
  assert.ok(evidence.quotes.every(row => !row.opening));
  const captured = summarizeMarketObservation({ fixtures: frozen.fixtures, evidence, checkedAt: frozen.options.observedAt });
  assert.equal(source(captured, 'macauslot').quoteCount, 24);
  assert.equal(source(captured, 'macauslot').pairedFixtureCount, 12);
  assert.equal(captured.dualSourceFixtureCount, 0);
  assert.equal(captured.trueOpeningFixtureCount, 0);
  const replay = summarizeMarketObservation({ fixtures: frozen.fixtures, evidence, checkedAt: '2026-11-01T00:00:00.000Z' });
  assert.equal(source(replay, 'macauslot').status, 'stale');
  assert.equal(source(replay, 'macauslot').quoteCount, 0);
  assert.equal(source(replay, 'macauslot').pairedFixtureCount, 0);
  assert.equal(source(replay, 'macauslot').latestSourceUpdatedAt, '2026-10-31T10:04:36.000Z');
  assert.equal(replay.dualSourceFixtureCount, 0);
  assert.equal(replay.alignedEligibleFixtureCount, 0);
  assert.equal(replay.trueOpeningFixtureCount, 0);
  assert.equal(replay.releaseGate, 'BLOCKED');
  assert.equal(JSON.stringify(evidence), before);
  assert.equal(JSON.stringify(frozen), original);
});

test('source failure preserves healthy independent data and never turns reachability into coverage', () => {
  const summary = summarize(pair('macauslot'), { diagnostics: [
    { id: 'hkjc', status: 'unavailable', code: 'authorization_required', httpStatus: 403 },
    { sourceId: 'titan007', status: 'available', httpStatus: 200, matchedCount: 999 },
  ] });
  assert.equal(source(summary, 'macauslot').pairedFixtureCount, 1);
  assert.equal(source(summary, 'hkjc').status, 'unavailable');
  assert.equal(source(summary, 'titan007').status, 'missing');
  assert.equal(summary.dualSourceFixtureCount, 0);
});

test('summary is a strict whitelist even with injected secrets, prices and forged aggregates', () => {
  const summary = summarize(pair('macauslot'), { diagnostics: [{ id: 'macauslot', status: 'available', token: 'sensitive-token',
    code: '<script>attack</script>', probability: .99, decimalOdds: 1.9, quoteCount: 100000 }],
    signals: [{ probability: .99, selection: 'home', token: 'sensitive-token' }],
    crawler: { apiKey: 'sensitive-token' }, releaseGate: 'GREEN', sources: [{ quoteCount: 100000 }] });
  assert.deepEqual(Object.keys(summary).sort(), ['version', 'checkedAt', 'expiresAt', 'fixtureCount', 'sources',
    'dualSourceFixtureCount', 'alignedEligibleFixtureCount', 'trueOpeningFixtureCount', 'releaseGate'].sort());
  for (const row of summary.sources) assert.deepEqual(Object.keys(row).sort(), ['id', 'group', 'status', 'quoteCount',
    'pairedFixtureCount', 'latestSourceUpdatedAt', 'openingCount'].sort());
  assert.doesNotMatch(JSON.stringify(summary), /sensitive-token|probability|selection|decimalOdds|script|apiKey/);
  assert.equal(source(summary, 'macauslot').quoteCount, 2);
  assert.equal(summary.releaseGate, 'BLOCKED');
});

test('expired, changed or already-started fixtures do not contribute market readiness', () => {
  for (const changed of [{ ...fixture, updatedAt: at(-86400001) }, { ...fixture, status: 'IN_PLAY' },
    { ...fixture, kickoff: at(-1) }, { ...fixture, kickoff: at(8 * 86400000) }]) {
    const quotes = [...pair('macauslot'), ...pair('hkjc')].map(row => ({ ...row, fixtureSnapshot: { ...changed } }));
    assert.equal(summarize(quotes, {}, now, [changed]).dualSourceFixtureCount, 0);
  }
});

test('collector forwards shared transport, budget, clock, signal, credentials and durable state paths', async () => {
  const env = { TEST_KEY: 'private-key' }, controller = new AbortController(), remaining = () => 50000;
  const fetchImpl = async () => { throw new Error('no real requests'); };
  let calls = 0;
  const result = await collectMarketObservation({ fixtures: [fixture], statePath: '/tmp/observation-crawler.json',
    clock: () => now, remaining, signal: controller.signal, fetchImpl, env }, { collectEvidence: async args => {
    calls++;
    assert.equal(args.statePath, '/tmp/observation-crawler.json');
    assert.equal(args.providerStatePath, '/tmp/observation-crawler.json.providers.json');
    assert.equal(args.fetchImpl, fetchImpl); assert.equal(args.env, env); assert.equal(args.remaining, remaining);
    assert.equal(args.signal, controller.signal); assert.equal(args.nowISO, now);
    return { quotes: [...pair('macauslot'), ...pair('hkjc')], signals: [{ probability: .75 }],
      diagnostics: [{ id: 'macauslot', status: 'partial' }], marketStates: [], crawler: { requestCount: 4 } };
  } });
  assert.equal(calls, 1);
  assert.equal(result.summary.alignedEligibleFixtureCount, 1);
  assert.equal(result.privateEvidence.quotes.length, 4);
  assert.equal(result.privateEvidence.signals[0].probability, .75);
  assert.doesNotMatch(JSON.stringify(result.summary), /private-key|probability|requestCount/);
});

test('long collection uses completion clock so quotes expiring during requests are stale', async () => {
  let ticks = 0;
  const result = await collectMarketObservation({ fixtures: [fixture], clock: () => ticks++ ? at(300001) : now },
    { collectEvidence: async () => ({ quotes: pair('macauslot') }) });
  assert.equal(result.summary.checkedAt, at(300001));
  assert.equal(source(result.summary, 'macauslot').status, 'stale');
});

test('all-source rejection is an unavailable observation with sanitized diagnostics', async () => {
  const result = await collectMarketObservation({ fixtures: [fixture], clock: () => now },
    { collectEvidence: async () => { throw new Error('https://private.example/?token=do-not-log'); } });
  assert.ok(result.summary.sources.every(row => row.status === 'unavailable' && row.quoteCount === 0));
  assert.doesNotMatch(JSON.stringify(result), /do-not-log|private.example/);
  assert.equal(result.summary.releaseGate, 'BLOCKED');
});

test('empty fixtures preserve legitimate zero and skip collection, invalid identities fail before transport', async () => {
  const options = { collectEvidence: async () => { assert.fail('transport must not run'); } };
  const result = await collectMarketObservation({ fixtures: [], clock: () => now }, options);
  assert.equal(result.summary.fixtureCount, 0);
  assert.equal(result.summary.dualSourceFixtureCount, 0);
  assert.ok(result.summary.sources.every(row => row.status === 'missing' && row.quoteCount === 0));
  await assert.rejects(collectMarketObservation({ fixtures: [fixture, { ...fixture, home: 'conflict' }], clock: () => now }, options), /CONFLICTING_FIXTURE_ID/);
  assert.throws(() => summarizeMarketObservation({ fixtures: [], checkedAt: 'bad' }), /MARKET_OBSERVATION_TIME_INVALID/);
});

test('clock rollback and malformed evidence fail closed', async () => {
  let ticks = 0;
  await assert.rejects(collectMarketObservation({ fixtures: [fixture], clock: () => ticks++ ? at(-1) : now },
    { collectEvidence: async () => ({}) }), /MARKET_OBSERVATION_CLOCK_REGRESSED/);
  assert.throws(() => summarize([], { quotes: 'bad' }), /MARKET_EVIDENCE_INVALID/);
});
