import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPrediction, appendReportPredictions, appendResultAndScore, evaluatePredictionLedger } from '../prediction-ledger.mjs';
import { summarizeEvaluations, temporalCalibrationExperiment } from '../forecast-evaluation.mjs';
import { digest } from '../policy.mjs';

const NOW = '2026-10-31T12:00:00.000Z', kickoff = '2026-11-01T12:00:00.000Z', finished = '2026-11-01T14:00:00.000Z';
const fixture = { id: 'event-1', source: 'openligadb', league: 'BL1', homeTeamId: '1', awayTeamId: '2', kickoff, season: '2026' };
const forecast = { fixtureId: fixture.id, status: 'forecast', generatedAt: NOW, trainingCutoff: NOW,
  trainingHash: 'a'.repeat(64), probabilities: { home: .6, draw: .2, away: .2 }, freshness: { validUntil: '2026-10-31T13:00:00.000Z' } };
const input = { fixture, forecast, model: { id: 'venue-poisson-v2', version: 2, calibrated: false }, reportId: 'b'.repeat(64), nowISO: NOW };
const result = { ...fixture, status: 'FINISHED', period: 'full-time', homeGoals: 2, awayGoals: 0, resultObservedAt: finished };
async function workspace(t) { const directory = await mkdtemp(join(tmpdir(), 'forecast-ledger-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }

test('concurrent identical predictions are published once and conflicting rewrites fail', async t => {
  const directory = await workspace(t);
  const writes = await Promise.all(Array.from({ length: 5 }, () => appendPrediction({ directory, ...input })));
  assert.equal(writes.filter(row => row.created).length, 1);
  await assert.rejects(appendPrediction({ directory, ...input, forecast: { ...forecast, probabilities: { home: .2, draw: .2, away: .6 } } }), /IMMUTABLE_LEDGER_CONFLICT/);
  await assert.rejects(appendPrediction({ directory, ...input, nowISO: finished }), /INVALID_PREDICTION_RECORD/);
  const event = (await readdir(directory))[0]; assert.equal((await readdir(join(directory, event, 'predictions'))).length, 1);
});

test('publication documents and internal reports register the same immutable records', async t => {
  const directory = await workspace(t), rows = [{ fixture, forecast },
    { fixture: { ...fixture, id: 'missing-history' }, forecast: { status: 'unavailable', generatedAt: NOW, reasons: ['HISTORY_UNAVAILABLE'] } }];
  const report = { publication: { reportId: input.reportId }, forecasts: { model: input.model, generatedAt: NOW }, results: rows };
  const document = { kind: 'prematch-forecast-report', publication: report.publication, model: input.model, generatedAt: NOW, fixtures: rows };
  assert.deepEqual(await appendReportPredictions({ directory, report: document, nowISO: NOW }), { recorded: 1, reused: 0, opportunities: 2 });
  assert.deepEqual(await appendReportPredictions({ directory, report, nowISO: NOW }), { recorded: 0, reused: 1, opportunities: 2 });
  const evaluation = await evaluatePredictionLedger({ directory, nowISO: NOW, horizonHours: 24 });
  assert.equal(evaluation.coverage.eligible, 2); assert.equal(evaluation.coverage.skipped, 1); assert.equal(evaluation.coverage.pending, 1);
  await assert.rejects(appendReportPredictions({ directory, report: { publication: report.publication }, nowISO: NOW }), /INVALID_LEDGER_REPORT/);
});

test('90-minute results score idempotently and revisions preserve the original prediction and scores', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  const first = await appendResultAndScore({ directory, result, nowISO: finished });
  const repeat = await appendResultAndScore({ directory, result: { ...result, resultObservedAt: '2026-11-01T15:00:00.000Z' }, nowISO: '2026-11-01T15:00:00.000Z' });
  assert.equal(first.scores[0].record.metrics.brier.toFixed(2), '0.24');
  assert.equal(repeat.result.created, false); assert.equal(repeat.scores[0].created, false);
  const revision = { ...result, homeGoals: 0, awayGoals: 2, resultObservedAt: '2026-11-01T16:00:00.000Z' };
  await appendResultAndScore({ directory, result: revision, nowISO: revision.resultObservedAt });
  const before = await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24 });
  const after = await evaluatePredictionLedger({ directory, nowISO: revision.resultObservedAt, horizonHours: 24 });
  assert.equal(before.evaluations[0].actual, 'home'); assert.equal(after.evaluations[0].actual, 'away');
  assert.deepEqual(after.evaluations[0].probabilities, forecast.probabilities);
  assert.equal(after.coverage.evaluated, 1);
  const restore = { ...result, resultObservedAt: '2026-11-01T17:00:00.000Z' };
  await appendResultAndScore({ directory, result: restore, nowISO: restore.resultObservedAt });
  assert.equal((await evaluatePredictionLedger({ directory, nowISO: restore.resultObservedAt, horizonHours: 24 })).evaluations[0].actual, 'home');
  await assert.rejects(appendResultAndScore({ directory, result: { ...result, period: 'extra-time' }, nowISO: finished }), /INVALID_RESULT_VERSION/);
  await assert.rejects(appendResultAndScore({ directory, result, nowISO: NOW }), /FUTURE_RESULT_OBSERVATION/);
});

test('rescheduled results are void and missing results remain pending, not losses', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  const empty = await evaluatePredictionLedger({ directory, nowISO: NOW, horizonHours: 24 });
  assert.equal(empty.coverage.pending, 1); assert.equal(empty.metrics, null);
  const moved = { ...result, kickoff: '2026-11-02T12:00:00.000Z', resultObservedAt: '2026-11-02T14:00:00.000Z' };
  await appendResultAndScore({ directory, result: moved, nowISO: moved.resultObservedAt });
  const evaluation = await evaluatePredictionLedger({ directory, nowISO: moved.resultObservedAt, horizonHours: 24 });
  assert.equal(evaluation.coverage.skipped, 1); assert.equal(evaluation.metrics, null);
  assert.equal(evaluation.exclusions[0].reason, 'void-identity-or-schedule-changed');
});

test('replaying a result repairs interrupted scoring and conflicting simultaneous revisions are quarantined', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  await appendResultAndScore({ directory, result, nowISO: finished });
  const event = (await readdir(directory))[0], scores = join(directory, event, 'scores');
  await unlink(join(scores, (await readdir(scores))[0]));
  const repaired = await appendResultAndScore({ directory, result, nowISO: finished });
  assert.equal(repaired.result.created, false); assert.equal(repaired.scores[0].created, true);
  await appendResultAndScore({ directory, result: { ...result, homeGoals: 0, awayGoals: 2 }, nowISO: finished });
  const evaluation = await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24 });
  assert.equal(evaluation.coverage.skipped, 1);
  assert.equal(evaluation.exclusions[0].reason, 'AMBIGUOUS_RESULT_REVISION');
});

test('damaged immutable records fail integrity checks instead of producing altered scores', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  const event = (await readdir(directory))[0], predictions = join(directory, event, 'predictions');
  const path = join(predictions, (await readdir(predictions))[0]), envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.record.probabilities = { home: .2, draw: .2, away: .6 };
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24 }), /LEDGER_INTEGRITY_FAILURE/);
});

test('replay cannot see a prediction before it was actually registered', async t => {
  const directory = await workspace(t);
  await appendPrediction({ directory, ...input, nowISO: '2026-10-31T12:01:00.000Z' });
  assert.equal((await evaluatePredictionLedger({ directory, nowISO: NOW, horizonHours: 24 })).coverage.eligible, 0);
});

test('coverage and reliability include empty bins without implying calibration', () => {
  const summary = summarizeEvaluations([{ probabilities: forecast.probabilities, actual: 'home', baseline: { home: 1 / 3, draw: 1 / 3, away: 1 / 3 } }], { eligible: 3, pending: 1, skipped: 1 });
  assert.equal(summary.coverage.rate, 1 / 3); assert.equal(summary.reliability.home.reduce((n, b) => n + b.count, 0), 1);
  assert.ok(summary.reliability.home.some(bin => bin.count === 0 && bin.observedFrequency === null));
  assert.equal(summary.uncertainty.status, 'insufficient-sample'); assert.equal(summary.uncertainty.brier, null);
});

test('live coverage counts unavailable fixtures and does not cherry-pick an earlier available forecast', async t => {
  const directory = await workspace(t), generatedAt = '2026-10-31T11:30:00.000Z';
  await appendPrediction({ directory, ...input, forecast: { ...forecast, generatedAt, trainingCutoff: generatedAt } });
  const report = { publication: { reportId: input.reportId }, forecasts: { generatedAt: NOW },
    results: [{ fixture, forecast: { fixtureId: fixture.id, generatedAt: NOW, status: 'unavailable', reasons: ['BACKTEST_INSUFFICIENT'] } }] };
  await appendReportPredictions({ directory, report, nowISO: NOW });
  const evaluation = await evaluatePredictionLedger({ directory, nowISO: NOW, horizonHours: 24 });
  assert.equal(evaluation.coverage.eligible, 1); assert.equal(evaluation.coverage.skipped, 1);
  assert.equal(evaluation.exclusions[0].reason, 'FORECAST_UNAVAILABLE');
});

test('calibration adapter only fits past prospective outcomes and hides test labels from apply', () => {
  const fitCutoff = '2026-10-01T00:00:00.000Z';
  const row = { provenance: 'prospective-ledger', probabilities: forecast.probabilities, actual: 'home', generatedAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-01T00:00:00.000Z', validUntil: '2026-09-01T01:00:00.000Z', trainingCutoff: '2026-09-01T00:00:00.000Z',
    source: 'openligadb', league: 'BL1', model: input.model, modelHash: digest(input.model),
    predictionId: 'a'.repeat(64), reportId: input.reportId, trainingHash: forecast.trainingHash, resultVersionId: 'c'.repeat(64),
    kickoff: '2026-09-02T00:00:00.000Z', resultObservedAt: '2026-09-02T03:00:00.000Z', resultRecordedAt: '2026-09-02T03:00:00.000Z' };
  const training = Array.from({ length: 100 }, (_, i) => ({ ...row, fixtureId: `train-${i}` }));
  const evaluation = Array.from({ length: 30 }, (_, i) => ({ ...row, fixtureId: `test-${i}`, generatedAt: '2026-10-02T00:00:00.000Z',
    recordedAt: '2026-10-02T00:00:00.000Z', validUntil: '2026-10-02T01:00:00.000Z',
    kickoff: '2026-10-03T00:00:00.000Z', resultObservedAt: '2026-10-03T03:00:00.000Z', resultRecordedAt: '2026-10-03T03:00:00.000Z' }));
  const delayed = { ...row, fixtureId: 'delayed-result', resultRecordedAt: '2026-10-04T00:00:00.000Z' };
  const options = { fitCutoff, cohort: { modelId: input.model.id, modelVersion: 2, modelHash: digest(input.model), source: 'openligadb', league: 'BL1', horizonHours: 24, toleranceHours: 1 },
    fit: rows => { assert.equal(rows.length, 100); assert.ok(rows.every(row => row.fixtureId.startsWith('train-'))); return {}; },
    apply: (_, features) => { assert.ok(!('actual' in features)); return features.probabilities; } };
  const result = temporalCalibrationExperiment([...training, ...evaluation, delayed], options);
  assert.equal(result.status, 'research-evaluation-only'); assert.equal(result.calibrated, false);
  assert.equal(temporalCalibrationExperiment(evaluation, options).status, 'insufficient-prospective-evidence');
  assert.throws(() => temporalCalibrationExperiment([...training, training[0], ...evaluation], options), /DUPLICATE_CALIBRATION_FIXTURE/);
  assert.equal(temporalCalibrationExperiment([...training, ...evaluation].map(row => ({ ...row, provenance: 'revised-snapshot-retrospective' })), options).status, 'insufficient-prospective-evidence');
});

test('actual registration lead time and expiry govern frozen evaluation', async t => {
  const directory = await workspace(t), recorded = '2026-10-31T12:30:00.000Z';
  await appendPrediction({ directory, ...input, nowISO: recorded });
  await appendResultAndScore({ directory, result, nowISO: finished });
  assert.equal((await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24 })).coverage.evaluated, 0);
  const actual = await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 23, toleranceHours: 1 });
  assert.equal(actual.coverage.evaluated, 1); assert.equal(actual.evaluations[0].horizonHours, 23.5);
  await assert.rejects(appendPrediction({ directory, ...input, nowISO: forecast.freshness.validUntil }), /INVALID_PREDICTION_RECORD/);
});

test('result backfill is not visible before its actual ledger registration time', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  await appendResultAndScore({ directory, result, nowISO: '2026-11-02T14:00:00.000Z' });
  const past = await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24 });
  assert.equal(past.coverage.evaluated, 0); assert.equal(past.coverage.pending, 1);
});

test('mixed model configurations cannot produce a pooled headline score', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  await appendResultAndScore({ directory, result, nowISO: finished });
  const other = { ...fixture, id: 'second-event' };
  await appendPrediction({ directory, ...input, fixture: other, forecast: { ...forecast, fixtureId: other.id }, model: { ...input.model, version: 3 } });
  await appendResultAndScore({ directory, result: { ...result, id: other.id }, nowISO: finished });
  const mixed = await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24 });
  assert.equal(mixed.assessmentStatus, 'blocked-mixed-cohorts'); assert.equal(mixed.metrics, null);
  const isolated = await evaluatePredictionLedger({ directory, nowISO: finished, horizonHours: 24, modelId: input.model.id, modelVersion: 2 });
  assert.equal(isolated.coverage.evaluated, 1); assert.ok(isolated.metrics);
});
