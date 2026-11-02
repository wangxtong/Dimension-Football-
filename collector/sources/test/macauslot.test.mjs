import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMacauslot, fetchMacauslotEvidence, macauslotTime, macauslotHandicap, MACAUSLOT_EVENTS, MACAUSLOT_ODDS } from '../macauslot.mjs';

const original = JSON.parse(await readFile(new URL('./fixtures/macauslot-20261031.json', import.meta.url), 'utf8'));
const setup = () => structuredClone(original);
const run = s => parseMacauslot(s.events, s.odds, { ...s.options, fixtures: s.fixtures });
const eventId = '2068079847081443329', fixtureId = 'tsdb-2494084';
const selected = s => ({ event: s.events.data.find(r => r.event.ev_id === eventId).event,
  config: s.events.odds_config.find(c => c.BETTING_ID === eventId), batch: s.odds.data.find(r => r.ev_id === eventId),
  market: s.odds.data.find(r => r.ev_id === eventId).markets.find(m => m.is_current === '1') });

test('real official excerpt: 12 unique prematch fixtures, 24 decimal quotes, one missing event and no opening', () => {
  const s = setup(), before = JSON.stringify(s), r = run(s);
  assert.equal(s.provenance.simulation, false);
  assert.equal(s.provenance.odds.sha256, '475f106698ada0e6a4d2c2b3c1f1da3ec3cfa6650d6aee63627b26923de08d70');
  assert.equal(r.quotes.length, 24);
  assert.equal(new Set(r.quotes.map(q => q.fixtureId)).size, 12);
  assert.equal(r.marketStates.length, 1);
  assert.equal(r.marketStates[0].fixtureId, 'oldb-83234');
  assert.equal(r.marketStates[0].stateReason, 'fixture_identity_unmatched');
  assert.ok(r.quotes.every(q => q.sourceId === 'macauslot' && q.provider === 'macauslot-official' && q.bookmaker === 'Macau SLOT'
    && q.sourceUpdatedAt === '2026-10-31T10:04:36.000Z' && q.quoteTimeBasis === 'whole-file-update'
    && q.transactionUpdatedAt === null && !Object.hasOwn(q, 'opening')));
  const pair = r.quotes.filter(q => q.fixtureId === fixtureId);
  assert.deepEqual(pair.map(q => [q.selection, q.handicap, q.decimalOdds]), [['home', -.5, 2.06], ['away', .5, 1.78]]);
  assert.ok(pair.every(q => q.providerMatchId === eventId && q.providerPoolId === '2114622798281256961'));
  assert.ok(r.quotes.filter(q => q.fixtureId === 'oldb-83219').every(q => Math.abs(q.handicap) === 1.5));
  assert.equal(JSON.stringify(s), before);
});

test('local clock uses explicit Macau offset; signed half-lines retain home/away meaning', () => {
  assert.equal(macauslotTime('2026-11-01 01:30:00'), '2026-10-31T17:30:00.000Z');
  for (const bad of ['2026-02-30 12:00:00', '2026-11-01 25:00:00', '2026-11-01T01:30:00Z', null]) assert.equal(macauslotTime(bad), null);
  for (const [value, want] of [['0/-0.5', -.25], ['0/+0.5', .25], ['-0.5/-1', -.75], ['+1/+1.5', 1.25], ['0', 0]]) assert.equal(macauslotHandicap(value), want);
  for (const bad of ['0/1', '0.25', '1/1.5/2', '0/-0.5junk', '', '-11', null]) assert.equal(macauslotHandicap(bad), null);
});

test('suspended, incomplete, wrong-period or contradictory current markets never use a lower alternative line', async t => {
  const changes = {
    eventHidden: v => { v.event.displayed = 'N'; }, eventClosed: v => { v.event.status = 'S'; },
    inPlay: v => { v.event.state = '1'; }, currentState: v => { v.event.currentState = '1'; },
    configClosed: v => { v.config.S = 4; }, configWrongLeague: v => { v.config.ES = 'ENG2'; },
    conflictingLeagueId: v => { v.event.eventType.ev_type_id = '123'; },
    batchClosed: v => { v.batch.status = 'S'; }, hidden: v => { v.market.displayed = 'N'; },
    suspended: v => { v.market.status = 'S'; }, halfTime: v => { v.market.sort = 'A1'; v.market.outcomeGroup.sort = 'A1'; },
    removedMain: v => { v.market.is_current = '0'; }, duplicateMain: v => { v.batch.markets.push(structuredClone(v.market)); },
    wrongEvent: v => { v.market.ev_id = '123'; }, wrongOutcomeEvent: v => { v.market.outcomes[0].ev_id = '123'; },
    missingSide: v => { v.market.outcomes.pop(); }, duplicateSide: v => { v.market.outcomes[1].type = 'H'; },
    wrongDirection: v => { v.market.outcomes[0].fb_result = 'A'; }, closedSide: v => { v.market.outcomes[0].status = 'S'; },
    contradictoryTeam: v => { v.market.outcomes[0].desc = '曼聯'; },
    hiddenSide: v => { v.market.outcomes[0].displayed = 'N'; }, missingPrice: v => { delete v.market.outcomes[0].lp_num; },
    zeroDenominator: v => { v.market.outcomes[0].lp_den = '0'; }, nonIntegerFraction: v => { v.market.outcomes[0].lp_num = '1060.9'; },
    contradictoryRate: v => { v.market.outcomes[0].rate = '1.86'; }, nonOppositeLines: v => { v.market.away_hcap_disp = '-0.5'; },
    invalidLine: v => { v.market.hcap_disp = '-0.25'; }, currentAlternativeConflict: v => { v.market.hilo_type = '-1'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const s = setup(); change(selected(s)); const r = run(s);
    assert.equal(r.quotes.filter(q => q.fixtureId === fixtureId).length, 0);
    assert.equal(r.quotes.length, 22);
    assert.ok(r.marketStates.some(q => q.fixtureId === fixtureId && q.marketState === 'unavailable'));
  });
});

test('event/config/market joins are unique in both directions and never coerce unsafe IDs', async t => {
  const changes = {
    repeatedEvent: s => { s.events.data.push(structuredClone(s.events.data.find(r => r.event.ev_id === eventId))); },
    repeatedConfig: s => { s.events.odds_config.push(structuredClone(selected(s).config)); },
    repeatedOdds: s => { s.odds.data.push(structuredClone(selected(s).batch)); },
    reusedFixture: s => { s.fixtures.push({ ...s.fixtures[0], id: 'second-local-id' }); },
    unsafeNumericId: s => { selected(s).event.ev_id = Number(eventId); },
    changedKickoff: s => { selected(s).event.start_time = '2026-10-31 21:30:00'; },
    reversedTeams: s => { const e = selected(s).event; [e.home_team, e.away_team] = [e.away_team, e.home_team]; },
    unknownName: s => { selected(s).event.home_team = '車路士青年'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const s = setup(); change(s); const r = run(s);
    assert.ok(!r.quotes.some(q => q.fixtureId === fixtureId || q.fixtureId === 'second-local-id'));
    assert.equal(r.quotes.length, 22);
  });
});

test('future, stale or unbound snapshot timestamps cannot be refreshed by a new local capture or systime', async t => {
  for (const [name, change] of Object.entries({
    futureUpdate: s => { s.options.sourceUpdatedAt = '2026-10-31T10:05:18.000Z'; },
    staleUpdate: s => { s.options.sourceUpdatedAt = '2026-10-31T09:59:00.000Z'; },
    noUpdate: s => { delete s.options.sourceUpdatedAt; },
    futureHttpDate: s => { s.options.sourceAsOf = '2026-10-31T10:06:00.000Z'; },
    modifiedAfterResponse: s => { s.options.sourceAsOf = '2026-10-31T10:04:00.000Z'; },
    staleScheduleCapture: s => { s.options.scheduleObservedAt = '2026-10-31T09:59:00.000Z'; },
    futureLocalClock: s => { s.events.systime = '2026-10-31 18:05:30'; },
    unknownTimezone: s => { s.events.systime = '2026-10-31T10:01:02Z'; },
  })) await t.test(name, () => { const s = setup(); change(s); assert.throws(() => run(s), /stale_snapshot/); });
});

const response = (payload, headers = {}, status = 200) => new Response(JSON.stringify(payload), { status, headers: {
  'content-type': 'application/json', date: 'Sat, 31 Oct 2026 10:05:09 GMT', 'last-modified': 'Sat, 31 Oct 2026 10:04:36 GMT', ...headers } });
function transport(s, calls) {
  const fn = async (url, init) => { calls.push({ url, init }); return response(url === MACAUSLOT_EVENTS ? s.events : s.odds); };
  fn.timeoutMs = 30000; return fn;
}
const fetchOptions = (s, fetchImpl) => ({ fixtures: s.fixtures, nowISO: s.options.observedAt,
  clock: () => s.options.observedAt, remaining: () => 90000, fetchImpl });

test('provider alternatives, arbitrary metadata and injected opening labels never become opening evidence', () => {
  const s = setup();
  for (const batch of s.odds.data) for (const market of batch.markets) Object.assign(market, {
    opening: { basis: 'provider-opening', observedAt: '2026-10-01T00:00:00Z' }, privateMetadata: 'discard-marker',
  });
  const r = run(s);
  assert.equal(r.quotes.length, 24);
  assert.ok(r.quotes.every(q => !q.opening));
  assert.ok(!JSON.stringify(r).includes('discard-marker'));
});

test('P0 denies direct fetch regardless of injected mock transport', async () => {
  const s = setup(), calls = [];
  const evidence = await fetchMacauslotEvidence(fetchOptions(s, async url => {
    calls.push(url); throw Error('NETWORK_CALLED_WHILE_BLOCKED');
  }));
  assert.deepEqual(calls, []);
  assert.equal(evidence.quotes.length, 0);
  assert.equal(evidence.marketStates.length, 0);
  assert.equal(evidence.diagnostics[0].status, 'blocked');
  assert.equal(evidence.diagnostics[0].code, 'ACCESS_BLOCKED');
  assert.ok(evidence.fixtureDiagnostics.every(row => row.code === 'ACCESS_BLOCKED'));
});
