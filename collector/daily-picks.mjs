// 研究参考：体彩 hhad 是含“让球平”的三项市场，绝不是二项亚洲让球盘。
// 所有结算都以赛前冻结的 selection + 对应市场 + 90分钟官方FT结果为基础。
// 本模块不向正式发布链路放行，不证明商业授权或模型已校准。
const OUTCOME = Object.freeze({ WIN: '全赢', LOSS: '全输' });
const SIDES = Object.freeze(['home', 'draw', 'away']);
// Research quote freshness ceiling; never promote historical prices into a live freeze.
const MAX_QUOTE_AGE_MS = 60 * 60 * 1000;
const validGoals = n => Number.isInteger(n) && n >= 0 && n <= 30;
const validOdds = n => typeof n === 'number' && Number.isFinite(n) && n > 1 && n <= 100;
const validId = n => (typeof n === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(n)) || Number.isSafeInteger(n) && n > 0;
const validMarket = m => m && m.pool === 'hhad' && Number.isInteger(m.goalLine)
  && typeof m.source === 'string' && m.source.trim().length > 0 && m.source.length <= 160
  && validOdds(m.home) && validOdds(m.draw) && validOdds(m.away);
const rounded = n => Math.round((n + Number.EPSILON) * 1e6) / 1e6;

/**
 * A three-selection handicap result is never a stake refund: when the adjusted
 * score is tied, draw wins at its offered odds and home / away both lose.
 * In particular hhad goalLine -1 is NOT Asian handicap -1.0.
 */
export function settleHhad({ homeGoals, awayGoals, goalLine, selection, decimalOdds } = {}) {
  if (!validGoals(homeGoals) || !validGoals(awayGoals) || !Number.isInteger(goalLine)
    || !SIDES.includes(selection) || !validOdds(decimalOdds)) return null;
  const margin = homeGoals - awayGoals + goalLine;
  const winningSelection = margin > 0 ? 'home' : margin < 0 ? 'away' : 'draw';
  const won = winningSelection === selection;
  return { selection, winningSelection, margin, outcome: won ? OUTCOME.WIN : OUTCOME.LOSS,
    decimalOdds, profitUnits: won ? rounded(decimalOdds - 1) : -1 };
}

// 兼容原导出名称，但不再接受“无选择项就按主队结算”的错误调用。
export const settleHandicap = settleHhad;

// 原模型的1X2倾向只是旁路研究信号，未校准为体彩hhad概率，
// 尤其不能用1X2的“平局”概率代替让球平。
export function pickSide({ probabilities, goalLine } = {}) {
  if (!probabilities || !Number.isInteger(goalLine)) return null;
  const home = probabilities.home, draw = probabilities.draw, away = probabilities.away;
  // Number(null) and Number('') are zero; neither is a genuine model probability.
  if (![home, draw, away].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) return null;
  const total = home + draw + away;
  if (!(total > 0) || Math.abs(total - 1) > 0.01) return null;
  const h = home / total, d = draw / total, a = away / total;
  let homeProxy = h, awayProxy = a;
  if (goalLine < 0) homeProxy = h - d * 0.5;
  if (goalLine > 0) awayProxy = a - d * 0.5;
  return { side: homeProxy >= awayProxy ? 'home' : 'away',
    confidence: rounded(Math.max(homeProxy, awayProxy) * 100),
    market: 'hhad', method: 'UNCALIBRATED_1X2_PROXY_NOT_HHAD_PROBABILITY',
    researchOnly: true };
}

/** Always include unselected matches in coverage; never promote missing model data to a pick. */
export function buildDailyPicks({ matches = [], forecasts = [], nowISO, limit = 10 } = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now) || !Array.isArray(matches) || !Array.isArray(forecasts)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return { picks: [], total: 0, skipped: 'INVALID_INPUT' };
  // Duplicate model entries must not pick a winner by input order (Map last-write-wins).
  // The jc- prefix is an alias of the same Sporttery matchId, not a second forecast.
  const normalizedId = value => validId(value) ? String(value).replace(/^jc-/, '') : null;
  // Both identifiers may be supplied by different feeds. They must refer to
  // the same fixture; otherwise a model for match 222 can be scored as 111.
  const forecastIdentityMismatch = f => f && f.matchId != null && f.fixtureKey != null
    && normalizedId(f.matchId) !== normalizedId(f.fixtureKey);
  const forecastKey = f => {
    if (!f || forecastIdentityMismatch(f)) return null;
    return normalizedId(f.fixtureKey) || normalizedId(f.matchId);
  };
  const mismatchedForecastIds = new Set();
  const byKey = new Map(), forecastCounts = new Map(), excludedForecasts = [];
  for (const f of forecasts) {
    const key = forecastKey(f);
    if (!key) {
      const mismatch = forecastIdentityMismatch(f);
      if (mismatch) for (const value of [f.matchId, f.fixtureKey]) {
        const id = normalizedId(value);
        if (id) mismatchedForecastIds.add(id);
      }
      excludedForecasts.push({ matchId: f?.matchId ?? null, fixtureKey: f?.fixtureKey ?? null,
        probabilities: f?.probabilities ?? null,
        generatedAt: f?.generatedAt ?? f?.recordedAt ?? null,
        reason: mismatch ? 'FORECAST_IDENTITY_MISMATCH' : 'INVALID_FORECAST_KEY' });
      continue;
    }
    const count = (forecastCounts.get(key) || 0) + 1;
    forecastCounts.set(key, count);
    if (count === 1) byKey.set(key, f);
    else byKey.delete(key);
  }
  for (const f of forecasts) {
    const key = forecastKey(f);
    if (key && forecastCounts.get(key) > 1) excludedForecasts.push({
      matchId: f.matchId ?? null, fixtureKey: f.fixtureKey ?? null,
      generatedAt: f.generatedAt ?? f.recordedAt ?? null,
      probabilities: f.probabilities ?? null, reason: 'DUPLICATE_FORECAST' });
  }
  // Reject every row in a duplicated matchId group BEFORE considering prices or selections.
  // This also avoids counting the first row when later input proves its identity ambiguous.
  const matchGroups = new Map(), conflictingMatches = new Map();
  for (const m of matches) {
    if (!m || !validId(m.matchId)) continue;
    const id = String(m.matchId), group = matchGroups.get(id) || [];
    group.push(m);
    matchGroups.set(id, group);
  }
  for (const [id, group] of matchGroups) {
    if (group.length < 2) continue;
    const identities = new Set(group.map(m => JSON.stringify([
      m.handicap?.source ?? null, m.home ?? null, m.away ?? null, m.kickoff ?? null,
    ])));
    conflictingMatches.set(id, identities.size > 1 ? 'IDENTITY_CONFLICT' : 'DUPLICATE_MATCH_ID');
  }
  const picks = [], excludedCandidates = [];
  const exclude = (m, reason) => excludedCandidates.push({
    matchId: m && validId(m.matchId) ? m.matchId : null,
    home: typeof m?.home === 'string' ? m.home : null,
    away: typeof m?.away === 'string' ? m.away : null,
    kickoff: typeof m?.kickoff === 'string' ? m.kickoff : null,
    handicap: m?.handicap ? {
      source: m.handicap.source ?? null, pool: m.handicap.pool ?? null,
      goalLine: m.handicap.goalLine ?? null, home: m.handicap.home ?? null,
      draw: m.handicap.draw ?? null, away: m.handicap.away ?? null,
      updatedAt: m.handicap.updatedAt ?? null,
    } : null,
    reason,
  });
  for (const m of matches) {
    if (!m || !validId(m.matchId)) { exclude(m, 'INVALID_MATCH_ID'); continue; }
    const id = String(m.matchId);
    if (conflictingMatches.has(id)) { exclude(m, conflictingMatches.get(id)); continue; }
    // Quarantine both identities implicated by a contradictory forecast, even
    // when an independent valid forecast happens to share one of those IDs.
    if (mismatchedForecastIds.has(id)) { exclude(m, 'FORECAST_IDENTITY_MISMATCH'); continue; }
    if (forecastCounts.get(id) > 1) { exclude(m, 'DUPLICATE_FORECAST'); continue; }
    if (!validMarket(m.handicap)) { exclude(m, 'INVALID_HHAD_MARKET'); continue; }
    const kickoff = Date.parse(m.kickoff);
    if (!Number.isFinite(kickoff) || kickoff <= now) { exclude(m, 'KICKOFF_NOT_FUTURE'); continue; }
    const sourceQuoteAt = typeof m.handicap.updatedAt === 'string' ? Date.parse(m.handicap.updatedAt) : NaN;
    if (Number.isFinite(sourceQuoteAt) && sourceQuoteAt <= now && now - sourceQuoteAt > MAX_QUOTE_AGE_MS) {
      exclude(m, 'QUOTE_STALE'); continue;
    }
    const forecast = byKey.get(id) || null;
    // Only pre-match source versions may be used; unknown timestamps must be explicit.
    const asOf = forecast?.generatedAt ?? forecast?.recordedAt ?? null;
    const asOfMs = typeof asOf === 'string' ? Date.parse(asOf) : NaN;
    // An old model forecast cannot establish that today's market price existed when the model ran.
    // The hhad price is first independently observed NOW; never backdate its selection to model generatedAt.
    const modelIsPrematch = Number.isFinite(asOfMs) && asOfMs <= now && asOfMs < kickoff;
    const quoteIsPrematch = Number.isFinite(sourceQuoteAt) && sourceQuoteAt <= now && sourceQuoteAt < kickoff;
    const isPrematch = modelIsPrematch && quoteIsPrematch;
    const modelPick = isPrematch ? pickSide({ probabilities: forecast.probabilities, goalLine: m.handicap.goalLine }) : null;
    const pick = modelPick ? { ...modelPick, decimalOdds: m.handicap[modelPick.side] } : null;
    picks.push({ matchId: m.matchId, league: m.league, home: m.home, away: m.away, kickoff: m.kickoff,
      handicap: { source: m.handicap.source, pool: 'hhad', goalLine: m.handicap.goalLine,
        home: m.handicap.home, draw: m.handicap.draw, away: m.handicap.away,
        updatedAt: m.handicap.updatedAt || null },
      homeRank: m.homeRank || null, awayRank: m.awayRank || null,
      ...(modelIsPrematch ? { probabilities: forecast.probabilities } : {}),
      modelGeneratedAt: modelIsPrematch ? asOf : null,
      quoteObservedAt: quoteIsPrematch ? nowISO : null,
      // Snapshot selection is created at collection time, not at an older model-generation timestamp.
      predictionFrozenAt: isPrematch ? nowISO : null, pick });
  }
  picks.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || String(a.matchId).localeCompare(String(b.matchId)));
  const displayed = picks.slice(0, limit), hidden = picks.slice(limit);
  // The display limit is not an audit filter: retain every candidate, rejected row,
  // selected direction and associated quote for later full-denominator evaluation.
  return { picks: displayed, allPicks: picks, excludedCandidates, excludedForecasts,
    inputTotal: matches.length, forecastInputTotal: forecasts.length, total: picks.length,
    selected: displayed.filter(p => p.pick).length,
    selectedAll: picks.filter(p => p.pick).length,
    hiddenSelected: hidden.filter(p => p.pick).length,
    hiddenTotal: hidden.length,
    withoutModel: picks.filter(p => !p.pick).length,
    market: 'sporttery-hhad-three-way', researchOnly: true };
}

/** Read-only tally: unresolved, duplicate and unselected rows are never wins or losses. */
export function settleDailyPicks({ picks = [], results = [] } = {}) {
  if (!Array.isArray(picks) || !Array.isArray(results)) return { rows: [], error: 'INVALID_INPUT' };
  const byMatch = new Map();
  for (const result of results) {
    const id = result && (result.matchId ?? result.fixtureKey);
    if (!validId(id)) continue;
    const key = String(id).replace(/^jc-/, '');
    const item = byMatch.get(key) || [];
    item.push(result);
    byMatch.set(key, item);
  }
  const pickCounts = new Map(), rows = [];
  for (const p of picks) {
    if (p && validId(p.matchId)) {
      const key = String(p.matchId);
      pickCounts.set(key, (pickCounts.get(key) || 0) + 1);
    }
  }
  let selected = 0, unselected = 0, pending = 0, invalid = 0, duplicate = 0;
  for (const p of picks) {
    if (!p || !validId(p.matchId)) { invalid++; continue; }
    const id = String(p.matchId);
    if (pickCounts.get(id) > 1) { duplicate++; continue; }
    if (!validMarket(p.handicap) || p.pick?.market !== 'hhad' || !SIDES.includes(p.pick?.side)) {
      unselected++; continue;
    }
    selected++;
    const matched = byMatch.get(id) || [];
    if (!matched.length) { pending++; continue; }
    if (matched.length !== 1) { duplicate++; continue; }
    const r = matched[0];
    // Require an observed *full-time* result, not a live score or a synthetic winner.
    const resultAt = Date.parse(r.resultObservedAt);
    const kickoff = Date.parse(p.kickoff);
    const frozenAt = Date.parse(p.predictionFrozenAt);
    const modelAt = Date.parse(p.modelGeneratedAt);
    const sourceQuoteAt = Date.parse(p.handicap.updatedAt);
    const quoteObservedAt = Date.parse(p.quoteObservedAt);
    if (!['FT', 'FINISHED'].includes(r.status) || !Number.isFinite(resultAt)
      || !Number.isFinite(kickoff) || !Number.isFinite(frozenAt)
      || !Number.isFinite(modelAt) || !Number.isFinite(sourceQuoteAt) || !Number.isFinite(quoteObservedAt)
      || !(modelAt <= quoteObservedAt && sourceQuoteAt <= quoteObservedAt
        && quoteObservedAt <= frozenAt && frozenAt - sourceQuoteAt <= MAX_QUOTE_AGE_MS
        && frozenAt < kickoff && kickoff + 90 * 60000 <= resultAt)
      // Source identity cannot be optional: a same-numbered match from another feed
      // or a postponed match with a changed kickoff must not settle this freeze.
      || typeof r.home !== 'string' || r.home !== p.home
      || typeof r.away !== 'string' || r.away !== p.away
      || typeof r.kickoff !== 'string' || Date.parse(r.kickoff) !== kickoff) { invalid++; continue; }
    const decimalOdds = p.handicap[p.pick.side];
    // Price chosen at freeze time must still match its frozen market-side quote.
    // This is an internal consistency check, not yet an immutable RAW proof.
    if (p.pick.decimalOdds !== decimalOdds) { invalid++; continue; }
    const settled = settleHhad({ homeGoals: r.homeGoals, awayGoals: r.awayGoals,
      goalLine: p.handicap.goalLine, selection: p.pick.side, decimalOdds });
    if (!settled) { invalid++; continue; }
    rows.push({ ...p, actual: { homeGoals: r.homeGoals, awayGoals: r.awayGoals, observedAt: r.resultObservedAt }, ...settled });
  }
  const wins = rows.filter(r => r.outcome === OUTCOME.WIN).length;
  const hitRate = rows.length ? rounded(wins / rows.length * 100) : null;
  return { market: 'hhad-three-way', researchOnly: true, rows, total: rows.length, decided: rows.length,
    wins, losses: rows.length - wins, pushes: 0, hitRate,
    profitUnits: rounded(rows.reduce((sum, r) => sum + r.profitUnits, 0)),
    coverage: { inputPicks: picks.length, selected, unselected, pending, invalid, duplicate } };
}
