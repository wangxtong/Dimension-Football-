import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildModelExperimentEvidence, runExportModelExperimentCli } from '../export-model-experiment.mjs';

const protocolFile = new URL('../../research/model-experiments/openligadb-temperature-v1-982.protocol.json', import.meta.url);
const resultFile = new URL('../../research/model-experiments/openligadb-temperature-v1-982.result.json', import.meta.url);
const hash = text => createHash('sha256').update(text).digest('hex');
async function input() {
  const [p, r] = await Promise.all([readFile(protocolFile, 'utf8'), readFile(resultFile, 'utf8')]);
  return { protocol: JSON.parse(p), result: JSON.parse(r), protocolFileSha256: hash(p), resultFileSha256: hash(r) };
}
const keys = value => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, nested]) => [key, ...keys(nested)]) : [];

test('the website asset reproduces the frozen first result without fitting or exporting per-match data', async () => {
  const data = await input(), output = buildModelExperimentEvidence(data);
  const bytes = await readFile(new URL('../../website/model-experiment-evidence.json', import.meta.url));
  assert.ok(bytes.length < 20000); assert.deepEqual(JSON.parse(bytes), output);
  assert.equal(output.binding.resultFileSha256, '71c9ec6268b44ff3a977384c7396146ea0e1b2a6b1c13407c27082e26989e08f');
  assert.equal(output.kind, 'model-experiment-evidence'); assert.equal(output.releaseGate, 'BLOCKED');
  assert.equal(output.independentEvidence, false); assert.equal(output.calibrated, false); assert.equal(output.historicalOnly, true);
  assert.deepEqual(output.samples, { input: 982, warmup: 392, calibration: { eligible: 391, evaluated: 383, skipped: 8 },
    holdout: { eligible: 199, evaluated: 182, skipped: 17, rate: 182 / 199 }, asObserved: { calibration: 0, holdout: 0 } });
  assert.equal(output.holdout.baseline.logLoss, data.result.snapshot.holdout.baseline.metrics.logLoss);
  assert.equal(output.holdout.candidate.logLoss, data.result.snapshot.holdout.candidate.metrics.logLoss);
  assert.ok(output.holdout.candidateMinusBaseline.logLoss > 0); assert.ok(output.holdout.candidateMinusBaseline.brier > 0);
  assert.equal(output.holdout.candidateMinusBaseline.accuracy, 0); assert.equal(output.decision.status, 'NOT_ADOPTED');
  assert.equal(output.decision.candidateAdopted, false); assert.ok(output.decision.reasons.includes('NO_PROPER_SCORE_IMPROVEMENT'));
  assert.ok(!keys(output).some(key => ['evaluations', 'probabilities', 'candidateProbabilities', 'baselineProbabilities', 'fixtures', 'candidates', 'recommendations', 'actual'].includes(key)));
});

test('mismatched provenance, inflated metrics and modified raw scores fail validation', async () => {
  const mutations = [data => { data.protocol.rawInputSha256 = 'a'.repeat(64); }, data => { data.result.protocolHash = 'a'.repeat(64); },
    data => { data.result.snapshot.holdout.candidate.metrics.logLoss = .1; },
    data => { data.result.snapshot.holdout.evaluations[0].candidateProbabilities.home = .99; },
    data => { data.result.independentEvidence = true; },
    data => { data.result.snapshot.holdout.quality.uncertainty.pairedBrierDifference.estimate = -.2; }];
  for (const mutate of mutations) {
    const data = await input(); mutate(data);
    assert.throws(() => buildModelExperimentEvidence(data));
  }
});

test('unknown fields from the research artifact are never copied into the website asset', async () => {
  const data = await input(); data.result.arbitrary = { notificationToken: 'DO_NOT_EXPORT_RAW_CONTENT', currentRecommendation: 'DO_NOT_EXPORT_RAW_CONTENT' };
  data.result.snapshot.holdout.evaluations[0].privateRawPayload = 'DO_NOT_EXPORT_RAW_CONTENT';
  assert.ok(!JSON.stringify(buildModelExperimentEvidence(data)).includes('DO_NOT_EXPORT_RAW_CONTENT'));
});

test('export CLI preserves the frozen sources and a failed export preserves the prior asset', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'experiment-asset-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const p = join(directory, 'protocol.json'), r = join(directory, 'result.json'), output = join(directory, 'asset.json');
  const raw = await Promise.all([readFile(protocolFile, 'utf8'), readFile(resultFile, 'utf8')]);
  await Promise.all([writeFile(p, raw[0]), writeFile(r, raw[1])]);
  let out = '', errors = ''; const io = { stdout: value => { out += value; }, stderr: value => { errors += value; } };
  const args = ['--protocol', p, '--result', r, '--output', output];
  assert.equal(await runExportModelExperimentCli(args, io), 0); const previous = await readFile(output, 'utf8');
  assert.equal(JSON.parse(out).releaseGate, 'BLOCKED'); assert.equal(errors, '');
  assert.equal(await readFile(p, 'utf8'), raw[0]); assert.equal(await readFile(r, 'utf8'), raw[1]);
  assert.equal(await runExportModelExperimentCli(['--protocol', p, '--result', r, '--output', r], io), 1);
  assert.equal(await readFile(r, 'utf8'), raw[1]);
  await writeFile(r, '{"raw":"DO_NOT_ECHO_RAW"}');
  assert.equal(await runExportModelExperimentCli(args, io), 1);
  assert.equal(await readFile(output, 'utf8'), previous); assert.ok(!errors.includes('DO_NOT_ECHO_RAW'));
});
