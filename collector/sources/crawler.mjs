import { acquireLock, atomicJson, readJson } from '../storage.mjs';
import { CRAWLER_AGENT, robotsPolicy } from './robots.mjs';
import { retryAfterMs } from './health.mjs';
import { browserResourceTarget } from '../browser-runtime/index.mjs';

const DAY = 86_400_000, BODY_LIMIT = 1_500_000, ROBOTS_LIMIT = 64_000;
const MACAU_ORIGIN = 'https://www.macauslot.com';
const ORIGINS = ['https://livestatic.titan007.com', 'https://www.statarea.com', 'https://www.ttyingqiu.com'];
export const CRAWLER_CODES = new Set(['robots_denied', 'robots_unavailable', 'access_challenge', 'authorization_required',
  'access_denied', 'rate_limited', 'http_unavailable', 'redirect_blocked', 'crawler_cooldown', 'crawler_budget_exhausted',
  'crawler_cancelled', 'crawler_timeout', 'crawler_response_too_large', 'crawler_network_unavailable',
  'crawler_target_denied', 'crawler_credentials_rejected', 'cache_validation_failed', 'crawl_delay_exceeds_budget']);
for (const code of ['browser_navigation_failed', 'browser_target_denied', 'browser_policy_required']) CRAWLER_CODES.add(code);
export const DEFAULT_CRAWLER_POLICY = Object.freeze({ version: 1, minIntervalMs: 300, requestTimeoutMs: 3000,
  maxRequests: 24, maxRetries: 1, retryDelayMs: 300, cacheTtlMs: 15_000, robotsTtlMs: 21_600_000, blockedCooldownMs: 3_600_000 });
const BOUNDS = { minIntervalMs: [100, 10_000], requestTimeoutMs: [100, 6000], maxRequests: [3, 100],
  maxRetries: [0, 2], retryDelayMs: [100, 2000], cacheTtlMs: [0, 30_000], robotsTtlMs: [60_000, DAY], blockedCooldownMs: [60_000, DAY] };
export function readCrawlerPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_CRAWLER_POLICY, key))) throw new Error('INVALID_CRAWLER_POLICY');
  const policy = { ...DEFAULT_CRAWLER_POLICY, ...value };
  if (policy.version !== 1 || Object.entries(BOUNDS).some(([key, [min, max]]) => !Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max)) throw new Error('INVALID_CRAWLER_POLICY');
  return policy;
}
export class CrawlerError extends Error {
  constructor(code, status = null) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new CrawlerError(code, status); };
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const emptyState = () => ({ version: 1, origins: {}, robots: {}, cache: {} });

// Capability allowlist: the crawler cannot become an arbitrary URL/credential proxy.
export function crawlerTarget(value, method = 'GET', body) {
  let url; try { url = new URL(value); } catch { fail('crawler_target_denied'); }
  // Deny this previously unadmitted origin before cached reads, robots or live HTTP.
  if (url.origin === MACAU_ORIGIN) fail('crawler_target_denied');
  if (url.username || url.password || url.hash || !ORIGINS.includes(url.origin)) fail('crawler_target_denied');
  let id;
  if (url.origin === ORIGINS[0] && method === 'GET'
    && /^\/vbsxml\/(bfdata_ut\.js|goal(17|24|31)\.xml)$/.test(url.pathname)
    && [...url.searchParams.keys()].every(key => key === 'r') && url.searchParams.getAll('r').length <= 1
    && (!url.search || /^\d{1,20}$/.test(url.searchParams.get('r') || ''))) id = 'titan007';
  if (url.origin === ORIGINS[1] && method === 'GET' && !url.search
    && /^\/predictions(?:\/date\/20\d{2}-\d{2}-\d{2}\/competition)?$/.test(url.pathname)) id = 'statarea';
  if (url.origin === ORIGINS[2] && url.pathname === '/query/hall/jdList' && method === 'POST' && !url.search
    && body === 'raceStatus=0&amountMode=3&sortType=10&raceType=1&gameId=0&pageNo=1&pageSize=30') id = 'tiantian';
  if (!id || method === 'GET' && body != null) fail('crawler_target_denied');
  return { id, origin: url.origin, url: url.href, key: url.origin + url.pathname, method,
    responseMaxBytes: BODY_LIMIT };
}

function safeHeaders(input) {
  const headers = new Headers(input);
  return Object.fromEntries(['date', 'last-modified', 'age', 'etag', 'content-type', 'cache-control', 'vary']
    .filter(key => headers.has(key) && headers.get(key).length <= 1024).map(key => [key, headers.get(key)]));
}

async function readCrawlerState(path) {
  let value;
  try { value = await readJson(path, 20_000_000); }
  catch (error) { if (error.code === 'ENOENT') return emptyState(); throw new Error('CRAWLER_STATE_UNREADABLE'); }
  const invalid = () => { throw new Error('CRAWLER_STATE_INVALID'); };
  if (value?.version !== 1 || ['origins', 'robots', 'cache'].some(key => !value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) invalid();
  const state = emptyState();
  for (const kind of ['origins', 'robots']) {
    for (const [origin, row] of Object.entries(value[kind])) {
      // Quarantine legacy denied-origin state without reviving its old cache.
      if (origin === MACAU_ORIGIN) continue;
      if (!ORIGINS.includes(origin) || !row || !timestamp(row.checkedAt)) invalid();
      if (kind === 'origins') {
        if (!(CRAWLER_CODES.has(row.code) || row.code === 'ok') || row.nextAllowedAt !== null && !timestamp(row.nextAllowedAt)) invalid();
        state.origins[origin] = { checkedAt: row.checkedAt, nextAllowedAt: row.nextAllowedAt, code: row.code };
      } else {
        if (typeof row.text !== 'string' || Buffer.byteLength(row.text) > ROBOTS_LIMIT) invalid();
        state.robots[origin] = { checkedAt: row.checkedAt, text: row.text };
      }
    }
  }
  if (Object.keys(value.cache).length > 12) invalid();
  for (const [key, entry] of Object.entries(value.cache)) {
    // Drop only the known blocked origin. Unknown other keys still fail closed.
    let parsed; try { parsed = new URL(key); } catch { invalid(); }
    if (parsed.origin === MACAU_ORIGIN) continue;
    let target;
    try { target = crawlerTarget(key); } catch { invalid(); }
    if (!entry || typeof entry.text !== 'string' || Buffer.byteLength(entry.text) > target.responseMaxBytes
      || !timestamp(entry.fetchedAt) || !entry.headers || typeof entry.headers !== 'object' || Array.isArray(entry.headers)) invalid();
    if (entry.engine !== undefined && !['http', 'crawlee-playwright'].includes(entry.engine)) invalid();
    state.cache[key] = { text: entry.text, headers: safeHeaders(entry.headers), fetchedAt: entry.fetchedAt, engine: entry.engine || 'http' };
  }
  return state;
}

function aborted(signal) { if (signal?.aborted) fail('crawler_cancelled'); }
function interruptible(promise, signal) {
  if (signal?.aborted) { promise.catch(() => {}); return Promise.reject(new CrawlerError('crawler_cancelled')); }
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new CrawlerError('crawler_cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
async function pause(ms, signal) {
  if (ms <= 0) { aborted(signal); return; }
  let timer;
  try { await interruptible(new Promise(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}
async function readText(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => {}); fail('crawler_response_too_large'); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > limit) fail('crawler_response_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}
function challenge(text, headers) {
  return headers.get('cf-mitigated') === 'challenge'
    || /(?:id=["']challenge-form|\/cdn-cgi\/challenge-platform\/|<title>\s*(?:Just a moment|Access denied)|verify (?:that )?you are (?:a )?human[\s\S]{0,500}(?:captcha|challenge))/i.test(text);
}
function cacheable(headers) {
  return !/(?:no-store|private)/i.test(headers.get('cache-control') || '')
    && (!headers.get('vary') || headers.get('vary').toLowerCase() === 'accept-encoding');
}

export async function withPublicCrawler({ statePath, policy = DEFAULT_CRAWLER_POLICY, fetchImpl = fetch,
  clock = () => new Date().toISOString(), remaining = () => Infinity, signal, browser }, operation) {
  policy = readCrawlerPolicy(policy);
  const release = await acquireLock(statePath);
  try {
    const state = await readCrawlerState(statePath), queues = new Map(), lastStart = new Map(), delays = new Map(), events = [], active = new Set();
    let networkRequests = 0;
    const reservations = new Map();
    const now = () => Date.parse(clock());
    for (const [origin, row] of Object.entries(state.origins)) lastStart.set(origin, performance.now() - Math.max(0, now() - Date.parse(row.checkedAt)));
    const check = (requestSignal) => { aborted(requestSignal); aborted(signal); if (remaining() <= 0) fail('crawler_budget_exhausted'); };
    const cooldown = (origin, code, ms) => {
      const next = Math.max(Date.parse(state.origins[origin]?.nextAllowedAt) || 0, now() + Math.min(DAY, ms));
      state.origins[origin] = { checkedAt: new Date(now()).toISOString(), code,
        nextAllowedAt: new Date(next).toISOString() };
    };
    const ready = origin => { if (Date.parse(state.origins[origin]?.nextAllowedAt) > now()) fail('crawler_cooldown'); };
    async function reserve(origin, requestSignal) {
      const previous = reservations.get(origin) || Promise.resolve();
      const task = previous.then(async () => {
      check(requestSignal); ready(origin);
      if (networkRequests >= policy.maxRequests) fail('crawler_budget_exhausted');
      const interval = Math.max(policy.minIntervalMs, delays.get(origin) || 0);
      const elapsed = performance.now() - (lastStart.get(origin) ?? -Infinity);
      const delay = Math.max(0, interval - elapsed);
      // Only the two registered Macau JSON endpoints may need the site's
      // documented 10-second interval. Never lower a longer robots directive.
      if (delay >= remaining() || delay > (6000)) fail('crawl_delay_exceeds_budget');
      await pause(delay, requestSignal); check(requestSignal); ready(origin);
      if (networkRequests >= policy.maxRequests) fail('crawler_budget_exhausted');
      networkRequests++; lastStart.set(origin, performance.now());
      });
      reservations.set(origin, task.catch(() => {}));
      return task;
    }
    async function request(url, init, origin, requestSignal, limit, responseTimeoutMs = policy.requestTimeoutMs) {
      const rendered = !!browser?.matches?.(url);
      if (!rendered) await reserve(origin, requestSignal);
      else { check(requestSignal); ready(origin); }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(rendered ? 25_000 : responseTimeoutMs, Math.max(1, remaining())));
      const combined = AbortSignal.any([controller.signal, requestSignal, signal].filter(Boolean));
      const requestPolicy = rendered ? {
        beforeRequest: async descriptor => {
          if (!browserResourceTarget(descriptor.url, descriptor) || new URL(descriptor.url).origin !== origin) fail('browser_target_denied');
          const rules = robotsPolicy(await robots({ origin }, combined), descriptor.url);
          if (!rules.allowed) fail('robots_denied');
          delays.set(origin, rules.delayMs);
          await reserve(origin, combined);
        },
        afterResponse: async ({ status, headers }) => {
          check(combined);
          const retryMs = retryAfterMs(headers.get('retry-after'), now());
          if (status === 429) { cooldown(origin, 'rate_limited', Math.max(60_000, retryMs || 0)); fail('rate_limited', status); }
          if (headers.get('cf-mitigated') === 'challenge') { cooldown(origin, 'access_challenge', policy.blockedCooldownMs); fail('access_challenge', status); }
          if ([401, 403].includes(status)) {
            const code = status === 403 ? 'access_denied' : 'authorization_required';
            cooldown(origin, code, policy.blockedCooldownMs); fail(code, status);
          }
          if (status >= 300 && status < 400) fail('redirect_blocked', status);
          if (status >= 500) { cooldown(origin, 'http_unavailable', retryMs || 60_000); fail('http_unavailable', status); }
        },
      } : undefined;
      try {
        return await interruptible((async () => {
          const response = await (rendered ? browser.fetch : fetchImpl)(url, { ...init, redirect: 'manual', signal: combined,
            ...(requestPolicy ? { requestPolicy } : {}) });
          const text = await readText(response, limit);
          return { status: response.status, headers: response.headers, text };
        })(), combined);
      } catch (error) {
        if (requestSignal?.aborted || signal?.aborted) fail('crawler_cancelled');
        if (remaining() <= 0) fail('crawler_budget_exhausted');
        if (controller.signal.aborted) fail('crawler_timeout');
        if (CRAWLER_CODES.has(error.code)) throw error;
        fail('crawler_network_unavailable');
      } finally { clearTimeout(timer); controller.abort(); }
    }
    async function robots(target, requestSignal) {
      const cached = state.robots[target.origin];
      if (cached && now() >= Date.parse(cached.checkedAt) && now() - Date.parse(cached.checkedAt) <= policy.robotsTtlMs) return cached.text;
      const result = await request(`${target.origin}/robots.txt`, { method: 'GET', headers: { 'User-Agent': `${CRAWLER_AGENT}/1.0`, Accept: 'text/plain' } }, target.origin, requestSignal, ROBOTS_LIMIT);
      let text = '';
      if ([404, 410].includes(result.status)) text = '';
      else if (result.status === 200 && !challenge(result.text, result.headers) && !/<(?:html|body|script|form)\b/i.test(result.text)) text = result.text;
      else {
        const code = [401, 403].includes(result.status) ? 'robots_denied' : result.status === 429 ? 'rate_limited' : 'robots_unavailable';
        cooldown(target.origin, code, retryAfterMs(result.headers.get('retry-after'), now()) || (code === 'robots_denied' ? policy.blockedCooldownMs : 60_000));
        fail(code, result.status);
      }
      state.robots[target.origin] = { text, checkedAt: new Date(now()).toISOString() };
      return text;
    }
    async function crawl(target, init, requestSignal) {
      check(requestSignal); ready(target.origin);
      const rules = robotsPolicy(await robots(target, requestSignal), target.url);
      if (!rules.allowed) {
        state.origins[target.origin] = { checkedAt: new Date(now()).toISOString(), code: 'robots_denied', nextAllowedAt: null };
        fail('robots_denied');
      }
      delays.set(target.origin, rules.delayMs);
      const engine = browser?.matches?.(target.url) ? 'crawlee-playwright' : 'http';
      const stored = state.cache[target.key], cached = stored?.engine === engine ? stored : null;
      const age = cached ? now() - Date.parse(cached.fetchedAt) : Infinity;
      if (target.method === 'GET' && age >= 0 && age < policy.cacheTtlMs) {
        return { response: new Response(cached.text, { headers: cached.headers }), cache: 'hit', attempts: 0 };
      }
      const headers = new Headers(init.headers);
      for (const name of headers.keys()) if (!['accept', 'content-type', 'referer', 'user-agent'].includes(name)) fail('crawler_credentials_rejected');
      headers.set('User-Agent', `${CRAWLER_AGENT}/1.0`);
      if (cached && target.method === 'GET') {
        if (cached.headers.etag) headers.set('If-None-Match', cached.headers.etag);
        else if (cached.headers['last-modified']) headers.set('If-Modified-Since', cached.headers['last-modified']);
      }
      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        let result;
        try { result = await request(target.url, { method: target.method, headers, body: init.body }, target.origin, requestSignal,
          target.responseMaxBytes, target.responseTimeoutMs); }
        catch (error) {
          if (target.method === 'GET' && attempt < policy.maxRetries && ['crawler_timeout', 'crawler_network_unavailable'].includes(error.code)) {
            await pause(policy.retryDelayMs * 2 ** attempt + Math.floor(Math.random() * 100), requestSignal); continue;
          }
          throw error;
        }
        const retryMs = retryAfterMs(result.headers.get('retry-after'), now());
        if (result.status === 429) { cooldown(target.origin, 'rate_limited', Math.max(60_000, retryMs || 0)); fail('rate_limited', 429); }
        if (challenge(result.text, result.headers)) { cooldown(target.origin, 'access_challenge', policy.blockedCooldownMs); fail('access_challenge', result.status); }
        if ([401, 403].includes(result.status) || /<input\b[^>]*type\s*=\s*["']password["']/i.test(result.text)) {
          const code = result.status === 403 ? 'access_denied' : 'authorization_required';
          cooldown(target.origin, code, policy.blockedCooldownMs); fail(code, result.status);
        }
        if (result.status >= 300 && result.status < 400 && result.status !== 304) fail('redirect_blocked', result.status);
        if ([502, 503, 504].includes(result.status)) {
          if (retryMs) { cooldown(target.origin, 'http_unavailable', retryMs); fail('http_unavailable', result.status); }
          if (target.method === 'GET' && attempt < policy.maxRetries) {
            await pause(policy.retryDelayMs * 2 ** attempt + Math.floor(Math.random() * 100), requestSignal); continue;
          }
        }
        if (result.status === 304) {
          const date = Date.parse(result.headers.get('date'));
          if (!cached || !['If-None-Match', 'If-Modified-Since'].some(name => headers.has(name))
            || !Number.isFinite(date) || Math.abs(now() - date) > 300_000
            || cached.headers['last-modified'] && result.headers.has('last-modified')
              && result.headers.get('last-modified') !== cached.headers['last-modified']) fail('cache_validation_failed', 304);
          result.text = cached.text;
          result.headers = new Headers({ ...cached.headers, ...safeHeaders(result.headers) });
        } else if (result.status !== 200) fail('http_unavailable', result.status);
        const record = { text: result.text, headers: safeHeaders(result.headers), fetchedAt: new Date(now()).toISOString(), engine };
        if (target.method === 'GET' && cacheable(result.headers)) state.cache[target.key] = record;
        else delete state.cache[target.key];
        state.origins[target.origin] = { code: 'ok', checkedAt: new Date(now()).toISOString(), nextAllowedAt: null };
        return { response: new Response(result.text, { headers: record.headers }), cache: result.status === 304 ? 'revalidated' : 'miss', attempts: attempt + 1 };
      }
    }
    const fetchQueued = async (url, init = {}) => {
      const target = crawlerTarget(url, init.method || 'GET', init.body);
      // Reject secrets even on a cache hit or before the first robots request.
      for (const name of new Headers(init.headers).keys()) if (!['accept', 'content-type', 'referer', 'user-agent'].includes(name)) fail('crawler_credentials_rejected');
      const requestSignal = AbortSignal.any([init.signal, signal].filter(Boolean));
      const started = performance.now();
      const previous = queues.get(target.origin) || Promise.resolve();
      let unlock;
      const gate = new Promise(resolve => { unlock = resolve; });
      // An aborted waiter must not release the next waiter past an active owner.
      queues.set(target.origin, previous.then(() => gate));
      try {
        await interruptible(previous, requestSignal);
        const result = await crawl(target, init, requestSignal);
        events.push({ sourceId: target.id, endpoint: target.key, checkedAt: new Date(now()).toISOString(), code: 'ok',
          httpStatus: 200, cache: result.cache, attempts: result.attempts, durationMs: Math.round(performance.now() - started) });
        return result.response;
      } catch (error) {
        const code = CRAWLER_CODES.has(error.code) ? error.code : 'crawler_network_unavailable';
        if (['http_unavailable', 'crawler_network_unavailable', 'crawler_timeout', 'browser_navigation_failed'].includes(code)) cooldown(target.origin, code, 60_000);
        events.push({ sourceId: target.id, endpoint: target.key, checkedAt: new Date(now()).toISOString(), code,
          httpStatus: Number.isInteger(error.status) ? error.status : null, durationMs: Math.round(performance.now() - started) });
        throw new CrawlerError(code, error.status);
      } finally { unlock(); }
    };
    const fetchPublic = (url, init) => {
      const task = fetchQueued(url, init);
      active.add(task);
      task.then(() => active.delete(task), () => active.delete(task));
      return task;
    };
    fetchPublic.timeoutMs = browser?.fetch ? 120_000 : 8000;
    let result;
    try { result = await operation(fetchPublic); }
    finally {
      await Promise.allSettled([...active]);
      // Discard stale cached pages and bound the state even as date URLs advance.
      let cacheBytes = 0;
      state.cache = Object.fromEntries(Object.entries(state.cache).filter(([, entry]) => now() - Date.parse(entry.fetchedAt) < DAY)
        .sort((a, b) => Date.parse(b[1].fetchedAt) - Date.parse(a[1].fetchedAt)).slice(0, 12)
        .filter(entry => { const size = Buffer.byteLength(JSON.stringify(entry)); if (cacheBytes + size > 16_000_000) return false; cacheBytes += size; return true; }));
      await atomicJson(statePath, state);
    }
    return { result, crawler: { version: 1, checkedAt: new Date(now()).toISOString(), networkRequests,
      maxRequests: policy.maxRequests, runtime: browser?.metadata || { engine: 'http' }, events: events.slice(-100),
      origins: Object.entries(state.origins).map(([origin, row]) => ({ origin, ...row })) } };
  } finally { await release(); }
}

// Standalone transport checks use exactly the already implemented public feeds.
export const PUBLIC_PROBES = Object.freeze([
  ...['bfdata_ut.js', 'goal17.xml', 'goal24.xml', 'goal31.xml'].map(name => ({ sourceId: 'titan007',
    url: `https://livestatic.titan007.com/vbsxml/${name}`, init: { method: 'GET', headers: { Referer: 'https://live.titan007.com/index2in1.aspx?id=17' } } })),
  { sourceId: 'statarea', url: 'https://www.statarea.com/predictions', init: { method: 'GET' } },
  { sourceId: 'tiantian', url: 'https://www.ttyingqiu.com/query/hall/jdList', init: { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'raceStatus=0&amountMode=3&sortType=10&raceType=1&gameId=0&pageNo=1&pageSize=30' } },
]);
