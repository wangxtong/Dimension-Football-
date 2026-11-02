import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOpenFootballSeason, collectOpenFootballHistory, OPENFOOTBALL_LEAGUES } from '../sources/openfootball.mjs';

function payload(matches, name = 'Test League 2025/26') { return { name, matches }; }
function match(over = {}) {
  return { date: '2025-08-15', time: '20:00', round: 'Matchday 1',
    team1: 'Liverpool FC', team2: 'AFC Bournemouth', score: { ft: [4, 2], ht: [2, 0] }, ...over };
}
const responder = body => async () => ({ ok: true, json: async () => body });

test('maps openfootball matches into normalized history rows', async () => {
  const r = await fetchOpenFootballSeason({ season: '2025-26', league: 'en.1', fetchImpl: responder(payload([match()])) });
  assert.equal(r.error, undefined);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.equal(row.source, 'openfootball');
  assert.equal(row.league, 'PL');
  assert.equal(row.home, 'Liverpool FC');
  assert.equal(row.homeGoals, 4);
  assert.equal(row.awayGoals, 2);
  assert.equal(row.kickoff, '2025-08-15T20:00:00.000Z');
  assert.equal(row.status, 'FINISHED');
  assert.equal(row.round, 'Matchday 1');
});

test('drops rows without a usable score, date or distinct teams', async () => {
  const r = await fetchOpenFootballSeason({ season: '2025-26', league: 'en.1', fetchImpl: responder(payload([
    match({ score: {} }), match({ score: { ft: [null, 1] } }), match({ score: { ft: [21, 0] } }),
    match({ date: 'not-a-date' }), match({ team1: 'A', team2: 'A' }), match({ team1: '' }),
    match({ score: { ft: [1, 0] } }),
  ])) });
  assert.equal(r.rows.length, 1);
  assert.equal(r.total, 7);
});

test('refuses unknown league or season instead of guessing', async () => {
  const a = await fetchOpenFootballSeason({ season: '2025-26', league: 'xx.9', fetchImpl: responder(payload([])) });
  assert.equal(a.error, 'UNKNOWN_LEAGUE');
  const b = await fetchOpenFootballSeason({ season: '1999-00', league: 'en.1', fetchImpl: responder(payload([])) });
  assert.equal(b.error, 'UNKNOWN_SEASON');
});

test('degrades on transport and HTTP failures without throwing', async () => {
  const a = await fetchOpenFootballSeason({ season: '2025-26', league: 'en.1', fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(a.error, 'FETCH_UNCONFIRMED');
  const b = await fetchOpenFootballSeason({ season: '2025-26', league: 'en.1',
    fetchImpl: async () => ({ ok: false, status: 503, body: { cancel: async () => {} } }) });
  assert.equal(b.error, 'HTTP_503');
});

test('collectOpenFootballHistory aggregates per-league diagnostics', async () => {
  const r = await collectOpenFootballHistory({ seasons: ['2025-26'], leagues: ['en.1', 'de.1'],
    fetchImpl: responder(payload([match()])) });
  assert.equal(r.rows.length, 2);
  assert.equal(r.diagnostics.length, 2);
  assert.deepEqual(r.diagnostics.map(d => d.league), ['en.1', 'de.1']);
  assert.equal(OPENFOOTBALL_LEAGUES['fr.1'], 'FL1');
});