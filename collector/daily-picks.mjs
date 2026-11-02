// 研究参考：体彩 hhad 是含“让球平”的三项市场，绝不是二项亚洲让球盘。
// 所有结算都以赛前冻结的 selection + 对应市场 + 90分钟官方FT结果为基础。
// 本模块不向正式发布链路放行，不证明商业授权或模型已校准。
const OUTCOME = Object.freeze({ WIN: '全赢', LOSS: '全输' });
const SIDES = Object.freeze(['home', 'draw', 'away']);
const validGoals = n => Number.isInteger(n) && n >= 0 && n <= 30;
const validOdds = n => typeof n === 'number' && Number.isFinite(n) && n > 1 && n <= 100;
const validId = n => (typeof n === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(n)) || Number.isSafeInteger(n) && n > 0;
const validMarket = m => m && m.pool === 'hhad' && Number.isInteger(m.goalLine)
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
  const home = Number(probabilities.home), draw = Number(probabilities.draw), away = Number(probabilities.away);
  if (![home, draw, away].every(v => Number.isFinite(v) && v >= 0)) return null;
  const total = home + draw + away;
  if (!(total > 0)) return null;
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
  const byKey = new Map();
  for (const f of forecasts) {
    const key = f && (f.fixtureKey ?? f.matchId);
    if (key !== undefined && key !== null && validId(key)) byKey.set(String(key), f);
  }
  const picks = [], seen = new Set();
  for (const m of matches) {
    if (!m || !validId(m.matchId) || !validMarket(m.handicap)) continue;
    const kickoff = Date.parse(m.kickoff);
    if (!Number.isFinite(kickoff) || kickoff <= now) continue;
    const id = String(m.matchId);
    if (seen.has(id)) continue;
    seen.add(id);
    const forecast = byKey.get('jc-' + id) || byKey.get(id) || null;
    // Only pre-match source versions may be used; unknown timestamps must be explicit.
    const asOf = forecast?.generatedAt ?? forecast?.recordedAt ?? null;
    const asOfMs = typeof asOf === 'string' ? Date.parse(asOf) : NaN;
    // An old model forecast cannot establish that today's market price existed when the model ran.
    // The hhad price is first independently observed NOW; never backdate its selection to model generatedAt.
    const sourceQuoteAt = typeof m.handicap.updatedAt === 'string' ? Date.parse(m.handicap.updatedAt) : NaN;
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
  return { picks: picks.slice(0, limit), total: picks.length,
    selected: picks.filter(p => p.pick).length,
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
  const seen = new Set(), rows = [];
  let selected = 0, unselected = 0, pending = 0, invalid = 0, duplicate = 0;
  for (const p of picks) {
    if (!p || !validId(p.matchId)) { invalid++; continue; }
    const id = String(p.matchId);
    if (seen.has(id)) { duplicate++; continue; }
    seen.add(id);
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
        && quoteObservedAt <= frozenAt && frozenAt < kickoff && kickoff <= resultAt)
      || r.home && r.home !== p.home || r.away && r.away !== p.away) { invalid++; continue; }
    const decimalOdds = p.handicap[p.pick.side];
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
