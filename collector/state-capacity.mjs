import { lstat, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { digest } from './policy.mjs';
import { canonicalTimestamp, validDataHash } from './data/identity.mjs';
import { verifyReplayBundle } from './data/run-manifest.mjs';

const MIB = 1024 * 1024;
export const STATE_CAPACITY_DEFAULTS = Object.freeze({ limitBytes: 32 * MIB, fileLimit: 10000, intervalMinutes: 5, chunkBytes: 4 * MIB });
const topLevel = new Set(['predictions.json', 'publication.json', 'public-fixtures.json', 'openligadb-fixtures.json',
  'run-inputs.json', 'run-manifest.json', 'prospective-evaluation.json']);
const ledgerPath = /^reports\/forecast-ledger\/([a-f0-9]{64})\/(predictions|results|scores|opportunities)\/([a-f0-9]{64})\.json$/;
const recordKinds = { predictions: 'prediction', results: 'result', scores: 'score', opportunities: 'opportunity' };
const replayPath = /^reports\/replays\/([a-f0-9]{64})\/(run-inputs|run-manifest)\.json$/;
const blockedName = /(?:^|[\/._-])(?:secrets?|credentials?|tokens?|env|locks?|symlinks?|private[-_]?key)(?:[\/._-]|$)/i;
const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
function allowedPath(path) {
  if (typeof path !== 'string' || path.length > 300 || !/^[A-Za-z0-9_./-]+$/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..') || blockedName.test(path)) return false;
  return /^state\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/.test(path)
    || path.startsWith('reports/') && topLevel.has(path.slice(8)) || ledgerPath.test(path) || replayPath.test(path)
    || path === 'reports/.delivery/current.json'
    || /^reports\/\.delivery\/reports\/[a-f0-9]{64}\/(content|receipt)\.json$/.test(path);
}
const category = path => ledgerPath.exec(path)?.[2] || (replayPath.test(path) ? 'replays'
  : path.startsWith('state/') ? 'mutable-state' : path.includes('/.delivery/') ? 'current-delivery' : 'current-reports');

function entry(path, content) {
  if (!allowedPath(path) || typeof content !== 'string' || content.length % 4 || /[^A-Za-z0-9+/=]/.test(content)) throw Error('CAPACITY_FILE_INVALID');
  const bytes = Buffer.from(content, 'base64');
  if (bytes.toString('base64') !== content) throw Error('CAPACITY_FILE_INVALID');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw Error('CAPACITY_JSON_INVALID'); }
  return { path, content, value, rawBytes: bytes.length, base64Bytes: content.length,
    sha256: byteHash(bytes), wireEntryBytes: Buffer.byteLength(JSON.stringify({ path, content })) };
}

/** Read only allowlisted JSON. Symlinks and secret-like paths are never opened. */
async function directoryEntries(root) {
  const entries = [], ignored = { symlinks: 0, files: 0 }; let scannedBytes = 0;
  if (!(await lstat(root)).isDirectory()) throw Error('CAPACITY_ROOT_INVALID');
  async function walk(relative) {
    const absolute = join(root, relative);
    let names; try { names = await readdir(absolute, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${name.name}`;
      if (name.isSymbolicLink()) { ignored.symlinks++; continue; }
      if (blockedName.test(path)) { ignored.files++; continue; }
      if (name.isDirectory()) {
        if (relative === 'state' || relative.startsWith('state/') || path === 'reports/forecast-ledger' || path.startsWith('reports/forecast-ledger/')
          || path === 'reports/replays' || path.startsWith('reports/replays/') || path === 'reports/.delivery' || path.startsWith('reports/.delivery/')) await walk(path);
        continue;
      }
      if (!name.isFile() || !allowedPath(path)) { ignored.files++; continue; }
      const stat = await lstat(join(root, path));
      if (!stat.isFile() || stat.size > 64 * MIB || (scannedBytes += stat.size) > 512 * MIB || entries.length >= 50000) throw Error('CAPACITY_SCAN_LIMIT');
      entries.push(entry(path, (await readFile(join(root, path))).toString('base64')));
    }
  }
  // Do not follow a symlink at either top-level directory.
  for (const directory of ['state', 'reports']) {
    let stat; try { stat = await lstat(join(root, directory)); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) { ignored.symlinks++; continue; }
    if (stat.isDirectory()) await walk(directory);
  }
  const current = entries.find(file => file.path === 'reports/.delivery/current.json')?.value;
  // Hosted state persists only the active delivery snapshot, not old versions.
  return { entries: entries.filter(file => !file.path.startsWith('reports/.delivery/reports/')
    || validDataHash(current?.reportId) && file.path.startsWith(`reports/.delivery/reports/${current.reportId}/`)), ignored };
}

function wireSize(entries, revision) {
  const filesBytes = 2 + entries.reduce((sum, file) => sum + file.wireEntryBytes, 0) + Math.max(0, entries.length - 1);
  const storedBytes = Buffer.byteLength(`{"revision":${revision},"files":`) + filesBytes + 1;
  const putBytes = Buffer.byteLength(`{"expectedRevision":${revision - 1},"files":`) + filesBytes + 1;
  return { storedBytes, putBytes, wireBytes: Math.max(storedBytes, putBytes) };
}
function projection({ bytes, files, snapshotBytes, snapshotFiles, intervalMinutes, limitBytes, fileLimit }) {
  const bytesLeft = Math.max(0, limitBytes - snapshotBytes), filesLeft = Math.max(0, fileLimit - snapshotFiles);
  const byteRuns = bytes ? Math.floor(bytesLeft / bytes) : null, fileRuns = files ? Math.floor(filesLeft / files) : null;
  const finite = [byteRuns, fileRuns].filter(value => value !== null);
  const alreadyOverLimit = snapshotBytes > limitBytes || snapshotFiles > fileLimit;
  const successfulRunsRemaining = alreadyOverLimit ? 0 : finite.length ? Math.min(...finite) : null;
  const firstRejectedRun = alreadyOverLimit ? 0 : successfulRunsRemaining === null ? null : successfulRunsRemaining + 1;
  return { kind: 'conditional-repeat-one-report', intervalMinutes, appendWireBytesPerReport: bytes, appendFilesPerReport: files,
    bytesPerDay: bytes * 1440 / intervalMinutes, filesPerDay: files * 1440 / intervalMinutes,
    successfulRunsRemaining, firstRejectedRun,
    hoursToFirstRejection: firstRejectedRun === null ? null : firstRejectedRun * intervalMinutes / 60,
    limitingFactor: successfulRunsRemaining === null ? null : byteRuns !== null && byteRuns === successfulRunsRemaining ? 'serialized-bytes' : 'file-count' };
}

/** Pure capacity accounting; each report is a separate scenario, never a summed round. */
export function analyzeStateEntries(files, options = {}) {
  const settings = { ...STATE_CAPACITY_DEFAULTS, ...options }, { limitBytes, fileLimit, intervalMinutes, chunkBytes } = settings;
  const revision = options.revision ?? 1;
  if (!Array.isArray(files) || files.length > 50000 || ![limitBytes, fileLimit, chunkBytes, revision].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isFinite(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080 || revision >= Number.MAX_SAFE_INTEGER) throw Error('CAPACITY_OPTIONS_INVALID');
  const entries = files.map(file => entry(file.path, file.content)).sort((a, b) => a.path.localeCompare(b.path));
  if (new Set(entries.map(file => file.path)).size !== entries.length) throw Error('CAPACITY_DUPLICATE_PATH');
  const wire = wireSize(entries, revision), snapshot = { ...wire, fileCount: entries.length,
    rawBytes: entries.reduce((sum, file) => sum + file.rawBytes, 0), base64Bytes: entries.reduce((sum, file) => sum + file.base64Bytes, 0),
    remainingWireBytes: Math.max(0, limitBytes - wire.wireBytes), remainingFiles: Math.max(0, fileLimit - entries.length),
    withinLimits: wire.wireBytes <= limitBytes && entries.length <= fileLimit };
  const warnings = [], categories = new Map(), reports = new Map(), predictions = [], scores = [], replayGroups = new Map();
  const ledger = { predictions: 0, opportunities: 0, results: 0, scores: 0, integrityFailures: 0,
    unscoredPredictions: 0, unresolvedPredictions: 0, allRecordsProtected: true };
  const report = id => {
    if (!reports.has(id)) reports.set(id, { reportId: id, generatedAt: null, files: [], counts: { replayBundles: 0, predictions: 0, opportunities: 0 } });
    return reports.get(id);
  };
  for (const file of entries) {
    const key = category(file.path), counts = categories.get(key) || { category: key, files: 0, rawBytes: 0, appendWireBytes: 0 };
    counts.files++; counts.rawBytes += file.rawBytes; counts.appendWireBytes += file.wireEntryBytes + 1; categories.set(key, counts);
    const match = ledgerPath.exec(file.path);
    if (match) {
      const kind = match[2], record = file.value?.record; ledger[kind]++;
      if (!record || file.value.sha256 !== digest(record) || record.kind !== recordKinds[kind]
        || ({ predictions: record.predictionId, results: record.resultVersionId, scores: record.scoreId }[kind] ?? match[3]) !== match[3]) {
        ledger.integrityFailures++; continue;
      }
      if (kind === 'predictions') predictions.push(record);
      if (kind === 'scores') scores.push(record);
      if ((kind === 'predictions' || kind === 'opportunities') && validDataHash(record.reportId)) {
        const sample = report(record.reportId); sample.files.push(file); sample.counts[kind]++;
        if (!sample.generatedAt && canonicalTimestamp(record.generatedAt)) sample.generatedAt = record.generatedAt;
      }
    }
    const replay = replayPath.exec(file.path);
    if (replay) { const group = replayGroups.get(replay[1]) || []; group.push(file); replayGroups.set(replay[1], group); }
  }
  const scoresByPrediction = new Map();
  for (const score of scores) {
    const matching = scoresByPrediction.get(score.predictionId) || [];
    matching.push(score); scoresByPrediction.set(score.predictionId, matching);
  }
  for (const prediction of predictions) {
    const matching = scoresByPrediction.get(prediction.predictionId) || [];
    if (!matching.length) ledger.unscoredPredictions++;
    if (!matching.some(score => score.status === 'scored' || typeof score.status === 'string' && score.status.startsWith('void-'))) ledger.unresolvedPredictions++;
  }
  // Invalid records are never interpreted as proof that their predictions can be removed.
  if (ledger.integrityFailures) warnings.push('LEDGER_INTEGRITY_FAILURE_RECORDS_RETAINED');
  const archiveFiles = [], invalidReplayReports = [];
  for (const [reportId, group] of replayGroups) {
    try {
      const manifest = group.find(file => file.path.endsWith('/run-manifest.json'))?.value;
      const inputs = group.find(file => file.path.endsWith('/run-inputs.json'))?.value;
      const verified = verifyReplayBundle({ manifest, inputs }, { reportId });
      const sample = report(reportId); sample.files.push(...group); sample.counts.replayBundles++; sample.generatedAt = verified.manifest.generatedAt;
      archiveFiles.push(...group.map(file => ({ path: file.path, reportId, bytes: file.rawBytes, sha256: file.sha256,
        objectKey: `vantis/archive/replays/${reportId}/${file.sha256}/${file.path.split('/').at(-1)}` })));
    } catch { invalidReplayReports.push(reportId); }
  }
  if (invalidReplayReports.length) warnings.push('INVALID_REPLAY_RETAINED_IN_HOT_STATE');
  const reportSamples = [...reports.values()].sort((a, b) => a.reportId.localeCompare(b.reportId)).map(sample => {
    const bytes = sample.files.reduce((sum, file) => sum + file.wireEntryBytes + 1, 0),
      ledgerFiles = sample.files.filter(file => ledgerPath.test(file.path));
    const args = { snapshotBytes: wire.wireBytes, snapshotFiles: entries.length, intervalMinutes, limitBytes, fileLimit };
    return { reportId: sample.reportId, generatedAt: sample.generatedAt, counts: sample.counts,
      withReplayRetention: projection({ ...args, bytes, files: sample.files.length }),
      afterVerifiedReplayArchival: { ...projection({ ...args, bytes: ledgerFiles.reduce((sum, file) => sum + file.wireEntryBytes + 1, 0), files: ledgerFiles.length }),
        conditional: true, existingSnapshotUnchanged: true, excludesArchiveIndexOverhead: true } };
  });
  const chunks = []; let chunk = null;
  for (const file of archiveFiles) {
    if (!chunk || chunk.bytes + file.bytes > chunkBytes) { chunk = { index: chunks.length + 1, bytes: 0, files: [] }; chunks.push(chunk); }
    chunk.files.push(file); chunk.bytes += file.bytes;
    if (file.bytes > chunkBytes) chunk.oversizedSingleObject = true;
  }
  if (!reportSamples.length) warnings.push('NO_VALID_REPORT_GROWTH_SAMPLE');
  if (chunks.some(row => row.oversizedSingleObject)) warnings.push('ARCHIVE_OBJECT_EXCEEDS_CHUNK_TARGET');
  const archivePaths = new Set(archiveFiles.map(file => file.path));
  return { version: 1, kind: 'hosted-state-capacity', mode: 'read-only', limits: { wireBytes: limitBytes, files: fileLimit, archiveChunkBytes: chunkBytes }, snapshot,
    categories: [...categories.values()], ledger, reportSamples,
    observedGrowth: { available: false, reason: 'One snapshot cannot establish an observed growth rate. Every projection repeats one identified report only.' },
    assumptions: ['Base64 and JSON envelope overhead are included; each future report has new immutable IDs.',
      'Mutable current files are assumed stable in size. Future results, scores, schedule growth and archive-index overhead are additional, unmeasured costs.',
      'Delivery-only runs do not necessarily append forecasts. Do not add separate report scenarios or different pipelines into one collection round.',
      'Projected rejection time is a conditional capacity bound, not a collection schedule guarantee or a safe retention duration.'],
    migration: { status: 'blocked-until-independent-archive-and-restore-verification', deletesAuthorized: false,
      protectedLedgerFiles: ledger.predictions + ledger.opportunities + ledger.results + ledger.scores, ledgerFilesEligibleForRemoval: 0,
      candidateReplayFiles: archiveFiles.length, candidateReplayRawBytes: archiveFiles.reduce((sum, file) => sum + file.bytes, 0),
      candidateReplayWireBytes: entries.filter(file => archivePaths.has(file.path)).reduce((sum, file) => sum + file.wireEntryBytes + 1, 0),
      ledgerNextStep: 'Independent immutable event-key ledger partitions require archive-aware result scoring, opportunity evaluation and restore before hot records can move. Unscored predictions and their opportunities remain queryable; age alone never authorizes deletion.',
      invalidReplayReports, chunks,
      steps: ['Upload each listed object to independent private R2 archive with create-if-absent; an existing object must match the listed SHA256.',
        'Read each object back, verify byte length and SHA256, then verify the paired run manifest and inputs with verifyReplayBundle.',
        'CAS an archive index containing reportId, original paths, object keys, hashes and verified readback time; retain the existing hot state on any failure.',
        'Implement and offline-test archive-aware restore and exact-code replay, including unavailable archive and corrupted-object failures.',
        'Only after restore verification, CAS a new hot-state revision that excludes the archived replay pair and preserves every ledger record. Do not remove run-inputs.json or run-manifest.json current pointers.',
        'Read back the committed hot state, re-count protected ledger records and verify archive references. A conflict or missing object aborts removal.'] }, warnings };
}

export async function inspectStateCapacity({ root, snapshotFile, ...options } = {}) {
  if (Boolean(root) === Boolean(snapshotFile)) throw Error('CAPACITY_INPUT_REQUIRED');
  if (snapshotFile) {
    const stat = await lstat(snapshotFile);
    if (!stat.isFile() || stat.size > 512 * MIB) throw Error('CAPACITY_INPUT_INVALID');
    const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8'));
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw Error('CAPACITY_REVISION_INVALID');
    return { ...analyzeStateEntries(snapshot.files, { ...options, revision: snapshot.revision }), input: { kind: 'hosted-snapshot', revision: snapshot.revision } };
  }
  const { entries, ignored } = await directoryEntries(resolve(root));
  return { ...analyzeStateEntries(entries, options), input: { kind: 'directory-projection', ignored,
    note: 'Uses the hosted-state path allowlist and current delivery pointer. Actual remote snapshot bytes may differ.' } };
}

const HELP = 'Usage: node collector/state-capacity.mjs (--root DIRECTORY | --snapshot FILE) [--interval-minutes 5] [--limit-mib 32] [--file-limit 10000] [--chunk-mib 4]\nOffline, read-only capacity and archive plan; prints JSON. --help reads no files. No upload or deletion is performed.\n';
export async function runStateCapacityCli(argv, { stdout = process.stdout } = {}) {
  if (argv.includes('--help')) { stdout.write(HELP); return 0; }
  const options = {}, names = { '--root': 'root', '--snapshot': 'snapshotFile', '--interval-minutes': 'intervalMinutes',
    '--limit-mib': 'limitBytes', '--file-limit': 'fileLimit', '--chunk-mib': 'chunkBytes' };
  for (let index = 0; index < argv.length; index += 2) {
    const key = names[argv[index]], value = argv[index + 1];
    if (!key || value === undefined || value.startsWith('--') || Object.hasOwn(options, key)) throw Error('CAPACITY_ARGUMENT_INVALID');
    options[key] = ['root', 'snapshotFile'].includes(key) ? value : Number(value) * (['limitBytes', 'chunkBytes'].includes(key) ? MIB : 1);
  }
  const result = await inspectStateCapacity(options); stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.snapshot.withinLimits && !result.warnings.length ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runStateCapacityCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${/^CAPACITY_[A-Z_]+$/.test(error.message) ? error.message : 'CAPACITY_INSPECTION_FAILED'}\n`); process.exitCode = 1;
  });
}
