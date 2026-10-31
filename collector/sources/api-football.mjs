import { isoMillis } from '../policy.mjs';
import { withEventIdentity } from '../data/identity.mjs';
import { retryAfterMs } from './health.mjs';

// API-Sports direct subscription, not the separate RapidAPI gateway.
// https://www.api-football.com/documentation_v3#tag/Fixtures/operation/get-fixtures
export const apiFootballLeagues = Object.freeze({ PL: 39, PD: 140, SA: 135, BL1: 78, FL1: 61 });
const DAY = 86_400_000, RESPONSE_LIMIT = 2_000_000, DEADLINE_MS = 6000;
const SAFE_CODES = new Set(['response_too_large', 'invalid_json', 'invalid_response', 'incomplete_response',
  'duplicate_fixture_id', 'too_many_fixtures', 'authorization_required', 'access_denied', 'rate_limited',
  'http_unavailable', 'stale_response', 'plan_restricted', 'quota_exceeded', 'api_error', 'timeout']);

class SourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function readJSON(response) {
  if (Number(response.headers?.get('content-length')) > RESPONSE_LIMIT) throw new SourceError('response_too_large');
  const reader = response.body?.getReader?.();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RESPONSE_LIMIT) throw new SourceError('response_too_large');
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT) throw new SourceError('response_too_large');
  }
  try { return JSON.parse(text); }
  catch { throw new SourceError('invalid_json'); }
}

function normalize(payload, league, checkedAt, now, until) {
  if (!payload || payload.get !== 'fixtures' || !Array.isArray(payload.response)
    || !payload.errors || typeof payload.errors !== 'object') throw new SourceError('invalid_response');
  const errorFields = Object.keys(payload.errors);
  if (errorFields.length) {
    // Never copy upstream messages: a provider may reflect a credential in an error.
    const code = errorFields.includes('plan') ? 'plan_restricted'
      : errorFields.includes('token') ? 'authorization_required'
        : errorFields.includes('rateLimit') ? 'rate_limited'
          : errorFields.includes('requests') ? 'quota_exceeded' : 'api_error';
    throw new SourceError(code);
  }
  if (payload.response.length > 99) throw new SourceError('too_many_fixtures');
  if (!Number.isSafeInteger(payload.results) || payload.results !== payload.response.length
    || payload.paging?.current !== 1 || !Number.isSafeInteger(payload.paging?.total)
    || payload.paging.total < 1) throw new SourceError('invalid_response');
  if (payload.paging.total > 1) throw new SourceError('incomplete_response');
  const fixtures = [], ids = new Set();
  let rejectedCount = 0, latest = -Infinity;
  for (const match of payload.response) {
    const row = match?.fixture, home = match?.teams?.home, away = match?.teams?.away;
    const kickoff = isoMillis(row?.date);
    const valid = Number.isSafeInteger(row?.id) && row.id > 0
      && match?.league?.id === apiFootballLeagues[league]
      && Number.isSafeInteger(home?.id) && home.id > 0
      && Number.isSafeInteger(away?.id) && away.id > 0 && home.id !== away.id
      && typeof home?.name === 'string' && !!home.name.trim()
      && typeof away?.name === 'string' && !!away.name.trim() && home.name.trim() !== away.name.trim()
      && Number.isFinite(kickoff) && Number.isSafeInteger(row?.timestamp) && row.timestamp * 1000 === kickoff;
    if (!valid) { rejectedCount++; continue; }
    if (ids.has(row.id)) throw new SourceError('duplicate_fixture_id');
    ids.add(row.id);
    latest = Math.max(latest, kickoff);
    // TBD may contain a provisional date. Keep only confirmed, not-started games.
    if (row.status?.short !== 'NS' || kickoff <= now || kickoff > until) continue;
    fixtures.push(withEventIdentity({
      id: `af-${row.id}`, providerMatchId: row.id, league,
      home: home.name.trim(), away: away.name.trim(), kickoff: new Date(kickoff).toISOString(),
      homeTeamId: String(home.id), awayTeamId: String(away.id),
      ...(Number.isSafeInteger(match.league.season) ? { season: String(match.league.season) } : {}),
      status: 'SCHEDULED', source: 'api-football', sourceId: 'api-football',
      evidenceUrl: `https://v3.football.api-sports.io/fixtures?id=${row.id}`,
      updatedAt: checkedAt, fetchedAt: checkedAt, sourceUpdatedAt: null,
    }));
  }
  return { fixtures, receivedCount: payload.response.length, rejectedCount,
    // The request is bounded at 99 games. Do not claim coverage if all 99 fall in the requested window.
    truncated: payload.response.length === 99 && latest <= until };
}

async function fetchLeague({ league, apiKey, now, checkedAt, window, fetchImpl }) {
  const url = new URL('https://v3.football.api-sports.io/fixtures');
  url.searchParams.set('league', apiFootballLeagues[league]);
  url.searchParams.set('next', '99');
  url.searchParams.set('timezone', 'UTC');
  const common = { id: 'api-football', sourceId: 'api-football', league, url: url.href,
    checkedAt, window, checkType: 'official-api',
    capability: 'API-Football 五大联赛未来赛程；仅保留 NS，不提供盘口或预测。' };
  if (!apiKey) return { fixtures: [], diagnostic: { ...common, status: 'unavailable',
    note: 'authorization_required', fetchedAt: null, responseAt: null, httpStatus: null,
    matchedCount: 0, receivedCount: null } };
  const controller = new AbortController();
  let timer, httpStatus = null, responseAt = null, retryMs = null;
  try {
    const operation = (async () => {
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'x-apisports-key': apiKey, Accept: 'application/json', 'User-Agent': 'DimensionFootball-Collector/1.0' } });
      httpStatus = Number.isInteger(response?.status) ? response.status : null;
      retryMs = retryAfterMs(response.headers?.get('retry-after'), now);
      if (!response?.ok) throw new SourceError(httpStatus === 401 ? 'authorization_required'
        : httpStatus === 403 ? 'access_denied' : httpStatus === 429 ? 'rate_limited' : 'http_unavailable');
      const responseTime = Date.parse(response.headers?.get('date'));
      responseAt = Number.isFinite(responseTime) ? new Date(responseTime).toISOString() : null;
      if (!Number.isFinite(responseTime) || Math.abs(now - responseTime) > 300_000) throw new SourceError('stale_response');
      return normalize(await readJSON(response), league, checkedAt, now, Date.parse(window.to));
    })();
    const result = await Promise.race([operation, new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new SourceError('timeout')); }, DEADLINE_MS);
    })]);
    return { fixtures: result.fixtures, diagnostic: { ...common,
      status: result.rejectedCount || result.truncated ? 'partial' : result.fixtures.length ? 'available' : 'complete',
      note: result.truncated ? 'fixture_limit_reached' : result.fixtures.length ? `matched_${result.fixtures.length}` : 'no_upcoming_fixtures',
      fetchedAt: checkedAt, responseAt, httpStatus, matchedCount: result.fixtures.length,
      receivedCount: result.receivedCount, rejectedCount: result.rejectedCount } };
  } catch (error) {
    return { fixtures: [], diagnostic: { ...common, status: 'unavailable',
      note: SAFE_CODES.has(error?.code) ? error.code : 'network_unavailable',
      fetchedAt: checkedAt, responseAt, httpStatus, matchedCount: 0, receivedCount: null, retryAfterMs: retryMs } };
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function fetchApiFootballFixtures({ apiKey = '', nowISO = new Date().toISOString(), fetchImpl = fetch, days = 7 } = {}) {
  const now = isoMillis(nowISO);
  if (!Number.isFinite(now) || typeof fetchImpl !== 'function' || !Number.isInteger(days) || days < 1 || days > 14
    || typeof apiKey !== 'string' || apiKey.length > 256 || /[\r\n]/.test(apiKey)) throw new TypeError('Invalid API-Football fixture request');
  const checkedAt = new Date(now).toISOString(), window = {
    from: checkedAt, to: new Date(now + days * DAY).toISOString(), timezone: 'UTC', fromExclusive: true, toInclusive: true,
  };
  const results = await Promise.all(Object.keys(apiFootballLeagues).map(league => fetchLeague({
    league, apiKey: apiKey.trim(), now, checkedAt, window, fetchImpl,
  })));
  const fixtures = results.flatMap(result => result.fixtures).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
  return { fixtures, diagnostics: results.map(result => result.diagnostic), window, checkedAt };
}
