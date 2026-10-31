// Machine identity is independent of dashboard visitor sessions and cookies.
const ISSUER = 'https://token.actions.githubusercontent.com';
const JWKS_URL = `${ISSUER}/.well-known/jwks`;
const caches = new WeakMap();
const decoder = new TextDecoder('utf-8', { fatal: true });
function denied(code = 'ACTIONS_IDENTITY_INVALID', status = 401) {
  return Object.assign(new Error(code), { code, status });
}
function decodeSegment(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw denied();
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
    return Uint8Array.from(binary, c => c.charCodeAt(0));
  } catch { throw denied(); }
}
async function fetchKeys(fetchImpl, now) {
  let cache = caches.get(fetchImpl);
  if (cache?.expiresAt > now) return cache.keys;
  if (cache?.pending) return cache.pending;
  cache = { expiresAt: 0 };
  caches.set(fetchImpl, cache);
  cache.pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      // Workers reject redirect:'error' before network dispatch. Manual plus the
      // non-2xx rejection below preserves the fixed-origin, no-redirect boundary.
      const response = await fetchImpl(JWKS_URL, { headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      if (!response.ok || Number(response.headers.get('content-length') || 0) > 65536 || !response.body) throw Error();
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 65536) { await reader.cancel(); throw Error(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const data = JSON.parse(decoder.decode(bytes));
      if (!Array.isArray(data.keys) || !data.keys.length || data.keys.length > 32) throw Error();
      const keys = new Map();
      for (const key of data.keys) {
        if (key.kty !== 'RSA' || key.alg !== 'RS256' || key.use !== 'sig' || typeof key.kid !== 'string'
          || !key.kid.length || key.kid.length > 200 || keys.has(key.kid) || typeof key.n !== 'string'
          || key.n.length < 342 || key.n.length > 1366 || !/^[A-Za-z0-9_-]+$/.test(key.n) || key.e !== 'AQAB'
          || ['d', 'p', 'q', 'dp', 'dq', 'qi'].some(field => field in key)) throw Error();
        keys.set(key.kid, await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
      }
      cache.keys = keys;
      cache.expiresAt = now + 300000;
      return keys;
    } catch { throw denied('ACTIONS_KEYS_UNAVAILABLE', 503); }
    finally { clearTimeout(timer); }
  })();
  try { return await cache.pending; } finally { delete cache.pending; }
}

export async function verifyActionsIdentity(request, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  let origin;
  try {
    const url = new URL(env.DASHBOARD_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== env.DASHBOARD_ORIGIN) throw Error();
    origin = url.origin;
  } catch { throw denied('ACTIONS_AUDIENCE_NOT_CONFIGURED', 503); }
  const authorization = request.headers.get('authorization');
  if (!authorization || authorization.length > 16384 || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization)) throw denied();
  const token = authorization.slice(7), parts = token.split('.');
  if (parts.length !== 3) throw denied();
  let header, claims;
  try {
    header = JSON.parse(decoder.decode(decodeSegment(parts[0])));
    claims = JSON.parse(decoder.decode(decodeSegment(parts[1])));
  } catch { throw denied(); }
  if (!header || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.length || header.kid.length > 200
    || ['jku', 'x5u', 'jwk', 'crit'].some(key => Object.hasOwn(header, key))) throw denied();
  const seconds = now / 1000;
  if (!claims || claims.iss !== ISSUER || claims.aud !== origin
    || claims.repository !== 'wangxtong/Dimension-Football-' || claims.repository_id !== '1438127927'
    || claims.repository_owner_id !== '317304857' || claims.ref !== 'refs/heads/main'
    || claims.workflow_ref !== 'wangxtong/Dimension-Football-/.github/workflows/live-publication.yml@refs/heads/main'
    || !['schedule', 'push', 'workflow_dispatch'].includes(claims.event_name)
    || ![claims.exp, claims.nbf, claims.iat].every(Number.isSafeInteger)
    || claims.exp <= seconds || claims.nbf > seconds || claims.iat > seconds
    || claims.exp <= claims.iat || claims.exp - claims.iat > 600 || claims.nbf > claims.exp
    || seconds - claims.iat > 600) throw denied();
  const keys = await fetchKeys(fetchImpl, now), key = keys.get(header.kid);
  // Unknown IDs do not force arbitrary refreshes; a short bounded cache also limits rotation delay.
  if (!key) throw denied();
  let verified = false;
  try {
    verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodeSegment(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { /* Invalid signatures never become authenticated claims. */ }
  if (!verified) throw denied();
  return claims;
}
