import { FAILURE_CODES, retryAfterMs } from './health.mjs';

// Fixed destinations: credentials must never follow a redirect or a next_page URL.
export const PROVIDER_ORIGINS = Object.freeze({
  sportmonks: 'https://api.sportmonks.com',
  'the-odds-api': 'https://api.the-odds-api.com',
  isports: 'https://api.isportsapi.com',
});
export class ProviderError extends Error {
  constructor(code, httpStatus = null, retryMs = null) {
    super(code); this.code = code; this.httpStatus = httpStatus; this.retryAfterMs = retryMs;
  }
}

export const ACCOUNT_FAILURES = new Set(['authorization_required', 'invalid_credentials', 'subscription_required', 'rate_limited']);
export const LOCAL_FAILURES = new Set(['cancelled', 'budget_exhausted', 'request_limit']);

// A complete league is the commit boundary. A later league's entitlement or
// schema failure cannot erase data already verified for another competition.
export async function collectProviderLeagues({ provider, leagues, nowISO, clock = () => nowISO, leagueHealth = {}, collect }) {
  const result = { observations: [], signals: [], diagnostics: [] };
  let stopped;
  for (const league of leagues) {
    const nextProbeAt = leagueHealth[league]?.nextProbeAt;
    if (Date.parse(nextProbeAt) > Date.parse(clock())) {
      result.diagnostics.push({ id: provider, sourceId: provider, league, checkedAt: clock(), status: 'unavailable',
        code: 'cooldown', nextProbeAt, matchedCount: 0, requestAttempted: false });
      continue;
    }
    try {
      if (stopped) throw stopped;
      const part = await collect(league);
      result.observations.push(...part.observations); result.signals.push(...part.signals); result.diagnostics.push(...part.diagnostics);
    } catch (error) {
      const code = error instanceof ProviderError && FAILURE_CODES.has(error.code) ? error.code : 'invalid_response';
      result.diagnostics.push({ id: provider, sourceId: provider, league, checkedAt: clock(), status: 'unavailable', code,
        httpStatus: error instanceof ProviderError ? error.httpStatus : null,
        retryAfterMs: error instanceof ProviderError ? error.retryAfterMs : null, matchedCount: 0, requestAttempted: !stopped });
      if (ACCOUNT_FAILURES.has(code) || LOCAL_FAILURES.has(code)) stopped = error;
    }
  }
  return result;
}
export function credential(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x20\x7f]/u.test(value.trim())) {
    throw new ProviderError('invalid_credentials');
  }
  return value.trim();
}
export function createProviderClient({ provider, apiKey, fetchImpl = fetch, nowISO,
  clock = () => nowISO, signal, maxRequests = 30, timeoutMs = 6000, remaining = () => Infinity }) {
  const key = credential(apiKey), origin = Object.hasOwn(PROVIDER_ORIGINS, provider) ? PROVIDER_ORIGINS[provider] : null;
  if (!origin) throw new ProviderError('invalid_provider');
  let requests = 0, successfulResponses = 0, failedResponses = 0;
  return {
    get requests() { return requests; },
    get transportStatus() { return !requests ? 'unknown' : successfulResponses === requests ? 'healthy'
      : successfulResponses ? 'degraded' : 'unavailable'; },
    get responseCounts() { return { successful: successfulResponses, failed: failedResponses }; },
    async get(path, params = {}) {
      if (!key) throw new ProviderError('not_configured');
      if (signal?.aborted) throw new ProviderError('cancelled');
      if (remaining() <= 0) throw new ProviderError('budget_exhausted');
      if (requests >= maxRequests) throw new ProviderError('request_limit');
      if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/u.test(path)) throw new ProviderError('invalid_endpoint');
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new ProviderError('invalid_endpoint');
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
      const headers = { Accept: 'application/json', 'User-Agent': 'DimensionFootball-Collector/1.0' };
      if (provider === 'sportmonks') headers.Authorization = key;
      else url.searchParams.set(provider === 'isports' ? 'api_key' : 'apiKey', key);
      requests++;
      const controller = new AbortController();
      const joined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      let timer, status = null;
      try {
        const operation = (async () => {
          const response = await fetchImpl(url.href, { method: 'GET', headers, redirect: 'manual', signal: joined });
          status = response.status;
          if (response.ok) successfulResponses++; else failedResponses++;
          const now = Date.parse(clock());
          if (!response.ok) {
            await response.body?.cancel?.().catch(() => {});
            throw new ProviderError(status === 401 ? 'authorization_required' : status === 402 ? 'subscription_required'
              : status === 403 ? 'plan_restricted' : status === 429 ? 'rate_limited'
                : status >= 300 && status < 400 ? 'redirect_blocked' : 'http_unavailable', status,
            retryAfterMs(response.headers?.get('retry-after'), now));
          }
          const responseAt = Date.parse(response.headers?.get('date'));
          if (!Number.isFinite(responseAt) || Math.abs(now - responseAt) > 300_000) {
            await response.body?.cancel?.().catch(() => {}); throw new ProviderError('stale_response', status);
          }
          if (Number(response.headers?.get('content-length')) > 2_000_000) {
            await response.body?.cancel?.().catch(() => {}); throw new ProviderError('response_too_large', status);
          }
          const reader = response.body?.getReader();
          if (!reader) throw new ProviderError('invalid_response', status);
          let bytes = 0, text = ''; const decoder = new TextDecoder();
          try {
            for (;;) {
              const chunk = await reader.read(); if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > 2_000_000) throw new ProviderError('response_too_large', status);
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally { await reader.cancel().catch(() => {}); }
          let data;
          try { data = JSON.parse(text); } catch { throw new ProviderError('invalid_json', status); }
          return { data, httpStatus: status, responseAt: new Date(responseAt).toISOString(), fetchedAt: new Date(clock()).toISOString() };
        })();
        return await Promise.race([operation, new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new ProviderError('timeout', status)); },
            Math.max(1, Math.min(timeoutMs, remaining())));
        }), new Promise((_, reject) => {
          if (signal?.aborted) reject(new ProviderError('cancelled', status));
          else signal?.addEventListener('abort', () => reject(new ProviderError('cancelled', status)), { once: true, signal: controller.signal });
        })]);
      } catch (error) {
        if (signal?.aborted) throw new ProviderError('cancelled', status);
        if (remaining() <= 0) throw new ProviderError('budget_exhausted', status);
        if (error instanceof ProviderError) throw error;
        // A fetch exception may contain a URL including apiKey. Never propagate it.
        throw new ProviderError('network_unavailable', status);
      } finally { clearTimeout(timer); controller.abort(); }
    },
  };
}
