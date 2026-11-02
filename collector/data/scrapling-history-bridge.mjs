import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeHistoryRecord } from './history-cache.mjs';

// Research-only bridge from Scrapling's immutable OpenLigaDB archive to Node history.
// Never inserts forecasts into publication pipelines or invents pre-match observations.
const MAX_RAW = 2_000_000, MAX_JSON = 2_000_000, MAX_ROWS = 500;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const finiteInt = x => Number.isSafeInteger(x) && x > 0;
const invalid = code => { throw new Error('SCRAPLING_BRIDGE_' + code); };
const time = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)) invalid('TIME_INVALID');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) invalid('TIME_INVALID');
  const canonical = new Date(ms).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) invalid('TIME_INVALID');
  return canonical;
};
async function readRegularFile(root, name, max) {
  const path = join(root, name), stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > max) invalid('FILE_INVALID');
  return readFile(path);
}
const safeJSON = bytes => {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('JSON_INVALID'); }
};
function sourceFT(row) {
  if (row?.matchIsFinished !== true || !Array.isArray(row.matchResults)) return null;
  const scores = row.matchResults.filter(r => r?.resultTypeKind === 'After90Minutes');
  if (scores.length !== 1 || ![scores[0]?.pointsTeam1, scores[0]?.pointsTeam2]
    .every(v => Number.isInteger(v) && v >= 0 && v <= 20)) return null;
  return [scores[0].pointsTeam1, scores[0].pointsTeam2];
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function requireTrue(condition, code) { if (!condition) invalid(code); }

/** Convert only independently checked after-the-fact 90-minute FT records. */
export async function readScraplingHistoryBatch({ directory } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) invalid('DIRECTORY_INVALID');
  const root = resolve(directory), stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(root) !== root) invalid('DIRECTORY_INVALID');
  const [raw, projected, receiptBytes] = await Promise.all([
    readRegularFile(root, 'raw.bin', MAX_RAW),
    readRegularFile(root, 'projection.json', MAX_JSON),
    readRegularFile(root, 'receipt.json', 50_000),
  ]);
  const projection = safeJSON(projected), receipt = safeJSON(receiptBytes);
  const season = receipt?.season, observedAt = time(receipt?.fetchedAtUTC);
  const isLive = receipt.observationMode === 'LIVE_SOURCE_HTTP';
  requireTrue(receipt.version === 1 && receipt.kind === 'public-source-raw-receipt'
    && receipt.sourceId === 'openligadb-bl1-history'
    && Number.isInteger(season) && season >= 2010 && season <= 2026
    && receipt.requestedURL === 'https://api.openligadb.de/getmatchdata/bl1/' + season
    && (isLive || receipt.observationMode === 'OFFLINE_VERIFIED_INPUT')
    && (isLive ? receipt.httpStatus === 200 && typeof receipt.serverDateUTC === 'string'
      && Math.abs(Date.parse(time(receipt.serverDateUTC)) - Date.parse(observedAt)) <= 300_000
      : receipt.httpStatus === null)
    && receipt.modelReady === false && receipt.releaseGate === 'BLOCKED'
    && receipt.historicalPregameObserved === false && receipt.containsVerifiedOdds === false,
  'RECEIPT_IDENTITY_INVALID');
  requireTrue(validHash(receipt.rawSha256) && sha256(raw) === receipt.rawSha256
    && receipt.rawBytes === raw.byteLength
    && validHash(receipt.projectionSha256) && sha256(projected) === receipt.projectionSha256,
  'HASH_MISMATCH');
  const source = safeJSON(raw);
  requireTrue(Array.isArray(source) && source.length <= MAX_ROWS
    && projection.kind === 'historical-match-results'
    && projection.sourceId === 'openligadb' && projection.league === 'BL1'
    && projection.seasonStart === season && projection.modelReady === false
    && projection.historicalPregameObserved === false
    && projection.received === source.length
    && Array.isArray(projection.records) && projection.records.length <= MAX_ROWS
    && receipt.recordCount === projection.records.length
    && projection.validIdentities === projection.records.length
    && projection.finishedWithVerifiedFT + projection.missingOrUnverifiedFT === projection.validIdentities
    && projection.rejectedIdentity + projection.validIdentities === projection.received,
  'PROJECTION_INVALID');

  const rawById = new Map();
  for (const row of source) {
    if (!finiteInt(row?.matchID)) continue;
    if (rawById.has(row.matchID)) invalid('DUPLICATE_SOURCE_ID');
    rawById.set(row.matchID, row);
  }
  const records = [], seen = new Set();
  let missingFT = 0;
  for (const record of projection.records) {
    const sourceRow = rawById.get(record?.fixtureId);
    requireTrue(sourceRow && !seen.has(record.fixtureId)
      && sourceRow.leagueShortcut === 'bl1' && sourceRow.leagueSeason === season
      && sourceRow.team1?.teamId === record.homeTeamId && sourceRow.team2?.teamId === record.awayTeamId
      && sourceRow.team1?.teamName?.trim()?.slice(0, 120) === record.home
      && sourceRow.team2?.teamName?.trim()?.slice(0, 120) === record.away
      && time(sourceRow.matchDateTimeUTC) === time(record.kickoffUTC)
      && same(sourceFT(sourceRow), record.ft),
    'SOURCE_PROJECTION_MISMATCH');
    seen.add(record.fixtureId);
    if (record.ft === null) { missingFT++; continue; }
    requireTrue(Array.isArray(record.ft) && record.ft.length === 2
      && record.resultObservedAtUTC === receipt.fetchedAtUTC,
    'RESULT_TIME_INVALID');
    records.push(normalizeHistoryRecord({
      id: 'oldb-' + record.fixtureId, source: 'openligadb',
      sourceFixtureId: String(record.fixtureId),
      league: 'BL1', season: String(season), kickoff: time(record.kickoffUTC),
      home: record.home, away: record.away,
      homeTeamId: String(record.homeTeamId), awayTeamId: String(record.awayTeamId),
      homeGoals: record.ft[0], awayGoals: record.ft[1],
      status: 'FINISHED', period: 'full-time',
      fetchedAt: observedAt, observedAt, resultObservedAt: observedAt, sourceUpdatedAt: null,
    }));
  }
  requireTrue(records.length === projection.finishedWithVerifiedFT
    && missingFT === projection.missingOrUnverifiedFT
    && new Set(records.map(row => row.canonicalMatchId)).size === records.length,
  'RESULT_COVERAGE_MISMATCH');
  records.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
  return {
    version: 1, kind: 'research-history-batch', source: 'openligadb',
    league: 'BL1', season: String(season), observationMode: receipt.observationMode,
    observedAt, providerResponseAt: isLive ? time(receipt.serverDateUTC) : null,
    rawSha256: receipt.rawSha256, rawBytes: raw.byteLength,
    projectionSha256: receipt.projectionSha256,
    coverage: { received: projection.received, validIdentities: projection.validIdentities,
      scoredFT: records.length, missingOrUnverifiedFT: missingFT, rejectedIdentity: projection.rejectedIdentity },
    modelReadyForProspective: false, historicalPregameObserved: false, releaseGate: 'BLOCKED',
    records,
  };
}
/** Save normalized research rows separately, without overwriting original evidence. */
export async function persistScraplingHistoryBatch({ directory, outputRoot } = {}) {
  const batch = await readScraplingHistoryBatch({ directory });
  if (typeof outputRoot !== 'string' || !isAbsolute(outputRoot)) invalid('OUTPUT_ROOT_INVALID');
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (await realpath(root) !== root) invalid('OUTPUT_ROOT_INVALID');
  const content = Buffer.from(JSON.stringify(batch) + '\n');
  // Raw bytes can be identical across different observation times. Preserve
  // each normalized observation while keeping identical replays idempotent.
  const normalizedSha256 = sha256(content);
  const destination = join(root, 'research-' + batch.source + '-' + batch.season
    + '-' + batch.rawSha256 + '-' + normalizedSha256 + '.json');
  let created = false;
  try {
    const f = await open(destination, 'wx', 0o600);
    try { await f.writeFile(content); await f.sync(); created = true; }
    finally { await f.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = await readRegularFile(root, basename(destination), MAX_JSON);
    if (!prior.equals(content)) invalid('IMMUTABLE_ARCHIVE_CONFLICT');
  }
  return { status: 'RESEARCH_HISTORICAL_RAW_IMPORTED',
    source: batch.source, season: batch.season, outputFile: destination,
    batchSha256: normalizedSha256, rawSha256: batch.rawSha256,
    records: batch.records.length, created, modelReadyForProspective: false,
    releaseGate: 'BLOCKED' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [directory, outputRoot] = process.argv.slice(2);
  try {
    process.stdout.write(JSON.stringify(await persistScraplingHistoryBatch({ directory, outputRoot })) + '\n');
  } catch {
    process.stderr.write('SCRAPLING_HISTORY_BRIDGE_FAILED\n');
    process.exitCode = 1;
  }
}
