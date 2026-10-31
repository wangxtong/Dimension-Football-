import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPublicFixtures, parsePublicFixtures } from '../public-fixtures.mjs';
import { runPublic } from '../../public.mjs';

const NOW = '2026-10-31T04:00:00.000Z', KICKOFF = '2026-10-31T14:30:00Z';
const oldb = () => ({ matchID: 7, leagueShortcut: 'bl1', leagueSeason: 2026,
  team1: { teamId: 1, teamName: 'FC Bayern München' }, team2: { teamId: 2, teamName: 'VfB Stuttgart' },
  matchDateTimeUTC: KICKOFF, matchIsFinished: false, matchResults: [], lastUpdateDateTime: '2026-07-01T12:00:00' });
const tsdb = () => ({ idEvent: '100', idLeague: '4328', strLeague: 'English Premier League', strSport: 'Soccer',
  idHomeTeam: '1', idAwayTeam: '2', strHomeTeam: 'Chelsea', strAwayTeam: 'Manchester United',
  dateEvent: '2026-10-31', strTime: '12:30:00', strTimestamp: '2026-10-31T12:30:00',
  strStatus: 'NS', strPostponed: 'no', intHomeScore: null, intAwayScore: null });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { date: new Date(NOW).toUTCString(), ...headers },
});
const parse = (rows, source = 'openligadb') => parsePublicFixtures(source === 'openligadb' ? rows : { events: rows },
  { source, league: source === 'openligadb' ? 'BL1' : 'PL', season: 2026, nowISO: NOW });

test('public schedules keep explicit identities, UTC times, provenance and unknown update time', () => {
  const german = parse([oldb()]).fixtures[0], english = parse([tsdb()], 'thesportsdb-free').fixtures[0];
  assert.equal(german.id, 'oldb-7'); assert.equal(german.league, 'BL1');
  assert.equal(german.kickoff, '2026-10-31T14:30:00.000Z');
  assert.equal(german.sourceUpdatedAt, null); assert.equal(german.updatedAt, NOW);
  assert.equal(english.id, 'tsdb-100'); assert.equal(english.kickoff, '2026-10-31T12:30:00.000Z');
});

test('wrong league, malformed identity, local-only time and duplicate IDs cannot enter the pool', () => {
  for (const patch of [{ leagueShortcut: 'bl2' }, { leagueSeason: 2025 }, { matchDateTimeUTC: '2026-10-31T14:30:00' },
    { matchDateTimeUTC: '2026-02-30T14:30:00Z' }, { team2: { teamId: 1, teamName: 'Other' } }, { matchID: -1 }]) {
    assert.equal(parse([{ ...oldb(), ...patch }]).fixtures.length, 0);
  }
  assert.throws(() => parse([oldb(), oldb()]), { message: 'duplicate_fixture_id' });
  for (const patch of [{ idLeague: '4335' }, { strLeague: 'Unrelated League' }, { strSport: 'Basketball' },
    { strTime: '' }, { strTime: '00:00:00' }, { strTimestamp: '2026-10-31T13:30:00' }]) {
    assert.equal(parse([{ ...tsdb(), ...patch }], 'thesportsdb-free').fixtures.length, 0);
  }
});

test('finished, scored, postponed and outside-window matches are excluded', () => {
  for (const patch of [{ matchIsFinished: true }, { matchIsFinished: null }, { matchResults: [{ pointsTeam1: 1 }] },
    { matchDateTimeUTC: '2026-10-30T14:30:00Z' }, { matchDateTimeUTC: '2026-11-08T14:30:00Z' }]) {
    assert.equal(parse([{ ...oldb(), ...patch }]).fixtures.length, 0);
  }
  for (const patch of [{ strStatus: 'FT' }, { strStatus: 'Time to be defined' }, { strPostponed: 'yes' }, { intHomeScore: '0' }]) {
    assert.equal(parse([{ ...tsdb(), ...patch }], 'thesportsdb-free').fixtures.length, 0);
  }
  assert.throws(() => parse([tsdb(), tsdb()], 'thesportsdb-free'), { message: 'invalid_response' });
  assert.deepEqual(parse(null, 'thesportsdb-free').fixtures, []);
});

test('public reads use only fixed official endpoints, no private credential and no redirects', async () => {
  const calls = [];
  const report = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, fetchImpl: async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'manual');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'User-Agent']);
    assert.ok(init.headers['User-Agent'].includes('Dimension-Football-'));
    if (url.startsWith('https://api.openligadb.de/')) return json([oldb()]);
    assert.ok(url.startsWith('https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id='));
    return json({ events: url.endsWith('4328') ? [tsdb()] : null });
  } });
  assert.equal(calls.length, 5); assert.equal(report.fixtures.length, 2);
  assert.equal(report.simulated, false); assert.equal(report.poolComplete, false);
  assert.ok(report.diagnostics.every(row => row.status === 'partial'));
});

test('failures are isolated and rate-limit metadata is retained without retrying', async () => {
  let calls = 0;
  const result = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, fetchImpl: async url => {
    calls++;
    return url.includes('openligadb') ? json({}, 429, { 'retry-after': '3600' })
      : json({ events: url.endsWith('4328') ? [tsdb()] : null });
  } });
  assert.equal(calls, 5); assert.equal(result.fixtures.length, 1);
  assert.equal(result.diagnostics[0].code, 'rate_limited');
  assert.equal(result.diagnostics[0].retryAfterMs, 3600000);
});

test('redirects, stale responses, oversized bodies, HTML and secret-bearing exceptions fail safely', async () => {
  const cases = [
    [() => json({}, 302, { location: 'https://private.invalid/' }), 'redirect_blocked'],
    [() => json({}, 401), 'authorization_required'],
    [() => json({}, 200, { date: 'Thu, 01 Jan 1970 00:00:00 GMT' }), 'stale_response'],
    [() => json({}, 200, { 'content-length': '2000001' }), 'response_too_large'],
    [() => new Response('<html>login</html>', { headers: { date: new Date(NOW).toUTCString() } }), 'invalid_json'],
    [() => { throw new Error('private-key-must-not-appear'); }, 'network_unavailable'],
  ];
  for (const [fetchImpl, code] of cases) {
    const result = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, fetchImpl });
    assert.equal(result.fixtures.length, 0); assert.ok(result.diagnostics.every(row => row.code === code));
    assert.ok(!JSON.stringify(result).includes('private-key-must-not-appear'));
  }
});

test('timeouts bound a fetch ignoring AbortSignal; cancellation and exhausted budgets stop further requests', async () => {
  const timed = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  assert.ok(timed.diagnostics.every(row => row.code === 'timeout'));
  const controller = new AbortController(); let calls = 0;
  const cancelled = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, signal: controller.signal, fetchImpl: async () => {
    calls++; controller.abort(); return json([]);
  } });
  assert.equal(calls, 1); assert.equal(cancelled.diagnostics[0].code, 'cancelled');
  const exhausted = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, remaining: () => 0,
    fetchImpl: () => assert.fail('budget exhausted') });
  assert.equal(exhausted.diagnostics[0].code, 'budget_exhausted');
});

test('a window crossing the season boundary requests both seasons and never claims full coverage', async () => {
  const calls = [];
  const result = await fetchPublicFixtures({ nowISO: '2026-06-29T04:00:00.000Z', clock: () => NOW,
    fetchImpl: async url => { calls.push(url); return json(url.includes('openligadb') ? [] : { events: null }); } });
  assert.equal(calls.length, 6); assert.ok(calls.some(url => url.endsWith('/2025'))); assert.ok(calls.some(url => url.endsWith('/2026')));
  assert.equal(result.poolComplete, false);
});

test('public CLI connects real-shaped fixtures to existing analysis and retains attribution separately', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'football-public-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const result = await runPublic(['--collect'], { cwd, env: {}, clock: () => NOW, stdout: () => {}, fetchImpl: async url => {
    if (url.includes('api.openligadb.de')) return json([oldb()]);
    if (url.includes('thesportsdb.com')) return json({ events: null });
    // Public evidence unavailable: this must produce source_insufficient, never fake candidates.
    return new Response('User-agent: *\nDisallow: /', { headers: { date: new Date(NOW).toUTCString() } });
  } });
  assert.equal(result.exitCode, 0); assert.equal(result.collection.report.simulated, false);
  assert.equal(result.collection.report.poolComplete, false); assert.equal(result.collection.report.summary.total, 1);
  assert.equal(result.collection.report.summary.candidates, 0);
  assert.equal(result.collection.report.summary.sourceInsufficient, 1);
  const attribution = JSON.parse(await readFile(join(cwd, 'reports/public/openligadb-fixtures.json'), 'utf8'));
  assert.equal(attribution.attribution.license, 'ODbL-1.0'); assert.equal(attribution.fixtures.length, 1);
  assert.ok((await readFile(join(cwd, 'reports/public/public-sources.md'), 'utf8')).includes('完整覆盖：否'));
  assert.ok((await readFile(result.collection.files.briefPath, 'utf8')).includes('ODbL-1.0'));
});
