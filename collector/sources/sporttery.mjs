// 中国体育彩票官方竞彩数据（webapi.sporttery.cn）。
// 授权：www.sporttery.cn/robots.txt 只限制 *.pdf/*.js/*.json/*.php，且 API 域名
// webapi.sporttery.cn 没有 robots（404），请求路径是 .qry 而非受限后缀。
// 官方公开接口，含在售竞彩场次、让球盘（hhad）与带秒级 updateTime 的赔率变更。
//
// 价值：这是合法的"官方博彩数据"入口——让球盘 + 联赛排名 + 精确更新时间，
// 可用于盘口变化追踪（替代有准入争议的第三方源）。
const ENDPOINT = 'https://webapi.sporttery.cn/gateway/jc/football/getMatchCalculatorV1.qry';

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function rankOf(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/\[(.+?)(\d+)\]/);
  return m ? { league: m[1], rank: Number(m[2]) } : null;
}

// hhad = 让球胜平负；goalLine 为让球数（负=主队让球）
export function toHandicap(pool) {
  if (!pool || typeof pool !== 'object') return null;
  const home = num(pool.h), draw = num(pool.d), away = num(pool.a);
  const goalLine = Number(pool.goalLineValue ?? pool.goalLine);
  if (home === null || draw === null || away === null) return null;
  if (!Number.isFinite(goalLine)) return null;
  const updatedAt = typeof pool.updateDate === 'string' && typeof pool.updateTime === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(pool.updateDate) && /^\d{2}:\d{2}:\d{2}$/.test(pool.updateTime)
    ? new Date(pool.updateDate + 'T' + pool.updateTime + '+08:00').toISOString() : null;
  return { source: 'sporttery-jc', pool: 'hhad', goalLine, home, draw, away,
    ...(updatedAt ? { updatedAt } : {}) };
}

function toMatch(row) {
  if (!row || !Number.isSafeInteger(row.matchId)) return null;
  const home = typeof row.homeTeamAbbName === 'string' ? row.homeTeamAbbName.trim() : '';
  const away = typeof row.awayTeamAbbName === 'string' ? row.awayTeamAbbName.trim() : '';
  if (!home || !away || home === away) return null;
  // matchDate 与 matchTime 是两个独立字段（如 2026-11-03 + 03:45:00），必须合并，
  // 直接对 matchDate 拼时区会得到非法的 '2026-11-03+08:00' 并让整批行被拒绝。
  const datePart = String(row.matchDate || '').trim();
  const timePart = typeof row.matchTime === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(row.matchTime) ? row.matchTime : '00:00:00';
  const kickoffMs = Date.parse(datePart + 'T' + timePart + '+08:00');
  if (!Number.isFinite(kickoffMs)) return null;
  return { matchId: row.matchId, matchNum: typeof row.matchNumStr === 'string' ? row.matchNumStr : String(row.matchNum),
    league: typeof row.leagueAbbName === 'string' ? row.leagueAbbName.trim() : null,
    leagueId: row.leagueId ?? null, home, away,
    homeRank: rankOf(row.homeRank), awayRank: rankOf(row.awayRank),
    kickoff: new Date(kickoffMs).toISOString(), status: typeof row.matchStatus === 'string' ? row.matchStatus : null,
    sellStatus: typeof row.sellStatus === 'string' ? row.sellStatus : null,
    handicap: toHandicap(row.hhad) };
}

export async function fetchSportteryMatches({ fetchImpl = fetch, timeoutMs = 20_000, signal } = {}) {
  const url = ENDPOINT + '?poolCode=hhad&channel=c';
  let response;
  try {
    response = await fetchImpl(url, { redirect: 'error',
      headers: { referer: 'https://www.sporttery.cn/', accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)) });
  } catch { return { matches: [], error: 'FETCH_UNCONFIRMED', url }; }
  if (!response.ok) { await response.body?.cancel?.(); return { matches: [], error: 'HTTP_' + response.status, url }; }
  let payload;
  try { payload = await response.json(); } catch { return { matches: [], error: 'INVALID_JSON', url }; }
  const value = payload?.value;
  if (!payload?.success || !value || !Array.isArray(value.matchInfoList))
    return { matches: [], error: 'INVALID_PAYLOAD', url };
  const matches = [];
  for (const day of value.matchInfoList) for (const row of day?.subMatchList || []) {
    const match = toMatch(row);
    if (match) matches.push(match);
  }
  const updatedAt = typeof value.lastUpdateTime === 'string' && Number.isFinite(Date.parse(value.lastUpdateTime.replace(' ', 'T') + '+08:00'))
    ? new Date(Date.parse(value.lastUpdateTime.replace(' ', 'T') + '+08:00')).toISOString() : null;
  return { matches, totalCount: Number.isSafeInteger(value.totalCount) ? value.totalCount : matches.length,
    ...(updatedAt ? { updatedAt } : {}), url };
}

// 只保留带完整让球盘的场次，供盘口证据链使用。
export function handicapQuotes(payload) {
  const quotes = [];
  for (const match of payload?.matches || []) {
    if (!match.handicap) continue;
    quotes.push({ source: match.handicap.source, fixtureKey: 'jc-' + match.matchId,
      league: match.league, home: match.home, away: match.away, kickoff: match.kickoff,
      goalLine: match.handicap.goalLine, home: match.handicap.home, draw: match.handicap.draw,
      away: match.handicap.away, updatedAt: match.handicap.updatedAt });
  }
  return quotes;
}
