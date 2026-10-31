import { digest, isoMillis } from './policy.mjs';

// This is a separately fitted, league-level totals baseline, not a derivative
// of the 1X2 model's home/away rates. It is research-only and never releases picks.
export const TOTALS_RESEARCH_MODEL = Object.freeze({
  id: 'league-totals-poisson-research-v1', version: 1, calibrated: false,
  market: 'over-under', minimumTrainingMatches: 40, resultLagHours: 4,
  lookbackDays: 540, minimumProspectiveEvaluation: 200,
  purpose: 'historical-as-observed-replay-not-formal-prediction'
});

const DAY = 86400000;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const validLine = value => Number.isFinite(value) && value >= 0.5 && value <= 8.5 && Number.isInteger(value - 0.5);
const validGoals = row => [row?.homeGoals, row?.awayGoals].every(value => Number.isInteger(value) && value >= 0 && value <= 20);
const mean = numbers => numbers.reduce((total, n) => total + n, 0) / numbers.length;
const tally = (reasons, reason) => { reasons[reason] = (reasons[reason] || 0) + 1; };
function meanInterval(numbers) {
  if (numbers.length < 2) return null;
  const value = mean(numbers), variance = numbers.reduce((total, n) => total + (n - value) ** 2, 0) / (numbers.length - 1);
  const margin = 1.96 * Math.sqrt(variance / numbers.length);
  return { estimate: value, lower: value - margin, upper: value + margin };
}
function historyVisibility(row) {
  const observed = isoMillis(row?.observedAt), resultObserved = isoMillis(row?.resultObservedAt);
  // A first-fetch snapshot alone does not establish when a full-time result
  // became visible. Require both explicit observation clocks.
  if (!Number.isFinite(observed) || !Number.isFinite(resultObserved)) return null;
  const clocks = [observed, resultObserved];
  for (const key of ['fetchedAt', 'sourceUpdatedAt']) {
    if (row[key] == null) continue;
    const timestamp = isoMillis(row[key]);
    if (!Number.isFinite(timestamp)) return null;
    clocks.push(timestamp);
  }
  return Math.max(...clocks);
}
function validateScope({ source, league, cutoffISO, minimumTraining }) {
  if (!token(source) || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(league)
    || !Number.isFinite(isoMillis(cutoffISO)) || !Number.isInteger(minimumTraining) || minimumTraining < 40)
    throw new Error('INVALID_TOTALS_TRAINING_OPTIONS');
}

/** Only observable, settled, same-source/same-league versions strictly before cutoff. */
export function fitTotalsBaseline(history, { source, league, cutoffISO, minimumTraining = 40 } = {}) {
  validateScope({ source, league, cutoffISO, minimumTraining });
  if (!Array.isArray(history) || history.length > 10000) throw new Error('INVALID_TOTALS_HISTORY');
  const cutoff = isoMillis(cutoffISO), reasons = {}, selected = [], seen = new Map();
  let duplicateRecords = 0, scopedRecords = 0;
  for (const row of history) {
    if (row?.source !== source || row?.league !== league) continue;
    scopedRecords++;
    if (!token(row.id) || !Number.isFinite(isoMillis(row.kickoff))
      || !validGoals(row) || row.status !== 'FINISHED' || row.period !== 'full-time') {
      tally(reasons, 'INVALID_FULL_TIME_RESULT'); continue;
    }
    const fingerprint = digest([row.id, row.kickoff, row.homeTeamId, row.awayTeamId,
      row.homeGoals, row.awayGoals, row.status, row.period]);
    if (seen.has(row.id)) {
      if (seen.get(row.id) !== fingerprint) throw new Error('CONFLICTING_TOTALS_RESULT_ID');
      duplicateRecords++; continue;
    }
    seen.set(row.id, fingerprint);
    const knownAt = historyVisibility(row), kickoff = isoMillis(row.kickoff);
    if (knownAt === null || isoMillis(row.resultObservedAt) <= kickoff) {
      tally(reasons, 'RESULT_VISIBILITY_UNVERIFIED'); continue;
    }
    if (knownAt > cutoff) { tally(reasons, 'FUTURE_RESULT_REVISION_EXCLUDED'); continue; }
    if (kickoff + TOTALS_RESEARCH_MODEL.resultLagHours * 3600000 > cutoff
      || cutoff - kickoff > TOTALS_RESEARCH_MODEL.lookbackDays * DAY) {
      tally(reasons, 'OUTSIDE_CAUSAL_TRAINING_WINDOW'); continue;
    }
    selected.push({ id: row.id, source, league, kickoff: row.kickoff, homeGoals: row.homeGoals,
      awayGoals: row.awayGoals, observedAt: row.observedAt, resultObservedAt: row.resultObservedAt,
      ...(row.fetchedAt ? { fetchedAt: row.fetchedAt } : {}),
      ...(row.sourceUpdatedAt ? { sourceUpdatedAt: row.sourceUpdatedAt } : {}) });
  }
  selected.sort((a, b) => isoMillis(a.kickoff) - isoMillis(b.kickoff) || a.id.localeCompare(b.id));
  const sufficient = selected.length >= minimumTraining;
  return { kind: 'totals-research-fit', status: sufficient ? 'RESEARCH_BASELINE_READY' : 'BACKTEST_INSUFFICIENT',
    releaseGate: 'BLOCKED', canRelease: false, calibrated: false,
    model: TOTALS_RESEARCH_MODEL, source, league, trainingCutoff: cutoffISO,
    sample: { scopedRecords, eligibleTrainingMatches: selected.length, duplicateRecords, exclusions: reasons },
    trainingHash: sufficient ? digest(selected) : null,
    goalMean: sufficient ? mean(selected.map(row => row.homeGoals + row.awayGoals)) : null,
    evidenceLimitation: 'Observation timestamps on supplied rows are not independent proof of historical publication.' };
}

/** Half-goal markets only: no push and no misleading quarter-line settlement. */
export function poissonTotalsProbabilities(goalMean, line) {
  if (!Number.isFinite(goalMean) || goalMean <= 0 || goalMean > 40 || !validLine(line))
    throw new Error('INVALID_TOTALS_PROBABILITY_INPUT');
  let point = Math.exp(-goalMean), under = point;
  for (let goals = 1; goals <= Math.floor(line); goals++) {
    point *= goalMean / goals;
    under += point;
  }
  return { under, over: 1 - under };
}

export function predictTotalsBaseline(fitted, { fixture, generatedAt, line = 2.5 } = {}) {
  if (fitted?.kind !== 'totals-research-fit' || fitted.status !== 'RESEARCH_BASELINE_READY'
    || fitted.canRelease !== false || fitted.model?.id !== TOTALS_RESEARCH_MODEL.id
    || !token(fixture?.id) || fixture.source !== fitted.source || fixture.league !== fitted.league
    || !Number.isFinite(isoMillis(fixture.kickoff)) || !Number.isFinite(isoMillis(generatedAt))
    || isoMillis(generatedAt) !== isoMillis(fitted.trainingCutoff)
    || isoMillis(generatedAt) >= isoMillis(fixture.kickoff)
    || !validLine(line) || !/^[a-f0-9]{64}$/.test(fitted.trainingHash || ''))
    throw new Error('INVALID_TOTALS_RESEARCH_FORECAST');
  return { kind: 'research-totals-probabilities', modelId: TOTALS_RESEARCH_MODEL.id,
    modelVersion: TOTALS_RESEARCH_MODEL.version, calibrated: false,
    source: fixture.source, league: fixture.league, fixtureId: fixture.id,
    generatedAt, kickoff: fixture.kickoff, line, probabilities: poissonTotalsProbabilities(fitted.goalMean, line),
    trainingHash: fitted.trainingHash, trainingCutoff: fitted.trainingCutoff,
    releaseGate: 'BLOCKED', provenance: 'as-observed-history-replay-not-prospective' };
}

export function scoreTotalsProbabilities(probabilities, line, homeGoals, awayGoals) {
  if (!validLine(line) || !validGoals({ homeGoals, awayGoals })
    || !probabilities || !Number.isFinite(probabilities.over) || !Number.isFinite(probabilities.under)
    || probabilities.over < 0 || probabilities.over > 1 || probabilities.under < 0 || probabilities.under > 1
    || Math.abs(probabilities.over + probabilities.under - 1) > 1e-9)
    throw new Error('INVALID_TOTALS_SCORE');
  const actual = homeGoals + awayGoals > line ? 'over' : 'under';
  const p = probabilities[actual];
  return { actual, brier: (probabilities.over - Number(actual === 'over')) ** 2
    + (probabilities.under - Number(actual === 'under')) ** 2,
  logLoss: -Math.log(Math.max(1e-15, p)),
  accuracy: Number((probabilities.over === probabilities.under ? null
    : probabilities.over > probabilities.under ? 'over' : 'under') === actual) };
}

/** Research diagnostics only. These counts are not a verified prospective ledger. */
export function summarizeTotalsEvaluations(rows, { eligible = rows.length, skipped = 0, pending = 0, bins = 5 } = {}) {
  if (!Array.isArray(rows) || !Number.isInteger(bins) || bins < 2 || bins > 20
    || ![eligible, skipped, pending].every(n => Number.isSafeInteger(n) && n >= 0)
    || eligible !== rows.length + skipped + pending)
    throw new Error('INVALID_TOTALS_COVERAGE');
  const scored = rows.map(row => ({ ...scoreTotalsProbabilities(row.probabilities, row.line, row.homeGoals, row.awayGoals),
    ...(row.baseline ? { baseline: scoreTotalsProbabilities(row.baseline, row.line, row.homeGoals, row.awayGoals) } : {}) }));
  const metrics = scored.length ? Object.fromEntries(['brier', 'logLoss', 'accuracy'].map(k => [k, mean(scored.map(r => r[k]))])) : null;
  if (metrics && scored.every(r => r.baseline)) {
    metrics.baselineBrier = mean(scored.map(r => r.baseline.brier));
    metrics.baselineLogLoss = mean(scored.map(r => r.baseline.logLoss));
  }
  const reliability = Array.from({ length: bins }, (_, index) => {
    const members = rows.filter(r => Math.min(bins - 1, Math.floor(r.probabilities.over * bins)) === index);
    return { lower: index / bins, upper: (index + 1) / bins, count: members.length,
      meanProbability: members.length ? mean(members.map(r => r.probabilities.over)) : null,
      observedFrequency: members.length ? mean(members.map(r => Number(r.homeGoals + r.awayGoals > r.line))) : null,
      status: members.length >= 20 ? 'descriptive' : 'insufficient-bin-sample' };
  });
  return { kind: 'research-only-totals-evaluation', status: rows.length < TOTALS_RESEARCH_MODEL.minimumProspectiveEvaluation
      ? 'BACKTEST_INSUFFICIENT' : 'RETROSPECTIVE_ONLY_UNVERIFIED',
    releaseGate: 'BLOCKED', canRelease: false, calibrated: false,
    coverage: { eligible, evaluated: rows.length, skipped, pending, rate: eligible ? rows.length / eligible : null,
      denominator: 'supplied-results-only-not-all-scheduled-opportunities' },
    metrics, reliability, uncertainty: { method: 'normal-approximation-mean-95pct',
      status: rows.length >= 30 ? 'approximate-dependent-matches' : 'insufficient-sample',
      brier: meanInterval(scored.map(r => r.brier)), logLoss: meanInterval(scored.map(r => r.logLoss)),
      pairedBrierDifference: scored.length && scored.every(r => r.baseline)
        ? meanInterval(scored.map(r => r.brier - r.baseline.brier)) : null },
    limitations: ['No prospective publication or independent time attestation has been verified.',
      'Approximate intervals ignore shared teams, seasons and fixture dependence.',
      'Half-goal totals only; Asian integer/quarter lines and push/half-win settlement are not scored.',
      'A 200-row retrospective summary does not satisfy the per-league prospective release requirement.'] };
}

/** Exact lead-time, as-observed replay; NEVER count this as prospective predictions. */
export function walkForwardTotalsBacktest(history, { source, league, nowISO, horizonHours = 24,
  line = 2.5, maximumEvaluation = 300 } = {}) {
  if (!Array.isArray(history) || history.length > 10000 || !token(source) || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(league)
    || !Number.isFinite(isoMillis(nowISO)) || !Number.isFinite(horizonHours) || horizonHours < 0 || horizonHours > 336
    || !validLine(line) || !Number.isSafeInteger(maximumEvaluation) || maximumEvaluation < 200 || maximumEvaluation > 1000)
    throw new Error('INVALID_TOTALS_BACKTEST_OPTIONS');
  const now = isoMillis(nowISO), candidates = history.filter(row => row?.source === source && row?.league === league
    && Number.isFinite(isoMillis(row.kickoff)) && isoMillis(row.kickoff) + 4 * 3600000 <= now)
    .toSorted((a, b) => isoMillis(a.kickoff) - isoMillis(b.kickoff) || String(a.id).localeCompare(String(b.id)))
    .slice(-maximumEvaluation);
  if (new Set(candidates.map(row => row.id)).size !== candidates.length) throw new Error('DUPLICATE_TOTALS_BACKTEST_MATCH');
  const rows = [], exclusions = []; let pending = 0;
  for (const match of candidates) {
    if (match.status === 'POSTPONED') { pending++; continue; }
    if (match.status !== 'FINISHED' || match.period !== 'full-time' || !validGoals(match)) {
      exclusions.push({ fixtureId: match.id, reason: 'NOT_VERIFIED_FINISHED' }); continue;
    }
    const observed = historyVisibility(match);
    if (observed === null || isoMillis(match.resultObservedAt) <= isoMillis(match.kickoff)) {
      exclusions.push({ fixtureId: match.id, reason: 'RESULT_VISIBILITY_UNVERIFIED' }); continue;
    }
    if (observed > now) { pending++; continue; }
    const cutoffISO = new Date(isoMillis(match.kickoff) - horizonHours * 3600000).toISOString();
    const trained = fitTotalsBaseline(history, { source, league, cutoffISO });
    if (trained.status !== 'RESEARCH_BASELINE_READY') {
      exclusions.push({ fixtureId: match.id, reason: trained.status, trainingMatches: trained.sample.eligibleTrainingMatches }); continue;
    }
    const forecast = predictTotalsBaseline(trained, { fixture: match, generatedAt: cutoffISO, line });
    rows.push({ fixtureId: match.id, source, league, kickoff: match.kickoff, generatedAt: cutoffISO,
      resultObservedAt: match.resultObservedAt, horizonHours, line, probabilities: forecast.probabilities,
      homeGoals: match.homeGoals, awayGoals: match.awayGoals, trainingHash: forecast.trainingHash,
      provenance: 'as-observed-history-replay-not-prospective' });
  }
  const result = summarizeTotalsEvaluations(rows, { eligible: candidates.length, skipped: exclusions.length, pending });
  return { ...result, source, league, line, horizonHours, visibility: 'as-observed-history-replay',
    evaluatedRows: rows, exclusions, sampleFloorNotReleaseEvidence: true };
}
