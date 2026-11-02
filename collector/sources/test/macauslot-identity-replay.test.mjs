import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMacauslot } from '../macauslot.mjs';
import { summarizeMarketObservation } from '../../market-observation.mjs';

const original = JSON.parse(await readFile(new URL('./fixtures/macauslot-20261101.json', import.meta.url), 'utf8'));
const setup = () => structuredClone(original);
const run = s => parseMacauslot(s.events, s.odds, { ...s.options, fixtures: s.fixtures });
const fixtureId = 'tsdb-2482229', eventId = '2063121627711733761';
const event = s => s.events.data.find(row => row.event.ev_id === eventId).event;
const observation = (s, result, checkedAt = s.checkedAt) => summarizeMarketObservation({ fixtures: s.fixtures, checkedAt,
  evidence: { ...result, quotes: [...result.quotes, ...s.otherEvidence.quotes],
    marketStates: [...result.marketStates, ...s.otherEvidence.marketStates] } });

test('real 2026-11-01 excerpt maps four previously unmatched bilingual fixtures without altering the source prices or times', () => {
  const s = setup(), before = JSON.stringify(s), result = run(s);
  assert.equal(s.provenance.simulation, false);
  assert.equal(s.provenance.actionRunId, 41359658475);
  assert.equal(s.provenance.events.cachedTextSha256, 'b63e11e77b53ce31b355af0c953a745eb5ebe778bf62163093bc436022ba9c80');
  assert.equal(s.provenance.odds.cachedTextSha256, '6a494864b2cd5f147f7771cdb5fa2d74777aabb8fac928ce6935f373a2b1893d');
  assert.equal(result.quotes.length, 8);
  assert.equal(result.marketStates.length, 0);
  assert.ok(result.fixtureDiagnostics.every(row => row.code === 'matched'));
  const expected = {
    'tsdb-2482229': [.25, 1.8, -.25, 2.04],
    'tsdb-2489539': [-.25, 2.08, .25, 1.76],
    'tsdb-2494080': [-.25, 2.06, .25, 1.78],
    'tsdb-2506274': [-.25, 1.87, .25, 1.97],
  };
  for (const [id, values] of Object.entries(expected)) {
    const quotes = result.quotes.filter(q => q.fixtureId === id);
    assert.deepEqual(quotes.map(q => q.selection), ['home', 'away']);
    assert.deepEqual(quotes.flatMap(q => [q.handicap, q.decimalOdds]), values);
  }
  assert.ok(result.quotes.every(q => q.observedAt === s.options.observedAt && q.sourceUpdatedAt === s.options.sourceUpdatedAt
    && q.validUntil === '2026-11-01T23:01:06.000Z' && !Object.hasOwn(q, 'opening')));
  assert.equal(JSON.stringify(s), before);
});

test('static reviewed aliases work without keyword metadata and accept the explicit English spelling variants', () => {
  const s = setup(), expected = run(s).quotes;
  for (const row of s.events.data) delete row.event.translateName.keyWord;
  assert.deepEqual(run(s).quotes, expected);
  s.fixtures.find(f => f.id === 'tsdb-2494080').home = 'Newcastle Utd';
  s.fixtures.find(f => f.id === 'tsdb-2506274').home = 'Deportivo A Coruna';
  assert.equal(run(s).quotes.length, 8);
});

test('new aliases still reject near names, reversed sides, wrong league/time and duplicate identities', async t => {
  const changes = {
    nearNameDespiteKeyword: s => { event(s).home_team = '莎索羅青年'; },
    nearEnglishName: s => { s.fixtures.find(f => f.id === fixtureId).home = 'Sassuolo Reserves'; },
    reversedTeams: s => { const e = event(s); [e.home_team, e.away_team] = [e.away_team, e.home_team]; },
    wrongLeague: s => { event(s).eventType.name = '意大利乙組聯賽'; },
    shiftedKickoff: s => { event(s).start_time = '2026-11-03 02:30:00'; },
    duplicateEvent: s => { s.events.data.push(structuredClone(s.events.data.find(r => r.event.ev_id === eventId))); },
    duplicateFixture: s => { s.fixtures.push({ ...s.fixtures.find(f => f.id === fixtureId), id: 'duplicate-local-id' }); },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const s = setup(); change(s); const result = run(s);
    assert.equal(result.quotes.length, 6);
    assert.ok(result.quotes.every(q => q.fixtureId !== fixtureId && q.fixtureId !== 'duplicate-local-id'));
  });
});

test('historical replay aligns two independent sources but has zero genuine openings and cannot authorize release', () => {
  const s = setup(), result = run(s), summary = observation(s, result);
  assert.equal(summary.checkedAt, '2026-11-01T22:57:26.897Z');
  assert.equal(summary.sources.find(row => row.id === 'macauslot').pairedFixtureCount, 4);
  assert.equal(summary.dualSourceFixtureCount, 2);
  assert.equal(summary.alignedEligibleFixtureCount, 2);
  assert.equal(summary.trueOpeningFixtureCount, 0);
  assert.equal(summary.releaseGate, 'BLOCKED');
  assert.equal(summary.expiresAt, '2026-11-01T23:01:06.000Z');
  const expired = observation(s, result, '2026-11-02T00:00:00.000Z');
  assert.equal(expired.dualSourceFixtureCount, 0);
  assert.equal(expired.alignedEligibleFixtureCount, 0);
  assert.ok(expired.sources.every(row => row.quoteCount === 0));
});
