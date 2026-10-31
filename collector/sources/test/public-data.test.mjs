import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchPublicFixtures, fetchPublicResults, parsePublicFixtures, parseOpenLigaHistory } from '../public-fixtures.mjs';
import { publicInputMetadata } from '../../data/coverage.mjs';

const NOW = '2026-10-31T04:00:00.000Z', LATER = '2026-10-31T05:00:00.000Z';
const scheduled = () => ({ matchID: 7, leagueShortcut: 'bl1', leagueSeason: 2026,
  team1: { teamId: 1, teamName: 'Home' }, team2: { teamId: 2, teamName: 'Away' },
  matchDateTimeUTC: '2026-11-01T14:30:00Z', matchIsFinished: false, matchResults: [] });
const historical = (season, id) => ({ ...scheduled(), matchID: id, leagueSeason: season,
  matchDateTimeUTC: season === 2025 ? '2026-05-01T14:30:00Z' : '2026-10-01T14:30:00Z', matchIsFinished: true,
  matchResults: [{ resultTypeKind: 'After90Minutes', pointsTeam1: 2, pointsTeam2: 1 }] });
const json = (data, now, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { Date: new Date(now).toUTCString(), ...headers } });
async function workspace(t) { const path = await mkdtemp(join(tmpdir(), 'public-data-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('public history cache reduces prior-season calls without refreshing observation or fixture time', async t => {
  const historyCachePath = join(await workspace(t), 'history.json'), calls = []; let now = NOW;
  const fetchImpl = async url => {
    calls.push(url);
    return json(url.endsWith('/2025') ? [historical(2025, 9)] : url.endsWith('/2026') ? [scheduled(), historical(2026, 8)] : { events: null }, now);
  };
  const run = () => fetchPublicFixtures({ historyCachePath, nowISO: now, clock: () => now, includeHistory: true, fetchImpl });
  const first = await run(); now = LATER; const second = await run();
  assert.equal(calls.filter(url => url.endsWith('/2025')).length, 1);
  assert.equal(calls.filter(url => url.endsWith('/2026')).length, 2);
  assert.equal(second.history.length, 2);
  assert.ok(second.history.every(row => row.observedAt === NOW && row.resultObservedAt === NOW));
  assert.equal(second.history.find(row => row.season === '2025').fetchedAt, NOW);
  assert.equal(second.history.find(row => row.season === '2026').fetchedAt, LATER);
  assert.equal(second.fixtures[0].fetchedAt, LATER);
  assert.equal(second.diagnostics.find(row => row.purpose === 'history' && row.season === '2025').code, 'history_cache_hit');
  assert.equal(first.history[0].sourceUpdatedAt, null);
  assert.equal(second.coverage.find(row => row.league === 'PL').historyStatus, 'not-supported');
  assert.equal(second.coverage.find(row => row.league === 'BL1').historyStatus, 'available');
});

test('cooldown stops the second OpenLiga request in the same round and after restart', async t => {
  const cooldownStatePath = join(await workspace(t), 'cooldown.json'); let calls = 0;
  const fetchImpl = async url => {
    if (url.includes('openligadb')) { calls++; return json({}, NOW, 429, { 'Retry-After': '86400' }); }
    return json({ events: null }, NOW);
  };
  const args = { cooldownStatePath, nowISO: NOW, clock: () => NOW, includeHistory: true, fetchImpl };
  const first = await fetchPublicFixtures(args), second = await fetchPublicFixtures(args);
  assert.equal(calls, 1);
  assert.equal(first.diagnostics[1].code, 'source_cooldown');
  assert.equal(second.diagnostics[0].code, 'source_cooldown');
  const input = publicInputMetadata(second), german = input.coverage.find(row => row.league === 'BL1');
  assert.equal(german.historyStatus, 'unavailable');
  assert.ok(input.fixtureDiagnostics.some(row => row.nextProbeAt === '2026-11-01T04:00:00.000Z'));
  assert.ok(!JSON.stringify(input).includes('endpoint'));
});

test('logical duplicate events are quarantined and diagnostics retain parser quality counts', () => {
  const fixture = scheduled();
  const parsed = parsePublicFixtures([fixture, { ...fixture, matchID: 77 }], { source: 'openligadb', league: 'BL1', season: 2026, nowISO: NOW });
  assert.equal(parsed.fixtures.length, 0); assert.equal(parsed.rejectedCount, 2);
  const past = historical(2026, 8);
  const history = parseOpenLigaHistory([past, { ...past, matchID: 88 }], { season: 2026, nowISO: NOW });
  assert.equal(history.history.length, 0); assert.equal(history.rejectedCount, 2);
});

test('coverage distinguishes a failed history request from unsupported leagues and retains safe diagnostic fields', async () => {
  const manifest = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, includeHistory: true,
    fetchImpl: async url => url.endsWith('/2025') ? json({}, NOW, 503)
      : json(url.endsWith('/2026') ? [scheduled(), historical(2026, 8)] : { events: null }, NOW) });
  const metadata = publicInputMetadata(manifest);
  const bl1 = metadata.coverage.find(row => row.league === 'BL1');
  assert.equal(bl1.historyStatus, 'partial'); assert.equal(bl1.historyCount, 1);
  assert.ok(bl1.diagnostics.some(row => row.code === 'http_unavailable' && row.httpStatus === 503));
  assert.ok(metadata.coverage.every(row => row.complete === false && row.expectedFixtureCount === null));
  assert.throws(() => publicInputMetadata({ ...manifest, diagnostics: [{ ...manifest.diagnostics[0], code: 'arbitrary private text' }] }), /INVALID_PUBLIC_DIAGNOSTICS/);
});

test('results refresh requests only the current season and does not reacquire other fixtures', async () => {
  const calls = [];
  const result = await fetchPublicResults({ nowISO: NOW, clock: () => NOW, fetchImpl: async url => {
    calls.push(url); return json([scheduled(), historical(2026, 8)], NOW);
  } });
  assert.deepEqual(calls, ['https://api.openligadb.de/getmatchdata/bl1/2026']);
  assert.equal(result.fixtures.length, 0); assert.equal(result.history.length, 1);
  assert.equal(result.history[0].resultObservedAt, NOW);
});

const sports = new Map([
  ['4328', 'English Premier League'], ['4335', 'Spanish La Liga'],
  ['4332', 'Italian Serie A'], ['4334', 'French Ligue 1'],
]);
function sportsResponse(url) {
  const league = new URL(url).searchParams.get('id');
  return { events: [{ idEvent: league, idLeague: league, strLeague: sports.get(league), strSport: 'Soccer',
    idHomeTeam: '1', idAwayTeam: '2', strHomeTeam: 'Home', strAwayTeam: 'Away',
    dateEvent: '2026-11-01', strTime: '14:30:00', strStatus: 'NS', strPostponed: 'no', intHomeScore: null, intAwayScore: null }] };
}

test('duplicate history cannot discard five leagues of valid fixtures or a successful prior season', async () => {
  const calls = [], duplicate = historical(2026, 8);
  const result = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, includeHistory: true, fetchImpl: async url => {
    calls.push(url);
    return json(url.endsWith('/2026') ? [scheduled(), duplicate, duplicate]
      : url.endsWith('/2025') ? [historical(2025, 9)] : sportsResponse(url), NOW);
  } });
  assert.equal(calls.length, 6);
  assert.equal(result.fixtures.length, 5); assert.equal(new Set(result.fixtures.map(row => row.league)).size, 5);
  assert.deepEqual(result.history.map(row => row.season), ['2025']);
  const metadata = publicInputMetadata(result), bl1 = metadata.coverage.find(row => row.league === 'BL1');
  assert.equal(bl1.fixtureStatus, 'sample'); assert.equal(bl1.historyStatus, 'partial');
  assert.equal(bl1.receivedCount, 4); // Three current rows + one prior row, never count the shared response twice.
  const failed = metadata.fixtureDiagnostics.find(row => row.code === 'duplicate_fixture_id');
  assert.equal(failed.stage, 'history'); assert.equal(failed.purpose, 'history');
  assert.equal(failed.inputCount, 3); assert.equal(failed.historyCount, 0);
  assert.equal(failed.httpStatus, 200); assert.equal(failed.fetchedAt, NOW);
  assert.ok(result.fixtures.every(row => row.observedAt === NOW && row.sourceUpdatedAt === null));
});

test('ambiguous scheduled IDs still fail closed while independently usable history survives', async () => {
  const result = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, includeHistory: true, fetchImpl: async url =>
    json(url.endsWith('/2026') ? [scheduled(), scheduled(), historical(2026, 8)]
      : url.endsWith('/2025') ? [] : sportsResponse(url), NOW) });
  assert.equal(result.fixtures.length, 4); assert.equal(result.history.length, 1);
  assert.equal(result.diagnostics.find(row => row.code === 'duplicate_fixture_id').stage, 'fixtures');
  assert.equal(result.coverage.find(row => row.league === 'BL1').fixtureStatus, 'unavailable');
  // A past/finished event using a future event's ID is also ambiguous.
  assert.throws(() => parsePublicFixtures([scheduled(), historical(2026, 7)],
    { source: 'openligadb', league: 'BL1', season: 2026, nowISO: NOW }), { message: 'duplicate_fixture_id' });
});

test('a corrupt history cache leaves all valid league schedules usable and is never overwritten', async t => {
  const historyCachePath = join(await workspace(t), 'history.json');
  const original = 'corrupt-private-content'; await writeFile(historyCachePath, original);
  const calls = [];
  const result = await fetchPublicFixtures({ historyCachePath, nowISO: NOW, clock: () => NOW, includeHistory: true,
    fetchImpl: async url => { calls.push(url); return json(url.endsWith('/2026') ? [scheduled(), historical(2026, 8)] : sportsResponse(url), NOW); } });
  assert.equal(result.fixtures.length, 5); assert.equal(result.history.length, 0); assert.equal(calls.length, 5);
  assert.ok(!calls.some(url => url.endsWith('/2025')));
  assert.equal(await readFile(historyCachePath, 'utf8'), original);
  assert.ok(!JSON.stringify(result).includes(original));
  const bl1 = publicInputMetadata(result).coverage.find(row => row.league === 'BL1');
  assert.equal(bl1.historyStatus, 'unavailable'); assert.equal(bl1.fixtureCount, 1);
  assert.equal(bl1.diagnostics.filter(row => row.code === 'history_cache_unavailable').length, 2);
  assert.ok(bl1.diagnostics.filter(row => row.purpose === 'history').every(row => row.stage === 'history-cache' && !row.cacheHit));
});

test('a history cache write failure preserves all schedules without replaying requests or claiming cached results', async t => {
  const historyCachePath = join(await workspace(t), 'history.json'), calls = [];
  const result = await fetchPublicFixtures({ historyCachePath, nowISO: NOW, clock: () => NOW, includeHistory: true,
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('/2026')) {
        // The cache loaded successfully; fail its later atomic rename without relying on OS permission settings.
        await mkdir(historyCachePath);
        return json([scheduled(), historical(2026, 8)], NOW);
      }
      return json(sportsResponse(url), NOW);
    } });
  assert.equal(result.fixtures.length, 5); assert.equal(result.history.length, 0);
  assert.equal(calls.length, 5); assert.equal(new Set(calls).size, 5);
  assert.equal((await stat(historyCachePath)).isDirectory(), true);
  const failed = result.diagnostics.filter(row => row.code === 'history_cache_unavailable');
  assert.equal(failed.length, 2); assert.equal(failed[0].httpStatus, 200); assert.equal(failed[0].fetchedAt, NOW);
  assert.ok(failed.every(row => row.historyCount === 0 && row.status === 'unavailable' && !row.cacheHit));
});

test('schedule-only collection never opens a broken or locked history cache', async t => {
  const historyCachePath = join(await workspace(t), 'history.json');
  await writeFile(historyCachePath, 'broken'); await writeFile(`${historyCachePath}.lock`, 'existing-owner');
  const result = await fetchPublicFixtures({ historyCachePath, nowISO: NOW, clock: () => NOW,
    fetchImpl: async url => json(url.includes('openligadb') ? [scheduled()] : sportsResponse(url), NOW) });
  assert.equal(result.fixtures.length, 5);
  assert.ok(result.coverage.every(row => ['not-requested', 'not-supported'].includes(row.historyStatus)));
  assert.equal(await readFile(`${historyCachePath}.lock`, 'utf8'), 'existing-owner');
});

test('failed cache lock cleanup retains already persisted data without replay or deleting changed ownership', async t => {
  const historyCachePath = join(await workspace(t), 'history.json'); let calls = 0;
  const result = await fetchPublicFixtures({ historyCachePath, nowISO: NOW, clock: () => NOW, includeHistory: true,
    fetchImpl: async url => {
      calls++;
      if (url.endsWith('/2026')) {
        await writeFile(`${historyCachePath}.lock`, 'changed-owner');
        return json([scheduled(), historical(2026, 8)], NOW);
      }
      return json(url.endsWith('/2025') ? [] : sportsResponse(url), NOW);
    } });
  assert.equal(calls, 6); assert.equal(result.fixtures.length, 5); assert.equal(result.history.length, 1);
  assert.equal(result.coverage.find(row => row.league === 'BL1').historyStatus, 'partial');
  assert.equal(result.diagnostics.at(-1).code, 'history_cache_unavailable');
  assert.equal(result.diagnostics.at(-1).httpStatus, null);
  assert.equal(await readFile(`${historyCachePath}.lock`, 'utf8'), 'changed-owner');
  assert.ok(Object.values(JSON.parse(await readFile(historyCachePath, 'utf8')).entries).some(row => row.records.length === 1));
});

test('diagnostic stages and sample counts remain sanitized and oversized arrays fail per source', async () => {
  const result = await fetchPublicFixtures({ nowISO: NOW, clock: () => NOW, includeHistory: true,
    fetchImpl: async url => json(url.includes('openligadb') ? Array(10001).fill(null) : sportsResponse(url), NOW) });
  assert.equal(result.fixtures.length, 4); assert.equal(result.history.length, 0);
  assert.ok(result.diagnostics.filter(row => row.id === 'openligadb').every(row => row.code === 'invalid_response' && row.httpStatus === 200));
  assert.throws(() => publicInputMetadata({ ...result, diagnostics: [{ ...result.diagnostics[0], stage: 'private error text' }] }), /INVALID_PUBLIC_DIAGNOSTICS/);
  assert.throws(() => publicInputMetadata({ ...result, diagnostics: [{ ...result.diagnostics[0], inputCount: -1 }] }), /INVALID_PUBLIC_DIAGNOSTICS/);
});
