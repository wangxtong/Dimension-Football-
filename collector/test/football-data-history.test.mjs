import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFootballDataHistory, HISTORY_LEAGUES } from '../sources/football-data-history.mjs';

const NOW = '2026-11-02T12:00:00.000Z';
function match(overrides = {}) {
  return { id: 1001, utcDate: '2026-10-01T14:00:00Z', status: 'FINISHED', competition: { code: 'PL' },
    homeTeam: { id: 57, name: 'Arsenal FC' }, awayTeam: { id: 61, name: 'Chelsea FC' },
    score: { fullTime: { home: 2, away: 1 } }, season: { startDate: '2026-08-15' }, ...overrides };
}
function responder(byLeague) {
  return async (url) => {
    const league = String(url).match(/competitions\/([A-Z0-9]+)\//)?.[1];
    const body = byLeague[league];
    if (!body) return { ok: false, status: 404, body: { cancel: async () => {} } };
    return { ok: true, json: async () => body };
  };
}

test('maps finished matches into internal history rows with stable identity', async () => {
  const result = await collectFootballDataHistory({ apiKey: 'k', leagues: ['PL'], nowISO: NOW,
    fetchImpl: responder({ PL: { matches: [match()] } }) });
  assert.equal(result.history.length, 1);
  const row = result.history[0];
  assert.equal(row.source, 'football-data.org');
  assert.equal(row.id, 'fd-1001');
  assert.equal(row.league, 'PL');
  assert.equal(row.home, 'Arsenal FC');
  assert.equal(row.homeTeamId, '57');
  assert.equal(row.homeGoals, 2);
  assert.equal(row.awayGoals, 1);
  assert.equal(row.season, '2026');
  assert.equal(row.status, 'FINISHED');
  assert.equal(result.diagnostics[0].status, 'available');
});

test('drops rows without usable identity or full-time score instead of inventing them', async () => {
  const result = await collectFootballDataHistory({ apiKey: 'k', leagues: ['PL'], nowISO: NOW,
    fetchImpl: responder({ PL: { matches: [
      match({ id: 1, score: { fullTime: { home: null, away: null } } }),
      match({ id: 2, homeTeam: { id: 0, name: 'X' } }),
      match({ id: 3, awayTeam: { id: 61, name: 'Chelsea FC' }, homeTeam: { id: 57, name: 'Chelsea FC' } }),
      match({ id: 4, competition: { code: 'SA' } }),
      match({ id: 5, utcDate: 'not-a-date' }),
      match({ id: 6 }),
    ] } }) });
  assert.deepEqual(result.history.map(row => row.id), ['fd-6']);
});

test('transport and HTTP failures degrade per league without throwing', async () => {
  const result = await collectFootballDataHistory({ apiKey: 'k', leagues: ['PL', 'SA'], nowISO: NOW,
    fetchImpl: async (url) => {
      if (String(url).includes('PL')) throw new Error('socket');
      return { ok: false, status: 429, body: { cancel: async () => {} } };
    } });
  assert.equal(result.history.length, 0);
  assert.equal(result.diagnostics.length, 2);
  assert.equal(result.diagnostics[0].code, 'HISTORY_FETCH_UNCONFIRMED');
  assert.equal(result.diagnostics[1].code, 'HISTORY_HTTP_429');
});

test('missing key yields an explicit diagnostic and no network call', async () => {
  let called = false;
  const result = await collectFootballDataHistory({ apiKey: '', nowISO: NOW,
    fetchImpl: async () => { called = true; return { ok: true, json: async () => ({ matches: [] }) }; } });
  assert.equal(called, false);
  assert.equal(result.history.length, 0);
  assert.equal(result.diagnostics[0].code, 'HISTORY_KEY_REQUIRED');
  assert.deepEqual([...HISTORY_LEAGUES], ['PL', 'PD', 'SA', 'BL1', 'FL1']);
});

test('caps per-league rows and de-duplicates identical fixture ids', async () => {
  const many = Array.from({ length: 5 }, (_, i) => match({ id: 1000 + i }));
  const result = await collectFootballDataHistory({ apiKey: 'k', leagues: ['PL'], nowISO: NOW, maxPerLeague: 3,
    fetchImpl: responder({ PL: { matches: [...many, ...many] } }) });
  assert.equal(result.history.length, 3);
  assert.equal(new Set(result.history.map(row => row.id)).size, 3);
});