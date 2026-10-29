// Official API: https://docs.football-data.org/general/v4/competition.html
// v4 dateTo is exclusive: https://docs.football-data.org/general/v4/index.html
// Authentication is supplied only as X-Auth-Token to the official API host.
export const fixtureLeagues = Object.freeze(['PL', 'PD', 'SA', 'BL1', 'FL1']);
const DAY = 86400000;
const MAX_FIXTURES = 3000;
const RESPONSE_LIMIT = 2000000;
const DEADLINE_MS = 6000;

function sourceUTC(value) {
  if (typeof value !== 'string') return NaN;
  const parts = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!parts) return NaN;
  const canonical = `${parts[1]}.${(parts[2] || '').padEnd(3, '0')}Z`, ms = Date.parse(canonical);
  return Number.isFinite(ms) && new Date(ms).toISOString() === canonical ? ms : NaN;
}

class FixtureSourceError extends Error {
  constructor(code, httpStatus = null) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function fixtureWindow(now, days) {
  const to = now + days * DAY;
  // Asking through the next UTC midnight also covers the last partial day.
  // Local filtering below keeps only the exact rolling [now, now + days] window.
  const exclusiveEnd = (Math.floor(to / DAY) + 1) * DAY;
  return {
    from: new Date(now).toISOString(),
    to: new Date(to).toISOString(),
    dateFrom: new Date(now).toISOString().slice(0, 10),
    dateTo: new Date(exclusiveEnd).toISOString().slice(0, 10),
    timezone: 'UTC',
    dateToExclusive: true,
    fromExclusive: true,
    toInclusive: true,
  };
}

async function readJSON(response) {
  if (Number(response.headers?.get('content-length')) > RESPONSE_LIMIT) {
    throw new FixtureSourceError('response_too_large', response.status);
  }
  const reader = response.body?.getReader?.();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > RESPONSE_LIMIT) throw new FixtureSourceError('response_too_large', response.status);
        text += decoder.decode(value, {stream: true});
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT) {
      throw new FixtureSourceError('response_too_large', response.status);
    }
  }
  try { return JSON.parse(text); }
  catch { throw new FixtureSourceError('invalid_json', response.status); }
}

function normalizeMatches(payload, league, checkedAt, now, until) {
  if (!payload || !Array.isArray(payload.matches)
      || (payload.competition?.code && payload.competition.code !== league)) {
    throw new FixtureSourceError('invalid_response');
  }
  if (payload.matches.length > MAX_FIXTURES) throw new FixtureSourceError('too_many_fixtures');
  const fixtures = [], ids = new Set();
  let rejectedCount = 0;
  for (const match of payload.matches) {
    const kickoff = sourceUTC(match?.utcDate);
    const home = match?.homeTeam?.name, away = match?.awayTeam?.name;
    const validIdentity = Number.isSafeInteger(match?.id) && match.id > 0
      && match?.competition?.code === league
      && typeof home === 'string' && !!home.trim() && typeof away === 'string' && !!away.trim()
      && home.trim() !== away.trim() && Number.isFinite(kickoff);
    if (!validIdentity) { rejectedCount++; continue; }
    if (ids.has(match.id)) throw new FixtureSourceError('duplicate_fixture_id');
    ids.add(match.id);
    if (!['SCHEDULED', 'TIMED'].includes(match.status) || kickoff <= now || kickoff > until) continue;
    const lastUpdated = sourceUTC(match.lastUpdated);
    fixtures.push({
      id: `fd-${match.id}`, providerMatchId: match.id,
      league, home: home.trim(), away: away.trim(),
      kickoff: new Date(kickoff).toISOString(), status: match.status,
      source: 'football-data.org', sourceId: 'football-data.org',
      evidenceUrl: `https://api.football-data.org/v4/matches/${match.id}`,
      // updatedAt/fetchedAt describe this successful fetch, never kickoff time.
      updatedAt: checkedAt, fetchedAt: checkedAt,
      sourceUpdatedAt: Number.isFinite(lastUpdated) ? new Date(lastUpdated).toISOString() : null,
    });
  }
  return {fixtures, receivedCount: payload.matches.length, rejectedCount};
}

async function fetchLeague({league, apiKey, now, checkedAt, window, fetchImpl}) {
  const url = new URL(`https://api.football-data.org/v4/competitions/${league}/matches`);
  url.searchParams.set('dateFrom', window.dateFrom);
  url.searchParams.set('dateTo', window.dateTo);
  const common = {
    id: 'football-data.org', sourceId: 'football-data.org', league, url: url.href,
    checkedAt, window, checkType: 'official-api',
    capability: '五大联赛未来赛程；仅保留 SCHEDULED/TIMED，不提供盘口或预测。',
  };
  if (!apiKey) return {fixtures: [], diagnostic: {
    ...common, status: 'unavailable', note: 'authorization_required', fetchedAt: null,
    httpStatus: null, matchedCount: 0, receivedCount: null,
    reason: '缺少 FOOTBALL_DATA_API_KEY；需要 football-data.org 授权令牌。',
  }};
  const controller = new AbortController();
  let timer, httpStatus = null, responseAt = null;
  try {
    const operation = (async () => {
      const response = await fetchImpl(url.href, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: {'X-Auth-Token': apiKey, Accept: 'application/json', 'User-Agent': 'DimensionFootball-Collector/1.0'},
      });
      httpStatus = Number.isInteger(response?.status) ? response.status : null;
      if (!response?.ok) throw new FixtureSourceError(
        httpStatus === 401 ? 'authorization_required' : httpStatus === 403 ? 'access_denied'
          : httpStatus === 429 ? 'rate_limited' : 'http_unavailable', httpStatus);
      const responseTime = Date.parse(response.headers?.get('date'));
      responseAt = Number.isFinite(responseTime) ? new Date(responseTime).toISOString() : null;
      if (!Number.isFinite(responseTime) || Math.abs(now - responseTime) > 300000) {
        throw new FixtureSourceError('stale_response', httpStatus);
      }
      return normalizeMatches(await readJSON(response), league, checkedAt, now, Date.parse(window.to));
    })();
    const result = await Promise.race([operation, new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new FixtureSourceError('timeout', httpStatus));
      }, DEADLINE_MS);
    })]);
    return {fixtures: result.fixtures, diagnostic: {
      ...common, status: result.rejectedCount ? 'partial' : result.fixtures.length ? 'available' : 'complete',
      note: result.fixtures.length ? `matched_${result.fixtures.length}` : 'no_upcoming_fixtures',
      fetchedAt: checkedAt, responseAt, httpStatus, matchedCount: result.fixtures.length,
      receivedCount: result.receivedCount, rejectedCount: result.rejectedCount,
    }};
  } catch (error) {
    return {fixtures: [], diagnostic: {
      ...common, status: 'unavailable', note: error?.code || 'network_unavailable',
      fetchedAt: checkedAt, responseAt, httpStatus: error?.httpStatus ?? httpStatus,
      matchedCount: 0, receivedCount: null,
    }};
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Fetch each league once; one failure does not discard another league's data. */
export async function fetchFootballFixtures({apiKey = '', nowISO = new Date().toISOString(), fetchImpl = fetch, days = 7} = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now) || typeof fetchImpl !== 'function' || !Number.isInteger(days) || days < 1 || days > 14) {
    throw new TypeError('Invalid fixture request: days must be an integer from 1 to 14');
  }
  if (typeof apiKey !== 'string' || apiKey.length > 256 || /[\r\n]/.test(apiKey)) throw new TypeError('Invalid fixture API key');
  const checkedAt = new Date(now).toISOString(), window = fixtureWindow(now, days);
  const results = await Promise.all(fixtureLeagues.map(league => fetchLeague({
    league, apiKey: apiKey.trim(), now, checkedAt, window, fetchImpl,
  })));
  const fixtures = results.flatMap(result => result.fixtures).sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.id.localeCompare(b.id));
  if (fixtures.length > MAX_FIXTURES) throw new RangeError('Fixture limit exceeded (3000); data was not truncated');
  return {fixtures, diagnostics: results.map(result => result.diagnostic), window, checkedAt};
}
