import { basicScreen, DEFAULT_POLICY, digest, isoMillis } from './policy.mjs';
import { summarizeEvaluations } from './forecast-evaluation.mjs';
import { normalizeHistoryRecord } from './data/history-cache.mjs';
import { partitionLogicalMatches } from './data/identity.mjs';

export const FORECAST_MODEL = Object.freeze({ id: 'venue-poisson-v2', version: 2,
  description: '按主客场与时间衰减计算进失球率，向联赛均值收缩的独立泊松基线',
  lookbackDays: 540, halfLifeDays: 180, priorMatches: 6,
  minimumLeagueMatches: 40, minimumTeamMatches: 6, minimumVenueMatches: 2,
  maximumTeamAgeDays: 120, resultLagHours: 4, backtestLimit: 80,
  calibrated: false, purpose: 'prematch-1x2-analysis', needsOdds: false });
export const BACKTEST_HORIZONS = Object.freeze([1, 24, 72, 168]);
const DAY = 86400000, OUTCOMES = ['home', 'draw', 'away'];
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const team = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
const round = value => Math.round(value * 1e8) / 1e8;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
// The latest record version cannot be projected into a historical cutoff from
// an older result timestamp alone. Supplier updates and fetches are evidence of
// when the *version* became available, not proof of original result publication.
const knownAt = row => {
  const times = ['resultObservedAt', 'observedAt', 'fetchedAt', 'sourceUpdatedAt']
    .map(key => isoMillis(row?.[key])).filter(Number.isFinite);
  return times.length ? Math.max(...times) : NaN;
};
// Strict historical replay additionally requires positive result visibility
// evidence. A fetch-only final score is not an as-observed training result.
const resultVisibleAt = row => Number.isFinite(isoMillis(row?.observedAt))
  && Number.isFinite(isoMillis(row?.resultObservedAt))
  && isoMillis(row.resultObservedAt) > isoMillis(row.kickoff)
  ? knownAt(row) : NaN;

export function prepareForecastHistory(input = []) {
  if (!Array.isArray(input) || input.length > 10000) throw new Error('INVALID_HISTORY_FILE');
  const matches = [], seen = new Map(); let rejected = 0, duplicates = 0;
  for (const row of input) {
    if (!row || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(row.league) || !token(row.id) || !token(row.source)
      || !team(row.home) || !team(row.away) || row.home.trim() === row.away.trim()
      || !token(row.homeTeamId) || !token(row.awayTeamId) || row.homeTeamId === row.awayTeamId
      || !Number.isFinite(isoMillis(row.kickoff)) || row.status !== 'FINISHED' || row.period !== 'full-time'
      || ![row.homeGoals, row.awayGoals].every(value => Number.isInteger(value) && value >= 0 && value <= 20)) { rejected++; continue; }
    let value;
    try { value = normalizeHistoryRecord(row); } catch { rejected++; continue; }
    const key = `${value.source}:${value.id}`;
    if (seen.has(key)) {
      const prior = seen.get(key);
      if (prior.recordHash !== value.recordHash) throw new Error('CONFLICTING_HISTORY_ID');
      for (const field of ['observedAt', 'resultObservedAt']) if (value[field] && (!prior[field] || value[field] < prior[field])) prior[field] = value[field];
      for (const field of ['fetchedAt', 'sourceUpdatedAt']) if (value[field] && (!prior[field] || value[field] > prior[field])) prior[field] = value[field];
      duplicates++; continue;
    }
    seen.set(key, value); matches.push(value);
  }
  const partitioned = partitionLogicalMatches(matches), accepted = partitioned.records;
  accepted.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.id.localeCompare(b.id));
  return { matches: accepted, rejected, duplicates: duplicates + partitioned.duplicates,
    logicalConflicts: partitioned.conflicts.reduce((sum, conflict) => sum + conflict.ids.length, 0) };
}

export function poissonProbabilities(homeRate, awayRate) {
  if (![homeRate, awayRate].every(value => Number.isFinite(value) && value >= .15 && value <= 4.5)) throw new Error('INVALID_GOAL_RATE');
  const probabilities = rate => {
    const values = [Math.exp(-rate)];
    for (let goals = 1; goals <= 20; goals++) values.push(values[goals - 1] * rate / goals);
    return values;
  };
  const h = probabilities(homeRate), a = probabilities(awayRate), p = { home: 0, draw: 0, away: 0 }, scores = [];
  for (let home = 0; home < h.length; home++) for (let away = 0; away < a.length; away++) {
    const probability = h[home] * a[away];
    p[home > away ? 'home' : home === away ? 'draw' : 'away'] += probability;
    scores.push({ home, away, probability });
  }
  const mass = p.home + p.draw + p.away;
  for (const key of OUTCOMES) p[key] /= mass;
  scores.sort((x, y) => y.probability - x.probability || x.home + x.away - y.home - y.away || x.home - y.home);
  return { probabilities: p, topScores: scores.slice(0, 3).map(row => ({ ...row, probability: row.probability / mass })) };
}

function trainingPool(fixture, matches, cutoff, visibility = 'current') {
  return matches.filter(row => row.source === fixture.source && row.league === fixture.league && row.id !== fixture.id
    && !(row.homeTeamId === fixture.homeTeamId && row.awayTeamId === fixture.awayTeamId && Date.parse(row.kickoff) === Date.parse(fixture.kickoff))
    && Date.parse(row.kickoff) + FORECAST_MODEL.resultLagHours * 3600000 <= cutoff
    && (visibility === 'snapshot' || (visibility === 'as-observed'
      ? Number.isFinite(resultVisibleAt(row)) && resultVisibleAt(row) <= cutoff
      : !Number.isFinite(knownAt(row)) || knownAt(row) <= cutoff))
    && cutoff - Date.parse(row.kickoff) <= FORECAST_MODEL.lookbackDays * DAY);
}

function predict(fixture, matches, cutoff, visibility = 'current') {
  const history = trainingPool(fixture, matches, cutoff, visibility), reasons = [];
  if (!token(fixture.homeTeamId) || !token(fixture.awayTeamId) || fixture.homeTeamId === fixture.awayTeamId) {
    return { status: 'unavailable', reasons: ['TEAM_ID_REQUIRED'] };
  }
  const involving = id => history.filter(row => row.homeTeamId === id || row.awayTeamId === id);
  const homeMatches = involving(fixture.homeTeamId), awayMatches = involving(fixture.awayTeamId);
  const homeVenue = history.filter(row => row.homeTeamId === fixture.homeTeamId), awayVenue = history.filter(row => row.awayTeamId === fixture.awayTeamId);
  const sample = { league: history.length, home: homeMatches.length, away: awayMatches.length,
    homeVenue: homeVenue.length, awayVenue: awayVenue.length };
  const weight = row => Math.exp(-Math.LN2 * (cutoff - Date.parse(row.kickoff)) / (FORECAST_MODEL.halfLifeDays * DAY));
  const effective = rows => { const weights = rows.map(weight), sum = weights.reduce((a, b) => a + b, 0);
    return { weightedMatches: round(sum), effectiveMatches: weights.length ? round(sum ** 2 / weights.reduce((a, b) => a + b ** 2, 0)) : 0 }; };
  const sampleQuality = { weighted: Object.fromEntries(Object.entries({ league: history, home: homeMatches, away: awayMatches, homeVenue, awayVenue })
    .map(([key, rows]) => [key, effective(rows)])), season: fixture.season == null ? null : String(fixture.season) };
  sampleQuality.currentSeason = sampleQuality.season ? Object.fromEntries(Object.entries({ league: history, home: homeMatches, away: awayMatches, homeVenue, awayVenue })
    .map(([key, rows]) => [key, rows.filter(row => row.season === sampleQuality.season).length])) : null;
  sampleQuality.unknownSeason = history.filter(row => !row.season).length;
  sampleQuality.coldStart = { status: !sampleQuality.season ? 'season-unknown' : Math.min(sampleQuality.currentSeason.home, sampleQuality.currentSeason.away) < FORECAST_MODEL.minimumTeamMatches ? 'limited-current-season' : 'current-season-sample-present',
    notes: ['Cross-season history is time-decayed; roster, transfer and managerial changes are not modeled.',
      'Promoted teams are not assigned invented same-league history.'] };
  if (!history.length) reasons.push('HISTORY_UNAVAILABLE');
  else if (history.length < FORECAST_MODEL.minimumLeagueMatches) reasons.push('LEAGUE_HISTORY_INSUFFICIENT');
  if (homeMatches.length < FORECAST_MODEL.minimumTeamMatches) reasons.push('HOME_HISTORY_INSUFFICIENT');
  if (awayMatches.length < FORECAST_MODEL.minimumTeamMatches) reasons.push('AWAY_HISTORY_INSUFFICIENT');
  if (homeVenue.length < FORECAST_MODEL.minimumVenueMatches || awayVenue.length < FORECAST_MODEL.minimumVenueMatches) reasons.push('VENUE_HISTORY_INSUFFICIENT');
  if ([homeMatches, awayMatches].some(rows => rows.length && cutoff - Date.parse(rows.at(-1).kickoff) > FORECAST_MODEL.maximumTeamAgeDays * DAY)) reasons.push('TEAM_HISTORY_STALE');
  if (reasons.length) return { status: 'unavailable', reasons, sample, sampleQuality };
  const sum = (rows, field) => rows.reduce((total, row) => total + weight(row) * (field ? row[field] : 1), 0);
  const leagueHome = sum(history, 'homeGoals') / sum(history), leagueAway = sum(history, 'awayGoals') / sum(history);
  if (leagueHome < .1 || leagueAway < .1) return { status: 'unavailable', reasons: ['LEAGUE_GOALS_INSUFFICIENT'], sample, sampleQuality };
  const smoothed = (rows, field, prior) => (sum(rows, field) + FORECAST_MODEL.priorMatches * prior) / (sum(rows) + FORECAST_MODEL.priorMatches);
  const homeRate = clamp(smoothed(homeVenue, 'homeGoals', leagueHome) * smoothed(awayVenue, 'homeGoals', leagueHome) / leagueHome, .15, 4.5);
  const awayRate = clamp(smoothed(awayVenue, 'awayGoals', leagueAway) * smoothed(homeVenue, 'awayGoals', leagueAway) / leagueAway, .15, 4.5);
  const strength = { basis: 'weighted-venue-goals-relative-to-league', leagueHomeGoals: leagueHome, leagueAwayGoals: leagueAway,
    homeAttack: smoothed(homeVenue, 'homeGoals', leagueHome) / leagueHome,
    homeDefenceConceding: smoothed(homeVenue, 'awayGoals', leagueAway) / leagueAway,
    awayAttack: smoothed(awayVenue, 'awayGoals', leagueAway) / leagueAway,
    awayDefenceConceding: smoothed(awayVenue, 'homeGoals', leagueHome) / leagueHome };
  const { probabilities, topScores } = poissonProbabilities(homeRate, awayRate);
  const ranked = OUTCOMES.toSorted((a, b) => probabilities[b] - probabilities[a]);
  return { status: 'forecast', reasons: [], probabilities, selection: Math.abs(probabilities[ranked[0]] - probabilities[ranked[1]]) < 1e-9 ? null : ranked[0],
    expectedGoals: { home: homeRate, away: awayRate }, topScores, sample, sampleQuality, strength,
    trainingCutoff: new Date(cutoff).toISOString(), newestTrainingKickoff: history.at(-1).kickoff,
    trainingHash: digest(history), confidence: 'uncalibrated-baseline',
    limitations: ['仅使用历史全场比分，未包含伤停、阵容、赛程负荷或盘口。', '基线概率尚未校准，不代表亚洲盘赢盘概率。'] };
}

const outcome = row => row.homeGoals > row.awayGoals ? 'home' : row.homeGoals === row.awayGoals ? 'draw' : 'away';
export function walkForwardBacktest(matches, { source, league, nowISO, horizonHours = 1, visibility = 'snapshot', remaining = () => Infinity }) {
  const now = isoMillis(nowISO);
  if (!Number.isFinite(now) || !Number.isFinite(horizonHours) || horizonHours < 0 || horizonHours > 336
    || !['snapshot', 'as-observed'].includes(visibility)) throw new Error('INVALID_BACKTEST_OPTIONS');
  const available = matches.filter(row => visibility === 'as-observed'
    ? Number.isFinite(resultVisibleAt(row)) && resultVisibleAt(row) <= now
    : !Number.isFinite(knownAt(row)) || knownAt(row) <= now)
    .toSorted((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.id.localeCompare(b.id));
  const candidates = available.filter(row => row.source === source && row.league === league
    && Date.parse(row.kickoff) + FORECAST_MODEL.resultLagHours * 3600000 <= now)
    .toSorted((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.id.localeCompare(b.id)).slice(-FORECAST_MODEL.backtestLimit);
  const evaluations = [], exclusions = [];
  let interrupted = false;
  for (const row of candidates) {
    if (remaining() <= 0) { interrupted = true; break; }
    const cutoff = Date.parse(row.kickoff) - horizonHours * 3600000, prediction = predict(row, available, cutoff, visibility);
    if (prediction.status !== 'forecast') { exclusions.push({ fixtureId: row.id, reasons: prediction.reasons }); continue; }
    const prior = trainingPool(row, available, cutoff, visibility), base = Object.fromEntries(OUTCOMES.map(key => [key, 1]));
    for (const match of prior) base[outcome(match)]++;
    for (const key of OUTCOMES) base[key] /= prior.length + 3;
    evaluations.push({ fixtureId: row.id, source, league, season: row.season || null, kickoff: row.kickoff,
      generatedAt: new Date(cutoff).toISOString(), horizonHours, trainingHash: prediction.trainingHash,
      newestTrainingKickoff: prediction.newestTrainingKickoff, sample: prediction.sample, sampleQuality: prediction.sampleQuality,
      probabilities: prediction.probabilities, baseline: base, actual: outcome(row),
      resultObservedAt: row.resultObservedAt || row.observedAt || null,
      provenance: visibility === 'snapshot' ? 'revised-snapshot-retrospective' : 'observed-history-replay' });
  }
  const evaluated = evaluations.length, skipped = exclusions.length;
  const assessment = summarizeEvaluations(evaluations, { eligible: candidates.length, skipped, pending: candidates.length - evaluated - skipped });
  return { source, league, method: 'chronological-walk-forward', horizonHours, visibility, evaluated, skipped, interrupted,
    ...assessment, evaluations, exclusions,
    status: interrupted ? 'incomplete' : evaluated >= 30 ? 'evaluated-small-sample' : 'insufficient-validation',
    limitations: ['回测使用开赛时间减去指定提前量为截点，仅用此前至少 4 小时的完赛比分。',
      visibility === 'snapshot' ? '当前修订快照回顾评估，不能还原当时可见性，未做概率校准。' : '按记录的结果观察时间回放，缺少观察时间的训练记录排除；不是已发布预测的前瞻成绩。',
      'Brier 为三分类平方误差之和；越低越好。基准为此前赛果频率，不表示投注收益。'] };
}

export function buildForecasts({ fixtures, history = [], nowISO, policy = DEFAULT_POLICY, simulated = false, remaining = () => Infinity }) {
  const clean = prepareForecastHistory(history), now = isoMillis(nowISO);
  if (!Number.isFinite(now)) throw new Error('INVALID_NOW');
  let rows = fixtures.map(fixture => {
    const screened = basicScreen(fixture, nowISO, policy);
    const blocked = simulated ? 'SIMULATION_ONLY' : screened?.reasons[0] || (clean.matches.length && remaining() <= 0 ? 'BUDGET_EXHAUSTED' : null);
    return { fixtureId: fixture.id, generatedAt: nowISO,
      ...(blocked ? { status: 'unavailable', reasons: [blocked] } : predict(fixture, clean.matches, now)) };
  });
  const groups = [...new Map(fixtures.map(row => [`${row.source}:${row.league}`, { source: row.source, league: row.league }])).values()];
  const backtests = [], cache = new Map();
  const validationFor = (group, horizonHours, purpose) => {
    const key = JSON.stringify([group.source, group.league, horizonHours]);
    if (!cache.has(key)) {
      const value = { ...walkForwardBacktest(clean.matches, { ...group, nowISO, horizonHours, remaining }), purpose };
      cache.set(key, value); backtests.push(value);
    }
    return cache.get(key);
  };
  // Actual publishing lead times take budget precedence over reference horizons.
  const validations = rows.map((row, index) => !simulated && row.status === 'forecast'
    ? validationFor(fixtures[index], (Date.parse(fixtures[index].kickoff) - now) / 3600000, 'actual-publication-horizon') : null);
  if (!simulated) for (const group of groups) for (const horizonHours of BACKTEST_HORIZONS) validationFor(group, horizonHours, 'reference-horizon');
  rows = rows.map((row, index) => {
    const fixture = fixtures[index], validation = validations[index];
    const checked = row.status === 'forecast' && (!validation || validation.interrupted || validation.evaluated < 30)
      ? { fixtureId: row.fixtureId, generatedAt: row.generatedAt, status: 'unavailable', reasons: ['BACKTEST_INSUFFICIENT'], sample: row.sample, sampleQuality: row.sampleQuality } : row;
    const required = {
      teamIdentity: token(fixture.homeTeamId) && token(fixture.awayTeamId) && fixture.homeTeamId !== fixture.awayTeamId,
      leagueHistory: (row.sample?.league || 0) >= FORECAST_MODEL.minimumLeagueMatches,
      homeHistory: (row.sample?.home || 0) >= FORECAST_MODEL.minimumTeamMatches,
      awayHistory: (row.sample?.away || 0) >= FORECAST_MODEL.minimumTeamMatches,
      venueHistory: Math.min(row.sample?.homeVenue || 0, row.sample?.awayVenue || 0) >= FORECAST_MODEL.minimumVenueMatches,
      teamRecency: !!row.sample?.home && !!row.sample?.away && !row.reasons.includes('TEAM_HISTORY_STALE'),
      prematchFreshness: !basicScreen(fixture, nowISO, policy),
      backtest: !!validation && !validation.interrupted && validation.evaluated >= 30,
    };
    return { ...checked, horizonHours: (Date.parse(fixture.kickoff) - now) / 3600000,
      validation: validation ? { status: validation.status, horizonHours: validation.horizonHours, selection: 'exact-publication-lead-time',
        visibility: validation.visibility, evaluated: validation.evaluated, skipped: validation.skipped, metrics: validation.metrics,
        coverage: validation.coverage, uncertainty: validation.uncertainty } : null,
      completeness: { scope: 'baseline-required-checks-not-global-coverage', passed: Object.values(required).filter(Boolean).length,
        total: Object.keys(required).length, checks: required, enrichmentMissing: ['injuries', 'lineups', 'odds'], globalCoverage: 'unknown' },
      freshness: { generatedAt: nowISO, fixtureFetchedAt: fixture.fetchedAt || fixture.updatedAt,
        fixtureSourceUpdatedAt: fixture.sourceUpdatedAt || null,
        validUntil: new Date(Math.min(now + 3600000, Date.parse(fixture.kickoff), Date.parse(fixture.updatedAt) + policy.maxFixtureAgeMs) || now).toISOString(),
        maximumAgeMinutes: 60 } };
  });
  return { version: 1, model: FORECAST_MODEL, generatedAt: nowISO, simulated,
    history: { accepted: clean.matches.length, rejected: clean.rejected, duplicates: clean.duplicates, logicalConflicts: clean.logicalConflicts },
    rows, backtests, summary: { forecasts: rows.filter(row => row.status === 'forecast').length, unavailable: rows.filter(row => row.status !== 'forecast').length } };
}

export function finalizeForecasts(model, fixtures, nowISO, policy = DEFAULT_POLICY) {
  const map = new Map(fixtures.map(fixture => [fixture.id, fixture]));
  const rows = model.rows.map(row => {
    const screened = basicScreen(map.get(row.fixtureId), nowISO, policy);
    const expired = Date.parse(row.freshness?.validUntil) <= Date.parse(nowISO);
    return row.status === 'forecast' && (screened || expired) ? { fixtureId: row.fixtureId, generatedAt: row.generatedAt,
      freshness: row.freshness, completeness: row.completeness, validation: row.validation,
      status: 'unavailable', reasons: screened?.reasons || ['FORECAST_EXPIRED'] } : row;
  });
  return { ...model, checkedAtPublication: nowISO, rows,
    summary: { forecasts: rows.filter(row => row.status === 'forecast').length, unavailable: rows.filter(row => row.status !== 'forecast').length } };
}
