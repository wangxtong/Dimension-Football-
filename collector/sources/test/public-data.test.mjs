import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  assert.equal(second.diagnostics.find(row => row.purpose === 'history').code, 'history_cache_hit');
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
