import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildEvaluationEvidence, exportEvaluationEvidence, runExportEvaluationCli } from '../export-evaluation.mjs';
import { createReplayBundle } from '../data/run-manifest.mjs';
import { FORECAST_MODEL } from '../forecast.mjs';
import { DEFAULT_POLICY, digest } from '../policy.mjs';
import { summarizeEvaluations } from '../forecast-evaluation.mjs';

const generatedAt = '2026-10-31T07:00:00.000Z', exportedAt = '2026-10-31T08:00:00.000Z';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function refreshDocument(bundle) {
  bundle.document.backtests = bundle.report.forecasts.backtests.map(({ evaluations, exclusions, ...summary }) => summary);
  bundle.document.backtestDetails.sha256 = sha(bundle.report.forecasts.backtests);
}
function fixture() {
  const history = ['home', 'away'].map((winner, i) => ({ id: `historical-${i}`, source: 'test-source', league: 'BL1',
    home: 'Home', away: 'Away', homeTeamId: '1', awayTeamId: '2', kickoff: `2026-09-0${i + 2}T12:00:00.000Z`,
    status: 'FINISHED', period: 'full-time', homeGoals: Number(winner === 'home'), awayGoals: Number(winner === 'away') }));
  const evaluations = history.map(row => ({ fixtureId: row.id, source: row.source, league: row.league, kickoff: row.kickoff,
    generatedAt: new Date(Date.parse(row.kickoff) - 86400000).toISOString(), horizonHours: 24, trainingHash: 'c'.repeat(64),
    probabilities: { home: .6, draw: .2, away: .2 }, baseline: { home: .4, draw: .2, away: .4 },
    actual: row.homeGoals ? 'home' : 'away', provenance: 'revised-snapshot-retrospective' }));
  const group = { source: 'test-source', league: 'BL1', horizonHours: 24, visibility: 'snapshot', method: 'chronological-walk-forward',
    purpose: 'reference-horizon', evaluated: 2, skipped: 0, interrupted: false, evaluations, exclusions: [],
    ...summarizeEvaluations(evaluations) };
  const report = { simulated: false, completedAt: generatedAt, summary: { total: 0 }, results: [],
    forecasts: { model: FORECAST_MODEL, generatedAt, backtests: [group] }, secret: 'DO_NOT_COPY_RAW_REPORT',
    currentPredictions: [{ probabilities: { home: .8, draw: .1, away: .1 }, selection: 'home' }] };
  const reportId = digest([generatedAt, false, report.summary, []]);
  report.publication = { reportId };
  const replay = createReplayBundle({ reportId, fixtures: [], history, policy: DEFAULT_POLICY, model: FORECAST_MODEL,
    generatedAt, cutoff: generatedAt, codeVersion: 'a'.repeat(40) });
  const document = { generatedAt, simulated: false, model: FORECAST_MODEL, publication: { reportId }, backtests: [], backtestDetails: { reportId } };
  const readiness = { kind: 'model-readiness', generatedAt: exportedAt, releaseGate: 'BLOCKED', model: { configurationHash: digest(FORECAST_MODEL) },
    protocol: { horizonHours: 1, toleranceHours: 1 }, ledger: { snapshotHash: 'b'.repeat(64) },
    leagues: ['PL', 'PD', 'SA', 'BL1', 'FL1'].map(league => ({ league, source: 'test-source', settledFrozenSamples: 0, minimumSampleGap: 200,
      registeredUnsettledMatches: 0, legacyOrInvalidFreezeRecords: 0 })) };
  const bundle = { report, document, ...replay, readiness, exportedAt }; refreshDocument(bundle); return bundle;
}
const serializedKeys = value => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, nested]) => [key, ...serializedKeys(nested)]) : [];

test('only historical aggregate metrics are exported, with baseline deltas preserving both improvement and deterioration', () => {
  const result = buildEvaluationEvidence(fixture()), group = result.groups[0];
  assert.equal(group.metrics.accuracy, .5); assert.equal(group.baseline.accuracy, 0); // Tied baseline has no selected direction.
  assert.ok(Math.abs(group.metrics.brier - .64) < 1e-12); assert.ok(Math.abs(group.baseline.brier - .56) < 1e-12);
  assert.ok(Math.abs(group.deltaVsBaseline.brier - .08) < 1e-12); // Accuracy improves while Brier is worse: do not hide this.
  assert.equal(group.deltaVsBaseline.accuracy, .5);
  assert.equal(result.releaseGate, 'BLOCKED'); assert.equal(result.historicalOnly, true);
  assert.equal(result.prospective.evaluated, 0); assert.deepEqual(result.improvement.series, []);
  assert.equal(result.improvement.status, 'NO_COMPARABLE_MODEL_VERSIONS');
  assert.ok(!JSON.stringify(result).includes('DO_NOT_COPY_RAW_REPORT'));
  assert.ok(!serializedKeys(result).some(key => ['probabilities', 'fixtures', 'selection', 'candidates', 'recommendations', 'trainingHash'].includes(key)));
});

test('report, input, manifest, model and individual outcomes must all agree', () => {
  const changes = [b => { b.report.publication.reportId = 'd'.repeat(64); },
    b => { b.manifest.codeVersion = 'f'.repeat(40); }, b => { b.inputs.history[0].homeGoals = 0; },
    b => { b.report.forecasts.model = { ...FORECAST_MODEL, version: 1 }; },
    b => { b.report.forecasts.backtests[0].evaluations[0].actual = 'away'; refreshDocument(b); }];
  for (const change of changes) { const bundle = fixture(); change(bundle); assert.throws(() => buildEvaluationEvidence(bundle)); }
});

test('tampered aggregate metrics cannot be re-labelled as a verified historical report', () => {
  const bundle = fixture(); bundle.report.forecasts.backtests[0].metrics.accuracy = .99; refreshDocument(bundle);
  assert.throws(() => buildEvaluationEvidence(bundle), /INVALID_HISTORICAL_EVALUATION_EVIDENCE/);
  const retrospective = fixture(); retrospective.report.forecasts.backtests[0].evaluations[0].provenance = 'prospective-ledger'; refreshDocument(retrospective);
  assert.throws(() => buildEvaluationEvidence(retrospective), /INVALID_HISTORICAL_EVALUATION_EVIDENCE/);
  const future = fixture(); future.report.forecasts.backtests[0].evaluations[0].generatedAt = 'invalid'; refreshDocument(future);
  assert.throws(() => buildEvaluationEvidence(future), /INVALID_HISTORICAL_EVALUATION_EVIDENCE/);
});

test('duplicate cohorts fail and missing history stays null instead of a zero-percent accuracy', () => {
  const duplicate = fixture(); duplicate.report.forecasts.backtests.push(structuredClone(duplicate.report.forecasts.backtests[0])); refreshDocument(duplicate);
  assert.throws(() => buildEvaluationEvidence(duplicate), /INVALID_HISTORICAL_EVALUATION_EVIDENCE/);
  const empty = fixture(), group = empty.report.forecasts.backtests[0];
  Object.assign(group, { league: 'PL', evaluated: 0, evaluations: [], ...summarizeEvaluations([]) }); refreshDocument(empty);
  const result = buildEvaluationEvidence(empty).groups[0];
  assert.equal(result.evaluated, 0); assert.equal(result.metrics, null); assert.equal(result.baseline, null);
  assert.equal(result.deltaVsBaseline, null); assert.ok(result.reasons.includes('HISTORY_UNAVAILABLE'));
});

test('CLI creates only its separate asset and failed exports never replace an existing asset', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'evaluation-export-')); t.after(() => rm(cwd, { recursive: true, force: true }));
  const bundle = fixture(), directory = join(cwd, 'reports'), outputFile = join(cwd, 'evidence.json');
  await mkdir(join(directory, 'replays', bundle.manifest.reportId), { recursive: true });
  await Promise.all([['latest.json', bundle.report], ['predictions.json', bundle.document], ['run-manifest.json', bundle.manifest],
    [`replays/${bundle.manifest.reportId}/run-inputs.json`, bundle.inputs]].map(([path, value]) => writeFile(join(directory, path), JSON.stringify(value))));
  const original = await readFile(join(directory, 'latest.json'), 'utf8'); let output = '', error = '';
  const io = { stdout: text => { output += text; }, stderr: text => { error += text; } };
  assert.equal(await runExportEvaluationCli(['--reports', directory, '--output', outputFile, '--now', exportedAt], io), 0);
  assert.equal(JSON.parse(output).releaseGate, 'BLOCKED'); assert.equal(error, '');
  assert.equal(await readFile(join(directory, 'latest.json'), 'utf8'), original);
  const priorAsset = await readFile(outputFile, 'utf8');
  await assert.rejects(exportEvaluationEvidence({ directory, outputFile: join(directory, 'replacement.json'), nowISO: exportedAt }), /MUST_NOT_OVERWRITE_SOURCE/);
  await writeFile(join(directory, 'run-manifest.json'), '{"private":"DO_NOT_ECHO_ERROR"}');
  assert.equal(await runExportEvaluationCli(['--reports', directory, '--output', outputFile, '--now', exportedAt], io), 1);
  assert.equal(await readFile(outputFile, 'utf8'), priorAsset); assert.equal(error, 'EVALUATION_EVIDENCE_EXPORT_FAILED\n');
});

test('committed real evidence stays bounded and separate from current prediction publication', async () => {
  const text = await readFile(new URL('../../website/evaluation-evidence.json', import.meta.url), 'utf8'), asset = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) < 100000); assert.equal(asset.model.version, 2); assert.equal(asset.model.calibrated, false);
  assert.equal(asset.binding.codeVersion, '17931a231f6f11ccbf191fff855eae7930ad3466');
  assert.equal(asset.binding.reportId, 'e541ec0487829321212c9c95d84a4790888baa7c0f0f284a6e72745e728902c6');
  assert.equal(asset.groups.length, 25); assert.equal(asset.prospective.evaluated, 0); assert.equal(asset.releaseGate, 'BLOCKED');
  assert.ok(asset.groups.filter(row => row.league !== 'BL1').every(row => row.metrics === null && row.evaluated === 0));
  assert.ok(!serializedKeys(asset).some(key => ['probabilities', 'fixtures', 'candidates', 'selection', 'recommendations'].includes(key)));
  assert.deepEqual(asset.groups.filter(row => row.league === 'BL1' && row.purpose === 'reference-horizon').map(row => [row.horizonHours, row.evaluated, row.skipped]), [[1, 63, 17], [24, 63, 17], [72, 63, 17], [168, 60, 20]]);
});
