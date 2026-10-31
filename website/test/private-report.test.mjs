import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import { createDashboard } from '../worker.mjs';

const ORIGIN = 'https://dashboard.example';
const password = 'test-only-password';
const salt = 'bc'.repeat(16);
const auth = { username: 'viewer', iterations: 100000, salt,
  hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex') };
const config = { DASHBOARD_AUTH: JSON.stringify(auth), DASHBOARD_SESSION_SECRET: 'ab'.repeat(32),
  DASHBOARD_ORIGIN: ORIGIN, REPORTS_GITHUB_TOKEN: 'unit-test-only-placeholder-read-token' };
const make = (pathname, options={}) => new Request(ORIGIN + pathname, options);
const signin = () => make('/login', { method: 'POST', headers: { Origin: ORIGIN,
  'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: 'viewer', password }) });
async function cookie(app) {
  return (await app.fetch(signin(), config)).headers.get('set-cookie').split(';')[0];
}
const apiFile = (name, payload) => {
  const raw = Buffer.from(JSON.stringify(payload));
  return Response.json({ type: 'file', name, encoding: 'base64',
    content: raw.toString('base64'), size: raw.length });
};

test('only the server can supply private report credentials', async () => {
  let calls = 0;
  const app = createDashboard({}, { fetchImpl: async () => {
    calls++; return apiFile('predictions.json', { message: 'ok' });
  }});
  const signed = await cookie(app);
  const response = await app.fetch(make('/api/predictions.json', {
    headers: { Cookie: signed, Authorization: 'Bearer client-supplied-value' }
  }), { ...config, REPORTS_GITHUB_TOKEN: '' });
  assert.equal(response.status, 503);
  assert.equal(calls, 0);
  assert.equal((await response.json()).error, 'REPORT_TOKEN_NOT_CONFIGURED');
});

test('private contents API supports only three fixed files and never follows browser inputs', async () => {
  const calls = [];
  const app = createDashboard({}, { fetchImpl: async (url, opts) => {
    calls.push({ url, opts });
    const name = new URL(url).pathname.split('/').pop();
    return apiFile(name, { reportId: 'expected' });
  }});
  const signed = await cookie(app);
  for (const name of ['predictions.json', 'publication.json', 'openligadb-fixtures.json']) {
    const res = await app.fetch(make('/api/' + name + '?url=https://untrusted.example', {
      headers: { Cookie: signed }
    }), config);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reportId, 'expected');
  }
  assert.equal((await app.fetch(make('/api/unknown.json', { headers: { Cookie: signed } }), config)).status, 404);
  assert.equal(calls.length, 3);
  for (const { url, opts } of calls) {
    assert.equal(new URL(url).host, 'api.github.com');
    assert.equal(new URL(url).searchParams.get('ref'), 'published-reports');
    assert.equal(opts.headers.Authorization, 'Bearer ' + config.REPORTS_GITHUB_TOKEN);
    assert.equal(opts.redirect, 'manual');
  }
});

test('missing permissions, redirects, false sizes, invalid encodings and bad UTF-8 fail closed', async () => {
  const invalid = [
    new Response('private file unavailable', { status: 403 }),
    new Response(null, { status: 302, headers: { Location: 'https://untrusted.example/' } }),
    apiFile('other-file.json', {}),
    Response.json({ type: 'file', name: 'predictions.json', encoding: 'base64', size: 9000000, content: 'e30=' }),
    Response.json({ type: 'file', name: 'predictions.json', encoding: 'base64', size: 6, content: 'e30=' }),
    Response.json({ type: 'file', name: 'predictions.json', encoding: 'base64', size: 2, content: '%%%=' }),
    Response.json({ type: 'file', name: 'predictions.json', encoding: 'base64', size: 2, content: '//8=' })
  ];
  const signed = await cookie(createDashboard());
  for (const reply of invalid) {
    const app = createDashboard({}, { fetchImpl: async () => reply });
    const result = await app.fetch(make('/api/predictions.json', { headers: { Cookie: signed } }), config);
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes(config.REPORTS_GITHUB_TOKEN));
  }
});
