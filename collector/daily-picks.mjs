// 每日盘口清单：把「体彩让球盘」与「模型 1X2 概率」合成一张可回测的每日推荐表。
// 设计目标对齐「每天 10 场 + 带盘口赔率 + 次日复盘」的形态，而不是只展示冻结计数。
//
// 结算口径（亚盘）：
//   全赢  让球后主队胜出且净胜 > |goalLine|
//   走盘  净胜 == |goalLine|
//   全输  其余
// 半赢/半输需要四分之一球盘（-0.25/-0.75），体彩 hhad 为整数/半球，暂不产生半赢半输。
const OUTCOME = Object.freeze({ WIN: '全赢', PUSH: '走盘', LOSS: '全输' });

export function settleHandicap({ homeGoals, awayGoals, goalLine }) {
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;
  if (!Number.isFinite(goalLine)) return null;
  const margin = homeGoals - awayGoals + goalLine;  // goalLine 为负表示主队让球
  if (margin > 0) return { outcome: OUTCOME.WIN, margin };
  if (margin === 0) return { outcome: OUTCOME.PUSH, margin };
  return { outcome: OUTCOME.LOSS, margin };
}

// 从 1X2 概率里挑「更可能的一侧」，并与让球盘对照给出倾向。
// 注意：这是启发式映射，不是校准后的亚盘概率；输出必须标注为研究参考。
export function pickSide({ probabilities, goalLine }) {
  if (!probabilities || !Number.isFinite(goalLine)) return null;
  const home = Number(probabilities.home), draw = Number(probabilities.draw), away = Number(probabilities.away);
  if (![home, draw, away].every(v => Number.isFinite(v) && v >= 0)) return null;
  const total = home + draw + away;
  if (!(total > 0)) return null;
  const h = home / total, d = draw / total, a = away / total;
  if (goalLine < 0) {
    // 主队让球：需要主队赢超过让球数。用「主胜概率 × 净胜余量」的粗代理。
    const edge = h - d * 0.5;
    return { side: edge >= a ? 'home' : 'away', confidence: Math.round(Math.max(edge, a) * 1000) / 10 };
  }
  if (goalLine > 0) {
    const edge = a - d * 0.5;
    return { side: edge >= h ? 'away' : 'home', confidence: Math.round(Math.max(edge, h) * 1000) / 10 };
  }
  return { side: h >= a ? 'home' : 'away', confidence: Math.round(Math.max(h, a) * 1000) / 10 };
}

// 组装每日清单：只保留有让球盘、且比赛尚未开赛的场次。
export function buildDailyPicks({ matches = [], forecasts = [], nowISO, limit = 10 } = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) return { picks: [], skipped: 'INVALID_NOW' };
  const byKey = new Map();
  for (const f of forecasts) {
    const key = String(f.fixtureKey || f.matchId || '');
    if (key) byKey.set(key, f);
  }
  const picks = [];
  for (const m of matches) {
    if (!m || !m.handicap) continue;
    const kickoff = Date.parse(m.kickoff);
    if (!Number.isFinite(kickoff) || kickoff <= now) continue;   // 只取未开赛
    const forecast = byKey.get('jc-' + m.matchId) || byKey.get(String(m.matchId)) || null;
    const pick = forecast ? pickSide({ probabilities: forecast.probabilities, goalLine: m.handicap.goalLine }) : null;
    picks.push({
      matchId: m.matchId, league: m.league, home: m.home, away: m.away, kickoff: m.kickoff,
      handicap: { goalLine: m.handicap.goalLine, home: m.handicap.home, draw: m.handicap.draw, away: m.handicap.away,
        updatedAt: m.handicap.updatedAt || null },
      homeRank: m.homeRank || null, awayRank: m.awayRank || null,
      ...(forecast ? { probabilities: forecast.probabilities, pick } : { pick: null }),
    });
  }
  picks.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  return { picks: picks.slice(0, limit), total: picks.length };
}

// 次日复盘：对已完赛且有让球盘的场次逐场结算，累计命中率。
export function settleDailyPicks({ picks = [], results = [] } = {}) {
  const byMatch = new Map();
  for (const r of results) {
    const key = String(r.matchId || r.fixtureKey || '');
    if (key) byMatch.set(key, r);
  }
  const rows = [];
  for (const p of picks) {
    const r = byMatch.get('jc-' + p.matchId) || byMatch.get(String(p.matchId));
    if (!r) continue;
    const settled = settleHandicap({ homeGoals: r.homeGoals, awayGoals: r.awayGoals, goalLine: p.handicap.goalLine });
    if (!settled) continue;
    rows.push({ ...p, actual: { homeGoals: r.homeGoals, awayGoals: r.awayGoals }, ...settled });
  }
  const decided = rows.filter(r => r.outcome !== OUTCOME.PUSH);
  const wins = decided.filter(r => r.outcome === OUTCOME.WIN);
  const hitRate = decided.length ? Math.round((wins.length / decided.length) * 10000) / 100 : null;
  return { rows, total: rows.length, decided: decided.length, wins: wins.length, pushes: rows.length - decided.length, hitRate };
}
