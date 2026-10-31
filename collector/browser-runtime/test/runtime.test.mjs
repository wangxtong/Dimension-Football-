import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserRuntime, browserTarget } from '../index.mjs';

test('Crawlee and real Chromium execute dynamic HTML and reuse a scoped authorized session without public traffic', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'football-browser-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'session.json');
  const state = { cookies: [{ name: 'fixture_session', value: 'synthetic-session', domain: 'www.statarea.com',
    path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }],
  origins: [{ origin: 'https://www.statarea.com', localStorage: [{ name: 'test_ready', value: 'session-restored' }] }] };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  let hadCookie = false;
  const runtime = await createBrowserRuntime({ env: { ...process.env, VANTIS_STATAREA_STORAGE_STATE: statePath },
    pageSetup: async page => {
      await page.route('**/*', async route => {
        assert.equal(new URL(route.request().url()).origin, 'https://www.statarea.com');
        hadCookie = (await route.request().allHeaders()).cookie?.includes('synthetic-session') || false;
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/html', Date: 'Tue, 27 Oct 2026 08:30:00 GMT' },
          body: '<html><body><script>setTimeout(()=>{const d=document.createElement("div");d.className="competition";d.textContent=localStorage.getItem("test_ready");document.body.append(d)},10)</script></body></html>' });
      });
    } });
  const response = await runtime.fetch('https://www.statarea.com/predictions');
  assert.match(await response.text(), /class="competition">session-restored/);
  assert.equal(hadCookie, true);
  assert.equal(response.headers.get('date'), 'Tue, 27 Oct 2026 08:30:00 GMT');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(runtime.metadata.engine, 'crawlee-playwright');
  assert.ok(!JSON.stringify(runtime.metadata).includes('synthetic-session'));
  await chmod(statePath, 0o644);
  await assert.rejects(createBrowserRuntime({ env: { ...process.env, VANTIS_STATAREA_STORAGE_STATE: statePath } }), { code: 'browser_session_permissions' });
  await chmod(statePath, 0o600);
  state.origins[0].origin = 'https://elsewhere.invalid';
  await writeFile(statePath, JSON.stringify(state));
  await assert.rejects(createBrowserRuntime({ env: { ...process.env, VANTIS_STATAREA_STORAGE_STATE: statePath } }), { code: 'browser_session_scope_invalid' });
});

test('browser target gate excludes APIs, off-site redirects, credentials in URLs and login submission', async () => {
  assert.equal(browserTarget('https://www.statarea.com/predictions'), true);
  for (const url of ['https://www.statarea.com/login', 'https://token@www.statarea.com/predictions',
    'https://v3.football.api-sports.io/fixtures', 'http://www.statarea.com/predictions', 'https://www.statarea.com/predictions?key=secret']) {
    assert.equal(browserTarget(url), false);
  }
});
