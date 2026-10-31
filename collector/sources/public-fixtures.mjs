import { isoMillis } from '../policy.mjs';
import { retryAfterMs } from './health.mjs';
import { SourceCooldownError, withSourceCooldown } from './cooldown.mjs';
import { withHistoryCache } from '../data/history-cache.mjs';
import { withEventIdentity, partitionLogicalMatches } from '../data/identity.mjs';
import { buildPublicCoverage } from '../data/coverage.mjs';

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
  constructor(code, httpStatus = null, retryMs = null, nextProbeAt = null) { super(code); this.code = code; this.httpStatus = httpStatus; this.retryMs = retryMs; this.nextProbeAt = nextProbeAt; }
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
    if (error instanceof SourceCooldownError) throw new PublicError(error.code, error.httpStatus, error.retryAfterMs, error.nextProbeAt);
    if (error instanceof PublicError) throw error;
    throw new PublicError('network_unavailable', httpStatus);
  } finally { clearTimeout(timer); controller.abort(); }
}

export function parsePublicFixtures(data, { source, league, season, nowISO, fetchedAt = nowISO, days = 7 }) {
  if (!['openligadb', 'thesportsdb-free'].includes(source) || !Number.isFinite(isoMillis(nowISO)) || !Number.isFinite(isoMillis(fetchedAt))
    || !Number.isInteger(days) || days < 1 || days > 7) throw new PublicError('invalid_response');
  const rows = source === 'openligadb' ? data : data?.events;
  if (source === 'thesportsdb-free' && rows === null) return { fixtures: [], receivedCount: 0, rejectedCount: 0 };
  if (!Array.isArray(rows) || rows.length > 3000 || source === 'thesportsdb-free' && rows.length > 1) throw new PublicError('invalid_response');
  const fixtures = [], seen = new Set(), duplicates = new Set(); let rejectedCount = 0;
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
    if (seen.has(String(matchId))) duplicates.add(String(matchId));
    seen.add(String(matchId));
    const scheduled = open ? row.matchIsFinished === false && Array.isArray(row.matchResults) && row.matchResults.length === 0
      : row.strStatus === 'NS' && row.strPostponed === 'no' && row.intHomeScore === null && row.intAwayScore === null;
    if (!scheduled || kickoff <= Date.parse(nowISO) || kickoff > Date.parse(nowISO) + days * DAY) continue;
    fixtures.push(withEventIdentity({ id: `${open ? 'oldb' : 'tsdb'}-${matchId}`, sourceFixtureId: String(matchId), league, home: home.trim(), away: away.trim(),
      homeTeamId: String(homeId), awayTeamId: String(awayId),
      ...(open ? { season: String(season) } : typeof row.strSeason === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,79}$/.test(row.strSeason) ? { season: row.strSeason } : {}),
      kickoff: new Date(kickoff).toISOString(), status: 'SCHEDULED', source,
      updatedAt: fetchedAt, fetchedAt, observedAt: fetchedAt,
      // OpenLigaDB lastUpdateDateTime has no timezone. Do not invent a UTC offset.
      sourceUpdatedAt: null }));
  }
  // A duplicate historical event must not poison unrelated future fixtures.
  // Still reject a scheduled ID also used by any other valid event/status.
  if (fixtures.some(row => duplicates.has(row.sourceFixtureId))) throw new PublicError('duplicate_fixture_id');
  const partition = partitionLogicalMatches(fixtures);
  return { fixtures: partition.records, receivedCount: rows.length,
    rejectedCount: rejectedCount + partition.conflicts.reduce((sum, conflict) => sum + conflict.ids.length, 0),
    conflicts: partition.conflicts };
}

export function parseOpenLigaHistory(data, { season, nowISO, observedAt = nowISO }) {
  if (!Array.isArray(data) || data.length > 3000 || !Number.isFinite(isoMillis(nowISO)) || !Number.isFinite(isoMillis(observedAt))) throw new PublicError('invalid_response');
  const history = [], seen = new Set(); let rejectedCount = 0;
  for (const row of data) {
    if (row?.matchIsFinished !== true) continue;
    const kickoff = isoMillis(row.matchDateTimeUTC);
    const scores = Array.isArray(row.matchResults) ? row.matchResults.filter(result => result.resultTypeKind === 'After90Minutes') : [];
    const score = scores[0];
    if (row.leagueShortcut !== 'bl1' || row.leagueSeason !== season || !id(row.matchID)
      || !id(row.team1?.teamId) || !id(row.team2?.teamId) || String(row.team1.teamId) === String(row.team2.teamId)
      || !name(row.team1?.teamName) || !name(row.team2?.teamName) || row.team1.teamName === row.team2.teamName
      || !Number.isFinite(kickoff) || !/Z$/.test(row.matchDateTimeUTC) || kickoff + 4 * 3600000 > Date.parse(nowISO)
      || scores.length !== 1 || ![score?.pointsTeam1, score?.pointsTeam2].every(value => Number.isInteger(value) && value >= 0 && value <= 20)) {
      rejectedCount++; continue;
    }
    if (seen.has(String(row.matchID))) throw new PublicError('duplicate_fixture_id');
    seen.add(String(row.matchID));
    history.push(withEventIdentity({ id: `oldb-${row.matchID}`, sourceFixtureId: String(row.matchID), source: 'openligadb', league: 'BL1', season: String(season), kickoff: new Date(kickoff).toISOString(),
      home: row.team1.teamName.trim(), away: row.team2.teamName.trim(), homeTeamId: String(row.team1.teamId), awayTeamId: String(row.team2.teamId),
      homeGoals: score.pointsTeam1, awayGoals: score.pointsTeam2, status: 'FINISHED', period: 'full-time',
      observedAt, resultObservedAt: observedAt, fetchedAt: observedAt, sourceUpdatedAt: null }));
  }
  const partition = partitionLogicalMatches(history);
  return { history: partition.records, rejectedCount: rejectedCount + partition.conflicts.reduce((sum, conflict) => sum + conflict.ids.length, 0),
    conflicts: partition.conflicts };
}

async function fetchPublicRound({ nowISO = new Date().toISOString(), days = 7, fetchImpl = fetch,
  clock = () => new Date().toISOString(), signal, remaining = () => Infinity, timeoutMs = 6000, includeHistory = false,
  cooldown, historyCache, historyCacheMaxAgeMs = DAY, resultsOnly = false } = {}) {
  const now = isoMillis(nowISO);
  if (!Number.isFinite(now) || !Number.isInteger(days) || days < 1 || days > 7) throw new Error('INVALID_PUBLIC_FIXTURE_WINDOW');
  if (!Number.isSafeInteger(historyCacheMaxAgeMs) || historyCacheMaxAgeMs < 0 || historyCacheMaxAgeMs > 7 * DAY) throw new Error('INVALID_HISTORY_CACHE_WINDOW');
  const seasonOf = time => { const date = new Date(time); return date.getUTCFullYear() - (date.getUTCMonth() < 6 ? 1 : 0); };
  const seasons = [...new Set([seasonOf(now), seasonOf(now + days * DAY)])];
  const requests = resultsOnly ? [{ source: 'openligadb', league: 'BL1', season: seasons[0], historyOnly: true,
    url: `https://api.openligadb.de/getmatchdata/bl1/${seasons[0]}` }] : [
    ...seasons.map(season => ({ source: 'openligadb', league: 'BL1', season, url: `https://api.openligadb.de/getmatchdata/bl1/${season}` })),
    ...(includeHistory ? [{ source: 'openligadb', league: 'BL1', season: seasons[0] - 1, historyOnly: true,
      url: `https://api.openligadb.de/getmatchdata/bl1/${seasons[0] - 1}` }] : []),
    ...Object.entries(SPORTS_LEAGUES).map(([league, [key]]) => ({ source: 'thesportsdb-free', league,
      url: `https://www.thesportsdb.com/api/v1/json/123/eventsnextleague.php?id=${key}` })),
  ];
  const fixtures = [], diagnostics = [], history = [];
  const unavailable = (common, error, stage, details = {}) => ({ ...common, ...details, stage,
    status: 'unavailable', code: stage === 'history-cache' ? 'history_cache_unavailable'
      : error instanceof PublicError ? error.code : 'invalid_response',
    httpStatus: details.httpStatus ?? (error instanceof PublicError ? error.httpStatus : null),
    retryAfterMs: error instanceof PublicError ? error.retryMs : null,
    nextProbeAt: error instanceof PublicError ? error.nextProbeAt : null,
    matchedCount: 0, historyCount: 0 });
  for (const request of requests) {
    const common = { id: request.source, league: request.league, endpoint: request.url, checkedAt: clock(),
      season: request.season === undefined ? null : String(request.season), purpose: request.historyOnly ? 'history' : 'fixtures',
      historyRequested: includeHistory && request.source === 'openligadb' };
    const historyCommon = { ...common, purpose: 'history', historyRequested: true };
    if (request.historyOnly && !historyCache) {
      diagnostics.push(unavailable(historyCommon, null, 'history-cache'));
      continue;
    }
    if (request.historyOnly && historyCacheMaxAgeMs > 0) {
      let cached;
      try { cached = historyCache.get(request, { nowISO: clock(), maxAgeMs: historyCacheMaxAgeMs }); }
      catch {
        historyCache = null;
        diagnostics.push(unavailable(historyCommon, null, 'history-cache'));
        continue;
      }
      if (cached) {
        history.push(...cached.records);
        diagnostics.push({ ...historyCommon, stage: 'history-cache', status: 'partial', code: 'history_cache_hit', cacheHit: true, fetchedAt: cached.fetchedAt,
          httpStatus: null, responseAt: null, matchedCount: 0, receivedCount: cached.receivedCount, rejectedCount: 0,
          inputCount: cached.receivedCount,
          historyCount: cached.records.length, historyRejectedCount: cached.rejectedCount });
        continue;
      }
    }
    let response;
    try {
      response = await getPublicJSON(request.url, { fetchImpl: (url, init) => cooldown.fetch(request.source, fetchImpl, url, init), signal, clock, remaining, timeoutMs });
    } catch (error) {
      diagnostics.push(unavailable(common, error, 'transport'));
      if (signal?.aborted || remaining() <= 0) break;
      continue;
    }
    const fetchedAt = clock(), rows = request.source === 'openligadb' ? response.data : response.data?.events;
    const inputCount = Array.isArray(rows) && rows.length <= 10000 ? rows.length : undefined;
    const details = { httpStatus: response.httpStatus, responseAt: response.responseAt, fetchedAt, cacheHit: false,
      ...(inputCount === undefined ? {} : { inputCount }) };
    if (!request.historyOnly) {
      const scheduleCommon = { ...common, historyRequested: false };
      try {
        const parsed = parsePublicFixtures(response.data, { ...request, nowISO, days, fetchedAt });
        fixtures.push(...parsed.fixtures);
        diagnostics.push({ ...scheduleCommon, ...details, stage: 'fixtures', status: 'partial',
          code: request.source === 'openligadb' ? 'community_schedule_unverified' : 'free_tier_limited',
          matchedCount: parsed.fixtures.length, receivedCount: parsed.receivedCount, rejectedCount: parsed.rejectedCount });
      } catch (error) {
        diagnostics.push(unavailable(scheduleCommon, error, 'fixtures', { ...details, receivedCount: inputCount ?? 0 }));
      }
    }
    if (common.historyRequested) {
      // Both capabilities can share one response; count received rows once,
      // but retain a separate input/accepted/rejected count for each parser.
      const historyDetails = { ...details, receivedCount: request.historyOnly ? inputCount ?? 0 : 0 };
      let stage = 'history';
      try {
        if (!historyCache) { stage = 'history-cache'; throw new Error('HISTORY_CACHE_UNAVAILABLE'); }
        const past = parseOpenLigaHistory(response.data, { season: request.season, nowISO, observedAt: fetchedAt });
        stage = 'history-cache';
        const saved = await historyCache.put(request, past.history, { fetchedAt, receivedCount: inputCount, rejectedCount: past.rejectedCount });
        history.push(...saved.records);
        diagnostics.push({ ...historyCommon, ...historyDetails, stage: 'history', status: 'partial',
          code: 'community_schedule_unverified', matchedCount: 0, historyCount: saved.records.length, historyRejectedCount: past.rejectedCount });
      } catch (error) {
        if (stage === 'history-cache') historyCache = null;
        diagnostics.push(unavailable(historyCommon, error, stage, historyDetails));
      }
    }
    if (signal?.aborted || remaining() <= 0) break;
  }
  const window = { from: nowISO, to: new Date(now + days * DAY).toISOString() };
  return { version: 1, kind: 'public-fixture-sample', dataSchemaVersion: 2, checkedAt: nowISO, simulated: false, poolComplete: false,
    window, coverage: buildPublicCoverage({ diagnostics, fixtures, history, window, includeHistory }),
    sources: PUBLIC_FIXTURE_SOURCES, diagnostics, fixtures, history,
    limitations: ['公开社区赛程与免费档仅用于有限覆盖试接入，不代表五大联赛完整或实时数据。',
      'OpenLigaDB 数据按 ODbL 1.0 保留归属；TheSportsDB 公共 Key 123 仅使用官方免费端点。',
      '采集时间不冒充供应商更新时间；开赛时间与赛事状态仍需独立核验。',
      '历史比分仅支持同源、同联赛、球队 ID 匹配的基础预测；缺少历史的联赛保留缺项。',
      '本文件不包含盘口；基础模型输出与严格亚洲盘候选分别计算。'] };
}

export async function fetchPublicFixtures(options = {}) {
  const { clock = () => new Date().toISOString(), signal, remaining = () => Infinity } = options;
  return withSourceCooldown({ statePath: options.cooldownStatePath, clock, signal, remaining }, async cooldown => {
    const run = historyCache => fetchPublicRound({ ...options, clock, cooldown, historyCache });
    if (!options.includeHistory) return run(null);
    let started = false, completedRound;
    try {
      return await withHistoryCache({ statePath: options.historyCachePath }, async historyCache => {
        started = true;
        completedRound = await run(historyCache);
        return completedRound;
      });
    } catch (error) {
      if (completedRound) {
        // Lock cleanup can fail after successful writes. Retain those real
        // samples, flag the cache, and leave its ownership record untouched.
        completedRound.diagnostics.push({ id: 'openligadb', league: 'BL1', checkedAt: clock(), season: null,
          purpose: 'history', historyRequested: true, stage: 'history-cache', status: 'unavailable',
          code: 'history_cache_unavailable', httpStatus: null, matchedCount: 0, historyCount: 0 });
        completedRound.coverage = buildPublicCoverage({ ...completedRound, includeHistory: true });
        return completedRound;
      }
      // An unreadable/locked cache disables history only. Never reset the file,
      // and never replay a round that already started issuing requests.
      if (started) throw error;
      return run(null);
    }
  });
}

export async function fetchPublicResults(options = {}) {
  return fetchPublicFixtures({ ...options, includeHistory: true, resultsOnly: true, historyCacheMaxAgeMs: 0 });
}
