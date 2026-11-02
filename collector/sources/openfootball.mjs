// openfootball 开放数据（GitHub raw），无 key、无 Cloudflare、无 robots 限制。
// 覆盖 2023-24 ~ 2026-27 四个赛季 × 五大联赛，每联赛约 380 场。
// 结构：{ name, matches: [{ date, time, round, team1, team2, score: { ft: [h, a], ht: [h, a] } }] }
//
// 重要限制：它只提供队名，没有稳定 teamId。而 prepareForecastHistory / 账本都要求
// homeTeamId/awayTeamId，所以这里**不直接把行喂进模型**，只产出规范化历史行；
// 要用必须先建「队名 → canonical teamId」映射层（见 docs/SOURCE_SCAN_2026-11-03.md）。
const HOST = 'https://raw.githubusercontent.com/openfootball/football.json/master';

export const OPENFOOTBALL_LEAGUES = Object.freeze({
  'en.1': 'PL', 'de.1': 'BL1', 'es.1': 'PD', 'it.1': 'SA', 'fr.1': 'FL1',
});
export const OPENFOOTBALL_SEASONS = Object.freeze(['2023-24', '2024-25', '2025-26', '2026-27']);

function parseKickoff(dateValue, timeValue) {
  if (typeof dateValue !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) return null;
  const time = typeof timeValue === 'string' && /^\d{1,2}[:.]\d{2}$/.test(timeValue)
    ? timeValue.replace('.', ':').padStart(5, '0') : '00:00';
  const iso = dateValue + 'T' + time + ':00.000Z';
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}

function toRow(match, league, season) {
  if (!match || typeof match.team1 !== 'string' || typeof match.team2 !== 'string') return null;
  const home = match.team1.trim(), away = match.team2.trim();
  if (!home || !away || home === away) return null;
  const ft = match.score && Array.isArray(match.score.ft) ? match.score.ft : null;
  if (!ft || ft.length !== 2) return null;
  const [homeGoals, awayGoals] = ft;
  if (!Number.isInteger(homeGoals) || !Number.isInteger(awayGoals)) return null;
  if (homeGoals < 0 || awayGoals < 0 || homeGoals > 20 || awayGoals > 20) return null;
  const kickoff = parseKickoff(match.date, match.time);
  if (!kickoff) return null;
  return { source: 'openfootball', league, season, home, away, kickoff,
    status: 'FINISHED', period: 'full-time', homeGoals, awayGoals,
    ...(typeof match.round === 'string' ? { round: match.round.slice(0, 80) } : {}) };
}

export async function fetchOpenFootballSeason({ season, league, fetchImpl = fetch,
  timeoutMs = 20_000, signal } = {}) {
  const mapped = OPENFOOTBALL_LEAGUES[league];
  if (!mapped) return { rows: [], error: 'UNKNOWN_LEAGUE' };
  if (!OPENFOOTBALL_SEASONS.includes(season)) return { rows: [], error: 'UNKNOWN_SEASON' };
  const url = HOST + '/' + season + '/' + league + '.json';
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) });
  } catch { return { rows: [], error: 'FETCH_UNCONFIRMED', url }; }
  if (!response.ok) { await response.body?.cancel?.(); return { rows: [], error: 'HTTP_' + response.status, url }; }
  let payload;
  try { payload = await response.json(); } catch { return { rows: [], error: 'INVALID_JSON', url }; }
  if (!payload || !Array.isArray(payload.matches)) return { rows: [], error: 'INVALID_PAYLOAD', url };
  const rows = [];
  for (const match of payload.matches) {
    const row = toRow(match, mapped, season);
    if (row) rows.push(row);
  }
  return { rows, total: payload.matches.length, name: typeof payload.name === 'string' ? payload.name : null, url };
}

// 一次拉多赛季多联赛；失败逐项降级，不抛错。
export async function collectOpenFootballHistory({ seasons = OPENFOOTBALL_SEASONS,
  leagues = Object.keys(OPENFOOTBALL_LEAGUES), fetchImpl = fetch, timeoutMs = 20_000, signal } = {}) {
  const rows = [], diagnostics = [];
  for (const season of seasons) for (const league of leagues) {
    const result = await fetchOpenFootballSeason({ season, league, fetchImpl, timeoutMs, signal });
    diagnostics.push({ league, season, matched: result.rows.length, total: result.total || 0,
      ...(result.error ? { error: result.error } : {}) });
    rows.push(...result.rows);
  }
  return { version: 1, rows, diagnostics };
}
