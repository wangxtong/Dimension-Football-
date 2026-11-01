import { readFile, writeFile, mkdir, realpath, lstat, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { verifyReplayBundle } from '../collector/data/run-manifest.mjs';
import { loadReportBundle, reportHash } from '../collector/report-store.mjs';
import { validateBundle } from '../website/report-schema.mjs';

const fixtureRoot = new URL('../collector/test/fixtures/', import.meta.url);
const REPORT_ID = 'e541ec0487829321212c9c95d84a4790888baa7c0f0f284a6e72745e728902c6';
const CODE_VERSION = '17931a231f6f11ccbf191fff855eae7930ad3466';
const ARTIFACT_SHA = '47abd070cbb520cf581a17c6706c5271d097ec034d986c9a1d44c4923ccff38e';
const required = ['latest.json', 'predictions.json', 'publication.json', 'run-manifest.json', 'run-inputs.json',
  'openligadb-fixtures.json', 'public-fixtures.json', 'public-source-fixtures.json',
  `replays/${REPORT_ID}/run-inputs.json`, `replays/${REPORT_ID}/run-manifest.json`];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('REPORT_FIXTURE_INVALID'); };
const allowed = name => required.includes(name)
  || /^forecast-ledger\/[a-f0-9]{64}\/(?:predictions|opportunities|results|scores)\/[a-f0-9]{64}\.json$/.test(name);
const secretName = /^(?:token|secret|password|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key)$/i;
function noSecrets(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (secretName.test(key)) fail();
    noSecrets(child);
  }
}

/** Data-only decoder. All paths, hashes and report bindings are checked before any filesystem write. */
export function decodeReportFixture(compressed) {
  try {
    if (!Buffer.isBuffer(compressed) || compressed.length > 2_000_000) fail();
    const fixture = JSON.parse(gunzipSync(compressed, { maxOutputLength: 8_000_000 }).toString('utf8'));
    if (fixture.version !== 1 || fixture.kind !== 'fixed-real-report-fixture' || fixture.reportId !== REPORT_ID
      || fixture.codeVersion !== CODE_VERSION || fixture.sourceRunId !== 41285125481 || fixture.artifactId !== 13074039427
      || fixture.artifactZipSha256 !== ARTIFACT_SHA || !Number.isFinite(Date.parse(fixture.exportedAt))
      || !Array.isArray(fixture.files) || fixture.files.length !== 30) fail();
    const files = new Map(), values = new Map(); let total = 0;
    for (const row of fixture.files) {
      if (typeof row.path !== 'string' || !allowed(row.path) || files.has(row.path)
        || !/^[a-f0-9]{64}$/.test(row.sha256 || '') || !Number.isSafeInteger(row.bytes) || row.bytes <= 0
        || row.bytes > 2_000_000 || typeof row.content !== 'string' || row.content.length > 2_700_000) fail();
      const bytes = Buffer.from(row.content, 'base64'); total += bytes.length;
      if (total > 5_000_000 || bytes.toString('base64') !== row.content || bytes.length !== row.bytes || hash(bytes) !== row.sha256) fail();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
      if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|\d{8,12}:AA[A-Za-z0-9_-]{25,}/.test(text)) fail();
      noSecrets(value); files.set(row.path, bytes); values.set(row.path, value);
    }
    if (required.some(path => !files.has(path))) fail();
    for (const name of ['run-inputs.json', 'run-manifest.json']) {
      if (!files.get(name).equals(files.get(`replays/${REPORT_ID}/${name}`))) fail();
    }
    const manifest = values.get('run-manifest.json'), inputs = values.get('run-inputs.json');
    verifyReplayBundle({ manifest, inputs }, { reportId: REPORT_ID, codeVersion: CODE_VERSION });
    const report = values.get('predictions.json'), raw = values.get('latest.json'), receipt = values.get('publication.json');
    if (manifest.simulated || raw.simulated !== false || raw.publication?.reportId !== REPORT_ID
      || receipt.reportId !== REPORT_ID || receipt.simulated !== false || !Array.isArray(receipt.files)
      || values.get('openligadb-fixtures.json').reportId !== REPORT_ID
      || Date.parse(fixture.exportedAt) < Date.parse(manifest.generatedAt)) fail();
    for (const entry of receipt.files) if (files.has(entry.name) && hash(files.get(entry.name)) !== entry.sha256) fail();
    const content = { version: 1, reportId: REPORT_ID, report, sourceData: { openligadb: values.get('openligadb-fixtures.json') } };
    validateBundle({ ...content, receipt, reportHash: reportHash(report) });
    return { fixture, files, content, receipt };
  } catch { fail(); }
}

export async function readReportFixture() {
  const metadata = JSON.parse(await readFile(new URL('real-report-e541.metadata.json', fixtureRoot), 'utf8'));
  const compressed = await readFile(new URL(`real-report-${REPORT_ID}.json.gz`, fixtureRoot));
  if (compressed.length !== metadata.gzipBytes || hash(compressed) !== metadata.gzipSha256) fail();
  return decodeReportFixture(compressed);
}

/** Restores reviewed original JSON into a new directory. Never collects, publishes, notifies or executes archive content. */
export async function restoreReportFixture(outputDirectory) {
  if (typeof outputDirectory !== 'string' || !isAbsolute(outputDirectory)) throw new Error('REPORT_FIXTURE_NEW_ABSOLUTE_DIRECTORY_REQUIRED');
  const directory = resolve(outputDirectory), parent = dirname(directory);
  if (parent === directory || await realpath(parent) !== parent) throw new Error('REPORT_FIXTURE_UNSAFE_DIRECTORY');
  try { await lstat(directory); throw new Error('REPORT_FIXTURE_DESTINATION_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const { fixture, files, content, receipt } = await readReportFixture();
  // Atomic mkdir refuses a concurrent file, directory or symlink at the target.
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const [name, bytes] of files) {
      const target = join(directory, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    // The upstream artifact excluded hidden files. These three JSON records are
    // an explicitly local reconstruction, not recovered historical delivery metadata.
    const snapshot = join(directory, '.delivery/reports', REPORT_ID);
    await mkdir(snapshot, { recursive: true, mode: 0o700 });
    await writeFile(join(snapshot, 'content.json'), JSON.stringify(content), { flag: 'wx', mode: 0o600 });
    await writeFile(join(snapshot, 'receipt.json'), JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
    const pointer = { version: 1, reportId: REPORT_ID, contentHash: reportHash(content), reportHash: reportHash(content.report),
      generatedAt: content.report.generatedAt, storedAt: new Date().toISOString(), revision: 1 };
    await writeFile(join(directory, '.delivery/current.json'), JSON.stringify(pointer), { flag: 'wx', mode: 0o600 });
    const bundle = await loadReportBundle(directory);
    return { directory, reportId: bundle.reportId, codeVersion: CODE_VERSION, files: files.size, sourceRunId: fixture.sourceRunId,
      artifactId: fixture.artifactId, exportedAt: fixture.exportedAt, localStoreReconstructed: true, releaseGate: 'BLOCKED' };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

export async function runRestoreReportCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--out' || !args[1]) throw new Error('REPORT_FIXTURE_ARGUMENTS_INVALID');
    stdout(JSON.stringify(await restoreReportFixture(args[1])) + '\n'); return 0;
  } catch { stderr('REPORT_FIXTURE_RESTORE_FAILED\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runRestoreReportCli(process.argv.slice(2));
