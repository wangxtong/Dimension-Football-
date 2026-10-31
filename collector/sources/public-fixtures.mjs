import { isoMillis } from '../policy.mjs';
import { retryAfterMs } from './health.mjs';

// These are provider-published public endpoints, not discovered private routes.
// 123 is TheSportsDB's documented shared free key; no secret is accepted here.
export const PUBLIC_FIXTURE_SOURCES = Object.freeze([
  { id: 'openligadb', name: 'OpenLigaDB', url: 'https://www.openligadb.de/',
    license: 'ODbL-1.0', licenseUrl: 'https://www.openligadb.de/lizenz', leagues: ['BL1'],
    coverage: 'Community Bundesliga schedule; publication does not confirm all kickoff times.' },
  { id: 'thesportsdb-free', name: 'TheSportsDB Free', url: 'https://www.thesportsdb.com/docs_api_guide.php',
    license: 'Provider terms; shared free tier', licenseUrl: 'https://www.thesportsdb.com/docs_api_guide.php',
    leagues: ['PL', 'PD', 'SA', 'FL1'], coverage: 'At most one next event per league on the documented free tier.' },
]);
const SPORTS_LEAGUES = { PL: ['4328', 'English Premier League'], PD: ['4335', 'Spanish La Liga'],
  SA: ['4332', 'Italian Serie A'], FL1: ['4334', 'French Ligue 1'] };
const USER_AGENT = 'DimensionFootball-Collector/1.0 (+https://github.com/wangxtong/Dimension-Football-)';
const DAY = 86400000;
class PublicError extends Error {
  constructor(code, httpStatus = null, retryMs = null) { super(code); this.code = code; this.httpStatus = httpStatus; this.retryMs = retryMs; }
}
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
const id = value => typeof value === 'number' ? Number.isSafeInteger(value) && value > 0 : typeof value === 'string' && /^[1-9][0-9]{0,14}$/.test(value);

async function getPublicJSON(url, { fetchImpl, signal, clock, remaining, timeoutMs }) {
  if (signal?.aborted) throw new PublicError('cancelled');
  if (remaining() <= 0) throw new PublicError('budget_exhausted');
  const controller = new AbortController(), joined = AbortSignal.any([controller.signal, signal].filter(Boolean));
  let timer, httpStatus = null;
  try {
    const operation = (async () => {
      const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: joined,
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT } });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel?.().catch(() => {});
        throw new PublicError(httpStatus === 401 || httpStatus === 403 ? 'authorization_required'
          : httpStatus === 429 ? 'rate_limited' : httpStatus >= 300 && httpStatus < 400 ? 'redirect_blocked' : 'http_unavailable',
        httpStatus, retryAfterMs(response.headers.get('retry-after'), Date.parse(clock())));
      }
      const serverTime = Date.parse(response.headers.get('date'));
      if (!Number.isFinite(serverTime) || Math.abs(Date.parse(clock()) - serverTime) > 300000) {
        await response.body?.cancel?.().catch(() => {}); throw new PublicError('stale_response', httpStatus);
      }
      if (Number(response.headers.get('content-length')) > 2000000) {
        await response.body?.cancel?.().catch(() => {}); throw new PublicError('response_too_large', httpStatus);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new PublicError('invalid_response', httpStatus);
      const decoder = new TextDecoder(); let bytes = 0, body = '';
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2000000) throw new PublicError('response_too_large', httpStatus);
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); }
      try { return { data: JSON.parse(body), httpStatus, responseAt: new Date(serverTime).toISOString() }; }
      catch { throw new PublicError('invalid_json', httpStatus); }
    })();
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new PublicError('timeout', httpStatus)); }, Math.max(1, Math.min(timeoutMs, remaining())));
    }), new Promise((_, reject) => {
      if (signal?.aborted) reject(new PublicError('cancelled', httpStatus));
      else signal?.addEventListener('abort', () => reject(new PublicError('cancelled', httpStatus)), { once: true, signal: controller.signal });
    })]);
  } catch (error) {
    if (signal?.aborted) throw new PublicError('cancelled', httpStatus);
    if (remaining() <= 0) throw new PublicError('budget_exhausted', httpStatus);
    if (error instanceof PublicError) throw error;
    throw new PublicError('network_unavailable', httpStatus);
  } finally { clearTimeout(timer); controller.abort(); }
}

export function parsePublicFixtures(data, { source, league, season, nowISO, days = 7 }) {
  if (!['openligadb', 'thesportsdb-free'].includes(source) || !Number.isFinite(isoMillis(nowISO))
    || !Number.isInteger(days) || days < 1 || days > 7) throw new PublicError('invalid_response');
  const rows = source === 'openligadb' ? data : data?.events;
  if (source === 'thesportsdb-free' && rows === null) return { fixtures: [], receivedCount: 0, rejectedCount: 0 };
  if (!Array.isArray(rows) || rows.length > 3000 || source === 'thesportsdb-free' && rows.length > 1) throw new PublicError('invalid_response');
  const fixtures = [], seen = new Set(); let rejectedCount = 0;
  for (const row of rows) {
    const open = source === 'openligadb', matchId = open ? row?.matchID : row?.idEvent;
    const home = open ? row?.team1?.teamName : row?.strHomeTeam, away = open ? row?.team2?.teamName : row?.strAwayTeam;
    const homeId = open ? row?.team1?.teamId : row?.idHomeTeam, awayId = open ? row?.team2?.teamId : row?.idAwayTeam;
    // OpenLigaDB supplies explicit UTC. TheSportsDB documents dateEvent + strTime as UTC;
    // never infer a time from dateEventLocal, strTimeLocal or a missing time.
    const timestamp = open ? row?.matchDateTimeUTC : /^\d{4}-\d{2}-\d{2}$/.test(row?.dateEvent || '')
      && /^\d{2}:\d{2}:\d{2}$/.test(row?.strTime || '') ? `${row.dateEvent}T${row.strTime}Z` : null;
    const kickoff = isoMillis(timestamp);
    const alternateTime = !open && row?.strTimestamp ? isoMillis(/(?:Z|[+-]\d{2}:\d{2})$/.test(row.strTimestamp)
      ? row.strTimestamp : `${row.strTimestamp}Z`) : kickoff;
    const correctLeague = open ? league === 'BL1' && row?.leagueShortcut === 'bl1' && row?.leagueSeason === season
      : SPORTS_LEAGUES[league]?.[0] === row?.idLeague && SPORTS_LEAGUES[league]?.[1] === row?.strLeague && row?.strSport === 'Soccer';
    if (!correctLeague || !id(matchId) || !id(homeId) || !id(awayId) || String(homeId) === String(awayId)
      || !name(home) || !name(away) || home.trim() === away.trim() || !Number.isFinite(kickoff)
      || open && !/Z$/.test(timestamp) || !open && (row.strTime === '00:00:00' || alternateTime !== kickoff)) { rejectedCount++; continue; }
    if (seen.has(String(matchId))) throw new PublicError('duplicate_fixture_id');
    seen.add(String(matchId));
    const scheduled = open ? row.matchIsFinished === false && Array.isArray(row.matchResults) && row.matchResults.length === 0
      : row.strStatus === 'NS' && row.strPostponed === 'no' && row.intHomeScore === null && row.intAwayScore === null;
    if (!scheduled || kickoff <= Date.parse(nowISO) || kickoff > Date.parse(nowISO) + days * DAY) continue;
    fixtures.push({ id: `${open ? 'oldb' : 'tsdb'}-${matchId}`, league, home: home.trim(), away: away.trim(),
      kickoff: new Date(kickoff).toISOString(), status: 'SCHEDULED', source,
      updatedAt: nowISO, fetchedAt: nowISO,
      // OpenLigaDB lastUpdateDateTime has no timezone. Do not invent a UTC offset.
      sourceUpdatedAt: null });
  }
  return { fixtures, receivedCount: rows.length, rejectedCount };
}

export async function fetchPublicFixtures({ nowISO = new Date().toISOString(), days = 7, fetchImpl = fetch,
  clock = () => new Date().toISOString(), signal, remaining = () => Infinity, timeoutMs = 6000 } = {}) {
  const now = isoMillis(nowISO);
  if (!Number.isFinite(now) || !Number.isInteger(days) || days < 1 || days > 7) throw new Error('INVALID_PUBLIC_FIXTURE_WINDOW');
  const seasonOf = time => { const date = new Date(time); return date.getUTCFullYear() - (date.getUTCMonth() < 6 ? 1 : 0); };
  const seasons = [...new Set([seasonOf(now), seasonOf(now + days * DAY)])];
  const requests = [
    ...seasons.map(season => ({ source: 'openligadb', league: 'BL1', season, url: `https://api.openligadb.de/getmatchdata/bl1/${season}` })),
    ...Object.entries(SPORTS_LEAGUES).map(([league, [key]]) => ({ source: 'thesportsdb-free', league,
      url: `https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=${key}` })),
  ];
  const fixtures = [], diagnostics = [];
  for (const request of requests) {
    const common = { id: request.source, league: request.league, endpoint: request.url, checkedAt: clock() };
    try {
      const response = await getPublicJSON(request.url, { fetchImpl, signal, clock, remaining, timeoutMs });
      const parsed = parsePublicFixtures(response.data, { ...request, nowISO, days });
      fixtures.push(...parsed.fixtures);
      diagnostics.push({ ...common, status: 'partial', code: request.source === 'openligadb' ? 'community_schedule_unverified' : 'free_tier_limited',
        httpStatus: response.httpStatus, responseAt: response.responseAt, matchedCount: parsed.fixtures.length,
        receivedCount: parsed.receivedCount, rejectedCount: parsed.rejectedCount });
    } catch (error) {
      diagnostics.push({ ...common, status: 'unavailable', code: error instanceof PublicError ? error.code : 'invalid_response',
        httpStatus: error instanceof PublicError ? error.httpStatus : null, retryAfterMs: error instanceof PublicError ? error.retryMs : null,
        matchedCount: 0 });
    }
    if (signal?.aborted || remaining() <= 0) break;
  }
  return { version: 1, kind: 'public-fixture-sample', checkedAt: nowISO, simulated: false, poolComplete: false,
    window: { from: nowISO, to: new Date(now + days * DAY).toISOString() },
    sources: PUBLIC_FIXTURE_SOURCES, diagnostics, fixtures,
    limitations: ['公开社区赛程与免费档仅用于有限覆盖试接入，不代表五大联赛完整或实时数据。',
      'OpenLigaDB 数据按 ODbL 1.0 保留归属；TheSportsDB 公共 Key 123 仅使用官方免费端点。',
      '采集时间不冒充供应商更新时间；开赛时间与赛事状态仍需独立核验。',
      '本文件不包含盘口或预测；取得赛程不等于取得有效预测证据。'] };
}
