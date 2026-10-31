import { generateKeyPairSync, createSign } from 'node:crypto';
import { NOW, ORIGIN } from './fixtures.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline-key', use: 'sig', alg: 'RS256' };
export const defaultClaims = { iss: 'https://token.actions.githubusercontent.com', aud: ORIGIN,
  repository: 'wangxtong/Dimension-Football-', repository_id: '1438127927', repository_owner_id: '317304857',
  ref: 'refs/heads/main', workflow_ref: 'wangxtong/Dimension-Football-/.github/workflows/live-publication.yml@refs/heads/main',
  event_name: 'schedule', iat: NOW / 1000 - 1, nbf: NOW / 1000 - 1, exp: NOW / 1000 + 299 };
export function token(claims = {}, header = {}) {
  const body = [JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid, ...header }), JSON.stringify({ ...defaultClaims, ...claims })]
    .map(value => Buffer.from(value).toString('base64url')).join('.');
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}
export function fakeKeys() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ keys: [publicJwk] });
  };
  return { fetchImpl, calls };
}
export class MemoryBucket {
  rows = new Map();
  sequence = 0;
  async get(key) {
    const row = this.rows.get(key);
    if (!row) return null;
    return { etag: row.etag, size: Buffer.byteLength(row.text), body: new Response(row.text).body, text: async () => row.text };
  }
  async put(key, text, options = {}) {
    if (this.beforePut) await this.beforePut(key, text, options);
    const old = this.rows.get(key), conditional = options.onlyIf;
    if (conditional?.etagDoesNotMatch === '*' && old) return null;
    if (conditional?.etagMatches !== undefined && conditional.etagMatches !== old?.etag) return null;
    const etag = `etag-${++this.sequence}`;
    this.rows.set(key, { text, etag });
    return { key, etag };
  }
  json(key) { const text = this.rows.get(key)?.text; return text ? JSON.parse(text) : null; }
}
export function machineRequest(path, { method = 'GET', body, bearer = token(), headers = {} } = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers: { authorization: `Bearer ${bearer}`,
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
export function stateFile(path, content) { return { path, content: Buffer.from(JSON.stringify(content)).toString('base64') }; }
