// football-data.org 免费档历史结果：把已完赛比赛转成内部 history 行，供赛前 1X2 模型使用。
// 为什么需要它：免费采集默认只能从 OpenLigaDB 拿到德甲历史，其余四大联赛没有样本，
// 结果就是每天赛程很多、可预测 0 场。football-data 免费档的 matches 端点可以取到
// 已完赛结果（实测 2026-11-02：PL 2025 赛季 380 场，HTTP 200），因此用它补齐同源历史。
// 免费档限流 10 请求/分钟：每个联赛只发一次请求，不重试、不翻页。
const HOST = 'https://api.football-data.org/v4/competitions';
export const HISTORY_LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1'];
const DAY = 86_400_000;

function dayString(ms) { return new Date(ms).toISOString().slice(0, 10); }

function historyRow(match, league, fetchedAt) {
  const home = typeof match?.homeTeam?.name === 'string' ? match.homeTeam.name.trim() : '';
  const away = typeof match?.awayTeam?.name === 'string' ? match.awayTeam.name.trim() : '';
  const kickoff = Date.parse(match?.utcDate || '');
  const homeGoals = match?.score?.fullTime?.home;
  const awayGoals = match?.score?.fullTime?.away;
  if (!home || !away || home === away || !Number.isFinite(kickoff)) return null;
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  if (homeGoals < 0 || awayGoals < 0) return null;
  if (!Number.isSafeInteger(match?.homeTeam?.id) || match.homeTeam.id <= 0) return null;
  if (!Number.isSafeInteger(match?.awayTeam?.id) || match.awayTeam.id <= 0) return null;
  if (match.homeTeam.id === match.awayTeam.id) return null;
  return { source: 'football-data.org', id: 'fd-' + match.id, league,
    home, away,
    homeTeamId: String(match.homeTeam.id), awayTeamId: String(match.awayTeam.id),
    kickoff: new Date(kickoff).toISOString(), status: 'FINISHED', period: 'full-time',
    homeGoals, awayGoals,
    ...(typeof match.season?.startDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(match.season.startDate)
      ? { season: match.season.startDate.slice(0, 4) } : {}),
    fetchedAt };
}

async function fetchLeagueHistory({ league, apiKey, dateFrom, dateTo, fetchImpl, timeoutMs, signal, fetchedAt }) {
  const url = new URL(HOST + '/' + league + '/matches');
  url.searchParams.set('status', 'FINISHED');
  url.searchParams.set('dateFrom', dateFrom);
  url.searchParams.set('dateTo', dateTo);
  const diagnostic = { id: 'football-data.org', league, url: url.href, status: 'unavailable',
    code: 'HISTORY_FETCH_FAILED', matchedCount: 0, receivedCount: null };
  let response;
  try {
    response = await fetchImpl(url.href, {
      headers: { 'X-Auth-Token': apiKey, accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean)),
    });
  } catch { return { history: [], diagnostic: { ...diagnostic, code: 'HISTORY_FETCH_UNCONFIRMED' } }; }
  if (!response.ok) {
    await response.body?.cancel();
    return { history: [], diagnostic: { ...diagnostic, code: 'HISTORY_HTTP_' + response.status, httpStatus: response.status } };
  }
  let payload;
  try { payload = await response.json(); }
  catch { return { history: [], diagnostic: { ...diagnostic, code: 'HISTORY_INVALID_JSON' } }; }
  if (!Array.isArray(payload?.matches)) return { history: [], diagnostic: { ...diagnostic, code: 'HISTORY_INVALID_PAYLOAD' } };
  const history = [];
  for (const match of payload.matches) {
    if (match?.competition?.code !== league) continue;
    const row = historyRow(match, league, fetchedAt);
    if (row) history.push(row);
  }
  return { history, diagnostic: { ...diagnostic, status: 'available', code: null,
    matchedCount: history.length, receivedCount: payload.matches.length } };
}

// 返回内部 history 行与每个联赛的采集诊断；任一联赛失败都不影响其余联赛。
export async function collectFootballDataHistory({ apiKey, leagues = HISTORY_LEAGUES, days = 420,
  fetchImpl = fetch, timeoutMs = 20_000, signal, nowISO = new Date().toISOString(),
  maxPerLeague = 400 } = {}) {
  const result = { version: 1, history: [], diagnostics: [] };
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    result.diagnostics.push({ id: 'football-data.org', status: 'unavailable', code: 'HISTORY_KEY_REQUIRED' });
    return result;
  }
  const nowMs = Date.parse(nowISO);
  if (!Number.isFinite(nowMs)) throw new Error('INVALID_NOW');
  const dateFrom = dayString(nowMs - days * DAY), dateTo = dayString(nowMs);
  const fetchedAt = new Date(nowMs).toISOString();
  const seen = new Set();
  for (const league of leagues) {
    const { history, diagnostic } = await fetchLeagueHistory({ league, apiKey: apiKey.trim(), dateFrom, dateTo,
      fetchImpl, timeoutMs, signal, fetchedAt });
    result.diagnostics.push(diagnostic);
    let kept = 0;
    for (const row of history) {
      if (seen.has(row.id) || kept >= maxPerLeague) continue;
      seen.add(row.id); kept += 1; result.history.push(row);
    }
  }
  return result;
}
