import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { decodeReportFixture, readReportFixture, restoreReportFixture, runRestoreReportCli } from '../../scripts/restore-report-fixture.mjs';
import { exportEvaluationEvidence } from '../export-evaluation.mjs';
import { loadReportBundle } from '../report-store.mjs';

const reportId = 'e541ec0487829321212c9c95d84a4790888baa7c0f0f284a6e72745e728902c6';
const fixturePath = new URL(`./fixtures/real-report-${reportId}.json.gz`, import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const temporary = async t => { const root = await mkdtemp(join(tmpdir(), 'dimension-real-report-')); t.after(() => rm(root, { recursive: true, force: true })); return root; };
function replaceJSON(row, value) {
  const bytes = Buffer.from(JSON.stringify(value)); Object.assign(row, { content: bytes.toString('base64'), bytes: bytes.length, sha256: sha(bytes) });
}

test('fixed original bytes restore offline and reproduce the committed historical asset exactly', async t => {
  const root = await temporary(t), directory = join(root, 'restored'), target = join(root, 'evaluation.json');
  const { fixture, files } = await readReportFixture();
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network forbidden during fixture restore/export'); };
  try {
    const result = await restoreReportFixture(directory);
    assert.equal(result.files, 30); assert.equal(result.localStoreReconstructed, true); assert.equal(result.releaseGate, 'BLOCKED');
    for (const [path, bytes] of files) assert.deepEqual(await readFile(join(directory, path)), bytes, path);
    const bundle = await loadReportBundle(directory);
    assert.equal(bundle.reportId, reportId); assert.equal(bundle.report.simulated, false);
    assert.equal(bundle.sourceData.openligadb.reportId, reportId);
    assert.equal(bundle.receipt.channels.notifications.status, 'not_configured');
    assert.equal(bundle.receipt.channels.externalWebsite.status, 'not_configured');
    await exportEvaluationEvidence({ directory, outputFile: target, nowISO: fixture.exportedAt });
    assert.deepEqual(await readFile(target), await readFile(new URL('../../website/evaluation-evidence.json', import.meta.url)));
    const asset = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(asset.prospective.evaluated, 0); assert.equal(asset.canRelease, false);
    assert.ok(asset.groups.find(row => row.league === 'BL1' && row.horizonHours === 1).metrics.accuracy < .5);
  } finally { globalThis.fetch = fetchBefore; }
});

test('corruption, traversal, duplicate names, executable paths and secret fields cannot enter a restored fixture', async () => {
  const compressed = await readFile(fixturePath), original = JSON.parse(gunzipSync(compressed));
  const changes = [
    value => { value.files[0].path = '../outside.json'; },
    value => { value.files[0].path = '/tmp/outside.json'; },
    value => { value.files[0].path = '.delivery/outbox.json'; },
    value => { value.files[0].path = 'run.sh'; },
    value => { value.files[0].path = value.files[1].path; },
    value => { value.files[0].sha256 = '0'.repeat(64); },
    value => { value.files[0].content += '!'; },
    value => { value.files[0].bytes += 1; },
    value => { value.reportId = '0'.repeat(64); },
    value => { value.artifactZipSha256 = '0'.repeat(64); },
    value => { replaceJSON(value.files[0], { authorization: 'do-not-copy' }); },
    value => { replaceJSON(value.files.find(row => row.path === 'run-manifest.json'), { reportId }); },
  ];
  for (const change of changes) {
    const candidate = structuredClone(original); change(candidate);
    assert.throws(() => decodeReportFixture(gzipSync(JSON.stringify(candidate))), /^Error: REPORT_FIXTURE_INVALID$/);
  }
  assert.throws(() => decodeReportFixture(compressed.subarray(0, -10)), /REPORT_FIXTURE_INVALID/);
  assert.throws(() => decodeReportFixture(gzipSync(Buffer.alloc(8_000_001, 32))), /REPORT_FIXTURE_INVALID/);
});

test('restore refuses occupied targets, symlinks and relative paths without damaging existing files', async t => {
  const root = await temporary(t), existing = join(root, 'existing'), alias = join(root, 'alias');
  await mkdir(existing); await writeFile(join(existing, 'keep.json'), '{"keep":true}'); await symlink(existing, alias);
  for (const target of [existing, alias, join(alias, 'new'), 'relative-report-directory']) {
    await assert.rejects(restoreReportFixture(target), /REPORT_FIXTURE_/);
  }
  assert.equal(await readFile(join(existing, 'keep.json'), 'utf8'), '{"keep":true}');
  assert.deepEqual(await readdir(existing), ['keep.json']);
  let output = '', error = '';
  assert.equal(await runRestoreReportCli(['--out', existing], { stdout: text => { output += text; }, stderr: text => { error += text; } }), 1);
  assert.equal(output, ''); assert.equal(error, 'REPORT_FIXTURE_RESTORE_FAILED\n');
});

test('retired d9 summary is preserved byte-for-byte and never re-labelled as recovered inputs', async () => {
  const bytes = await readFile(new URL('../../docs/evidence/retired-evaluation-d9.json', import.meta.url));
  assert.equal(sha(bytes), '6216912148bd1af0178157c3aedc662fb3bb9cdd11ee1b2e228310c5a3190f7e');
  const old = JSON.parse(bytes), current = JSON.parse(await readFile(new URL('../../website/evaluation-evidence.json', import.meta.url), 'utf8'));
  assert.equal(old.binding.reportId, 'd9d61ff8969b662a1a82b9ead07dcfa83e200104d2eb4484c8bff84866dc804c');
  assert.notEqual(current.binding.reportId, old.binding.reportId);
  assert.notEqual(current.binding.inputsHash, old.binding.inputsHash);
});
