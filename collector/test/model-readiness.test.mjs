import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModelReadiness, runModelReadinessCli } from '../model-readiness.mjs';
import { appendPrediction, appendReportPredictions, appendResultAndScore } from '../prediction-ledger.mjs';
import { digest } from '../policy.mjs';

const generatedAt = '2026-10-01T12:00:00.000Z', kickoff = '2026-10-02T12:00:00.000Z';
const finished = '2026-10-02T14:00:00.000Z';
const model = { id: 'readiness-test-model', version: 1, calibrated: false };
async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'model-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const fixture = (id, source = 'test-source', league = 'BL1') => ({ id, source, league, homeTeamId: '1', awayTeamId: '2', kickoff });
const forecast = id => ({ fixtureId: id, status: 'forecast', generatedAt, trainingCutoff: generatedAt,
  trainingHash: 'a'.repeat(64), probabilities: { home: .5, draw: .3, away: .2 },
  freshness: { validUntil: '2026-10-01T13:00:00.000Z' } });
async function settled(directory, id, { source, league, selectedModel = model, nowISO = finished } = {}) {
  const f = fixture(id, source, league);
  await appendPrediction({ directory, fixture: f, forecast: forecast(id), model: selectedModel, reportId: digest(id), nowISO: generatedAt });
  await appendResultAndScore({ directory, result: { ...f, status: 'FINISHED', period: 'full-time', homeGoals: 1, awayGoals: 1,
    resultObservedAt: finished }, nowISO });
}
const readiness = (directory, extra = {}) => buildModelReadiness({ directory, model, nowISO: finished, horizonHours: 24, ...extra });
const bl1 = report => report.leagues.find(row => row.league === 'BL1');

test('missing ledger cannot borrow retrospective or training counts for release', async t => {
  const directory = await workspace(t), missing = join(directory, 'forecast-ledger');
  await writeFile(join(directory, 'backtest.json'), JSON.stringify({ evaluated: 1000, historyMatches: 10000, calibrated: true }));
  const result = await readiness(missing);
  assert.equal(result.releaseGate, 'BLOCKED'); assert.equal(result.canRelease, false);
  assert.equal(result.ledger.status, 'MISSING'); assert.equal(result.calibration.status, 'NOT_CALIBRATED');
  assert.ok(result.blockers.includes('MODEL_NOT_CALIBRATED'));
  assert.deepEqual(result.leagues.map(row => [row.settledFrozenSamples, row.minimumSampleGap]), Array(5).fill([0, 200]));
  assert.deepEqual(await readdir(directory), ['backtest.json']);
});

test('only settled predictions in the exact model configuration and lead window count, including unavailable coverage', async t => {
  const directory = await workspace(t);
  await settled(directory, 'in-window');
  await settled(directory, 'old-configuration', { selectedModel: { ...model, priorMatches: 7 } });
  await settled(directory, 'late-result', { nowISO: '2026-10-03T14:00:00.000Z' });
  await appendPrediction({ directory, fixture: { ...fixture('short-lead'), kickoff: '2026-10-01T14:00:00.000Z' },
    forecast: forecast('short-lead'), model, reportId: digest('short-lead'), nowISO: generatedAt });
  await appendReportPredictions({ directory, nowISO: generatedAt, report: { kind: 'prematch-forecast-report',
    publication: { reportId: digest('unavailable') }, model, generatedAt,
    fixtures: [{ fixture: fixture('unavailable'), forecast: { status: 'unavailable', generatedAt, reasons: ['HISTORY_UNAVAILABLE'] } }] } });
  const result = await readiness(directory), league = bl1(result);
  assert.equal(league.settledFrozenSamples, 1); assert.equal(league.minimumSampleGap, 199);
  assert.equal(league.frozenConfigurationMatches, 3);
  assert.deepEqual(league.coverage, { eligible: 3, evaluated: 1, skipped: 1, pending: 1, rate: 1 / 3 });
  assert.ok(league.exclusionReasons.includes('FORECAST_UNAVAILABLE'));
  assert.equal(league.uncertainty.status, 'insufficient-sample');
  assert.equal(league.metrics.baselineBrier, undefined); assert.equal(result.baseline.evidenceVerified, false);
  assert.equal(result.releaseGate, 'BLOCKED');
});

test('two hundred settled samples and a calibrated flag are insufficient to release', async t => {
  const directory = await workspace(t), claimedModel = { ...model, calibrated: true };
  // Test data exercises the floor; these synthetic records are never production evidence.
  for (let batch = 0; batch < 20; batch++) await Promise.all(Array.from({ length: 10 }, (_, n) =>
    settled(directory, `test-only-${batch * 10 + n}`, { selectedModel: claimedModel })));
  const result = await readiness(directory, { model: claimedModel }), league = bl1(result);
  assert.equal(league.settledFrozenSamples, 200); assert.equal(league.minimumSampleGap, 0);
  assert.equal(league.sampleFloorSatisfied, true); assert.equal(league.releaseGate, 'BLOCKED');
  assert.equal(result.protocol.sampleFloorIsSufficient, false); assert.equal(result.canRelease, false);
  assert.equal(result.calibration.status, 'UNVERIFIED'); assert.equal(result.calibration.evidenceVerified, false);
  assert.ok(league.blockers.includes('CALIBRATION_EVIDENCE_UNVERIFIED'));
  assert.ok(league.blockers.includes('FROZEN_BASELINE_COMPARISON_MISSING'));
  assert.ok(league.blockers.includes('TRAINING_INPUT_VISIBILITY_UNVERIFIED'));
});

test('legacy freezes remain inventory and cannot be silently promoted using present metadata', async t => {
  const directory = await workspace(t); await settled(directory, 'legacy');
  const event = (await readdir(directory))[0], predictions = join(directory, event, 'predictions');
  const path = join(predictions, (await readdir(predictions))[0]);
  const { record } = JSON.parse(await readFile(path, 'utf8'));
  delete record.validUntil; delete record.modelHash; record.version = 1;
  await writeFile(path, JSON.stringify({ record, sha256: digest(record) }));
  const before = await readFile(path, 'utf8'), result = await readiness(directory), league = bl1(result);
  assert.equal(league.storedPredictionRecords, 1); assert.equal(league.registeredPrematchMatches, 1);
  assert.equal(league.legacyOrInvalidFreezeRecords, 1); assert.equal(league.settledFrozenSamples, 0);
  assert.equal(await readFile(path, 'utf8'), before);
});

test('source aliases cannot inflate the league sample through unreviewed cross-source pooling', async t => {
  const directory = await workspace(t);
  await settled(directory, 'source-a-id'); await settled(directory, 'source-b-id', { source: 'other-source' });
  const ambiguous = bl1(await readiness(directory));
  assert.equal(ambiguous.source, null); assert.equal(ambiguous.settledFrozenSamples, 0);
  assert.ok(ambiguous.blockers.includes('SOURCE_COHORT_AMBIGUOUS'));
  const explicit = bl1(await readiness(directory, { sourceByLeague: { BL1: 'test-source' } }));
  assert.equal(explicit.settledFrozenSamples, 1);
});

test('ledger damage is unknown evidence, not an empty successful assessment', async t => {
  const directory = await workspace(t); await settled(directory, 'damaged');
  const event = (await readdir(directory))[0], predictions = join(directory, event, 'predictions');
  const path = join(predictions, (await readdir(predictions))[0]), envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.record.probabilities = { home: .9, draw: .05, away: .05 };
  await writeFile(path, JSON.stringify(envelope));
  const result = await readiness(directory);
  assert.equal(result.ledger.status, 'UNREADABLE_OR_INVALID');
  assert.ok(result.blockers.includes('LEDGER_INTEGRITY_UNVERIFIED'));
  assert.equal(bl1(result).settledFrozenSamples, null); assert.equal(bl1(result).minimumSampleGap, null);
});

test('CLI emits machine-readable BLOCKED with a non-success gate exit, validates duplicate arguments, and never writes', async t => {
  const directory = await workspace(t); let out = '', error = '';
  const io = { stdout: value => { out += value; }, stderr: value => { error += value; } };
  assert.equal(await runModelReadinessCli(['--ledger', directory, '--now', finished, '--horizon-hours', '24'], io), 2);
  assert.equal(JSON.parse(out).releaseGate, 'BLOCKED'); assert.equal(error, '');
  out = '';
  assert.equal(await runModelReadinessCli(['--ledger', directory, '--ledger', directory], io), 1);
  assert.equal(out, ''); assert.equal(error, 'MODEL_READINESS_FAILED\n');
  assert.deepEqual(await readdir(directory), []);
});
