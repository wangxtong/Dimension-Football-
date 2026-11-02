import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Deterministic, read-only verification of pinned after-the-fact match results.
// It does NOT infer historical pregame observations, provider IDs, or odds.
export const PINNED_OPENFOOTBALL_COMMIT = 'e6744429ee395bc86f247348c6184bb08d4eb361';
export const ARCHIVE_DIRECTORY = fileURLToPath(
  new URL(`../research-archive/openfootball/${PINNED_OPENFOOTBALL_COMMIT}/`, import.meta.url),
);
const SEASONS = ['2019-20', '2020-21', '2021-22'];
const LEAGUES = [
  ['PL', 'en.1.json', 'English Premier League'],
  ['BL1', 'de.1.json', 'Deutsche Bundesliga'],
  ['PD', 'es.1.json', 'Primera División de España'],
  ['SA', 'it.1.json', 'Italian Serie A'],
  ['FL1', 'fr.1.json', 'French Ligue 1'],
];
const EXPECTED_PATHS = SEASONS.flatMap(season => LEAGUES.map(([, filename]) => `${season}/${filename}`));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlobSha1 = bytes => createHash('sha1')
  .update(`blob ${bytes.length}\\0`).update(bytes).digest('hex');

function reject(code) {
  const error = new Error(`ARCHIVE_${code}`);
  error.code = `ARCHIVE_${code}`;
  throw error;
}

function strictHash(hash, length) {
  return typeof hash === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(hash);
}

/** Exact immutable bytes + event-count readback, not model promotion. */
export async function verifyOpenFootballResearchArchive({ directory = ARCHIVE_DIRECTORY } = {}) {
  const root = resolve(directory);
  if (await realpath(root) !== root) reject('DIRECTORY_UNTRUSTED');
  const manifestStat = await lstat(join(root, 'manifest.json'));
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) reject('MANIFEST_NOT_REGULAR_FILE');
  let manifest;
  try { manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')); }
  catch { reject('MANIFEST_INVALID_JSON'); }
  if (manifest?.schemaVersion !== 1 || manifest.kind !== 'openfootball-pinned-raw-research-archive'
    || manifest.sourceCommit !== PINNED_OPENFOOTBALL_COMMIT
    || manifest.releaseGate !== 'BLOCKED'
    || manifest.sourcePublishedAtUTC !== null
    || !Array.isArray(manifest.files) || manifest.files.length !== EXPECTED_PATHS.length
    || manifest.fileCount !== EXPECTED_PATHS.length
    || !manifest.limitations?.includes('RETROSPECTIVE_RESULT_SNAPSHOT_NOT_ORIGINAL_PREGAME_VISIBILITY')) {
    reject('MANIFEST_INTEGRITY');
  }
  const listedPaths = manifest.files.map(file => file?.path);
  if (JSON.stringify(listedPaths) !== JSON.stringify(EXPECTED_PATHS)) reject('FILES_NOT_EXACTLY_PINNED');
  let received = 0, fullTime = 0, missingFullTime = 0, rawBytes = 0;
  const verified = [];
  for (const entry of manifest.files) {
    const season = entry.path.slice(0, 7);
    const league = LEAGUES.find(([, name]) => entry.path === `${season}/${name}`);
    if (!SEASONS.includes(season) || !league || league[0] !== entry.league || entry.season !== season
      || entry.competition !== `${league[2]} ${season.replace('-', '/')}`
      || !strictHash(entry.sha256, 64) || !strictHash(entry.gitBlobSHA1, 40)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 20 || entry.bytes > 2_000_000) reject('SOURCE_IDENTITY');
    const path = join(root, entry.path);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== entry.bytes) reject('RAW_SIZE_OR_TYPE');
    const bytes = await readFile(path);
    if (sha256(bytes) !== entry.sha256 || gitBlobSha1(bytes) !== entry.gitBlobSHA1) reject('RAW_HASH_MISMATCH');
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { reject('RAW_INVALID_JSON'); }
    if (body?.name !== entry.competition || !Array.isArray(body.matches)
      || body.matches.length > 3_000 || body.matches.length !== entry.received) reject('RAW_IDENTITY_OR_COUNT');
    const matches = body.matches;
    if (matches.some(m => !m || typeof m.team1 !== 'string' || !m.team1.trim()
      || typeof m.team2 !== 'string' || !m.team2.trim()
      || !/^\\d{4}-\\d{2}-\\d{2}$/.test(m.date || '')
      || typeof m.round !== 'string')) reject('RAW_EVENT_INVALID');
    const ft = matches.filter(m => Array.isArray(m.score?.ft)
      && m.score.ft.length === 2 && m.score.ft.every(v => Number.isSafeInteger(v) && v >= 0 && v <= 30)).length;
    if (ft !== entry.fullTime || matches.length - ft !== entry.missingFullTime) reject('FT_COUNT_MISMATCH');
    received += matches.length;
    fullTime += ft;
    missingFullTime += matches.length - ft;
    rawBytes += bytes.length;
    verified.push({ path: entry.path, sha256: entry.sha256, matches: matches.length, fullTime: ft,
      missingFullTime: matches.length - ft });
  }
  if (received !== manifest.totalReceived || fullTime !== manifest.totalFullTime
    || missingFullTime !== manifest.totalMissingFullTime || rawBytes !== manifest.totalRawBytes
    || received !== 5478 || fullTime !== 5377 || missingFullTime !== 101) reject('TOTAL_MISMATCH');
  return { status: 'VERIFIED_HISTORICAL_RAW_ONLY', sourceCommit: PINNED_OPENFOOTBALL_COMMIT,
    fileCount: verified.length, matches: received, fullTime, missingFullTime, rawBytes, modelReady: false,
    releaseGate: 'BLOCKED', files: verified };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyOpenFootballResearchArchive().then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
  }).catch(error => {
    process.stderr.write(`${error.code?.startsWith('ARCHIVE_') ? error.code : 'ARCHIVE_VERIFY_FAILED'}\n`);
    process.exitCode = 1;
  });
}
