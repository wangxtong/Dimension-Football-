import { acquireLock, atomicJson, readJson } from '../storage.mjs';
import { fetchFootballFixtures, fixtureLeagues } from './fixtures.mjs';
import { fetchApiFootballFixtures } from './api-football.mjs';
import { fetchSportmonksFixtures } from './sportmonks.mjs';
import { FAILURE_CODES } from './health.mjs';

export const SOURCE_REGISTRY = Object.freeze({
  'football-data.org': { capability: 'fixtures', independenceGroup: 'football-data.org',
    origin: 'https://api.football-data.org', fallback: 'api-football' },
  'api-football': { capability: 'fixtures', independenceGroup: 'api-football',
    origin: 'https://v3.football.api-sports.io', fallback: 'football-data.org' },
  sportmonks: { capability: 'fixtures', independenceGroup: 'sportmonks',
    origin: 'https://api.sportmonks.com', fallback: 'football-data.org' },
});
const ADAPTERS = { 'football-data.org': fetchFootballFixtures, 'api-football': fetchApiFootballFixtures, sportmonks: fetchSportmonksFixtures };
const IDS = Object.keys(SOURCE_REGISTRY), DAY = 86_400_000;
const OK = new Set(['available', 'complete']);
export const DEFAULT_SOURCE_POLICY = Object.freeze({ version: 1,
  fixturePriority: Object.freeze([...IDS]), failureThreshold: 2, cooldownMs: 300_000,
  maxCooldownMs: 3_600_000, authCooldownMs: 21_600_000, quotaCooldownMs: DAY });

export function readSourcePolicy(value) {
  const fail = () => { throw new Error('INVALID_SOURCE_POLICY'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_SOURCE_POLICY, key))) fail();
  const p = { ...DEFAULT_SOURCE_POLICY, ...value };
  if (p.version !== 1 || !Array.isArray(p.fixturePriority) || !p.fixturePriority.length
    || p.fixturePriority.length > IDS.length || new Set(p.fixturePriority).size !== p.fixturePriority.length
    || p.fixturePriority.some(id => !IDS.includes(id))) fail();
  if (!Number.isInteger(p.failureThreshold) || p.failureThreshold < 1 || p.failureThreshold > 10) fail();
  for (const key of ['cooldownMs', 'maxCooldownMs', 'authCooldownMs', 'quotaCooldownMs']) {
    if (!Number.isSafeInteger(p[key]) || p[key] < 60_000 || p[key] > DAY) fail();
  }
  if (p.maxCooldownMs < p.cooldownMs) fail();
  return { ...p, fixturePriority: [...p.fixturePriority] };
}

const validTime = value => value === null || typeof value === 'string'
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const emptyState = () => ({ version: 1, sources: {}, lastSelectedSource: null, events: [] });
const states = new Set(['healthy', 'degraded', 'unavailable']);
const codes = new Set([...FAILURE_CODES, 'ok', 'partial_coverage', 'cooldown', 'not_configured',
  'cancelled', 'budget_exhausted']);

// Fail closed on damaged state; silently resetting it would bypass quota cooldowns.
export async function readSourceHealth(path) {
  let value;
  try { value = await readJson(path, 256_000); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error('SOURCE_STATE_UNREADABLE'); }
  const fail = () => { throw new Error('SOURCE_STATE_INVALID'); };
  if (value?.version !== 1 || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)
    || Object.keys(value.sources).some(id => !IDS.includes(id))
    || !(value.lastSelectedSource === null || IDS.includes(value.lastSelectedSource))
    || !Array.isArray(value.events) || value.events.length > 50) fail();
  const clean = emptyState();
  clean.lastSelectedSource = value.lastSelectedSource;
  for (const [id, entry] of Object.entries(value.sources)) {
    if (!entry || !states.has(entry.status) || !codes.has(entry.code)
      || !Number.isInteger(entry.consecutiveFailures) || entry.consecutiveFailures < 0 || entry.consecutiveFailures > 100
      || !Number.isInteger(entry.healthyLeagues) || entry.healthyLeagues < 0 || entry.healthyLeagues > 5
      || !['lastCheckedAt', 'lastSuccessAt', 'nextProbeAt'].every(key => validTime(entry[key]))
      || !entry.lastCheckedAt) fail();
    clean.sources[id] = Object.fromEntries(['status', 'code', 'consecutiveFailures', 'healthyLeagues',
      'lastCheckedAt', 'lastSuccessAt', 'nextProbeAt'].map(key => [key, entry[key]]));
  }
  for (const event of value.events) {
    if (!event || !event.checkedAt || !validTime(event.checkedAt)
      || ![event.from, event.to].every(id => id === null || IDS.includes(id))
      || !['initial', 'fallback', 'preferred', 'unavailable'].includes(event.reason)) fail();
    clean.events.push({ checkedAt: event.checkedAt, from: event.from, to: event.to, reason: event.reason });
  }
  return clean;
}

export function sourceHealthSnapshot(state, policy, nowISO) {
  return { version: 1, checkedAt: nowISO, lastSelectedSource: state.lastSelectedSource,
    sources: IDS.map(id => ({ id, ...SOURCE_REGISTRY[id], priority: policy.fixturePriority.indexOf(id) + 1,
      enabled: policy.fixturePriority.includes(id), ...(state.sources[id] || {
        status: 'unknown', code: 'not_checked', consecutiveFailures: 0, healthyLeagues: 0,
        lastCheckedAt: null, lastSuccessAt: null, nextProbeAt: null }),
      observationAgeMs: state.sources[id]?.lastCheckedAt
        ? Math.max(0, Date.parse(nowISO) - Date.parse(state.sources[id].lastCheckedAt)) : null,
      circuit: Date.parse(state.sources[id]?.nextProbeAt) > Date.parse(nowISO) ? 'open' : 'closed' })),
    events: structuredClone(state.events) };
}

function summarize(result) {
  const rows = result.diagnostics;
  if (!Array.isArray(result.fixtures) || !Array.isArray(rows) || rows.length !== 5
    || new Set(rows.map(row => row.league)).size !== 5
    || rows.some(row => !fixtureLeagues.includes(row.league))) throw new Error('INVALID_ADAPTER_RESULT');
  const healthyLeagues = rows.filter(row => OK.has(row.status)).length;
  const partialLeagues = rows.filter(row => row.status === 'partial').length;
  const status = healthyLeagues === 5 ? 'healthy' : healthyLeagues + partialLeagues ? 'degraded' : 'unavailable';
  const failures = rows.filter(row => !OK.has(row.status));
  const notes = failures.map(row => row.note || row.code);
  // Actionable failures take precedence over generic transport/schema errors.
  const code = ['quota_exceeded', 'rate_limited', 'authorization_required', 'access_denied', 'plan_restricted', 'subscription_required', 'invalid_credentials']
    .find(code => notes.includes(code)) || notes.find(code => FAILURE_CODES.has(code))
    || (status === 'healthy' ? 'ok' : status === 'degraded' ? 'partial_coverage' : 'source_unavailable');
  return { status, code, healthyLeagues, score: healthyLeagues * 10 + partialLeagues,
    retryMs: Math.max(0, ...failures.map(row => Number.isSafeInteger(row.retryAfterMs)
      && row.retryAfterMs > 0 ? Math.min(row.retryAfterMs, DAY) : 0)) };
}

function observe(state, id, summary, policy, nowISO) {
  const previous = state.sources[id];
  // A plan lacking one league must not suppress the provider's four good leagues.
  const consecutiveFailures = summary.status === 'unavailable' ? Math.min(100, (previous?.consecutiveFailures || 0) + 1) : 0;
  let delay = 0;
  if (consecutiveFailures >= policy.failureThreshold) {
    delay = Math.min(policy.maxCooldownMs, policy.cooldownMs * 2 ** Math.min(16, consecutiveFailures - policy.failureThreshold));
  }
  if (summary.status === 'unavailable' && ['authorization_required', 'access_denied', 'plan_restricted', 'subscription_required', 'invalid_credentials'].includes(summary.code)) {
    delay = Math.max(delay, policy.authCooldownMs);
  }
  if (summary.code === 'quota_exceeded') delay = Math.max(delay, policy.quotaCooldownMs);
  if (summary.code === 'rate_limited') delay = Math.max(delay, 60_000);
  delay = Math.max(delay, summary.retryMs);
  state.sources[id] = { status: summary.status, code: summary.code, consecutiveFailures,
    healthyLeagues: summary.healthyLeagues, lastCheckedAt: nowISO,
    lastSuccessAt: summary.status === 'healthy' ? nowISO : previous?.lastSuccessAt || null,
    nextProbeAt: delay ? new Date(Date.parse(nowISO) + delay).toISOString() : null };
}

/** One bounded round; Sportmonks has bounded pagination. Never merge provider IDs. */
export async function collectManagedFixtures({ statePath, credentials, policy = DEFAULT_SOURCE_POLICY,
  nowISO, clock = () => new Date().toISOString(), days = 7, fetchImpl = fetch,
  requiredSource = null, signal, remaining = () => Infinity }) {
  policy = readSourcePolicy(policy);
  nowISO = new Date(nowISO).toISOString();
  if (requiredSource !== null && !IDS.includes(requiredSource)) throw new Error('INVALID_SOURCE_POLICY');
  const priority = requiredSource ? [requiredSource] : policy.fixturePriority;
  if (requiredSource && !policy.fixturePriority.includes(requiredSource)) throw new Error('REQUIRED_SOURCE_DISABLED');
  if (!priority.some(id => typeof credentials[id] === 'string' && credentials[id].trim())) {
    throw new Error('FIXTURE_API_KEY_OR_INPUT_REQUIRED');
  }
  const release = await acquireLock(statePath);
  try {
    const state = await readSourceHealth(statePath), attempts = [];
    let selected = null, interrupted = null;
    for (const id of priority) {
      if (signal?.aborted || remaining() <= 0) {
        interrupted = signal?.aborted ? 'cancelled' : 'budget_exhausted';
        break;
      }
      const checkedAt = new Date(clock()).toISOString();
      if (typeof credentials[id] !== 'string' || !credentials[id].trim()) {
        attempts.push({ id, status: 'skipped', code: 'not_configured', checkedAt }); continue;
      }
      if (Date.parse(state.sources[id]?.nextProbeAt) > Date.parse(checkedAt)) {
        attempts.push({ id, status: 'skipped', code: 'cooldown', checkedAt,
          nextProbeAt: state.sources[id].nextProbeAt }); continue;
      }
      const started = performance.now();
      let result, summary;
      try {
        result = await ADAPTERS[id]({ apiKey: credentials[id], nowISO: checkedAt, days, fetchImpl, clock, signal, remaining });
        summary = summarize(result);
      } catch {
        result = { fixtures: [], diagnostics: fixtureLeagues.map(league => ({ id, league,
          status: 'unavailable', note: 'source_unavailable', checkedAt })) };
        summary = summarize(result);
      }
      // Local cancellation / budget is not evidence of provider failure.
      if (signal?.aborted || remaining() <= 0) {
        interrupted = signal?.aborted ? 'cancelled' : 'budget_exhausted';
        attempts.push({ id, status: 'interrupted', code: interrupted, checkedAt }); break;
      }
      // Cooldowns start after the request ends, not before slow network I/O.
      const completedAt = new Date(clock()).toISOString();
      observe(state, id, summary, policy, completedAt);
      attempts.push({ id, status: summary.status, code: summary.code, checkedAt: completedAt,
        healthyLeagues: summary.healthyLeagues, fixtureCount: result.fixtures.length,
        latencyMs: Math.max(0, Math.round(performance.now() - started)), nextProbeAt: state.sources[id].nextProbeAt,
        leagues: result.diagnostics.map(row => ({ league: row.league,
          status: OK.has(row.status) ? 'complete' : row.status === 'partial' ? 'partial' : 'unavailable',
          code: OK.has(row.status) ? 'ok' : FAILURE_CODES.has(row.note || row.code) ? row.note || row.code : 'invalid_records',
          httpStatus: Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599 ? row.httpStatus : null })) });
      await atomicJson(statePath, state);
      if (summary.score > 0 && (!selected || summary.score > selected.summary.score)) selected = { id, result, summary };
      if (summary.status === 'healthy') break;
    }
    const selectedSource = selected?.id || null, previousSource = state.lastSelectedSource;
    if (!interrupted && previousSource !== selectedSource) {
      const reason = !selectedSource ? 'unavailable' : selectedSource !== priority[0] ? 'fallback'
        : previousSource ? 'preferred' : 'initial';
      state.events = [...state.events.slice(-49), { checkedAt: new Date(clock()).toISOString(), from: previousSource, to: selectedSource, reason }];
      state.lastSelectedSource = selectedSource;
    }
    await atomicJson(statePath, state);
    const diagnostics = selected?.result.diagnostics || [{ id: 'fixture-sources', status: 'unavailable',
      code: interrupted || 'NO_USABLE_FIXTURE_SOURCE', checkedAt: nowISO }];
    return { fixtures: selected?.result.fixtures || [], diagnostics,
      poolComplete: selected?.summary.status === 'healthy',
      management: { ...sourceHealthSnapshot(state, policy, new Date(clock()).toISOString()),
        mode: requiredSource ? 'provider-pinned' : 'automatic-failover', requiredSource, selectedSource,
        fallbackUsed: !!selectedSource && selectedSource !== priority[0], interrupted, attempts } };
  } finally { await release(); }
}

/** Public evidence has no verified interchangeable backup yet. Monitor without inventing one. */
export function publicSourceHealth(diagnostics = []) {
  return ['titan007', 'statarea', 'tiantian'].map(id => {
    const rows = diagnostics.filter(row => (row.sourceId || row.id) === id);
    const bad = rows.some(row => ['unavailable', 'failed', 'restricted'].includes(row.status));
    return { id, independenceGroup: id,
      capability: id === 'titan007' ? 'asian-handicap' : id === 'statarea' ? '1x2-signal' : 'monitor-only',
      status: !rows.length ? 'not_checked' : bad ? 'degraded' : rows.some(row => row.status === 'available') ? 'available' : 'pending',
      checkedAt: rows.find(row => validTime(row.checkedAt) && row.checkedAt)?.checkedAt || null,
      automaticFallback: false, reason: 'NO_VERIFIED_COMPATIBLE_BACKUP' };
  });
}
