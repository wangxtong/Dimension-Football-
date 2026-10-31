import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calibrationDiagnostics, evaluateQualityGroups, runEvaluationQualityCli, QUALITY_PROTOCOL } from '../evaluation-quality.mjs';

const start = Date.parse('2026-01-05T12:00:00.000Z'); // Monday: blocks are calendar weeks, not arbitrary groups of seven games.
const p = { home: .5, draw: .25, away: .25 };
function row(week, id = String(week), extra = {}) {
  const kickoff = new Date(start + week * 7 * 86400000).toISOString();
  return { fixtureId: `event-${id}`, source: 'test-source', league: 'BL1', horizonHours: 24,
    kickoff, generatedAt: new Date(Date.parse(kickoff) - 86400000).toISOString(), provenance: 'revised-snapshot-retrospective',
    probabilities: p, baseline: { home: .4, draw: .3, away: .3 }, actual: week % 2 ? 'away' : 'home', season: '2025', ...extra };
}
const group = (rows, horizonHours = 24) => ({ source: 'test-source', league: 'BL1', horizonHours, visibility: 'snapshot',
  evaluations: rows.map(value => ({ ...value, horizonHours, generatedAt: new Date(Date.parse(value.kickoff) - horizonHours * 3600000).toISOString() })) });
const uncertainty = rows => evaluateQualityGroups([group(rows)]).groups[0].uncertainty;

test('classwise fixed-bin ECE uses actual frequencies, includes empty bins and never certifies calibration', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ probabilities: p, actual: i < 50 ? 'home' : i < 75 ? 'draw' : 'away' }));
  const result = calibrationDiagnostics(rows);
  assert.equal(result.macroECE, 0); assert.equal(result.classes.home.ece, 0);
  assert.equal(result.classes.home.bins[2].count, 100); assert.equal(result.classes.home.bins[2].observedFrequency, .5);
  assert.equal(result.classes.home.bins[0].observedFrequency, null);
  assert.equal(result.status, 'descriptive-only-not-calibration-certification');
  const wrong = calibrationDiagnostics([{ probabilities: { home: 1, draw: 0, away: 0 }, actual: 'away' }]);
  assert.equal(wrong.macroECE, 2 / 3); assert.equal(wrong.classes.home.bins[4].count, 1);
  assert.equal(wrong.classes.home.bins[4].status, 'insufficient-bin-sample');
});

test('empty and malformed evidence cannot look perfectly calibrated', () => {
  const empty = calibrationDiagnostics([]); assert.equal(empty.macroECE, null); assert.equal(empty.classes.home.ece, null);
  const result = evaluateQualityGroups([group([])]).groups[0];
  assert.equal(result.uncertainty.status, 'no-samples'); assert.equal(result.uncertainty.pairedBrierDifference.estimate, null);
  assert.throws(() => calibrationDiagnostics([{ probabilities: { home: 2, draw: 0, away: -1 }, actual: 'home' }]), /INVALID_QUALITY_PROBABILITIES/);
});

test('paired resampling moves both scores together; an identical baseline has exactly zero paired intervals', () => {
  const rows = Array.from({ length: 8 }, (_, week) => row(week, String(week), { baseline: p }));
  const result = uncertainty(rows);
  assert.equal(result.blocks, 8); assert.equal(result.replicates, 2000); assert.equal(result.status, 'few-temporal-blocks');
  assert.deepEqual(result.pairedBrierDifference, { estimate: 0, lower: 0, upper: 0 });
  assert.deepEqual(result.pairedLogLossDifference, { estimate: 0, lower: 0, upper: 0 });
});

test('hundreds of games in seven weeks do not create eight independent blocks', () => {
  const rows = Array.from({ length: 700 }, (_, i) => row(i % 7, String(i)));
  const result = uncertainty(rows);
  assert.equal(result.observations, 700); assert.equal(result.blocks, 7); assert.equal(result.replicates, 0);
  assert.equal(result.status, 'insufficient-temporal-blocks'); assert.equal(result.pairedBrierDifference.lower, null);
  assert.ok(Number.isFinite(result.pairedBrierDifference.estimate));
});

test('replicating correlated games within each week does not artificially tighten a cluster interval', () => {
  const weeks = Array.from({ length: 8 }, (_, week) => row(week));
  const repeated = weeks.flatMap((value, i) => Array.from({ length: 10 }, (_, n) => ({ ...value, fixtureId: `repeated-${i}-${n}` })));
  const original = uncertainty(weeks).pairedBrierDifference, correlated = uncertainty(repeated).pairedBrierDifference;
  for (const key of ['estimate', 'lower', 'upper']) assert.ok(Math.abs(original[key] - correlated[key]) < 1e-12);
});

test('unequal week sizes retain the match-weighted paired mean', () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(0, `busy-${i}`, { actual: 'home' }));
  for (let week = 1; week < 8; week++) rows.push(row(week, `single-${week}`, { actual: 'away' }));
  for (const value of rows) { value.probabilities = { home: 1, draw: 0, away: 0 }; value.baseline = { home: 0, draw: 0, away: 1 }; }
  const result = uncertainty(rows);
  assert.ok(Math.abs(result.pairedBrierDifference.estimate - (-26 / 27)) < 1e-12);
  assert.equal(result.blockSizes[0].count, 20); assert.equal(result.blocks, 8);
});

test('the fixed seed is reproducible and independent of fixture input ordering', () => {
  const rows = Array.from({ length: 8 }, (_, week) => row(week));
  assert.deepEqual(uncertainty(rows), uncertainty(rows.toReversed()));
  assert.equal(QUALITY_PROTOCOL.bins, 5); assert.equal(QUALITY_PROTOCOL.bootstrapReplicates, 2000);
  assert.ok(Object.isFrozen(QUALITY_PROTOCOL));
});

test('cross-horizon overlap is disclosed without pooling or multiplying sample counts', () => {
  const rows = Array.from({ length: 3 }, (_, week) => row(week));
  const result = evaluateQualityGroups([group(rows), group(rows, 72)]);
  assert.equal(result.dependence.appearancesAcrossHorizons, 6); assert.equal(result.dependence.uniqueSourceFixtures, 3);
  assert.equal(result.dependence.repeatedAppearances, 3); assert.equal(result.dependence.pooledMetrics, null);
  assert.deepEqual(result.dependence.overlap[0], { source: 'test-source', league: 'BL1', horizonHours: [24, 72],
    counts: [3, 3], shared: 3, union: 3, identicalEvaluationSet: true });
  assert.equal(result.groups[0].sampleStructure.seasons[0].count, 3);
  assert.ok(result.groups.every(item => item.releaseGate === 'BLOCKED' && item.calibration.calibrated === false));
});

test('duplicate cohorts, duplicate matches, inconsistent outcomes and retrospective relabelling fail closed', () => {
  const a = group([row(0)]), duplicate = structuredClone(a);
  assert.throws(() => evaluateQualityGroups([a, duplicate]), /INVALID_QUALITY_COHORTS/);
  assert.throws(() => evaluateQualityGroups([group([row(0), row(0)])]), /DUPLICATE_WITHIN_QUALITY_COHORT/);
  const b = group([{ ...row(0), actual: 'away' }], 72);
  assert.throws(() => evaluateQualityGroups([a, b]), /INCONSISTENT_CROSS_HORIZON_OUTCOME/);
  assert.throws(() => evaluateQualityGroups([group([row(0, '0', { provenance: 'prospective-ledger' })])]), /INVALID_QUALITY_ROW/);
  assert.throws(() => evaluateQualityGroups([group([row(0, '0', { source: 'another-source' })])]), /INVALID_QUALITY_ROW/);
});

test('CLI fails without leaking raw errors and never writes into its report directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'quality-readonly-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'reports'));
  const root = join(directory, 'reports');
  await Promise.all(['latest.json', 'predictions.json', 'run-manifest.json'].map(name => writeFile(join(root, name), '{"raw":"DO_NOT_ECHO_RAW"}')));
  let out = '', error = ''; const io = { stdout: text => { out += text; }, stderr: text => { error += text; } };
  assert.equal(await runEvaluationQualityCli(['--reports', root], io), 1);
  assert.equal(out, ''); assert.equal(error, 'EVALUATION_QUALITY_FAILED\n');
  assert.deepEqual((await readdir(root)).sort(), ['latest.json', 'predictions.json', 'run-manifest.json']);
  assert.equal(await readFile(join(root, 'latest.json'), 'utf8'), '{"raw":"DO_NOT_ECHO_RAW"}');
  assert.equal(await runEvaluationQualityCli(['--reports', root, '--reports', root], io), 1);
});
