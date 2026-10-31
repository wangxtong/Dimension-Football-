import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserRuntime } from '../browser.mjs';
import { configureEnvironmentProxy } from '../network.mjs';

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
