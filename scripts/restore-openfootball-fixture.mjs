import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, realpath, lstat, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { OPENFOOTBALL_FILES, importOpenFootballHistory, openFootballHistoryUrl } from '../collector/sources/historical-openfootball.mjs';

const fixtureRoot = new URL('../collector/sources/test/fixtures/', import.meta.url);
// This reviewed manifest pins every original byte, including actual acquisition metadata.
const pins = JSON.parse(readFileSync(new URL('openfootball-e674442.metadata.json', fixtureRoot), 'utf8'));
const required = ['LICENSE.md', ...['2025-26', '2026-27'].flatMap(season => Object.values(OPENFOOTBALL_FILES)
  .flatMap(file => [`${season}/${file}`, `${season}/${file}.meta.json`]))];
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('OPENFOOTBALL_FIXTURE_INVALID'); };

/** Data-only decoder: no archive script, network request or filesystem write is performed. */
export function decodeOpenFootballFixture(compressed) {
  try {
    if (!Buffer.isBuffer(compressed) || compressed.length > 100_000) fail();
    const fixture = JSON.parse(gunzipSync(compressed, { maxOutputLength: 1_200_000 }).toString('utf8'));
    if (fixture.version !== 1 || fixture.kind !== 'fixed-openfootball-snapshots' || fixture.sourceCommit !== pins.sourceCommit
      || fixture.acquiredFrom !== pins.acquiredFrom || fixture.acquiredThrough !== pins.acquiredThrough
      || !Array.isArray(fixture.files) || fixture.files.length !== required.length || pins.files.length !== required.length) fail();
    const files = new Map(); let total = 0;
    for (const row of fixture.files) {
      const pin = pins.files.find(entry => entry.path === row.path);
      if (!required.includes(row.path) || files.has(row.path) || !pin || row.sha256 !== pin.sha256 || row.bytes !== pin.bytes
        || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || row.bytes > 150_000
        || typeof row.content !== 'string' || row.content.length > 200_000) fail();
      const bytes = Buffer.from(row.content, 'base64'); total += bytes.length;
      if (total > 800_000 || bytes.toString('base64') !== row.content || bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (row.path !== 'LICENSE.md') JSON.parse(text);
      files.set(row.path, bytes);
    }
    if (required.some(path => !files.has(path))) fail();
    let received = 0, retainedResults = 0, quarantined = 0;
    for (const season of ['2025-26', '2026-27']) for (const [league, filename] of Object.entries(OPENFOOTBALL_FILES)) {
      const name = `${season}/${filename}`, metadata = JSON.parse(files.get(`${name}.meta.json`));
      if (metadata.commit !== pins.sourceCommit || metadata.sha256 !== hash(files.get(name))
        || metadata.url !== openFootballHistoryUrl({ league, season, sourceCommit: pins.sourceCommit })) fail();
      const archive = importOpenFootballHistory(files.get(name), { league, season, sourceCommit: metadata.commit,
        sourceFetchedAt: metadata.fetchedAt, expectedSha256: metadata.sha256 });
      if (archive.coverage.modelReady !== 0 || archive.releaseGate !== 'BLOCKED') fail();
      received += archive.coverage.received; retainedResults += archive.coverage.retainedResults; quarantined += archive.coverage.quarantined;
    }
    return { fixture, files, coverage: { received, retainedResults, quarantined, modelReady: 0 } };
  } catch { fail(); }
}

export async function readOpenFootballFixture() {
  const compressed = await readFile(new URL('openfootball-e674442.json.gz', fixtureRoot));
  if (compressed.length !== pins.gzipBytes || hash(compressed) !== pins.gzipSha256) fail();
  return decodeOpenFootballFixture(compressed);
}

/** Restore only to a new absolute directory with a real, existing parent. */
export async function restoreOpenFootballFixture(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) throw new Error('OPENFOOTBALL_FIXTURE_NEW_ABSOLUTE_DIRECTORY_REQUIRED');
  const directory = resolve(outputDirectory), parent = dirname(directory);
  if (parent === directory || await realpath(parent) !== parent) throw new Error('OPENFOOTBALL_FIXTURE_UNSAFE_DIRECTORY');
  try { await lstat(directory); throw new Error('OPENFOOTBALL_FIXTURE_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { fixture, files, coverage } = await readOpenFootballFixture();
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const [name, bytes] of files) {
      const target = join(directory, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    return { directory, files: files.size, sourceCommit: fixture.sourceCommit, acquiredFrom: fixture.acquiredFrom,
      acquiredThrough: fixture.acquiredThrough, coverage, releaseGate: 'BLOCKED' };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function runRestoreOpenFootballCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('OPENFOOTBALL_FIXTURE_ARGUMENTS_INVALID');
    stdout(JSON.stringify(await restoreOpenFootballFixture(args[1])) + '\n'); return 0;
  } catch { stderr('OPENFOOTBALL_FIXTURE_RESTORE_FAILED\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runRestoreOpenFootballCli(process.argv.slice(2));
