// Explicit browser gate: node --test website/test/e2e.mjs (no public traffic).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pbkdf2Sync } from 'node:crypto';
import { createServer } from 'node:https';
import { gzipSync } from 'node:zlib';
import { NOW, sampleReport, sampleReceipt } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const password = 'synthetic-browser-test-password', salt = 'a1'.repeat(16);
const auth = { username: 'test-viewer', iterations: 100000, salt,
  hash: pbkdf2Sync(password, Buffer.from(salt, 'hex'), 100000, 32, 'sha256').toString('hex') };
const env = { DASHBOARD_AUTH: JSON.stringify(auth), DASHBOARD_SESSION_SECRET: 'a2'.repeat(32), DASHBOARD_ORIGIN: 'https://localhost',
  REPORTS_ORIGIN: 'https://reports.example.test', REPORTS_READ_TOKEN: 'synthetic-reports-test-token-0123456789abcdef', REPORTS_PROBE_TOKEN: 'b3'.repeat(32) };
let browser, output, createDashboard, assets, tls;

before(async () => {
  let modulePath = process.env.PLAYWRIGHT_MODULE || join(root, 'collector/browser-runtime/node_modules/playwright/index.mjs');
  if ((await stat(modulePath)).isDirectory()) modulePath = join(modulePath, 'index.mjs');
  const { chromium } = await import(pathToFileURL(resolve(modulePath)));
  output = await mkdtemp(join(tmpdir(), 'dimension-website-e2e-'));
  await promisify(execFile)(process.execPath, [join(root, 'website/build.mjs'), output], { cwd: root });
  await writeFile(join(output, 'package.json'), '{"type":"module"}\n');
  const source = await readFile(join(output, 'server/index.js'), 'utf8');
  const prefix = 'const EMBEDDED_ASSETS = ';
  assert.ok(source.startsWith(prefix), 'Build must embed the actual website assets');
  assets = JSON.parse(source.slice(prefix.length, source.indexOf(';\n')));
  assert.ok(assets['/report-schema.mjs'], 'The shared schema must be present in the deployable build');
  assert.ok(assets['/locale-zh.mjs'], 'The Chinese presentation module must be present in the deployable build');
  ({ createDashboard } = await import(pathToFileURL(join(output, 'server/index.js'))));
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', join(output, 'test-key.pem'), '-out', join(output, 'test-cert.pem')]);
  tls = { key: await readFile(join(output, 'test-key.pem')), cert: await readFile(join(output, 'test-cert.pem')) };
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}, { timeout: 60000 });
after(async () => { await browser?.close(); if (output) await rm(output, { recursive: true, force: true }); });

async function dashboard(t, mode = 'ecs') {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const errors = [];
  let origin;
  const state = { mode, report: sampleReport(), receipt: sampleReceipt(), status: 200, invalidJson: false, serverNow: NOW, calls: 0,
    freshness: null, health: null, gate: null, bootstrap: false };
  const bundle = () => ({ version: 1, reportId: state.report.publication.reportId, report: state.report, receipt: state.receipt,
    ...(state.freshness ? { freshness: state.freshness } : {}), ...(state.health ? { health: state.health } : {}) });
  const worker = createDashboard(assets, { clock: () => state.serverNow, fetchImpl: async (url, options) => {
    assert.equal(url, 'https://reports.example.test/api/report');
    assert.equal(options.headers.Authorization === 'Bearer ' + env.REPORTS_READ_TOKEN, true);
    state.calls++;
    if (state.gate) await state.gate;
    if (state.status !== 200) return new Response('synthetic-upstream-error', { status: state.status });
    if (state.invalidJson) return new Response('{', { headers: { 'Content-Type': 'application/json' } });
    return Response.json(bundle());
  } });
  const server = createServer(tls, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url, origin), chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const options = { method: incoming.method, headers: incoming.headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) ? { body: Buffer.concat(chunks) } : {}) };
      const localEnv = { ...env, DASHBOARD_ORIGIN: origin };
      if (state.bootstrap) localEnv.DASHBOARD_BOOTSTRAP_REPORT = 'gzip:' + gzipSync(JSON.stringify(bundle())).toString('base64');
      let response;
      if (['legacy', 'bundle'].includes(state.mode) && url.pathname.startsWith('/api/')) {
        // Inject compatibility/corruption responses after the real built Worker's authentication gate.
        const gate = await worker.fetch(new Request(origin + '/app.mjs', options), localEnv);
        if (gate.status !== 200) response = gate;
        else if (state.mode === 'bundle') response = Response.json(bundle());
        else response = url.pathname === '/api/report' ? new Response(null, { status: 404 })
          : Response.json(url.pathname.endsWith('predictions.json') ? state.report : state.receipt);
      } else response = await worker.fetch(new Request(url, options), localEnv);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { errors.push(error.message); outgoing.writeHead(500); outgoing.end('Test server failed'); }
  });
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `https://127.0.0.1:${server.address().port}`;
  // Permit only the local test server. Public requests are never used by these tests.
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  const login = async () => {
    await page.goto(origin + '/');
    await page.getByLabel('用户名').fill(auth.username); await page.getByLabel('密码').fill(password);
    await page.getByRole('button', { name: '登录看板 →' }).click();
    await page.waitForFunction(() => document.querySelector('#count-analysis')?.textContent === '2');
  };
  const refresh = async () => {
    await page.getByRole('button', { name: '刷新报告 ↻' }).click();
    await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  };
  t.after(() => assert.deepEqual(errors, [], 'The dashboard must not produce uncaught browser errors'));
  return { page, context, state, login, refresh, origin };
}

test('built website: login cookie, classifications, keyboard navigation, stable details and logout', { timeout: 60000 }, async t => {
  const { page, context, state, login } = await dashboard(t);
  await login();
  const session = (await context.cookies()).find(c => c.name === '__Host-dimension_session');
  assert.ok(session); assert.equal(session.secure, true); assert.equal(session.httpOnly, true); assert.equal(session.sameSite, 'Lax');
  assert.equal(await page.locator('#count-strict').textContent(), '1'); assert.equal(await page.locator('#count-missing').textContent(), '1');
  const summary = page.locator('[data-fixture-id="analysis"] summary');
  await summary.click(); await summary.focus();
  await page.clock.fastForward(31000);
  assert.equal(await page.locator('[data-fixture-id="analysis"] details').evaluate(node => node.open), true);
  assert.equal(await summary.evaluate(node => node === document.activeElement), true);
  await page.getByRole('tab', { name: '普通预测', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '严格候选', exact: true }).getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#cards').textContent(), /严格主队/);
  await page.keyboard.press('End'); assert.match(await page.locator('#cards').textContent(), /缺项主队/);
  await page.keyboard.press('Home'); assert.equal(await page.locator('[data-fixture-id="analysis"] details').evaluate(node => node.open), true);
  state.serverNow += 43200001;
  await page.getByRole('button', { name: '刷新报告 ↻' }).click();
  await page.waitForURL('**/login'); assert.equal(await page.getByRole('heading', { name: '登录预测看板' }).count(), 1);
  state.serverNow = NOW; await context.clearCookies();
  await login(); await page.getByRole('button', { name: '退出登录' }).click(); await page.waitForURL('**/login');
  assert.equal((await context.cookies()).some(c => c.name === '__Host-dimension_session'), false);
});

test('built website: 502, malformed JSON/schema and stale reports preserve the last valid cards', { timeout: 60000 }, async t => {
  const { page, state, login, refresh } = await dashboard(t);
  await login();
  const original = await page.locator('#updated').textContent();
  state.status = 404; await refresh(); assert.match(await page.locator('#warning').textContent(), /本次刷新失败/);
  assert.equal(await page.locator('#updated').textContent(), original);
  state.status = 200; state.invalidJson = true; await refresh(); assert.equal(await page.locator('#count-analysis').textContent(), '2');
  state.invalidJson = false; state.mode = 'bundle'; state.report = sampleReport('b'); state.report.fixtures[0] = {};
  await refresh(); assert.equal(await page.locator('#updated').textContent(), original);
  state.report = sampleReport('b', -1000); state.receipt = sampleReceipt(state.report); await refresh();
  assert.equal(await page.locator('#updated').textContent(), original);
  state.report = sampleReport('b', 1000); state.receipt = sampleReceipt(state.report, '222'); await refresh();
  assert.match(await page.locator('#updated').textContent(), /bbbbbbbbbbbb/);
});

test('built website: legacy report/receipt mismatch resets the run link without adopting stale delivery', { timeout: 60000 }, async t => {
  const { page, state, login, refresh } = await dashboard(t, 'legacy');
  await login(); assert.match(await page.locator('#run-link').getAttribute('href'), /runs\/111$/);
  state.report = sampleReport('b', 1000); await refresh();
  assert.match(await page.locator('#delivery').textContent(), /正在同步/);
  assert.match(await page.locator('#run-link').getAttribute('href'), /actions\/workflows\/public-sources.yml$/);
  state.receipt = null; await refresh(); assert.match(await page.locator('#run-link').getAttribute('href'), /actions\/workflows/);
  state.receipt = sampleReceipt(state.report, '222'); await refresh(); assert.match(await page.locator('#run-link').getAttribute('href'), /runs\/222$/);
});

test('built website: coherent bundle, bootstrap warning, expiration and 401 redirect', { timeout: 60000 }, async t => {
  const { page, context, state, login, refresh } = await dashboard(t, 'bundle');
  state.freshness = { mode: 'bootstrap' }; state.health = { status: 'upstream_unavailable' }; await login();
  assert.match(await page.locator('#warning').textContent(), /启动快照/); assert.match(await page.locator('#warning').textContent(), /上游暂不可用/);
  state.report = sampleReport('b', 1000); // Mismatched bundle receipt rejects the entire candidate snapshot.
  await refresh(); assert.match(await page.locator('#updated').textContent(), /aaaaaaaaaaaa/);
  state.receipt = sampleReceipt(state.report); await refresh(); assert.match(await page.locator('#updated').textContent(), /bbbbbbbbbbbb/);
  await page.clock.fastForward(3600001);
  await page.waitForFunction(() => document.querySelector('#count-analysis').textContent === '0');
  assert.equal(await page.locator('#count-strict').textContent(), '0'); assert.equal(await page.locator('#count-missing').textContent(), '3');
  assert.match(await page.locator('#warning').textContent(), /预测已过期/);
  await context.clearCookies(); await page.clock.fastForward(60001); await page.waitForURL('**/login');
});

test('built website: a timer cannot start a second fetch while manual refresh is pending', { timeout: 60000 }, async t => {
  const { page, state, login } = await dashboard(t); await login();
  await page.clock.fastForward(59000);
  const before = state.calls;
  let release; state.gate = new Promise(resolve => { release = resolve; });
  await page.getByRole('button', { name: '刷新报告 ↻' }).click();
  await page.waitForFunction(() => document.querySelector('#refresh').disabled);
  // Cross the periodic tick while staying inside the request's 12-second deadline.
  await page.clock.fastForward(2000);
  assert.equal(state.calls - before, 1);
  release(); state.gate = null; await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  assert.match(await page.locator('#updated').textContent(), /aaaaaaaaaaaa/);
  state.report = sampleReport('b', 1000); state.receipt = sampleReceipt(state.report);
  await page.clock.fastForward(60000);
  await page.waitForFunction(() => document.querySelector('#updated').textContent.includes('bbbbbbbbbbbb'));
  assert.equal(state.calls - before, 2, 'The next one-minute tick fetches the newer report once');
});

test('built website: reference horizons, actual effective samples and safely filtered coverage retain legacy fallbacks', { timeout: 60000 }, async t => {
  const { page, state, login, refresh } = await dashboard(t, 'bundle');
  const seed = state.report.backtests[0];
  state.report.backtests = [1, 24, 72, 168].map(horizonHours => ({ ...seed, source: 'openligadb', horizonHours,
    purpose: horizonHours === 24 ? 'actual-publication-horizon' : 'reference-horizon', visibility: horizonHours === 24 ? 'as-observed' : 'snapshot' }));
  state.report.backtests.push({ ...seed, source: 'openligadb', horizonHours: 13.5, purpose: 'actual-publication-horizon' });
  const forecast = state.report.fixtures[0].forecast;
  forecast.horizonHours = 13.5; forecast.validation.visibility = 'snapshot';
  forecast.sampleQuality = { weighted: { home: { effectiveMatches: 7.25 }, away: { effectiveMatches: 8.75 } } };
  state.report.coverage = [{ source: 'openligadb', league: 'BL1', fixtureCount: 3, historyCount: 144, fixtureStatus: 'sample', historyStatus: 'available' },
    null, { source: 'invalid', league: 'PL', fixtureCount: '3', historyCount: 0 },
    { source: '<img src=x onerror=alert(1)>', league: 'PL', fixtureCount: 0, historyCount: 0, fixtureStatus: 'unavailable', historyStatus: 'not-supported' }];
  await login();
  const validation = await page.locator('#validation').textContent();
  for (const hours of [1, 24, 72, 168]) assert.ok(validation.includes(`提前 ${hours} 小时`));
  assert.ok(!validation.includes('13.5')); assert.doesNotMatch(validation, /openligadb|Brier|Log loss/); assert.match(validation, /布里尔评分/); assert.match(validation, /对数损失/); assert.match(validation, /按已观察历史回放/);
  assert.match(await page.locator('[data-fixture-id="analysis"] details').textContent(), /实际预测提前 13.5 小时.*有效加权样本（主 \/ 客）7.3 \/ 8.8/s);
  assert.match(await page.locator('#coverage').textContent(), /赛程 3 场 · 样本覆盖；历史 144 场 · 可用/);
  assert.equal(await page.locator('#coverage img').count(), 0); assert.equal(await page.locator('#coverage .detail-row').count(), 2);
  assert.doesNotMatch(await page.locator('#coverage').textContent(), /openligadb|<img|onerror/);
  state.report = sampleReport('b', 1000); state.receipt = sampleReceipt(state.report);
  state.report.fixtures[0].forecast.sampleQuality = { weighted: { home: { effectiveMatches: 'invalid' }, away: { effectiveMatches: -1 } } };
  state.report.coverage = [null, { fixtureCount: 'invalid' }]; await refresh();
  assert.match(await page.locator('#validation').textContent(), /40 场回测/);
  assert.match(await page.locator('[data-fixture-id="analysis"] details').textContent(), /实际预测提前量未记录.*有效加权样本（主 \/ 客）未知 \/ 未知/s);
  assert.match(await page.locator('#coverage').textContent(), /未记录可核验/);
});

test('built website: all views localize names and machine labels without changing source JSON', { timeout: 60000 }, async t => {
  const { page, state, login } = await dashboard(t, 'bundle');
  const fixture = state.report.fixtures[0].fixture;
  Object.assign(fixture, { home: 'Bayern Munich', away: 'Borussia Dortmund', source: 'openligadb', homeTeamId: '40', awayTeamId: '7' });
  state.report.fixtures[0].marketCandidate.readiness.blockers = ['UNKNOWN_MACHINE_REASON'];
  state.report.fixtures[1].fixture.league = 'UNKNOWN_LEAGUE';
  state.report.fixtures[1].marketCandidate.candidate.quoteGroups = ['hkjc', 'unknown-provider-group'];
  state.report.fixtures[2].forecast.reasons = ['HOME_HISTORY_INSUFFICIENT', 'UNKNOWN_MACHINE_REASON'];
  state.report.backtests[0].source = 'unknown-provider';
  state.report.attribution = [{ name: 'OpenLigaDB', license: 'ODbL', url: 'https://example.test/data' },
    { name: 'Unknown Provider', license: 'Unknown License', url: 'https://example.test/license' }];
  state.report.coverage = [{ source: 'unknown-provider', league: 'UNKNOWN_LEAGUE', fixtureCount: 0, historyCount: 0,
    fixtureStatus: 'UNKNOWN_STATUS', historyStatus: 'UNKNOWN_STATUS' }];
  await login();
  assert.match(await page.locator('[data-fixture-id="analysis"] .teams').textContent(), /拜仁慕尼黑.*对阵.*多特蒙德/);
  assert.match(await page.locator('#validation').textContent(), /布里尔评分.*对数损失/s);
  assert.match(await page.locator('#delivery').textContent(), /机器人通知/);
  assert.match(await page.locator('#attribution').textContent(), /开放联赛原始数据与许可/);
  for (const label of ['普通预测', '严格候选', '暂不可评估']) {
    await page.getByRole('tab', { name: label, exact: true }).click();
    const text = (await page.locator('body').textContent()).replace(/报告编号 [a-f0-9]{12}/g, '报告编号');
    assert.doesNotMatch(text, /[A-Za-z]/, `${label} must use Chinese labels, including unknown metadata`);
  }
  const original = await page.evaluate(async () => (await (await fetch('/api/report')).json()).report);
  assert.equal(original.fixtures[0].fixture.home, 'Bayern Munich');
  assert.equal(original.backtests[0].source, 'unknown-provider');
  assert.equal(original.attribution[0].license, 'ODbL');
});


test('built Worker: ECS authorization, machine probe and visitor sessions stay separate', { timeout: 60000 }, async t => {
  const { page, context, origin, login } = await dashboard(t);
  const probe = origin + '/internal/report-status';
  assert.equal((await context.request.get(probe)).status(), 401);
  assert.equal((await context.request.get(probe, { headers: { Authorization: 'Bearer wrong' } })).status(), 401);
  const privileged = await context.request.get(probe, { headers: { Authorization: 'Bearer ' + env.REPORTS_PROBE_TOKEN } });
  assert.equal(privileged.status(), 200);
  const status = await privileged.json();
  assert.deepEqual(Object.keys(status).sort(), ['generatedAt', 'health', 'mode', 'reportHash', 'reportId', 'version']);
  assert.equal(status.mode, 'ecs'); assert.equal(status.reportId, 'a'.repeat(64)); assert.match(status.reportHash, /^[a-f0-9]{64}$/);
  assert.equal((await context.request.get(origin + '/api/report', { headers: { Authorization: 'Bearer ' + env.REPORTS_PROBE_TOKEN } })).status(), 401);
  await login();
  assert.equal(await page.evaluate(async () => (await fetch('/internal/report-status')).status), 401);
  assert.equal(await page.evaluate(async () => (await fetch('/api/report')).status), 200);
});

test('built Worker: upstream failure serves an explicitly labelled compressed bootstrap without renewing prediction validity', { timeout: 60000 }, async t => {
  const { page, state, login } = await dashboard(t);
  state.status = 503; state.bootstrap = true; await login();
  assert.match(await page.locator('#warning').textContent(), /启动快照/);
  assert.match(await page.locator('#warning').textContent(), /上游暂不可用/);
  const bundle = await page.evaluate(async () => (await fetch('/api/report')).json());
  assert.equal(bundle.freshness.mode, 'bootstrap'); assert.equal(bundle.health.status, 'upstream_unavailable');
  assert.equal(bundle.report.generatedAt, sampleReport().generatedAt);
  assert.equal(bundle.report.fixtures[0].forecast.freshness.validUntil, sampleReport().fixtures[0].forecast.freshness.validUntil);
  await page.clock.fastForward(3600001);
  await page.waitForFunction(() => document.querySelector('#count-analysis').textContent === '0');
  assert.equal(await page.locator('#count-missing').textContent(), '3');
  assert.match(await page.locator('#warning').textContent(), /预测已过期/);
});
