import { acquireLock, atomicJson, readJson } from '../storage.mjs';
import { createProviderClient, credential, ProviderError } from './provider-http.mjs';
import { fetchSportmonksEvidence } from './sportmonks.mjs';
import { fetchOddsApiEvidence } from './odds-api.mjs';
import { fetchIsportsEvidence } from './isports.mjs';
import { diagnostic } from './provider-utils.mjs';

export const PROVIDER_CATALOG = Object.freeze([
  { id: 'sportmonks', name: 'Sportmonks', env: 'SPORTMONKS_API_TOKEN', implemented: true,
    capabilities: ['fixtures', 'prematch-1x2-model'], setupUrl: 'https://my.sportmonks.com/', requirement: 'Football API + Predictions add-on' },
  { id: 'the-odds-api', name: 'The Odds API', env: 'THE_ODDS_API_KEY', implemented: true,
    capabilities: ['prematch-market-reference'], setupUrl: 'https://the-odds-api.com/', requirement: 'API key and sufficient credits' },
  { id: 'isports', name: 'iSports API', env: 'ISPORTS_API_KEY', implemented: true,
    capabilities: ['today-asian-handicap-reference'], setupUrl: 'https://www.isportsapi.com/', requirement: 'Live Data + Odds or Odds Pro' },
  { id: 'nami', name: '纳米数据', implemented: false, capabilities: ['contract-dependent'],
    setupUrl: 'https://www.nami.com/zh', requirement: '商务授权、接口协议、样本及交付主机尚待取得' },
  { id: 'opta', name: 'Opta', implemented: false, capabilities: ['contract-dependent'],
    setupUrl: 'https://www.statsperform.com/', requirement: '商业合同、具体产品和接口样本尚待取得' },
  { id: 'sportradar', name: 'Sportradar', implemented: false, capabilities: ['contract-dependent'],
    setupUrl: 'https://developer.sportradar.com/', requirement: '具体 Soccer / Probabilities 产品权限和样本尚待取得' },
  { id: 'lsports', name: 'LSports', implemented: false, capabilities: ['contract-dependent'],
    setupUrl: 'https://www.lsports.eu/odds-feed/', requirement: '交付协议、上游关系和数据使用权尚待取得' },
  { id: 'txodds', name: 'TXODDS', implemented: false, capabilities: ['contract-dependent'],
    setupUrl: 'https://txodds.net/', requirement: '交付协议、上游关系和数据使用权尚待取得' },
]);
const ADAPTERS = { sportmonks: fetchSportmonksEvidence, 'the-odds-api': fetchOddsApiEvidence, isports: fetchIsportsEvidence };
const IDS = Object.keys(ADAPTERS);
export const DEFAULT_PROVIDER_POLICY = Object.freeze({ version: 1, enabled: Object.freeze(IDS), maxRequestsPerProvider: 30,
  maxPages: 10, oddsRegions: 'eu', failureCooldownMs: 300000, maxCooldownMs: 3600000, authCooldownMs: 21600000 });
export function readProviderPolicy(input = {}) {
  const fail = () => { throw new Error('INVALID_PROVIDER_POLICY'); };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(DEFAULT_PROVIDER_POLICY, k))) fail();
  const p = { ...DEFAULT_PROVIDER_POLICY, ...input };
  if (p.version !== 1 || !Array.isArray(p.enabled) || p.enabled.some(id => !IDS.includes(id)) || new Set(p.enabled).size !== p.enabled.length
    || !['eu', 'uk', 'us', 'au'].includes(p.oddsRegions)) fail();
  for (const [key, min, max] of [['maxRequestsPerProvider', 1, 100], ['maxPages', 1, 20],
    ['failureCooldownMs', 60000, 86400000], ['maxCooldownMs', 60000, 86400000], ['authCooldownMs', 60000, 86400000]]) {
    if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > max) fail();
  }
  if (p.maxCooldownMs < p.failureCooldownMs) fail();
  return { ...p, enabled: [...p.enabled] };
}
const CODES = new Set(['ok', 'partial_coverage', 'invalid_credentials', 'authorization_required', 'subscription_required', 'plan_restricted',
  'rate_limited', 'redirect_blocked', 'http_unavailable', 'stale_response', 'response_too_large', 'invalid_json',
  'invalid_response', 'incomplete_response', 'duplicate_fixture_id', 'invalid_records', 'api_error', 'timeout', 'network_unavailable']);
const emptyState = () => ({ version: 1, sources: {} });
const iso = value => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export async function readProviderHealth(path) {
  let value;
  try { value = await readJson(path, 128000); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error('PROVIDER_STATE_UNREADABLE'); }
  const fail = () => { throw new Error('PROVIDER_STATE_INVALID'); };
  if (value?.version !== 1 || !value.sources || typeof value.sources !== 'object' || Array.isArray(value.sources)
    || Object.keys(value.sources).some(id => !IDS.includes(id))) fail();
  const clean = emptyState();
  for (const [id, row] of Object.entries(value.sources)) {
    if (!row || !['healthy', 'degraded', 'unavailable'].includes(row.status) || !CODES.has(row.code)
      || !Number.isInteger(row.failures) || row.failures < 0 || row.failures > 100
      || !row.lastCheckedAt || !iso(row.lastCheckedAt) || !iso(row.nextProbeAt)) fail();
    clean.sources[id] = Object.fromEntries(['status', 'code', 'failures', 'lastCheckedAt', 'nextProbeAt'].map(k => [k, row[k]]));
  }
  return clean;
}
export function providerStatus({ env = {}, state = emptyState(), policy = DEFAULT_PROVIDER_POLICY, nowISO }) {
  return PROVIDER_CATALOG.map(row => {
    const configured = !!(row.env && typeof env[row.env] === 'string' && env[row.env].trim());
    const health = state.sources[row.id] || null;
    return { ...row, configured, enabled: policy.enabled.includes(row.id), health,
      status: !row.implemented ? 'contract_required' : !policy.enabled.includes(row.id) ? 'disabled' : !configured ? 'not_configured'
        : Date.parse(health?.nextProbeAt) > Date.parse(nowISO) ? 'cooldown' : 'ready_to_check',
      observationAgeMs: health ? Math.max(0, Date.parse(nowISO) - Date.parse(health.lastCheckedAt)) : null };
  });
}

export async function collectProviderEvidence({ fixtures, nowISO, env = {}, statePath, policy = DEFAULT_PROVIDER_POLICY,
  fetchImpl = fetch, signal, clock = () => nowISO, remaining = () => Infinity }) {
  policy = readProviderPolicy(policy);
  const release = await acquireLock(statePath);
  try {
    const state = await readProviderHealth(statePath), observations = [], signals = [], diagnostics = [], attempts = [];
    for (const item of providerStatus({ env, state, policy, nowISO })) {
      if (item.status !== 'ready_to_check') {
        attempts.push({ id: item.id, status: item.status, requests: 0, nextProbeAt: item.health?.nextProbeAt ?? null }); continue;
      }
      if (signal?.aborted || remaining() <= 0) {
        attempts.push({ id: item.id, status: signal?.aborted ? 'cancelled' : 'budget_exhausted', requests: 0 }); continue;
      }
      let client;
      try {
        const key = credential(env[item.env]);
        client = createProviderClient({ provider: item.id, apiKey: key, nowISO, clock, fetchImpl, signal, remaining,
          maxRequests: policy.maxRequestsPerProvider });
        const result = await ADAPTERS[item.id]({ fixtures, nowISO, client, maxPages: policy.maxPages, regions: policy.oddsRegions });
        if (result.observations.length + observations.length > 10000) throw new ProviderError('response_too_large');
        observations.push(...result.observations); signals.push(...result.signals); diagnostics.push(...result.diagnostics);
        const partial = result.diagnostics.some(d => d.status === 'partial');
        if (client.requests) state.sources[item.id] = { status: partial ? 'degraded' : 'healthy', code: partial ? 'partial_coverage' : 'ok', failures: 0,
          lastCheckedAt: new Date(clock()).toISOString(), nextProbeAt: null };
        attempts.push({ id: item.id, status: !client.requests ? 'not_checked' : partial ? 'partial' : 'checked', requests: client.requests,
          observationCount: result.observations.length });
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'invalid_response';
        const interrupted = signal?.aborted || remaining() <= 0 || ['cancelled', 'budget_exhausted', 'request_limit'].includes(code);
        if (!interrupted) {
          const safeCode = CODES.has(code) ? code : 'invalid_response', failures = Math.min(100, (state.sources[item.id]?.failures || 0) + 1);
          const delay = ['authorization_required', 'subscription_required', 'plan_restricted', 'invalid_credentials'].includes(safeCode)
            ? policy.authCooldownMs : Math.min(policy.maxCooldownMs, policy.failureCooldownMs * 2 ** Math.min(10, failures - 1));
          const checkedAt = new Date(clock()).toISOString();
          state.sources[item.id] = { status: 'unavailable', code: safeCode, failures, lastCheckedAt: checkedAt,
            nextProbeAt: new Date(Date.parse(checkedAt) + Math.max(delay, error.retryAfterMs || 0)).toISOString() };
        }
        const safeCode = interrupted ? signal?.aborted ? 'cancelled' : remaining() <= 0 ? 'budget_exhausted' : code : CODES.has(code) ? code : 'invalid_response';
        diagnostics.push(diagnostic(item.id, nowISO, { status: 'unavailable', code: safeCode, httpStatus: error.httpStatus ?? null }));
        attempts.push({ id: item.id, status: safeCode, requests: client?.requests || 0, nextProbeAt: state.sources[item.id]?.nextProbeAt ?? null });
      }
      // No credential, body, URL query or arbitrary error crosses this boundary.
      await atomicJson(statePath, state);
    }
    return { quotes: [], signals, diagnostics,
      providers: { version: 1, checkedAt: nowISO, attempts, catalog: providerStatus({ env, state, policy, nowISO: clock() }), observations,
        marketUse: 'reference-only-until-upstream-and-opening-verification',
        historyMeaning: 'collection-snapshots-not-complete-provider-tick-history' } };
  } finally { await release(); }
}
