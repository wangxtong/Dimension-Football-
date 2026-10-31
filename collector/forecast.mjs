import { basicScreen, DEFAULT_POLICY, digest, isoMillis } from './policy.mjs';

export const FORECAST_MODEL = Object.freeze({ id: 'venue-poisson-v1', version: 1,
  description: '按主客场与时间衰减计算进失球率，向联赛均值收缩的独立泊松基线',
  lookbackDays: 540, halfLifeDays: 180, priorMatches: 6,
  minimumLeagueMatches: 40, minimumTeamMatches: 6, minimumVenueMatches: 2,
  maximumTeamAgeDays: 120, resultLagHours: 4, backtestLimit: 80,
  calibrated: false, purpose: 'prematch-1x2-analysis', needsOdds: false });
const DAY = 86400000, OUTCOMES = ['home', 'draw', 'away'];
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const team = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
const round = value => Math.round(value * 1e8) / 1e8;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

export function prepareForecastHistory(input = []) {
  if (!Array.isArray(input) || input.length > 10000) throw new Error('INVALID_HISTORY_FILE');
  const matches = [], seen = new Map(); let rejected = 0, duplicates = 0;
  for (const row of input) {
    if (!row || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(row.league) || !token(row.id) || !token(row.source)
      || !team(row.home) || !team(row.away) || row.home.trim() === row.away.trim()
      || !token(row.homeTeamId) || !token(row.awayTeamId) || row.homeTeamId === row.awayTeamId
      || !Number.isFinite(isoMillis(row.kickoff)) || row.status !== 'FINISHED' || row.period !== 'full-time'
      || ![row.homeGoals, row.awayGoals].every(value => Number.isInteger(value) && value >= 0 && value <= 20)) { rejected++; continue; }
    const value = Object.fromEntries(['id', 'source', 'league', 'kickoff', 'home', 'away', 'homeTeamId', 'awayTeamId',
      'homeGoals', 'awayGoals', 'status', 'period'].map(key => [key, row[key]]));
    const key = `${value.source}:${value.id}`, hash = digest(value);
    if (seen.has(key)) {
      if (seen.get(key) !== hash) throw new Error('CONFLICTING_HISTORY_ID');
      duplicates++; continue;
    }
    seen.set(key, hash); matches.push(value);
  }
  matches.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.id.localeCompare(b.id));
  return { matches, rejected, duplicates };
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

function trainingPool(fixture, matches, cutoff) {
  return matches.filter(row => row.source === fixture.source && row.league === fixture.league && row.id !== fixture.id
    && Date.parse(row.kickoff) + FORECAST_MODEL.resultLagHours * 3600000 <= cutoff
    && cutoff - Date.parse(row.kickoff) <= FORECAST_MODEL.lookbackDays * DAY);
}

function predict(fixture, matches, cutoff) {
  const history = trainingPool(fixture, matches, cutoff), reasons = [];
  if (!token(fixture.homeTeamId) || !token(fixture.awayTeamId) || fixture.homeTeamId === fixture.awayTeamId) {
    return { status: 'unavailable', reasons: ['TEAM_ID_REQUIRED'] };
  }
  const involving = id => history.filter(row => row.homeTeamId === id || row.awayTeamId === id);
  const homeMatches = involving(fixture.homeTeamId), awayMatches = involving(fixture.awayTeamId);
  const homeVenue = history.filter(row => row.homeTeamId === fixture.homeTeamId), awayVenue = history.filter(row => row.awayTeamId === fixture.awayTeamId);
  const sample = { league: history.length, home: homeMatches.length, away: awayMatches.length,
    homeVenue: homeVenue.length, awayVenue: awayVenue.length };
  if (!history.length) reasons.push('HISTORY_UNAVAILABLE');
  else if (history.length < FORECAST_MODEL.minimumLeagueMatches) reasons.push('LEAGUE_HISTORY_INSUFFICIENT');
  if (homeMatches.length < FORECAST_MODEL.minimumTeamMatches) reasons.push('HOME_HISTORY_INSUFFICIENT');
  if (awayMatches.length < FORECAST_MODEL.minimumTeamMatches) reasons.push('AWAY_HISTORY_INSUFFICIENT');
  if (homeVenue.length < FORECAST_MODEL.minimumVenueMatches || awayVenue.length < FORECAST_MODEL.minimumVenueMatches) reasons.push('VENUE_HISTORY_INSUFFICIENT');
  if ([homeMatches, awayMatches].some(rows => rows.length && cutoff - Date.parse(rows.at(-1).kickoff) > FORECAST_MODEL.maximumTeamAgeDays * DAY)) reasons.push('TEAM_HISTORY_STALE');
  if (reasons.length) return { status: 'unavailable', reasons, sample };
  const weight = row => Math.exp(-Math.LN2 * (cutoff - Date.parse(row.kickoff)) / (FORECAST_MODEL.halfLifeDays * DAY));
  const sum = (rows, field) => rows.reduce((total, row) => total + weight(row) * (field ? row[field] : 1), 0);
  const leagueHome = sum(history, 'homeGoals') / sum(history), leagueAway = sum(history, 'awayGoals') / sum(history);
  if (leagueHome < .1 || leagueAway < .1) return { status: 'unavailable', reasons: ['LEAGUE_GOALS_INSUFFICIENT'], sample };
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
    expectedGoals: { home: homeRate, away: awayRate }, topScores, sample, strength,
    trainingCutoff: new Date(cutoff).toISOString(), newestTrainingKickoff: history.at(-1).kickoff,
    trainingHash: digest(history), confidence: 'uncalibrated-baseline',
    limitations: ['仅使用历史全场比分，未包含伤停、阵容、赛程负荷或盘口。', '基线概率尚未校准，不代表亚洲盘赢盘概率。'] };
}

const outcome = row => row.homeGoals > row.awayGoals ? 'home' : row.homeGoals === row.awayGoals ? 'draw' : 'away';
const brier = (p, actual) => OUTCOMES.reduce((total, key) => total + (p[key] - Number(key === actual)) ** 2, 0);

export function walkForwardBacktest(matches, { source, league, nowISO, remaining = () => Infinity }) {
  const now = isoMillis(nowISO);
  const candidates = matches.filter(row => row.source === source && row.league === league
    && Date.parse(row.kickoff) + FORECAST_MODEL.resultLagHours * 3600000 <= now).slice(-FORECAST_MODEL.backtestLimit);
  const totals = { brier: 0, logLoss: 0, accuracy: 0, baselineBrier: 0, baselineLogLoss: 0 };
  let evaluated = 0, skipped = 0, interrupted = false;
  for (const row of candidates) {
    if (remaining() <= 0) { interrupted = true; break; }
    const cutoff = Date.parse(row.kickoff), prediction = predict(row, matches, cutoff);
    if (prediction.status !== 'forecast') { skipped++; continue; }
    const prior = trainingPool(row, matches, cutoff), base = Object.fromEntries(OUTCOMES.map(key => [key, 1]));
    for (const match of prior) base[outcome(match)]++;
    for (const key of OUTCOMES) base[key] /= prior.length + 3;
    const actual = outcome(row);
    totals.brier += brier(prediction.probabilities, actual);
    totals.logLoss += -Math.log(Math.max(1e-15, prediction.probabilities[actual]));
    totals.accuracy += Number(prediction.selection === actual);
    totals.baselineBrier += brier(base, actual);
    totals.baselineLogLoss += -Math.log(base[actual]);
    evaluated++;
  }
  return { source, league, method: 'chronological-walk-forward', evaluated, skipped, interrupted,
    metrics: evaluated ? Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, round(value / evaluated)])) : null,
    status: interrupted ? 'incomplete' : evaluated >= 30 ? 'evaluated-small-sample' : 'insufficient-validation',
    limitations: ['回测在每场开赛前重新估计，仅使用更早至少 4 小时的完赛比分。',
      '基于当前取得的历史修订快照，不能还原当时数据可见性；非前瞻验证，未做概率校准。',
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
  const backtests = simulated ? [] : groups.map(group => walkForwardBacktest(clean.matches, { ...group, nowISO, remaining }));
  rows = rows.map((row, index) => {
    const fixture = fixtures[index], validation = backtests.find(b => b.source === fixture.source && b.league === fixture.league);
    const checked = row.status === 'forecast' && (!validation || validation.interrupted || validation.evaluated < 30)
      ? { fixtureId: row.fixtureId, generatedAt: row.generatedAt, status: 'unavailable', reasons: ['BACKTEST_INSUFFICIENT'], sample: row.sample } : row;
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
    return { ...checked, validation: validation ? { status: validation.status, evaluated: validation.evaluated, skipped: validation.skipped, metrics: validation.metrics } : null,
      completeness: { scope: 'baseline-required-checks-not-global-coverage', passed: Object.values(required).filter(Boolean).length,
        total: Object.keys(required).length, checks: required, enrichmentMissing: ['injuries', 'lineups', 'odds'], globalCoverage: 'unknown' },
      freshness: { generatedAt: nowISO, fixtureFetchedAt: fixture.fetchedAt || fixture.updatedAt,
        fixtureSourceUpdatedAt: fixture.sourceUpdatedAt || null,
        validUntil: new Date(Math.min(now + 3600000, Date.parse(fixture.kickoff), Date.parse(fixture.updatedAt) + policy.maxFixtureAgeMs) || now).toISOString(),
        maximumAgeMinutes: 60 } };
  });
  return { version: 1, model: FORECAST_MODEL, generatedAt: nowISO, simulated,
    history: { accepted: clean.matches.length, rejected: clean.rejected, duplicates: clean.duplicates },
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
