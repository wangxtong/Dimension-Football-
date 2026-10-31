import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { demoInput } from '../demo.mjs';
import { runCollection } from '../pipeline.mjs';
import { writeReports } from '../report.mjs';
import { beginPublication, publishSummary, recordArtifact, verifyPublication } from '../publication.mjs';

const NOW = '2026-10-31T05:00:00.000Z';
async function run(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dimension-delivery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const d = demoInput(NOW);
  const result = await runCollection({ fixtures: d.fixtures, outDir: dir, statePath: join(dir, 'state.json'), simulated: true,
    clock: () => NOW, collectEvidence: async () => d.evidence });
  return { dir, ...result, receipt: () => readFile(join(dir, 'publication.json'), 'utf8').then(JSON.parse) };
}
const artifact = { outcome: 'success', id: '42', repository: 'wangxtong/Dimension-Football-', runId: '7',
  url: 'https://github.com/wangxtong/Dimension-Football-/actions/runs/7/artifacts/42', digest: 'a'.repeat(64) };

test('generation records only local delivery, hashes outputs and separates result categories', async t => {
  const r = await run(t), receipt = await r.receipt();
  assert.equal(receipt.channels.files.status, 'published');
  assert.equal(receipt.channels.githubArtifact.status, 'not_attempted');
  assert.equal(receipt.channels.notifications.status, 'not_configured');
  await verifyPublication(r.dir, receipt);
  const doc = JSON.parse(await readFile(r.files.predictionsPath, 'utf8'));
  assert.equal(doc.publication.reportId, receipt.reportId);
  assert.equal(doc.categories.unassessable.length, 3);
  assert.deepEqual(doc.categories.strictCandidates, [], 'simulation never appears among strict candidates');
  const html = await readFile(r.files.predictionsHtmlPath, 'utf8');
  for (const id of ['analysis', 'strict', 'unassessable']) assert.ok(html.includes(`id="${id}"`));
});

test('artifact outcome and summary append have separate receipts and repeated publication is idempotent', async t => {
  const r = await run(t), summary = join(r.dir, 'summary.md');
  await recordArtifact(r.dir, artifact);
  await publishSummary(r.dir, summary);
  const first = await readFile(summary, 'utf8');
  await publishSummary(r.dir, summary);
  assert.equal(await readFile(summary, 'utf8'), first);
  const receipt = await r.receipt();
  assert.equal(receipt.channels.githubArtifact.status, 'published');
  assert.equal(receipt.channels.githubArtifact.url, artifact.url);
  assert.equal(receipt.channels.githubSummary.status, 'published');
  assert.equal(receipt.events.length, 3);
  assert.ok(first.includes('实际发布回执'));
});

test('failed uploads, absent IDs and wrong artifact URLs cannot claim successful delivery', async t => {
  const r = await run(t);
  await recordArtifact(r.dir, { outcome: 'failure' });
  assert.equal((await r.receipt()).channels.githubArtifact.status, 'failed');
  await assert.rejects(recordArtifact(r.dir, { ...artifact, id: undefined }));
  await assert.rejects(recordArtifact(r.dir, { ...artifact, url: 'https://example.com/forged' }));
  assert.equal((await r.receipt()).channels.githubArtifact.status, 'failed');
  await recordArtifact(r.dir, artifact);
  assert.equal((await r.receipt()).channels.githubArtifact.status, 'published');
});

test('changed report bytes stop publication and persist a failure receipt', async t => {
  const r = await run(t);
  await writeFile(join(r.dir, 'predictions.md'), 'changed report');
  await assert.rejects(publishSummary(r.dir, join(r.dir, 'summary.md')), { message: 'PUBLICATION_CONTENT_CHANGED' });
  assert.equal((await r.receipt()).channels.githubSummary.code, 'PUBLICATION_CONTENT_CHANGED');
});

test('summary filesystem failure does not claim success and can be retried', async t => {
  const r = await run(t);
  await assert.rejects(publishSummary(r.dir, r.dir));
  assert.equal((await r.receipt()).channels.githubSummary.status, 'failed');
  await publishSummary(r.dir, join(r.dir, 'summary.md'));
  assert.equal((await r.receipt()).channels.githubSummary.status, 'published');
});

test('partial file generation leaves an explicit failed receipt', async t => {
  const r = await run(t), out = join(r.dir, 'broken');
  await mkdir(join(out, 'predictions.md'), { recursive: true });
  await assert.rejects(writeReports(r.report, out));
  const receipt = JSON.parse(await readFile(join(out, 'publication.json'), 'utf8'));
  assert.equal(receipt.channels.files.status, 'failed');
  await assert.rejects(verifyPublication(out, receipt), { message: 'PUBLICATION_NOT_READY' });
});
test('publication identity includes a validated input hash when provided', async t => {
  const r=await run(t),report={...r.report,inputHash:'a'.repeat(64)};
  const first=await beginPublication(report,r.dir),same=await beginPublication({...report},r.dir);
  assert.equal(first.reportId,same.reportId);
  const revised=await beginPublication({...report,inputHash:'b'.repeat(64)},r.dir);
  assert.notEqual(first.reportId,revised.reportId);
  await assert.rejects(beginPublication({...report,inputHash:'invalid'},r.dir),/INVALID_REPORT_INPUT_HASH/);
});
