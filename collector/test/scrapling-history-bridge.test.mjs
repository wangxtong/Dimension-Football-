import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readScraplingHistoryBatch, persistScraplingHistoryBatch } from '../data/scrapling-history-bridge.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const FETCHED = '2026-11-02T04:22:03.123456Z';
const item = (id, finished) => ({
  matchID: id, leagueShortcut: 'bl1', leagueSeason: 2025,
  matchDateTimeUTC: '2025-08-22T18:30:00Z',
  team1: { teamId: 40, teamName: 'FC Bayern München' },
  team2: { teamId: 1635, teamName: 'RB Leipzig' },
  matchIsFinished: finished,
  matchResults: finished ? [{ resultTypeKind: 'After90Minutes',
    pointsTeam1: 6, pointsTeam2: 0 }] : [],
});
const projectionRecord = (id, finished) => ({
  fixtureId: id, kickoffUTC: '2025-08-22T18:30:00.000000Z',
  homeTeamId: 40, awayTeamId: 1635,
  home: 'FC Bayern München', away: 'RB Leipzig',
  ft: finished ? [6, 0] : null, resultObservedAtUTC: finished ? FETCHED : null,
});
async function data(t, { mode = 'LIVE_SOURCE_HTTP' } = {}) {
  const temp = await mkdtemp(join(tmpdir(), 'scrapling-node-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, 'immutable'), outputRoot = join(temp, 'mapped');
  await mkdir(directory);
  const raw = Buffer.from(JSON.stringify([item(100, true), item(101, false)]));
  const projection = {
    kind: 'historical-match-results', sourceId: 'openligadb', league: 'BL1',
    seasonStart: 2025, records: [projectionRecord(100, true), projectionRecord(101, false)],
    received: 2, validIdentities: 2, finishedWithVerifiedFT: 1,
    missingOrUnverifiedFT: 1, rejectedIdentity: 0,
    modelReady: false, historicalPregameObserved: false,
  };
  const projected = Buffer.from(JSON.stringify(projection) + '\n');
  const receipt = {
    version: 1, kind: 'public-source-raw-receipt', sourceId: 'openligadb-bl1-history',
    requestedURL: 'https://api.openligadb.de/getmatchdata/bl1/2025',
    season: 2025, fetchedAtUTC: FETCHED,
    serverDateUTC: mode === 'LIVE_SOURCE_HTTP' ? '2026-11-02T04:22:03.000000Z' : null,
    observationMode: mode, httpStatus: mode === 'LIVE_SOURCE_HTTP' ? 200 : null,
    rawSha256: sha(raw), rawBytes: raw.length,
    projectionSha256: sha(projected), recordCount: 2,
    modelReady: false, historicalPregameObserved: false,
    containsVerifiedOdds: false, releaseGate: 'BLOCKED',
  };
  await Promise.all([
    writeFile(join(directory, 'raw.bin'), raw),
    writeFile(join(directory, 'projection.json'), projected),
    writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt)),
  ]);
  return { temp, directory, outputRoot, raw, projected, projection, receipt };
}
test('converts one verified 90-minute FT and excludes one unscored historical fixture', async t => {
  const x = await data(t);
  const batch = await readScraplingHistoryBatch(x);
  assert.equal(batch.kind, 'research-history-batch');
  assert.equal(batch.source, 'openligadb');
  assert.deepEqual(batch.coverage, {
    received: 2, validIdentities: 2, scoredFT: 1,
    missingOrUnverifiedFT: 1, rejectedIdentity: 0,
  });
  assert.equal(batch.records.length, 1);
  assert.equal(batch.records[0].id, 'oldb-100');
  assert.equal(batch.records[0].kickoff, '2025-08-22T18:30:00.000Z');
  assert.equal(batch.records[0].homeGoals, 6);
  assert.equal(batch.records[0].awayGoals, 0);
  assert.equal(batch.records[0].observedAt, '2026-11-02T04:22:03.123Z');
  assert.equal(batch.records[0].sourceUpdatedAt, null);
  assert.equal(batch.historicalPregameObserved, false);
  assert.equal(batch.modelReadyForProspective, false);
  assert.equal(batch.releaseGate, 'BLOCKED');
  assert.equal(batch.rawSha256, x.receipt.rawSha256);
});

test('corrupted raw fails even if old projection and receipt still look valid', async t => {
  const x = await data(t);
  await writeFile(join(x.directory, 'raw.bin'), Buffer.from('{"changed":true}'));
  await assert.rejects(readScraplingHistoryBatch(x), /SCRAPLING_BRIDGE_HASH_MISMATCH/);
});

test('a forged projection score is rejected even if forged projection hash is updated', async t => {
  const x = await data(t);
  x.projection.records[0].ft = [0, 6];
  const projected = Buffer.from(JSON.stringify(x.projection) + '\n');
  x.receipt.projectionSha256 = sha(projected);
  await writeFile(join(x.directory, 'projection.json'), projected);
  await writeFile(join(x.directory, 'receipt.json'), JSON.stringify(x.receipt));
  await assert.rejects(readScraplingHistoryBatch(x), /SCRAPLING_BRIDGE_SOURCE_PROJECTION_MISMATCH/);
});

test('fake online receipt cannot claim HTTP success or supplier response timestamp', async t => {
  const x = await data(t);
  x.receipt.serverDateUTC = null;
  await writeFile(join(x.directory, 'receipt.json'), JSON.stringify(x.receipt));
  await assert.rejects(readScraplingHistoryBatch(x), /SCRAPLING_BRIDGE_(TIME_INVALID|RECEIPT_IDENTITY_INVALID)/);
});

test('offline-mode archive preserves no-live observation evidence', async t => {
  const x = await data(t, { mode: 'OFFLINE_VERIFIED_INPUT' });
  const result = await readScraplingHistoryBatch(x);
  assert.equal(result.observationMode, 'OFFLINE_VERIFIED_INPUT');
  assert.equal(result.providerResponseAt, null);
});

test('append-only normalized result survives a second process-safe read and rejects replacement', async t => {
  const x = await data(t);
  const first = await persistScraplingHistoryBatch(x);
  assert.equal(first.status, 'RESEARCH_HISTORICAL_RAW_IMPORTED');
  assert.equal(first.created, true);
  const second = await persistScraplingHistoryBatch(x);
  assert.equal(second.created, false);
  assert.equal(second.batchSha256, first.batchSha256);
  const bytes = await readFile(first.outputFile);
  assert.equal(sha(bytes), first.batchSha256);
  await writeFile(first.outputFile, '{}');
  await assert.rejects(persistScraplingHistoryBatch(x), /SCRAPLING_BRIDGE_IMMUTABLE_ARCHIVE_CONFLICT/);
});

test('symlinked evidence files are rejected rather than read as trusted raw', async t => {
  const x = await data(t);
  await rm(join(x.directory, 'raw.bin'));
  await symlink(join(x.temp, 'other'), join(x.directory, 'raw.bin'));
  await assert.rejects(readScraplingHistoryBatch(x), /SCRAPLING_BRIDGE_FILE_INVALID/);
});
