import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRows, collectHfFixtures, fetchHfTeams, fetchHfOdds, CONFIGS, FD_CODES } from '../sources/hf-soccer-dataset.mjs';

const page = (rows, features = [], total = rows.length) => async () => ({
  ok: true, json: async () => ({ features: features.map((name, i) => ({ feature_idx: i, name })),
    rows: rows.map(row => ({ row })), num_rows_total: total }) });

test('requires no auth but surfaces HTTP failures instead of inventing data', async () => {
  const bad = await fetchRows({ config: 'fixtures', fetchImpl: async () => ({ ok: false, status: 401, body: { cancel: async () => {} } }) });
  assert.equal(bad.error, 'HTTP_401');
  const boom = await fetchRows({ config: 'fixtures', fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(boom.error, 'FETCH_UNCONFIRMED');
});

test('normalizes finished fixtures and skips unfinished or identity-less rows', async () => {
  const rows = [
    { id: 1, status: 'FT', goals_home: 2, goals_away: 1, date_utc: '2020-12-13T19:45:00', home_team_id: 10, away_team_id: 20, league_id: 39, referee_name: 'M. Dean' },
    { id: 2, status: 'NS', goals_home: null, goals_away: null, date_utc: '2020-12-14T19:45:00', home_team_id: 10, away_team_id: 20, league_id: 39 },
    { id: 3, status: 'FT', goals_home: null, goals_away: 1, date_utc: '2020-12-15T19:45:00', home_team_id: 10, away_team_id: 20, league_id: 39 },
    { id: 4, status: 'FT', goals_home: 1, goals_away: 1, date_utc: '2020-12-16T19:45:00', home_team_id: 10, away_team_id: 10, league_id: 39 },
  ];
  const out = await collectHfFixtures({ maxRows: 4, fetchImpl: page(rows) });
  assert.equal(out.rows.length, 1);
  const row = out.rows[0];
  assert.equal(row.source, 'hf-soccer-dataset');
  assert.equal(row.fixtureId, 'hf-1');
  assert.equal(row.homeGoals, 2);
  assert.equal(row.referee, 'M. Dean');
  assert.equal(row.kickoff, '2020-12-13T19:45:00.000Z');
});

test('teams carry football-data name so cross-source mapping is possible', async () => {
  const out = await fetchHfTeams({ maxRows: 3, fetchImpl: page([
    { id: 1718, api_football_id: 3993, name: 'El Paso Locomotive', fd_name: null, rating_mu: 1537.8 },
    { id: 52, api_football_id: 50, name: 'Manchester City', fd_name: 'Manchester City FC', rating_mu: 1900.1 },
    { id: 33, api_football_id: 42, name: 'Arsenal', fd_name: 'Arsenal FC', rating_mu: 1880.5 },
  ]) });
  assert.equal(out.teams.length, 3);
  assert.equal(out.teams[1].fdName, 'Manchester City FC');
  assert.equal(out.teams[2].elo, 1880.5);
  assert.equal(out.teams.filter(t => t.fdName).length, 2);
});

test('odds keep known_at and reject non-odds or undated rows', async () => {
  const out = await fetchHfOdds({ maxRows: 4, fetchImpl: page([
    { fixture_id: 209707, home_win: 1.3, draw: 5.75, away_win: 9, bookmaker: 'Bet365', known_at: '2020-12-13T19:45:00' },
    { fixture_id: 2, home_win: 1.0, draw: 2, away_win: 3, bookmaker: 'X', known_at: '2020-12-13T19:45:00' },
    { fixture_id: 3, home_win: 2, draw: 3, away_win: 4, bookmaker: 'Y', known_at: null },
  ]) });
  assert.equal(out.quotes.length, 1);
  const q = out.quotes[0];
  assert.equal(q.bookmaker, 'Bet365');
  assert.equal(q.knownAt, '2020-12-13T19:45:00.000Z');
  assert.deepEqual(CONFIGS.includes('fixture_lineups'), true);
  assert.equal(FD_CODES.E0, 'PL');
  assert.equal(FD_CODES.D1, 'BL1');
});