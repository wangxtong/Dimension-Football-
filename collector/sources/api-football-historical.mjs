import { createHash } from 'node:crypto';
import { apiFootballLeagues } from './api-football.mjs';

// Authorized, bounded, research-only backfill. This is a new optional source
// adapter; it is NOT wired to production scheduling or a publication surface.
const MAX_BYTES = 2_000_000;
const FETCH_DEADLINE_MS = 6000;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const integer = v => Number.isSafeInteger(v) && v >= 0 && v <= 30;
const utc = v => typeof v === 'string' && Number.isFinite(Date.parse(v))
  && /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(v);
const date = v => typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)
  && Number.isFinite(Date.parse(v + 'T00:00:00Z'))
  && new Date(Date.parse(v + 'T00:00:00Z')).toISOString().slice(0, 10) === v;

function failure(code, status = null) {
  const err = new Error(code); err.code = code; err.httpStatus = status; return err;
}
function requestWindow({ league, season, from, to, nowISO }) {
  const first = Date.parse(from + 'T00:00:00Z');
  const last = Date.parse(to + 'T00:00:00Z');
  const now = Date.parse(nowISO);
  if (!Object.hasOwn(apiFootballLeagues, league) || !Number.isInteger(season)
    || season < 2000 || season > 2030 || !date(from) || !date(to)
    || first > last || last - first > 31 * 86_400_000 || !utc(nowISO)
    || !Number.isFinite(now) || first > now
    || Number(from.slice(0, 4)) < season
    || Number(to.slice(0, 4)) > season + 1) throw failure('INVALID_HISTORICAL_WINDOW');
  return { from, to, nowISO: new Date(now).toISOString() };
}
async function limitedBytes(response) {
  if (Number(response.headers?.get('content-length')) > MAX_BYTES) throw failure('HISTORY_RESPONSE_TOO_LARGE', response.status);
  let count = 0; const parts = [];
  const reader = response.body?.getReader?.();
  if (!reader) throw failure('HISTORY_BODY_UNREADABLE', response.status);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw failure('HISTORY_BODY_UNREADABLE', response.status);
      count += value.byteLength;
      if (count > MAX_BYTES) throw failure('HISTORY_RESPONSE_TOO_LARGE', response.status);
      parts.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  if (!count) throw failure('HISTORY_EMPTY_BODY', response.status);
  const raw = Buffer.allocUnsafe(count); let offset = 0;
  for (const part of parts) { raw.set(part, offset); offset += part.length; }
  return raw;
}

/** Inspect the actual acquired bytes, retaining every rejected row in the raw hash. */
export function parseApiFootballHistoricalSnapshot(rawBytes, { league, season, from, to, nowISO, responseAt,
  requestStartedAt = null, httpStatus = 200 }) {
  requestWindow({ league, season, from, to, nowISO });
  if (!utc(responseAt) || httpStatus !== 200
    || requestStartedAt !== null && (!utc(requestStartedAt) || Date.parse(requestStartedAt) > Date.parse(nowISO))
    || Math.abs(Date.parse(responseAt) - Date.parse(nowISO)) > 300_000)
    throw failure('HISTORY_TIME_UNVERIFIED');
  if (!(rawBytes instanceof Uint8Array) || rawBytes.byteLength < 2 || rawBytes.byteLength > MAX_BYTES) throw failure('HISTORY_RAW_INVALID');
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)); }
  catch { throw failure('HISTORY_JSON_INVALID'); }
  if (body?.get !== 'fixtures' || !Array.isArray(body.response)
    || !body.errors || typeof body.errors !== 'object' || Array.isArray(body.errors) && body.errors.length > 0
    || !Array.isArray(body.errors) && Object.keys(body.errors).length > 0) throw failure('HISTORY_PROVIDER_ERROR');
  if (body.response.length > 200 || body.results !== body.response.length
    || body.paging?.current !== 1 || body.paging?.total !== 1) throw failure('HISTORY_INCOMPLETE_PAGE');
  const rawSha256 = sha256(rawBytes);
  const records = []; const exclusions = []; const seen = new Set();
  for (const [index, item] of body.response.entries()) {
    const f = item?.fixture, teams = item?.teams;
    const start = Date.parse(f?.date);
    const valid = Number.isSafeInteger(f?.id) && f.id > 0
      && Number.isSafeInteger(f?.timestamp) && f.timestamp * 1000 === start
      && utc(f.date) && Number.isFinite(start)
      && start <= Date.parse(nowISO) && f.date.slice(0, 10) >= from && f.date.slice(0, 10) <= to
      && item?.league?.id === apiFootballLeagues[league] && item.league.season === season
      && Number.isSafeInteger(teams?.home?.id) && teams.home.id > 0
      && Number.isSafeInteger(teams?.away?.id) && teams.away.id > 0 && teams.home.id !== teams.away.id
      && typeof teams.home.name === 'string' && !!teams.home.name.trim()
      && typeof teams.away.name === 'string' && !!teams.away.name.trim();
    if (!valid || seen.has(f?.id)) { exclusions.push({ index, reason: 'INVALID_OR_DUPLICATE_IDENTITY' }); continue; }
    seen.add(f.id);
    const score = item?.score?.fulltime;
    if (f.status?.short !== 'FT') { exclusions.push({ index, fixtureId: f.id, reason: 'NOT_REGULAR_TIME_FT' }); continue; }
    if (!integer(score?.home) || !integer(score?.away)
      || item.goals?.home != null && item.goals.home !== score.home
      || item.goals?.away != null && item.goals.away !== score.away) {
      exclusions.push({ index, fixtureId: f.id, reason: 'FT_SCORE_UNVERIFIED' }); continue;
    }
    records.push({
      source: 'api-football', league, season, fixtureId: f.id,
      homeTeamId: teams.home.id, awayTeamId: teams.away.id,
      homeName: teams.home.name.trim(), awayName: teams.away.name.trim(),
      kickoffUTC: new Date(start).toISOString(), ftHome: score.home, ftAway: score.away,
      status: 'FT', sourceObservedAt: new Date(Date.parse(nowISO)).toISOString(),
      sourceUpdatedAt: null, actualPregameVisibleAt: null, historicalBackfill: true,
      sourceSnapshotSha256: rawSha256, modelReadyForProspective: false,
    });
  }
  return {
    kind: 'api-football-bounded-retrospective-history', version: 1,
    source: 'api-football', league, season, window: { from, to },
    // Fetched/observed means the response body was fully received, not the initial request clock.
    sourceFetchedAt: new Date(Date.parse(nowISO)).toISOString(),
    sourceRequestStartedAt: requestStartedAt === null ? null : new Date(Date.parse(requestStartedAt)).toISOString(),
    httpStatus, responseAt: new Date(Date.parse(responseAt)).toISOString(),
    rawSha256, rawBytes: rawBytes.byteLength, rawBody: Buffer.from(rawBytes),
    received: body.response.length, acceptedFT: records.length, excluded: exclusions.length,
    records, exclusions, modelReadyForProspective: false, releaseGate: 'BLOCKED',
  };
}

/** Exactly one API request for one bounded month; caller persists RAW bytes append-only. */
export async function fetchApiFootballHistoricalMonth({ league, season, from, to,
  nowISO = new Date().toISOString(), apiKey = '', fetchImpl = fetch,
  clock = () => new Date().toISOString() } = {}) {
  const window = requestWindow({ league, season, from, to, nowISO });
  if (typeof apiKey !== 'string' || apiKey.length > 256 || /[\r\n]/.test(apiKey)) throw failure('HISTORY_API_KEY_INVALID');
  if (typeof fetchImpl !== 'function') throw failure('HISTORY_FETCH_INVALID');
  if (typeof clock !== 'function') throw failure('HISTORY_CLOCK_INVALID');
  const url = new URL('https://v3.football.api-sports.io/fixtures');
  url.searchParams.set('league', String(apiFootballLeagues[league]));
  url.searchParams.set('season', String(season));
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  url.searchParams.set('timezone', 'UTC');
  if (!apiKey.trim()) return { status: 'NOT_RUN', reason: 'AUTHENTICATED_EXECUTION_REQUIRED',
    source: 'api-football', league, season, window: { from, to }, requestAttempted: false };
  const controller = new AbortController(); let timer;
  try {
    const task = (async () => {
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'x-apisports-key': apiKey.trim(), Accept: 'application/json' } });
      if (!response?.ok) throw failure(response?.status === 401 ? 'HISTORY_AUTH_REQUIRED'
        : response?.status === 403 ? 'HISTORY_PLAN_DENIED'
          : response?.status === 429 ? 'HISTORY_RATE_LIMITED' : 'HISTORY_HTTP_UNAVAILABLE', response?.status);
      const serverTime = Date.parse(response.headers?.get('date'));
      if (!Number.isFinite(serverTime)) throw failure('HISTORY_SERVER_TIME_UNVERIFIED');
      const raw = await limitedBytes(response);
      // Never stamp a RAW body with a request-start timestamp. The completion clock
      // is acquired only after the stream finishes and the original bytes exist.
      const completedAt = clock();
      const startMillis = Date.parse(window.nowISO), completedMillis = Date.parse(completedAt);
      if (!utc(completedAt) || !Number.isFinite(completedMillis)
        || completedMillis < startMillis || completedMillis - startMillis > 60_000)
        throw failure('HISTORY_OBSERVATION_CLOCK_INVALID');
      if (Math.abs(serverTime - completedMillis) > 300_000)
        throw failure('HISTORY_SERVER_TIME_UNVERIFIED');
      return parseApiFootballHistoricalSnapshot(raw, {
        ...window, nowISO: new Date(completedMillis).toISOString(),
        requestStartedAt: window.nowISO, httpStatus: response.status, league, season,
        responseAt: new Date(serverTime).toISOString(),
      });
    })();
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(failure('HISTORY_TIMEOUT')); }, FETCH_DEADLINE_MS);
    })]);
  } catch (error) {
    // Only the bounded status code is preserved, never provider error bodies or headers.
    throw failure(error?.code?.startsWith('HISTORY_') ? error.code : 'HISTORY_NETWORK_UNAVAILABLE',
      Number.isInteger(error?.httpStatus) ? error.httpStatus : null);
  } finally { clearTimeout(timer); controller.abort(); }
}
