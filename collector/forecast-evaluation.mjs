import { isoMillis } from './policy.mjs';

export const OUTCOMES = Object.freeze(['home', 'draw', 'away']);
export function validProbabilities(p) {
  return !!p && OUTCOMES.every(key => Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1)
    && Math.abs(OUTCOMES.reduce((sum, key) => sum + p[key], 0) - 1) < 1e-6;
}
export function scoreProbabilities(probabilities, actual) {
  if (!validProbabilities(probabilities) || !OUTCOMES.includes(actual)) throw new Error('INVALID_EVALUATION');
  const ranked = OUTCOMES.toSorted((a, b) => probabilities[b] - probabilities[a]);
  const selection = probabilities[ranked[0]] === probabilities[ranked[1]] ? null : ranked[0];
  return { brier: OUTCOMES.reduce((sum, key) => sum + (probabilities[key] - Number(key === actual)) ** 2, 0),
    logLoss: -Math.log(Math.max(1e-15, probabilities[actual])), accuracy: Number(selection === actual) };
}
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length;
function meanInterval(values) {
  if (values.length < 2) return null;
  const mean = average(values), variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return { estimate: mean, lower: mean - margin, upper: mean + margin };
}

/** Diagnostic intervals are approximate; correlated fixtures are not independent trials. */
export function summarizeEvaluations(rows, { eligible = rows.length, skipped = 0, pending = 0, bins = 5 } = {}) {
  if (!Array.isArray(rows) || !Number.isInteger(bins) || bins < 2 || bins > 20
    || ![eligible, skipped, pending].every(n => Number.isInteger(n) && n >= 0)
    || eligible !== rows.length + skipped + pending) throw new Error('INVALID_EVALUATION_COVERAGE');
  const scored = rows.map(row => ({ ...scoreProbabilities(row.probabilities, row.actual),
    ...(row.baseline ? { baseline: scoreProbabilities(row.baseline, row.actual) } : {}) }));
  const metrics = scored.length ? Object.fromEntries(['brier', 'logLoss', 'accuracy'].map(key => [key, average(scored.map(row => row[key]))])) : null;
  if (metrics && scored.every(row => row.baseline)) {
    metrics.baselineBrier = average(scored.map(row => row.baseline.brier));
    metrics.baselineLogLoss = average(scored.map(row => row.baseline.logLoss));
  }
  const reliability = Object.fromEntries(OUTCOMES.map(key => [key, Array.from({ length: bins }, (_, index) => {
    const members = rows.filter(row => Math.min(bins - 1, Math.floor(row.probabilities[key] * bins)) === index);
    return { lower: index / bins, upper: (index + 1) / bins, count: members.length,
      meanProbability: members.length ? average(members.map(row => row.probabilities[key])) : null,
      observedFrequency: members.length ? average(members.map(row => Number(row.actual === key))) : null,
      status: members.length >= 20 ? 'descriptive' : 'insufficient-bin-sample' };
  })]));
  return { metrics, coverage: { eligible, evaluated: rows.length, skipped, pending, rate: eligible ? rows.length / eligible : null },
    reliability, uncertainty: { method: 'normal-approximation-mean-95pct', status: rows.length >= 30 ? 'approximate-small-sample' : 'insufficient-sample',
      brier: meanInterval(scored.map(row => row.brier)), logLoss: meanInterval(scored.map(row => row.logLoss)),
      pairedBrierDifference: scored.length && scored.every(row => row.baseline) ? meanInterval(scored.map(row => row.brier - row.baseline.brier)) : null,
      limitations: ['Intervals assume independent observations; match and team dependence can understate uncertainty.',
        'Reliability bins describe this sample and do not establish calibration.'] } };
}

/** A research-only adapter: outcomes must have been observed strictly before fitting. */
export function temporalCalibrationExperiment(rows, { fitCutoff, fit, apply, cohort, minimumTraining = 100, minimumEvaluation = 30 } = {}) {
  const cutoff = isoMillis(fitCutoff);
  if (!Array.isArray(rows) || !Number.isFinite(cutoff) || typeof fit !== 'function' || typeof apply !== 'function'
    || !Number.isInteger(minimumTraining) || minimumTraining < 100 || !Number.isInteger(minimumEvaluation) || minimumEvaluation < 30
    || !cohort || !['modelId', 'source', 'league'].every(key => typeof cohort[key] === 'string' && cohort[key])
    || !Number.isSafeInteger(cohort.modelVersion) || !/^[a-f0-9]{64}$/.test(cohort.modelHash || '')
    || !Number.isFinite(cohort.horizonHours) || cohort.horizonHours < 0
    || !Number.isFinite(cohort.toleranceHours) || cohort.toleranceHours < 0 || cohort.toleranceHours > 24) throw new Error('INVALID_CALIBRATION_EXPERIMENT');
  const eligible = rows.filter(row => row?.provenance === 'prospective-ledger' && validProbabilities(row.probabilities)
    && typeof row.fixtureId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(row.fixtureId)
    && OUTCOMES.includes(row.actual) && Number.isFinite(isoMillis(row.generatedAt)) && Number.isFinite(isoMillis(row.resultObservedAt))
    && ['predictionId', 'reportId', 'trainingHash', 'modelHash', 'resultVersionId'].every(key => /^[a-f0-9]{64}$/.test(row[key] || ''))
    && row.model?.id === cohort.modelId && row.model?.version === cohort.modelVersion && row.modelHash === cohort.modelHash
    && row.source === cohort.source && row.league === cohort.league
    && isoMillis(row.trainingCutoff) <= isoMillis(row.generatedAt) && isoMillis(row.generatedAt) <= isoMillis(row.recordedAt)
    && isoMillis(row.recordedAt) < isoMillis(row.kickoff) && isoMillis(row.recordedAt) < isoMillis(row.validUntil)
    && isoMillis(row.recordedAt) - isoMillis(row.generatedAt) < 3600000
    && (isoMillis(row.kickoff) - isoMillis(row.recordedAt)) / 3600000 >= cohort.horizonHours
    && (isoMillis(row.kickoff) - isoMillis(row.recordedAt)) / 3600000 <= cohort.horizonHours + cohort.toleranceHours
    && isoMillis(row.resultObservedAt) > isoMillis(row.kickoff) && isoMillis(row.resultRecordedAt) >= isoMillis(row.resultObservedAt));
  if (new Set(eligible.map(row => `${row.source}:${row.fixtureId}`)).size !== eligible.length) throw new Error('DUPLICATE_CALIBRATION_FIXTURE');
  const training = eligible.filter(row => isoMillis(row.resultRecordedAt) < cutoff);
  const evaluation = eligible.filter(row => isoMillis(row.recordedAt) >= cutoff);
  if (training.length < minimumTraining || evaluation.length < minimumEvaluation) return {
    status: 'insufficient-prospective-evidence', calibrated: false, training: training.length, evaluation: evaluation.length };
  const fitted = fit(structuredClone(training));
  const adjusted = evaluation.map(row => {
    // Only pre-result inputs are supplied to apply, never the held-out outcome.
    const probabilities = apply(fitted, structuredClone({ probabilities: row.probabilities, generatedAt: row.generatedAt,
      recordedAt: row.recordedAt, horizonHours: (isoMillis(row.kickoff) - isoMillis(row.recordedAt)) / 3600000 }));
    if (!validProbabilities(probabilities)) throw new Error('INVALID_CALIBRATED_PROBABILITIES');
    return { ...row, probabilities, baseline: row.probabilities };
  });
  return { status: 'research-evaluation-only', calibrated: false, fitCutoff, cohort, training: training.length, evaluation: evaluation.length,
    assessment: summarizeEvaluations(adjusted), note: 'No model promotion or production calibration is performed by this experiment.' };
}
