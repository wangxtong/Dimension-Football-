import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyActionsIdentity } from '../github-oidc.mjs';
import { NOW, ORIGIN } from './fixtures.mjs';
import { token, fakeKeys, machineRequest, publicJwk } from './hosted-fixtures.mjs';

test('real offline RSA signatures authorize only the fixed Actions identity and cache official JWKS', async () => {
  const { fetchImpl, calls } = fakeKeys();
  const options = { fetchImpl, now: NOW }, env = { DASHBOARD_ORIGIN: ORIGIN };
  for (const event_name of ['schedule', 'push', 'workflow_dispatch']) {
    const claims = await verifyActionsIdentity(machineRequest('/internal/state', { bearer: token({ event_name }) }), env, options);
    assert.equal(claims.repository_id, '1438127927');
    assert.equal(claims.event_name, event_name);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://token.actions.githubusercontent.com/.well-known/jwks');
  assert.equal(calls[0].init.redirect, 'error');
  await verifyActionsIdentity(machineRequest('/internal/state', { bearer: token({ iat: NOW / 1000 + 300, nbf: NOW / 1000 + 300, exp: NOW / 1000 + 600 }) }), env, { fetchImpl, now: NOW + 301000 });
  assert.equal(calls.length, 2);
});

test('repository, owner, audience, workflow, branch, event and JWT times are exact authorization boundaries', async () => {
  const { fetchImpl, calls } = fakeKeys();
  const changes = [{ iss: 'https://attacker.invalid' }, { aud: 'https://other.example' }, { aud: [ORIGIN] },
    { repository: 'attacker/Dimension-Football-' }, { repository_id: '1' }, { repository_owner_id: '1' },
    { ref: 'refs/pull/1/merge' }, { workflow_ref: 'wangxtong/Dimension-Football-/.github/workflows/test.yml@refs/heads/main' },
    { event_name: 'pull_request_target' }, { exp: NOW / 1000 }, { nbf: NOW / 1000 + 1 }, { iat: NOW / 1000 + 1 },
    { iat: NOW / 1000 - 601 }, { exp: NOW / 1000 + 600 }, { nbf: null }, { exp: '1793448300' }];
  for (const change of changes) await assert.rejects(verifyActionsIdentity(machineRequest('/internal/state', { bearer: token(change) }),
    { DASHBOARD_ORIGIN: ORIGIN }, { fetchImpl, now: NOW }), { code: 'ACTIONS_IDENTITY_INVALID' });
  assert.equal(calls.length, 0);
});

test('cookies, signature tampering, unsafe JWT headers and unknown signing keys never authorize', async () => {
  const { fetchImpl, calls } = fakeKeys(), env = { DASHBOARD_ORIGIN: ORIGIN }, options = { fetchImpl, now: NOW };
  await assert.rejects(verifyActionsIdentity(new Request(`${ORIGIN}/internal/state`, { headers: { cookie: 'session=visitor-cookie' } }), env, options), { status: 401 });
  assert.equal(calls.length, 0);
  const signed = token(), parts = signed.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  for (const bearer of [parts.join('.'), token({}, { alg: 'HS256' }), token({}, { jku: 'https://attacker.invalid/keys' }),
    token({}, { kid: 'unknown' }), token({}, { crit: [] }), 'a.b.c']) {
    await assert.rejects(verifyActionsIdentity(machineRequest('/internal/state', { bearer }), env, options), { code: 'ACTIONS_IDENTITY_INVALID' });
  }
  assert.equal(calls.length, 1);
});

test('bad origin and oversized or malformed JWKS fail closed with bounded retrieval', async () => {
  const request = machineRequest('/internal/state');
  await assert.rejects(verifyActionsIdentity(request, { DASHBOARD_ORIGIN: `${ORIGIN}/path` }, { now: NOW }), { status: 503 });
  for (const fetchImpl of [async () => new Response('x'.repeat(65537)), async () => Response.json({ keys: Array(33).fill(publicJwk) }),
    async () => Response.json({ keys: [{ ...publicJwk, d: 'private' }] }), async () => new Response('redirect', { status: 302 })]) {
    await assert.rejects(verifyActionsIdentity(request, { DASHBOARD_ORIGIN: ORIGIN }, { now: NOW, fetchImpl }), { code: 'ACTIONS_KEYS_UNAVAILABLE', status: 503 });
  }
});

test('a synchronous JWKS transport failure is retryable rather than permanently cached', async () => {
  let calls = 0;
  const fetchImpl = () => { if (++calls === 1) throw Error('offline'); return Response.json({ keys: [publicJwk] }); };
  const request = machineRequest('/internal/state'), env = { DASHBOARD_ORIGIN: ORIGIN }, options = { now: NOW, fetchImpl };
  await assert.rejects(verifyActionsIdentity(request, env, options), { code: 'ACTIONS_KEYS_UNAVAILABLE' });
  assert.equal((await verifyActionsIdentity(request, env, options)).repository_id, '1438127927');
  assert.equal(calls, 2);
});
