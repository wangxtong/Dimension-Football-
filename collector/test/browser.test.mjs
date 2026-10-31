import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserRuntime } from '../browser.mjs';
import { configureEnvironmentProxy } from '../network.mjs';
import { browserResourceTarget, createBrowserRouteHandler } from '../browser-runtime/index.mjs';

test('runtime auto mode detects absent isolated dependencies; explicit mode and authenticated sessions fail clearly', async t => {
  const path = await mkdtemp(join(tmpdir(), 'football-browser-missing-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const env = { VANTIS_CRAWLER_RUNTIME_DIR: path };
  assert.equal((await browserRuntime({ env })).metadata.reason, 'browser_dependencies_missing');
  await assert.rejects(browserRuntime({ env: { ...env, VANTIS_CRAWLER_ENGINE: 'crawlee' } }), { message: 'browser_dependencies_missing' });
  await assert.rejects(browserRuntime({ env: { ...env, VANTIS_STATAREA_STORAGE_STATE: '/private/session.json' } }), { message: 'browser_dependencies_missing' });
  assert.equal((await browserRuntime({ env, enabled: false })).metadata.engine, 'http');
  await assert.rejects(browserRuntime({ env: { VANTIS_CRAWLER_ENGINE: 'unknown' } }), { message: 'INVALID_CRAWLER_ENGINE' });
});

test('runtime networking uses inherited proxies, respects preconfigured support and redacts configuration errors', () => {
  const env = { HTTPS_PROXY: 'http://synthetic-user:synthetic-secret@proxy.invalid:8080', NO_PROXY: 'localhost' };
  let applied;
  assert.equal(configureEnvironmentProxy(env, value => { applied = value; }), true);
  assert.equal(applied, env);
  assert.equal(configureEnvironmentProxy({}, () => assert.fail('no proxy configured')), false);
  assert.equal(configureEnvironmentProxy({ ...env, NODE_USE_ENV_PROXY: '1' }, () => assert.fail('already configured')), true);
  assert.throws(() => configureEnvironmentProxy(env, null), { message: 'ENV_PROXY_REQUIRES_NODE_24_14' });
  assert.throws(() => configureEnvironmentProxy(env, () => { throw new Error(env.HTTPS_PROXY); }), { message: 'ENV_PROXY_CONFIGURATION_INVALID' });
});

test('browser routes require crawler authorization and exclude APIs, redirects and unapproved resources', async () => {
  const pageUrl = 'https://www.statarea.com/predictions', metadata = { browserRequests: 0 };
  const allowed = [], failures = []; let fetched = 0;
  const handler = createBrowserRouteHandler({ pageUrl, metadata,
    init: { requestPolicy: { beforeRequest: async descriptor => { allowed.push(descriptor.url); }, afterResponse: async () => {} } },
    onFailure: error => failures.push(error.code), responseForRequest: async () => { fetched++; return { status: 200, headers: {}, body: 'ok' }; } });
  async function route(url, resourceType, navigation = false, redirected = false) {
    let action;
    await handler({ request: () => ({ url: () => url, method: () => 'GET', resourceType: () => resourceType,
      isNavigationRequest: () => navigation, redirectedFrom: () => redirected ? {} : null }),
      abort: async () => { action = 'aborted'; }, fulfill: async () => { action = 'fulfilled'; } });
    return action;
  }
  assert.equal(await route(pageUrl, 'document', true), 'fulfilled');
  assert.equal(await route('https://www.statarea.com/assets/site.js?v=1', 'script'), 'fulfilled');
  for (const [url, kind] of [['https://www.statarea.com/account', 'fetch'], ['https://www.statarea.com/api/private.js', 'script'],
    ['https://elsewhere.invalid/assets/site.js', 'script'], ['https://www.statarea.com/assets/logo.png', 'image']]) {
    assert.equal(await route(url, kind), 'aborted');
  }
  assert.equal(await route(pageUrl, 'document', true, true), 'aborted');
  assert.deepEqual(failures, ['redirect_blocked']); assert.equal(fetched, 2); assert.equal(allowed.length, 2);
  assert.equal(browserResourceTarget('https://www.statarea.com/assets/site.js', { resourceType: 'fetch' }), false);
});

test('browser assets cannot bypass policy denial, response cooldown or manual redirect handling', async () => {
  const pageUrl = 'https://www.statarea.com/predictions';
  for (const mode of ['missing', 'robots', 'rate', 'redirect']) {
    const failures = []; let fetched = 0, fulfilled = 0;
    const requestPolicy = mode === 'missing' ? undefined : {
      beforeRequest: async () => { if (mode === 'robots') throw Object.assign(new Error('robots_denied'), { code: 'robots_denied' }); },
      afterResponse: async () => { if (mode === 'rate') throw Object.assign(new Error('rate_limited'), { code: 'rate_limited' }); },
    };
    const handler = createBrowserRouteHandler({ pageUrl, metadata: { browserRequests: 0 }, init: { requestPolicy },
      onFailure: error => failures.push(error.code), responseForRequest: async () => { fetched++; return { status: mode === 'redirect' ? 302 : 200, headers: {}, body: 'ok' }; } });
    await handler({ request: () => ({ url: () => pageUrl, method: () => 'GET', resourceType: () => 'document', isNavigationRequest: () => true }),
      abort: async () => {}, fulfill: async () => { fulfilled++; } });
    assert.equal(fulfilled, 0); assert.equal(fetched, ['missing', 'robots'].includes(mode) ? 0 : 1);
    assert.deepEqual(failures, [{ missing: 'browser_policy_required', robots: 'robots_denied', rate: 'rate_limited', redirect: 'redirect_blocked' }[mode]]);
  }
});
