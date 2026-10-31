import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { analyzeStateEntries, inspectStateCapacity, runStateCapacityCli } from '../state-capacity.mjs';
import { createReplayBundle } from '../data/run-manifest.mjs';
import { DEFAULT_POLICY, digest } from '../policy.mjs';
import { FORECAST_MODEL } from '../forecast.mjs';

const NOW = '2026-10-31T08:00:00.000Z', REPORT_A = 'a'.repeat(64), REPORT_B = 'b'.repeat(64);
const encode = (path, value) => ({ path, content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString('base64') });
const bytesHash = content => createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
function replay(reportId = REPORT_A) {
  const bundle = createReplayBundle({ reportId, fixtures: [], history: [], policy: DEFAULT_POLICY, model: FORECAST_MODEL,
    generatedAt: NOW, cutoff: NOW, codeVersion: 'c'.repeat(40) });
  return [encode(`reports/replays/${reportId}/run-inputs.json`, bundle.inputs), encode(`reports/replays/${reportId}/run-manifest.json`, bundle.manifest)];
}
function prediction(reportId = REPORT_A, fixtureId = '1') {
  const predictionId = digest([reportId, fixtureId]);
  const record = { kind: 'prediction', source: 'openligadb', fixtureId, reportId, predictionId, generatedAt: NOW };
  return encode(`reports/forecast-ledger/${digest([record.source, fixtureId])}/predictions/${predictionId}.json`, { record, sha256: digest(record) });
}
function opportunity(reportId = REPORT_A, fixtureId = '1') {
  const record = { kind: 'opportunity', source: 'openligadb', fixtureId, reportId, generatedAt: NOW, predictionId: digest([reportId, fixtureId]) };
  return encode(`reports/forecast-ledger/${digest([record.source, fixtureId])}/opportunities/${digest([reportId, fixtureId])}.json`, { record, sha256: digest(record) });
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'state-capacity-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}

test('accounts for exact Base64 JSON wire bytes and keeps different reports as separate scenarios', () => {
  const files = [...replay(), prediction(), opportunity(), ...replay(REPORT_B), prediction(REPORT_B, '2'),
    prediction(REPORT_B, '3'), opportunity(REPORT_B, '2'), encode('state/state.json', { value: '中文\n' })];
  const result = analyzeStateEntries(files, { revision: 8, intervalMinutes: 5 });
  assert.equal(result.snapshot.storedBytes, Buffer.byteLength(JSON.stringify({ revision: 8, files })));
  assert.equal(result.snapshot.putBytes, Buffer.byteLength(JSON.stringify({ expectedRevision: 7, files })));
  assert.equal(result.snapshot.rawBytes, files.reduce((sum, file) => sum + Buffer.from(file.content, 'base64').length, 0));
  assert.equal(result.reportSamples.length, 2);
  assert.deepEqual(result.reportSamples.map(row => row.counts.predictions), [1, 2]);
  assert.deepEqual(result.reportSamples.map(row => row.withReplayRetention.appendFilesPerReport), [4, 5]);
  assert.ok(result.reportSamples.every(row => row.withReplayRetention.bytesPerDay === row.withReplayRetention.appendWireBytesPerReport * 288));
  assert.equal(result.observedGrowth.available, false);
  assert.equal(result.ledger.unscoredPredictions, 3);
  assert.equal(result.migration.ledgerFilesEligibleForRemoval, 0);
  assert.equal(result.migration.deletesAuthorized, false);
});

test('reports byte exhaustion, file-count exhaustion, and already exceeded capacity separately', () => {
  const files = [...replay(), prediction(), opportunity()];
  const base = analyzeStateEntries(files), scenario = base.reportSamples[0].withReplayRetention;
  const byteLimited = analyzeStateEntries(files, { limitBytes: base.snapshot.wireBytes + scenario.appendWireBytesPerReport * 2 });
  assert.equal(byteLimited.reportSamples[0].withReplayRetention.successfulRunsRemaining, 2);
  assert.equal(byteLimited.reportSamples[0].withReplayRetention.firstRejectedRun, 3);
  assert.equal(byteLimited.reportSamples[0].withReplayRetention.hoursToFirstRejection, .25);
  const fileLimited = analyzeStateEntries(files, { fileLimit: 8 });
  assert.equal(fileLimited.reportSamples[0].withReplayRetention.limitingFactor, 'file-count');
  assert.equal(fileLimited.reportSamples[0].withReplayRetention.firstRejectedRun, 2);
  const exceeded = analyzeStateEntries(files, { limitBytes: 1 });
  assert.equal(exceeded.snapshot.withinLimits, false);
  assert.equal(exceeded.reportSamples[0].withReplayRetention.hoursToFirstRejection, 0);
  assert.equal(base.reportSamples[0].afterVerifiedReplayArchival.appendFilesPerReport, 2);
  assert.equal(base.reportSamples[0].afterVerifiedReplayArchival.conditional, true);
});

test('archive plan uses verified replay pairs, exact bytes and immutable hash keys without authorizing removal', () => {
  const files = [...replay(), ...replay(REPORT_B), prediction(), opportunity()];
  const largest = Math.max(...files.filter(file => file.path.includes('/replays/')).map(file => Buffer.from(file.content, 'base64').length));
  const result = analyzeStateEntries(files, { chunkBytes: largest + 1 });
  assert.equal(result.migration.candidateReplayFiles, 4);
  assert.ok(result.migration.chunks.length > 1);
  assert.ok(result.migration.chunks.every(chunk => chunk.bytes <= largest + 1));
  for (const file of result.migration.chunks.flatMap(chunk => chunk.files)) {
    const source = files.find(row => row.path === file.path);
    assert.equal(file.sha256, bytesHash(source.content));
    assert.equal(file.bytes, Buffer.from(source.content, 'base64').length);
    assert.ok(file.objectKey.includes(file.reportId));
    assert.ok(file.objectKey.includes(file.sha256));
    assert.ok(!file.path.includes('/forecast-ledger/'));
  }
  assert.equal(result.migration.protectedLedgerFiles, 2);
  assert.match(result.migration.status, /^blocked/);
  assert.equal(result.migration.deletesAuthorized, false);
  const damaged = structuredClone(files);
  const value = JSON.parse(Buffer.from(damaged[0].content, 'base64')); value.reportId = REPORT_B;
  damaged[0] = encode(damaged[0].path, value);
  const check = analyzeStateEntries(damaged);
  assert.equal(check.migration.candidateReplayFiles, 2);
  assert.deepEqual(check.migration.invalidReplayReports, [REPORT_A]);
  assert.ok(check.warnings.includes('INVALID_REPLAY_RETAINED_IN_HOT_STATE'));
});

test('pending and corrupt ledger records remain protected rather than becoming pruning candidates', () => {
  const pred = prediction(), pending = { kind: 'score', scoreId: 'e'.repeat(64), predictionId: digest([REPORT_A, '1']), status: 'pending-postponed' };
  const score = encode(`reports/forecast-ledger/${digest(['openligadb', '1'])}/scores/${pending.scoreId}.json`, { record: pending, sha256: digest(pending) });
  const damaged = prediction(REPORT_B, '2'); damaged.content = encode(damaged.path, { record: {}, sha256: '0'.repeat(64) }).content;
  const result = analyzeStateEntries([pred, score, damaged, opportunity()]);
  assert.equal(result.ledger.integrityFailures, 1);
  assert.equal(result.ledger.unscoredPredictions, 0);
  assert.equal(result.ledger.unresolvedPredictions, 1);
  assert.equal(result.migration.protectedLedgerFiles, 4);
  assert.equal(result.migration.ledgerFilesEligibleForRemoval, 0);
  assert.ok(result.warnings.includes('LEDGER_INTEGRITY_FAILURE_RECORDS_RETAINED'));
});

test('directory scan skips secrets and symlinks, selects the current delivery and never changes files', async t => {
  const root = await workspace(t), files = [...replay(), prediction(), opportunity(), encode('state/state.json', { stable: true }),
    encode('reports/.delivery/current.json', { reportId: REPORT_A }),
    encode(`reports/.delivery/reports/${REPORT_A}/content.json`, { current: true }),
    encode(`reports/.delivery/reports/${REPORT_A}/receipt.json`, { current: true }),
    encode(`reports/.delivery/reports/${REPORT_B}/content.json`, { old: true })];
  for (const file of files) { await mkdir(join(root, file.path, '..'), { recursive: true }); await writeFile(join(root, file.path), Buffer.from(file.content, 'base64')); }
  await writeFile(join(root, 'state/credentials.json'), 'invalid-json-never-read');
  await symlink(join(root, 'state/credentials.json'), join(root, 'state/link.json'));
  await writeFile(join(root, 'reports/latest.json'), 'full-detailed-report-not-part-of-hosted-state');
  const before = await readdir(root, { recursive: true });
  const result = await inspectStateCapacity({ root });
  assert.equal(result.snapshot.fileCount, files.length - 1);
  assert.equal(result.input.ignored.symlinks, 1);
  assert.equal(result.categories.find(row => row.category === 'current-delivery').files, 3);
  assert.deepEqual(await readdir(root, { recursive: true }), before);
  for (const file of files) assert.equal((await readFile(join(root, file.path))).toString('base64'), file.content);
});

test('snapshot and help CLI stay offline and validate their inputs without writing', async t => {
  const root = await workspace(t), snapshotFile = join(root, 'downloaded-state.json');
  await writeFile(snapshotFile, JSON.stringify({ revision: 3, files: [...replay(), prediction()] }));
  let output = '';
  assert.equal(await runStateCapacityCli(['--help', '--root', '/does-not-exist'], { stdout: { write: value => { output += value; } } }), 0);
  assert.match(output, /No upload or deletion/);
  output = '';
  assert.equal(await runStateCapacityCli(['--snapshot', snapshotFile], { stdout: { write: value => { output += value; } } }), 0);
  assert.equal(JSON.parse(output).input.kind, 'hosted-snapshot');
  assert.equal(JSON.parse(output).input.revision, 3);
  assert.deepEqual(await readdir(root), ['downloaded-state.json']);
  await assert.rejects(runStateCapacityCli(['--root', root, '--snapshot', snapshotFile]), /CAPACITY_INPUT_REQUIRED/);
  await assert.rejects(runStateCapacityCli(['--snapshot', snapshotFile, '--interval-minutes', '0']), /CAPACITY_OPTIONS_INVALID/);
  assert.throws(() => analyzeStateEntries([encode('../escape.json', {})]), /CAPACITY_FILE_INVALID/);
  assert.throws(() => analyzeStateEntries([encode('state/secret.json', {})]), /CAPACITY_FILE_INVALID/);
  const file = prediction(); assert.throws(() => analyzeStateEntries([file, file]), /CAPACITY_DUPLICATE_PATH/);
});
