import { acquireLock, atomicJson, readJson } from '../storage.mjs';
import { retryAfterMs } from './health.mjs';

const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const sourceId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(value);
export class SourceCooldownError extends Error {
  constructor(code, httpStatus = null, retryMs = null, nextProbeAt = null) {
    super(code); this.code = code; this.httpStatus = httpStatus; this.retryAfterMs = retryMs; this.nextProbeAt = nextProbeAt;
  }
}

async function load(path) {
  if (!path) return { version: 1, sources: {} };
  let state;
  try { state = await readJson(path, 128000); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, sources: {} }; throw new Error('SOURCE_COOLDOWN_UNREADABLE'); }
  if (state?.version !== 1 || !state.sources || typeof state.sources !== 'object' || Array.isArray(state.sources)
    || Object.keys(state.sources).length > 100) throw new Error('SOURCE_COOLDOWN_INVALID');
  const clean = { version: 1, sources: {} };
  for (const [id, row] of Object.entries(state.sources)) {
    if (!sourceId(id) || !row || !iso(row.checkedAt) || !iso(row.nextProbeAt)
      || !['rate_limited', 'http_unavailable'].includes(row.code)
      || ![429, 503].includes(row.httpStatus)) throw new Error('SOURCE_COOLDOWN_INVALID');
    clean.sources[id] = { checkedAt: row.checkedAt, nextProbeAt: row.nextProbeAt, code: row.code, httpStatus: row.httpStatus };
  }
  return clean;
}

// One locked acquisition round. Without a path the same-round guard remains active,
// but no files are written. Callers that schedule work must supply a persistent path.
export async function withSourceCooldown({ statePath, clock = () => new Date().toISOString(), signal,
  remaining = () => Infinity } = {}, operation) {
  const release = statePath ? await acquireLock(statePath) : async () => {};
  let queue = Promise.resolve();
  try {
    const state = await load(statePath);
    const fetchGuarded = (id, fetchImpl, url, init = {}) => {
      const run = async () => {
        if (!sourceId(id)) throw new Error('INVALID_COOLDOWN_SOURCE');
        if (signal?.aborted || init.signal?.aborted) throw new SourceCooldownError('cancelled');
        if (remaining() <= 0) throw new SourceCooldownError('budget_exhausted');
        const now = Date.parse(clock());
        if (!Number.isFinite(now)) throw new Error('INVALID_COOLDOWN_CLOCK');
        const previous = state.sources[id], next = Date.parse(previous?.nextProbeAt);
        if (next > now) throw new SourceCooldownError('source_cooldown', previous.httpStatus, next - now, previous.nextProbeAt);
        const joined = AbortSignal.any([signal, init.signal].filter(Boolean));
        let onAbort;
        const pending = Promise.resolve().then(() => fetchImpl(url, { ...init, signal: joined }));
        // Some injected transports do not honor AbortSignal. Do not let them
        // hold the persistent lock or mutate cooldown state after cancellation.
        pending.then(response => { if (joined.aborted) response?.body?.cancel?.().catch(() => {}); }, () => {});
        let response;
        try {
          response = await Promise.race([pending, new Promise((_, reject) => {
            onAbort = () => reject(new SourceCooldownError('cancelled'));
            if (joined.aborted) onAbort(); else joined.addEventListener('abort', onAbort, { once: true });
          })]);
        } finally { joined.removeEventListener('abort', onAbort); }
        const completed = Date.parse(clock()), retryMs = retryAfterMs(response.headers?.get('retry-after'), completed);
        if (response.status === 429 || response.status === 503 && retryMs) {
          const code = response.status === 429 ? 'rate_limited' : 'http_unavailable';
          const delay = Math.max(response.status === 429 ? 60000 : 0, retryMs || 0);
          const nextProbeAt = new Date(completed + delay).toISOString();
          state.sources[id] = { checkedAt: new Date(completed).toISOString(), nextProbeAt, code, httpStatus: response.status };
          await response.body?.cancel?.().catch(() => {});
          if (statePath) await atomicJson(statePath, state);
          throw new SourceCooldownError(code, response.status, delay, nextProbeAt);
        }
        return response;
      };
      // Queue the check as well as the request: parallel callers cannot race past
      // a Retry-After response before its cooldown is persisted.
      const task = queue.then(run);
      queue = task.catch(() => {});
      return task;
    };
    return await operation({ fetch: fetchGuarded });
  } finally { await queue; await release(); }
}
