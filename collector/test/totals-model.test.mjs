import test from 'node:test';
import assert from 'node:assert/strict';
import { TOTALS_RESEARCH_MODEL, fitTotalsBaseline, poissonTotalsProbabilities,
  predictTotalsBaseline, scoreTotalsProbabilities, summarizeTotalsEvaluations,
  walkForwardTotalsBacktest } from '../totals-model.mjs';

// All rows in these tests are explicitly synthetic unit fixtures, never real
// sports evidence, prospective publication records or model acceptance data.
const DAY = 86400000;
const stamp = milliseconds => new Date(milliseconds).toISOString();
const start = Date.parse('2025-01-01T12:00:00.000Z');
const makeRows = (count, base = start, source = 'fixture-source', league = 'BL1') => Array.from({ length: count }, (_, i) => {
  const kickoff = base + i * DAY;
  return { id: 'synthetic-' + i, source, league, status: 'FINISHED', period: 'full-time',
    kickoff: stamp(kickoff), homeTeamId: 'club-a', awayTeamId: 'club-b',
    homeGoals: i % 4, awayGoals: i % 3,
    resultObservedAt: stamp(kickoff + 5 * 3600000),
    observedAt: stamp(kickoff + 6 * 3600000),
    fetchedAt: stamp(kickoff + 7 * 3600000) };
});
const cutoffISO = '2025-10-01T12:00:00.000Z';
const fit = (rows, options = {}) => fitTotalsBaseline(rows,
  { source: 'fixture-source', league: 'BL1', cutoffISO, ...options });

test('independent O/U baseline fits only settled same-league as-observed results', () => {
  const rows = makeRows(50);
  const trained = fit(rows);
  assert.equal(trained.status, 'RESEARCH_BASELINE_READY');
  assert.equal(trained.sample.eligibleTrainingMatches, 50);
  assert.equal(trained.goalMean, rows.reduce((sum, r) => sum + r.homeGoals + r.awayGoals, 0) / 50);
  assert.equal(trained.canRelease, false);
  assert.equal(trained.calibrated, false);
  assert.equal(TOTALS_RESEARCH_MODEL.market, 'over-under');
  assert.equal(fit(rows.toReversed()).trainingHash, trained.trainingHash);
  const forecast = predictTotalsBaseline(trained, { fixture: {
    id: 'synthetic-future', source: 'fixture-source', league: 'BL1',
    kickoff: '2025-10-02T12:00:00.000Z'
  }, generatedAt: cutoffISO, line: 2.5 });
  assert.equal(forecast.provenance, 'as-observed-history-replay-not-prospective');
  assert.equal(forecast.releaseGate, 'BLOCKED');
  assert.ok(forecast.probabilities.over > 0 && forecast.probabilities.over < 1);
  assert.ok(Math.abs(forecast.probabilities.over + forecast.probabilities.under - 1) < 1e-12);
});

test('no cross-source pooling and a fetched-after-cutoff revision cannot enter the fit', () => {
  const rows = makeRows(50), original = fit(rows);
  const futureResult = { ...makeRows(1, Date.parse('2025-02-25T12:00:00.000Z'))[0],
    id: 'future-revision', homeGoals: 20, fetchedAt: '2026-10-01T00:00:00.000Z' };
  const otherSource = makeRows(100, start, 'unrelated-source');
  const trained = fit([...rows, futureResult, ...otherSource]);
  assert.equal(trained.trainingHash, original.trainingHash);
  assert.equal(trained.goalMean, original.goalMean);
  assert.equal(trained.sample.exclusions.FUTURE_RESULT_REVISION_EXCLUDED, 1);
  assert.equal(trained.sample.scopedRecords, 51);
});

test('unknown or invalid observation clocks never become backdated visibility', () => {
  const rows = makeRows(44).map(r => ({ ...r, resultObservedAt: undefined }));
  const trained = fit(rows);
  assert.equal(trained.status, 'BACKTEST_INSUFFICIENT');
  assert.equal(trained.trainingHash, null);
  assert.equal(trained.goalMean, null);
  assert.equal(trained.sample.exclusions.RESULT_VISIBILITY_UNVERIFIED, 44);
  assert.throws(() => fit(makeRows(40), { minimumTraining: 1 }), /INVALID_TOTALS_TRAINING_OPTIONS/);
});

test('conflicting same-source event revisions are rejected instead of silently counted twice', () => {
  const rows = makeRows(45);
  assert.throws(() => fit([...rows, { ...rows[2], homeGoals: 15 }]), /CONFLICTING_TOTALS_RESULT_ID/);
  const duplicate = fit([...rows, { ...rows[2] }]);
  assert.equal(duplicate.sample.duplicateRecords, 1);
  assert.equal(duplicate.sample.eligibleTrainingMatches, 45);
});

test('half-goal O/U proper scores reject integer and quarter Asian lines', () => {
  const probability = poissonTotalsProbabilities(2.5, 2.5);
  const expectedUnder = Math.exp(-2.5) * (1 + 2.5 + 2.5 ** 2 / 2);
  assert.ok(Math.abs(probability.under - expectedUnder) < 1e-12);
  const over = scoreTotalsProbabilities({ over: .75, under: .25 }, 2.5, 2, 1);
  assert.equal(over.actual, 'over');
  assert.equal(over.accuracy, 1);
  assert.ok(Math.abs(over.brier - .125) < 1e-12);
  assert.ok(Math.abs(over.logLoss + Math.log(.75)) < 1e-12);
  const under = scoreTotalsProbabilities({ over: .75, under: .25 }, 2.5, 1, 1);
  assert.equal(under.actual, 'under');
  assert.equal(under.accuracy, 0);
  for (const line of [2, 2.25, 2.75, 3]) {
    assert.throws(() => poissonTotalsProbabilities(2.5, line), /INVALID_TOTALS_PROBABILITY_INPUT/);
    assert.throws(() => scoreTotalsProbabilities(probability, line, 2, 1), /INVALID_TOTALS_SCORE/);
  }
  assert.throws(() => scoreTotalsProbabilities({ over: .9, under: .9 }, 2.5, 1, 1), /INVALID_TOTALS_SCORE/);
});

test('research summary counts all supplied skipped and pending and cannot assert release readiness', () => {
  const rows = [{ probabilities: { over: .75, under: .25 }, line: 2.5, homeGoals: 2, awayGoals: 1,
    baseline: { over: .5, under: .5 } }];
  const report = summarizeTotalsEvaluations(rows, { eligible: 3, skipped: 1, pending: 1 });
  assert.equal(report.status, 'BACKTEST_INSUFFICIENT');
  assert.equal(report.releaseGate, 'BLOCKED');
  assert.equal(report.coverage.rate, 1 / 3);
  assert.equal(report.metrics.baselineBrier, .5);
  assert.equal(report.reliability.reduce((sum, bucket) => sum + bucket.count, 0), 1);
  assert.equal(report.uncertainty.status, 'insufficient-sample');
  assert.throws(() => summarizeTotalsEvaluations(rows, { eligible: 1, skipped: 1 }), /INVALID_TOTALS_COVERAGE/);
  // Even 200 synthetic rows cannot become proven prospective results.
  const fake = summarizeTotalsEvaluations(Array.from({ length: 200 }, () => rows[0]));
  assert.equal(fake.status, 'RETROSPECTIVE_ONLY_UNVERIFIED');
  assert.equal(fake.canRelease, false);
  assert.equal(fake.releaseGate, 'BLOCKED');
});

test('walk-forward never fits on target outcome and never upgrades history replay to prospective', () => {
  const history = makeRows(260), nowISO = '2025-12-31T12:00:00.000Z';
  const baseline = walkForwardTotalsBacktest(history, {
    source: 'fixture-source', league: 'BL1', nowISO, horizonHours: 24, line: 2.5
  });
  assert.equal(baseline.horizonHours, 24);
  assert.equal(baseline.visibility, 'as-observed-history-replay');
  assert.equal(baseline.evaluatedRows.length, 220);
  assert.equal(baseline.coverage.skipped, 40);
  assert.equal(baseline.coverage.eligible, 260);
  assert.equal(baseline.status, 'RETROSPECTIVE_ONLY_UNVERIFIED');
  assert.equal(baseline.releaseGate, 'BLOCKED');
  assert.equal(baseline.canRelease, false);
  const first = baseline.evaluatedRows[0];
  assert.equal(first.fixtureId, 'synthetic-40');
  assert.equal(first.generatedAt, stamp(Date.parse(first.kickoff) - DAY));
  const futureVersion = { ...makeRows(1, Date.parse('2025-09-20T12:00:00.000Z'))[0],
    id: 'synthetic-later-revision', homeGoals: 20,
    resultObservedAt: '2026-01-01T00:00:00.000Z',
    observedAt: '2026-01-02T00:00:00.000Z', fetchedAt: '2026-01-03T00:00:00.000Z' };
  const withFuture = walkForwardTotalsBacktest([...history, futureVersion], {
    source: 'fixture-source', league: 'BL1', nowISO, horizonHours: 24, line: 2.5
  });
  assert.equal(withFuture.coverage.pending, 1);
  assert.deepEqual(withFuture.evaluatedRows, baseline.evaluatedRows);
});

test('short real-looking inputs are still insufficient and wrong cutoff is blocked', () => {
  const report = walkForwardTotalsBacktest(makeRows(10), {
    source: 'fixture-source', league: 'BL1', nowISO: '2025-12-31T12:00:00.000Z'
  });
  assert.equal(report.status, 'BACKTEST_INSUFFICIENT');
  assert.equal(report.coverage.evaluated, 0);
  const trained = fit(makeRows(50));
  assert.throws(() => predictTotalsBaseline(trained, { fixture: {
    id: 'synthetic-future', source: 'fixture-source', league: 'BL1',
    kickoff: '2025-10-02T12:00:00.000Z'
  }, generatedAt: '2025-10-02T00:00:00.000Z' }), /INVALID_TOTALS_RESEARCH_FORECAST/);
});
