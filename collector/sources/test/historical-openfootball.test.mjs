import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HISTORICAL_SOURCE_POLICY, OPENFOOTBALL_FILES, importOpenFootballHistory,
  openFootballHistoryUrl, prepareOpenFootballMappingPlan } from '../historical-openfootball.mjs';

const COMMIT = 'e6744429ee395bc86f247348c6184bb08d4eb361';
const NOW = '2026-10-31T10:04:11.541872+00:00';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
// Exact rows from pinned 2026-27/fr.1.json, read 2026-10-31. The full
// independently downloaded snapshots are verified by the opt-in test below.
const actualMatch = { round: 'Matchday 1', date: '2026-08-21', time: '20:45',
  team1: 'Olympique de Marseille', team2: 'RC Strasbourg Alsace', score: { ht: [0, 0], ft: [4, 0] } };
const reportedScore = { round: 'Matchday 1', date: '2026-08-22', time: '20:45',
  team1: 'ES Troyes AC', team2: 'Paris FC', score: [0, 0] };
const document = matches => ({ name: 'French Ligue 1 2026/27', matches });
const importRows = (rows, overrides = {}) => {
  const bytes = JSON.stringify(document(rows));
  return importOpenFootballHistory(bytes, { league: 'FL1', season: '2026-27', sourceCommit: COMMIT,
    sourceFetchedAt: NOW, expectedSha256: sha(bytes), ...overrides });
};

test('real source row preserves unknown UTC/IDs and actual acquisition visibility', () => {
  const result = importRows([actualMatch]);
  const [row] = result.records;
  assert.equal(row.source, 'openfootball');
  assert.equal(row.home, actualMatch.team1);
  assert.equal(row.localTime, '20:45');
  assert.equal(row.date, '2026-08-21');
  for (const key of ['kickoff', 'timezone', 'homeTeamId', 'awayTeamId', 'sourceFixtureId', 'sourceUpdatedAt']) assert.equal(row[key], null);
  assert.equal(row.observedAt, '2026-10-31T10:04:11.541Z');
  assert.equal(row.resultObservedAt, row.observedAt);
  assert.equal(row.sourceFetchedAtRaw, NOW);
  assert.equal(row.visibility, 'snapshot');
  assert.equal(row.modelReady, false);
  assert.equal(result.releaseGate, 'BLOCKED');
  assert.equal(result.coverage.modelReady, 0);
  assert.equal(result.manifest.license.license, 'CC0-1.0');
  assert.equal(result.manifest.license.thirdPartyRights, 'not-warranted');
  assert.equal(HISTORICAL_SOURCE_POLICY.footballDataCsv.status, 'BLOCKED');
});

test('generic reported scores remain replayable but are not assumed full-time', () => {
  const result = importRows([actualMatch, reportedScore, { ...actualMatch, round: 'Matchday 2', score: { ft: [1, 0], et: [2, 0] } }]);
  assert.equal(result.records.length, 1);
  assert.equal(result.quarantined.length, 2);
  assert.deepEqual(result.quarantined[0].raw, reportedScore);
  assert.equal(result.quarantined[0].reason, 'FULL_TIME_SCORE_UNPROVEN');
  assert.equal(result.coverage.incompleteResultSelection, true);
  assert.ok(result.manifest.limitations.includes('QUARANTINED_RESULTS_CAN_BIAS_EVALUATION'));
});

test('deduplicates identical rows; isolates conflicting scores or reschedules without selecting a winner', () => {
  const duplicate = importRows([actualMatch, structuredClone(actualMatch)]);
  assert.equal(duplicate.records.length, 1);
  assert.equal(duplicate.coverage.duplicates, 1);
  for (const changed of [{ ...actualMatch, date: '2026-08-22' }, { ...actualMatch, round: 'Matchday 2' }, { ...actualMatch, score: { ft: [0, 4] } }]) {
    const conflict = importRows([actualMatch, changed]);
    assert.equal(conflict.records.length, 0);
    assert.equal(conflict.quarantined.length, 2);
    assert.ok(conflict.quarantined.every(row => row.reason === 'SOURCE_MATCH_REVISION_CONFLICT'));
  }
});

test('home/away and source names never merge through fuzzy team matching', () => {
  const result = importRows([actualMatch,
    { ...actualMatch, team1: actualMatch.team2, team2: actualMatch.team1 }, { ...actualMatch, team1: 'Marseille' }]);
  assert.equal(new Set(result.records.map(row => row.sourceMatchKey)).size, 3);
  assert.equal(new Set(result.records.map(row => row.sourceRecordId)).size, 3);
});

test('rejects malformed, future and canceled result rows without fabricating defaults', () => {
  const rows = [
    { ...actualMatch, date: '2026-02-30' }, { ...actualMatch, time: '25:00' },
    { ...actualMatch, date: '2027-04-01' }, { ...actualMatch, status: 'canceled' },
    { ...actualMatch, team2: actualMatch.team1 }, { ...actualMatch, score: { ft: ['4', 0] } },
    { ...actualMatch, score: { ft: [4] } }, { ...actualMatch, date: '2024-08-21' },
    { ...actualMatch, score: { ft: [1, 0], ht: [2, 0] } },
  ];
  const result = importRows(rows);
  assert.equal(result.records.length, 0);
  assert.equal(result.quarantined.length, rows.length);
  const unscored = importRows([{ ...actualMatch, score: undefined, status: 'canceled' },
    { ...actualMatch, score: undefined, date: '2027-01-02' }]);
  assert.equal(unscored.coverage.unscored, 2);
  assert.equal(unscored.coverage.unscoredPastDate, 1);
});

test('provenance must pin one official league/season path, immutable commit and exact bytes', () => {
  assert.match(openFootballHistoryUrl({ league: 'PL', season: '2025-26', sourceCommit: COMMIT }), /2025-26\/en\.1\.json$/);
  for (const patch of [{ league: '../PL' }, { season: '2025-28' }, { sourceCommit: 'master' },
    { expectedSha256: '0'.repeat(64) }, { sourceFetchedAt: '2026-10-31' }, { sourceFetchedAt: '2026-02-30T00:00:00Z' }]) {
    assert.throws(() => importRows([actualMatch], patch));
  }
  assert.throws(() => importRows([actualMatch], { league: 'PL' }), /COMPETITION_MISMATCH/);
  const raw = Buffer.from([0xff, 0xff]);
  assert.throws(() => importOpenFootballHistory(raw, { league: 'FL1', season: '2026-27', sourceCommit: COMMIT,
    sourceFetchedAt: NOW, expectedSha256: sha(raw) }), /INVALID_HISTORICAL_JSON/);
});

test('acquisition changes provenance without rewriting the source match/record revision', () => {
  const first = importRows([actualMatch]);
  const later = importRows([actualMatch], { sourceFetchedAt: '2026-11-01T10:00:00Z' });
  assert.equal(first.records[0].sourceMatchKey, later.records[0].sourceMatchKey);
  assert.equal(first.records[0].recordHash, later.records[0].recordHash);
  assert.notEqual(first.manifestHash, later.manifestHash);
  const revised = importRows([{ ...actualMatch, score: { ft: [3, 0] } }]);
  assert.equal(first.records[0].sourceMatchKey, revised.records[0].sourceMatchKey);
  assert.notEqual(first.records[0].revisionId, revised.records[0].revisionId);
});

test('mapping work queue is bound to original evidence and cannot silently promote guesses', () => {
  const archive = importRows([actualMatch, reportedScore]);
  const plan = prepareOpenFootballMappingPlan(archive);
  assert.equal(plan.sourceManifestHash, archive.manifestHash);
  assert.equal(plan.releaseGate, 'BLOCKED');
  assert.equal(plan.events[0].kickoff, null);
  assert.equal(plan.events[0].recordHash, archive.records[0].recordHash);
  assert.equal(plan.scoreReview.length, 1);
  assert.ok(plan.teams.every(row => row.providerTeamId === null));
  archive.records[0].homeGoals = 9;
  assert.throws(() => prepareOpenFootballMappingPlan(archive), /INVALID_HISTORICAL_ARCHIVE/);
});

test('bounded snapshots reject excessive bytes/rows', () => {
  const options = { league: 'FL1', season: '2026-27', sourceCommit: COMMIT, sourceFetchedAt: NOW };
  const bytes = Buffer.alloc(2_000_001, ' ');
  assert.throws(() => importOpenFootballHistory(bytes, { ...options, expectedSha256: sha(bytes) }), /SIZE_LIMIT/);
  assert.throws(() => importRows(Array(3001).fill(actualMatch)), /INVALID_HISTORICAL_DOCUMENT/);
});

// Opt in with a root-owned, independently downloaded directory. This test never
// fetches or writes files; CI without the public snapshots reports an explicit skip.
const snapshotDirectory = process.env.OPENFOOTBALL_SNAPSHOT_DIRECTORY;
test('ten actual pinned snapshots: five leagues, two seasons, exact hashes and honest coverage', { skip: !snapshotDirectory }, async () => {
  const expected = {
    '2025-26': { PL: [353, 27, 'd6070bdf731546ccf97767f062e8af4bd26dd309dee69f6092025bf9c78f43c1'], BL1: [294, 12, '17d0999db6281e6365823acdbce41a4f01dd469eac63e1f897e4e47c02906672'],
      PD: [365, 15, 'b40397d8e62c640138548d57a1a9f76150549213d2a07fcbbb90ed0eabc6ccea'], SA: [344, 36, '28f7773dea86345aeb0cbb4aff2f90231033f7ed855219e70fdd1cf45d4d7e7f'], FL1: [282, 23, '3e9403445dd96f4bb7f740de22d4ea7e3ea7d640777a12eab621ae4d4dbf3bc7'] },
    '2026-27': { PL: [45, 5, 'bb91f0ab3e8359df163bb9ec98549bfed85e200dd4c32f3bd606b5890d932dd2'], BL1: [33, 3, '07fab65d4a1de8ce4c8472da9ccf4d1d2b145ecd5abdc5b6d4250a5c119d7681'],
      PD: [64, 5, '4b1a9906e3f2b279a1f25497a38f2f58e21ec19ea726b882fa646da7c07bc0e0'], SA: [50, 0, '721a6c220fecb8208287e41401fa2fce652cd23765ce58a39bf98cdaa3d528ad'], FL1: [41, 4, 'f875275f835e378fc8c4e7d48c7a2f327e7d426237bd057fe652fd47f30b5a4f'] },
  };
  let received = 0, results = 0, quarantined = 0;
  for (const [season, leagues] of Object.entries(expected)) for (const [league, [count, rejected, hash]] of Object.entries(leagues)) {
    const path = join(snapshotDirectory, season, OPENFOOTBALL_FILES[league]);
    const [bytes, metadataText] = await Promise.all([readFile(path), readFile(`${path}.meta.json`, 'utf8')]);
    const metadata = JSON.parse(metadataText);
    assert.equal(metadata.sha256, hash);
    assert.equal(metadata.commit, COMMIT);
    const archive = importOpenFootballHistory(bytes, { league, season, sourceCommit: metadata.commit,
      sourceFetchedAt: metadata.fetchedAt, expectedSha256: hash });
    assert.equal(archive.manifest.sourceUrl, metadata.url);
    assert.equal(archive.coverage.retainedResults, count);
    assert.equal(archive.coverage.quarantined, rejected);
    assert.equal(archive.coverage.modelReady, 0);
    if (season === '2026-27') assert.equal(archive.coverage.latestResultDate, '2026-09-20');
    received += archive.coverage.received; results += count; quarantined += rejected;
  }
  assert.deepEqual({ received, results, quarantined }, { received: 3504, results: 1871, quarantined: 130 });
});
