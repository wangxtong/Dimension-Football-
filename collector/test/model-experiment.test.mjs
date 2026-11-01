import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataHash } from '../data/identity.mjs';
import { temperatureScale, fitTemperature, prepareModelExperiment, runModelExperiment, runModelExperimentCli, EXPERIMENT_RULES } from '../model-experiment.mjs';

const asOf = '2026-10-31T00:00:00.000Z', executedAt = '2026-10-31T01:00:00.000Z', DAY = 86400000;
function history(count = 400) {
  const pairs = []; for (let home = 1; home <= 4; home++) for (let away = 1; away <= 4; away++) if (home !== away) pairs.push([home, away]);
  return Array.from({ length: count }, (_, i) => {
    const [home, away] = pairs[i % pairs.length];
    return { id: `history-${i}`, source: 'openligadb', league: 'BL1', home: `Team ${home}`, away: `Team ${away}`, homeTeamId: String(home), awayTeamId: String(away),
      kickoff: new Date(Date.parse(asOf) - (count - i + 1) * DAY).toISOString(), status: 'FINISHED', period: 'full-time',
      homeGoals: (Math.floor(i / 12) + home) % 4, awayGoals: (Math.floor(i / 12) + away) % 3, season: '2025',
      observedAt: asOf, resultObservedAt: asOf, fetchedAt: asOf, sourceUpdatedAt: null };
  });
}
const options = rows => ({ history: rows, source: 'openligadb', league: 'BL1', asOf, createdAt: asOf,
  rawInputSha256: dataHash(rows), experimentCodeHash: 'a'.repeat(64) });
const experiment = rows => { const input = options(rows); return runModelExperiment({ ...input, protocol: prepareModelExperiment(input), executedAt }); };
const calibrationRows = () => Array.from({ length: 100 }, (_, i) => ({ fixtureId: `fit-${i}`, source: 'openligadb', probabilities: { home: .8, draw: .1, away: .1 },
  actual: i < 60 ? 'home' : i < 80 ? 'draw' : 'away', generatedAt: '2026-01-01T00:00:00.000Z', kickoff: '2026-01-02T00:00:00.000Z',
  labelAvailableAt: '2026-01-02T04:00:00.000Z' }));
const fitCutoff = '2026-02-01T00:00:00.000Z';

test('temperature scaling normalizes, preserves ranks and ties, and has identity at one', () => {
  const p = { home: .6, draw: .25, away: .15 };
  assert.deepEqual(temperatureScale(p, 1), p);
  const softened = temperatureScale(p, .5), sharpened = temperatureScale(p, 2);
  assert.ok(Math.abs(Object.values(softened).reduce((a, b) => a + b) - 1) < 1e-12);
  assert.ok(softened.home < p.home && sharpened.home > p.home && softened.home > softened.draw && softened.draw > softened.away);
  const tied = temperatureScale({ home: .4, draw: .4, away: .2 }, 2); assert.equal(tied.home, tied.draw);
  assert.deepEqual(temperatureScale({ home: 1, draw: 0, away: 0 }, .5), { home: 1, draw: 0, away: 0 });
  assert.throws(() => temperatureScale(p, .1), /INVALID_TEMPERATURE_INPUT/);
});

test('the one-parameter fit reaches the analytic likelihood optimum without using holdout data', () => {
  const fitted = fitTemperature(calibrationRows(), { fitCutoff });
  assert.ok(Math.abs(fitted.inverseTemperature - Math.log(3) / Math.log(8)) < 1e-10);
  assert.ok(fitted.calibrationLogLoss.candidate < fitted.calibrationLogLoss.poisson);
  assert.equal(fitted.calibrated, false); assert.equal(fitted.status, 'fitted-internal-research-only');
  const posterior = temperatureScale(calibrationRows()[0].probabilities, fitted.inverseTemperature);
  assert.ok(Math.abs(posterior.home - .6) < 1e-10); assert.ok(Math.abs(posterior.draw - .2) < 1e-10);
});

test('sample floors, future fit labels and duplicate calibration fixtures cannot be bypassed', () => {
  assert.equal(fitTemperature(calibrationRows().slice(0, 99), { fitCutoff }).inverseTemperature, null);
  const future = calibrationRows(); future[0].labelAvailableAt = fitCutoff;
  assert.throws(() => fitTemperature(future, { fitCutoff }), /NONPAST_CALIBRATION_LABEL/);
  assert.throws(() => fitTemperature([...calibrationRows(), calibrationRows()[0]], { fitCutoff }), /DUPLICATE_CALIBRATION_FIXTURE/);
  const matched = calibrationRows().map((row, i) => ({ ...row, probabilities: { home: .5, draw: .25, away: .25 }, actual: i < 50 ? 'home' : i < 75 ? 'draw' : 'away' }));
  assert.equal(fitTemperature(matched, { fitCutoff }).inverseTemperature, 1);
});

test('time boundaries never split simultaneous kickoffs and observations after asOf are excluded', () => {
  const rows = history(21);
  for (let i = 0; i < rows.length; i++) rows[i].kickoff = new Date(Date.parse(asOf) - (30 - Math.floor(i / 3)) * DAY).toISOString();
  const protocol = prepareModelExperiment(options(rows));
  assert.equal(protocol.split.segments.warmup.count % 3, 0); assert.equal(protocol.split.segments.calibration.count % 3, 0);
  assert.equal(protocol.split.segments.holdout.count % 3, 0);
  const future = history(40);
  for (const field of ['observedAt', 'resultObservedAt', 'fetchedAt']) future[0][field] = '2026-11-01T00:00:00.000Z';
  const reduced = prepareModelExperiment(options(future)); assert.equal(reduced.history.accepted, 39); assert.equal(reduced.history.excludedAfterAsOf, 1);
});

test('full-history replay fits beyond the old last-80 window while genuine observed-time evidence remains absent', () => {
  const result = experiment(history());
  assert.equal(result.snapshot.status, 'completed-exploratory-only');
  assert.ok(result.snapshot.calibration.evaluated >= 100); assert.ok(result.snapshot.holdout.coverage.evaluated >= 30);
  assert.equal(result.snapshot.holdout.candidateMinusPoisson.accuracy, 0);
  assert.ok(result.snapshot.holdout.evaluations.every(row => row.candidateProbabilities && Date.parse(row.newestTrainingKickoff) + 4 * 3600000 <= Date.parse(row.generatedAt)));
  assert.equal(result.asObserved.calibration.evaluated, 0); assert.equal(result.asObserved.holdout.coverage.evaluated, 0);
  assert.equal(result.asObserved.calibration.fitted.inverseTemperature, null);
  assert.equal(result.releaseGate, 'BLOCKED'); assert.equal(result.independentEvidence, false); assert.equal(result.calibrated, false);
});

test('changing every later holdout outcome cannot change the frozen calibration fit or the first holdout forecast', () => {
  const original = history(), protocol = prepareModelExperiment(options(original)), changed = structuredClone(original);
  for (const row of changed) if (Date.parse(row.kickoff) >= Date.parse(protocol.split.holdoutStart)) { row.homeGoals = 20; row.awayGoals = 0; }
  const before = experiment(original), after = experiment(changed);
  assert.equal(before.snapshot.calibration.fitted.inverseTemperature, after.snapshot.calibration.fitted.inverseTemperature);
  assert.equal(before.snapshot.calibration.fitted.calibrationRowsHash, after.snapshot.calibration.fitted.calibrationRowsHash);
  assert.deepEqual(before.snapshot.holdout.evaluations[0].baselineProbabilities, after.snapshot.holdout.evaluations[0].baselineProbabilities);
  assert.notDeepEqual(before.snapshot.holdout.candidate.metrics, after.snapshot.holdout.candidate.metrics);
});

test('insufficient calibration does not fill a candidate with baseline probabilities or lower the floor', () => {
  const result = experiment(history(200));
  assert.equal(result.snapshot.status, 'insufficient-calibration'); assert.equal(result.snapshot.calibration.fitted.required, 100);
  assert.ok(result.snapshot.holdout.coverage.evaluated > 0);
  assert.equal(result.snapshot.holdout.candidate, null);
  assert.ok(result.snapshot.holdout.evaluations.every(row => row.candidateProbabilities === null));
});

test('input, code and protocol changes after freezing are rejected', () => {
  const rows = history(40), input = options(rows), protocol = prepareModelExperiment(input);
  assert.throws(() => runModelExperiment({ ...input, protocol, executedAt, experimentCodeHash: 'b'.repeat(64) }), /EXPERIMENT_PROTOCOL_OR_INPUT_MISMATCH/);
  const changed = structuredClone(protocol); changed.rules.minimumCalibration = 1;
  assert.throws(() => runModelExperiment({ ...input, protocol: changed, executedAt }), /EXPERIMENT_PROTOCOL_OR_INPUT_MISMATCH/);
  rows[0].homeGoals = 20;
  assert.throws(() => runModelExperiment({ ...input, protocol, executedAt }), /EXPERIMENT_PROTOCOL_OR_INPUT_MISMATCH/);
  assert.equal(EXPERIMENT_RULES.minimumCalibration, 100); assert.ok(Object.isFrozen(EXPERIMENT_RULES));
});

test('CLI freezes protocol before running and cannot overwrite a protocol, result or original input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'model-experiment-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'history.json'), protocol = join(directory, 'protocol.json'), output = join(directory, 'result.json');
  const raw = JSON.stringify({ history: history(40) }); await writeFile(file, raw);
  let out = '', error = ''; const io = { stdout: text => { out += text; }, stderr: text => { error += text; } };
  const prepare = ['prepare', '--history', file, '--source', 'openligadb', '--league', 'BL1', '--as-of', asOf, '--protocol', protocol];
  assert.equal(await runModelExperimentCli(prepare, io), 0); const frozen = await readFile(protocol, 'utf8');
  assert.equal(await runModelExperimentCli(prepare, io), 1); assert.equal(await readFile(protocol, 'utf8'), frozen);
  const run = ['run', '--history', file, '--protocol', protocol, '--output', output];
  assert.equal(await runModelExperimentCli(run, io), 0); const result = await readFile(output, 'utf8');
  assert.equal(await runModelExperimentCli(run, io), 1); assert.equal(await readFile(output, 'utf8'), result);
  assert.equal(await readFile(file, 'utf8'), raw); assert.ok(!out.includes('baselineProbabilities'));
  assert.ok(error.split('\n').filter(Boolean).every(value => value === 'MODEL_EXPERIMENT_FAILED'));
  assert.deepEqual((await readdir(directory)).sort(), ['history.json', 'protocol.json', 'result.json']);
});
