// Focused browser acceptance of source UI and local synthetic report responses.
// This does not certify build embedding, login, deployment or live collection.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { NOW, sampleReport, sampleReceipt } from './fixtures.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const historicalEvidence = JSON.parse(await readFile(join(root, 'website/evaluation-evidence.json')));
const historicalGroup = historicalEvidence.groups.find(row => row.league === 'BL1' && row.horizonHours === 24);
const historicalSample = `${historicalGroup.evaluated} 场`;
let browser;
before(async () => {
  const modulePath = process.env.PLAYWRIGHT_MODULE || join(root, 'collector/browser-runtime/node_modules/playwright/index.mjs');
  const { chromium } = await import(pathToFileURL(resolve(modulePath)));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
});
after(async () => browser?.close());

function summary() {
  return { version: 1, checkedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 240000).toISOString(), fixtureCount: 1,
    sources: [['hkjc', 'hkjc-first-party'], ['macauslot', 'macauslot-official'], ['titan007', 'titan007']].map(([id, group], i) => ({
      id, group, status: i < 2 ? 'available' : 'unavailable', quoteCount: i < 2 ? 2 : 0, pairedFixtureCount: i < 2 ? 1 : 0,
      latestSourceUpdatedAt: i < 2 ? new Date(NOW - 60000).toISOString() : null, openingCount: 0,
    })), dualSourceFixtureCount: 1, alignedEligibleFixtureCount: 1, trueOpeningFixtureCount: 0, releaseGate: 'BLOCKED' };
}
async function dashboard(t, viewport = { width: 1440, height: 1000 }) {
  const report = sampleReport(); report.publicationKind = 'observations'; report.marketObservation = summary();
  report.acquisition = { checkedAt: new Date(NOW - 3600000).toISOString() };
  report.summary = { fixtures: 3, forecasts: 0, unavailable: 3, strictCandidates: 0 };
  for (const row of report.fixtures) {
    row.forecast = { status: 'unavailable', reasons: ['RELEASE_GATE_BLOCKED'] };
    row.marketCandidate = { status: 'source_insufficient', reasons: ['RELEASE_GATE_BLOCKED'], candidate: null,
      readiness: { quoteGroups: [], verifiedOpeningCount: 0, blockers: ['RELEASE_GATE_BLOCKED'] } };
  }
  const state = { report, reportStatus: 200, experimentStatus: 200, experimentBody: null };
  const files = new Map(await Promise.all(['index.html', 'app.mjs', 'style.css', 'report-schema.mjs', 'locale-zh.mjs',
    'evaluation-evidence.json', 'model-experiment-evidence.json'].map(async name => ['/' + name, await readFile(join(root, 'website', name))])));
  const errors = [], context = await browser.newContext({ viewport });
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/report') {
      res.writeHead(state.reportStatus, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ version: 1, reportId: state.report.publication.reportId, report: state.report, receipt: sampleReceipt(state.report) }));
    }
    if (path === '/model-experiment-evidence.json') {
      res.writeHead(state.experimentStatus, { 'content-type': 'application/json' });
      return res.end(state.experimentBody ?? files.get(path));
    }
    const asset = files.get(path === '/' ? '/index.html' : path);
    res.writeHead(asset ? 200 : 404, { 'content-type': path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.json') ? 'application/json' : 'text/html' });
    res.end(asset || 'Not found');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: NOW });
  t.after(async () => { await context.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, []); });
  const open = async () => { await page.goto(origin); await page.waitForFunction(() => document.querySelector('#count-fixtures')?.textContent === '3'); };
  const refresh = async () => {
    await page.locator('#refresh').click(); await page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  };
  return { page, state, open, refresh };
}

test('source UI: desktop/mobile show a market subset, frozen 982/182 experiment, current historical archive and zero formal picks', { timeout: 60000 }, async t => {
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const { page, open } = await dashboard(t, viewport); await open();
    await page.waitForFunction(() => document.querySelector('#experiment-input').textContent === '982 条');
    assert.equal(await page.locator('#market-paired-count').textContent(), '1 场');
    assert.equal(await page.locator('#market-aligned-count').textContent(), '1 场');
    assert.equal(await page.locator('#market-opening-gap').textContent(), '1 场');
    assert.match(await page.locator('#market-source-table').textContent(), /香港马会.*澳门彩票官方.*球探/s);
    assert.match(await page.locator('#market-source-table').textContent(), /19:59 北京时间/);
    assert.equal(await page.locator('#experiment-holdout').textContent(), '182 / 199');
    assert.equal(await page.locator('#experiment-observed').textContent(), '0 场');
    assert.match(await page.locator('#experiment-badge').textContent(), /未采用/);
    assert.match(await page.locator('#experiment-binding').textContent(), /1b4a43bd1a27/);
    assert.match(await page.locator('#experiment-table').textContent(), /0\.587097.*0\.588516.*\+0\.001420/s);
    assert.equal(await page.locator('#history-sample').textContent(), historicalSample);
    assert.match(await page.locator('#market-scope').textContent(), /本轮受检赛事 1 场.*报告共 3 场/);
    assert.match(await page.locator('#collected-at').textContent(), /19:00/);
    assert.equal(await page.locator('#data-age').textContent(), '1 小时 0 分钟');
    assert.match(await page.locator('#updated').textContent(), /报告生成.*20:00 北京时间/);
    assert.equal(await page.locator('#today-picks-count').textContent(), '0');
    assert.equal(await page.locator('#count-publishable').textContent(), '0');
    assert.equal(await page.locator('#count-strict').textContent(), '0');
    assert.equal(await page.locator('[data-fixture-id]').count(), 3);
    const layout = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      overflowing: [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 10).map(node => `${node.tagName}#${node.id}.${node.className}`) }));
    assert.ok(layout.scrollWidth <= layout.width + 1, `viewport must not overflow horizontally: ${JSON.stringify(layout)}`);
    for (const target of ['#picks', '#backtest', '#schedule']) {
      await page.locator(`.section-nav a[href="${target}"]`).click();
      assert.equal(new URL(page.url()).hash, target);
    }
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, `a6-${name}.png`), fullPage: true });
    }
  }
});

test('source UI: invalid observation and unavailable experiment degrade independently; historical archive and schedule keep working', { timeout: 60000 }, async t => {
  const { page, state, open, refresh } = await dashboard(t);
  state.report.marketObservation.releaseGate = 'GREEN'; state.experimentStatus = 404; await open();
  await page.waitForFunction(() => document.querySelector('#experiment-state').textContent.includes('未加载'));
  assert.equal(await page.locator('#market-observation-content').isVisible(), false);
  assert.match(await page.locator('#market-observation-state').textContent(), /缺少有效/);
  assert.equal(await page.locator('#history-sample').textContent(), historicalSample);
  assert.equal(await page.locator('[data-fixture-id]').count(), 3);
  state.report.marketObservation = summary(); state.experimentStatus = 200; await refresh();
  await page.waitForFunction(() => document.querySelector('#experiment-input').textContent === '982 条');
  assert.equal(await page.locator('#market-paired-count').textContent(), '1 场');
  state.experimentBody = JSON.stringify({ version: 9, recommendations: ['malicious'] }); state.reportStatus = 502;
  await refresh(); await page.waitForFunction(() => document.querySelector('#experiment-state').textContent.includes('保留上次'));
  assert.equal(await page.locator('#experiment-holdout').textContent(), '182 / 199');
  assert.equal(await page.locator('#history-sample').textContent(), historicalSample);
  assert.match(await page.locator('#warning').textContent(), /本次刷新失败/);
  assert.equal(await page.locator('#today-picks-count').textContent(), '0');
});

test('source UI: zero inspected markets retain full schedules and a market refresh cannot renew schedule freshness', { timeout: 60000 }, async t => {
  const { page, state, open, refresh } = await dashboard(t); await open();
  const originalScheduleTime = await page.locator('#collected-at').textContent();
  const value = summary(); value.fixtureCount = value.dualSourceFixtureCount = value.alignedEligibleFixtureCount = 0;
  value.sources.forEach(row => Object.assign(row, { status: 'missing', quoteCount: 0, pairedFixtureCount: 0, latestSourceUpdatedAt: null }));
  state.report.marketObservation = value;
  await refresh();
  assert.match(await page.locator('#market-scope').textContent(), /本轮受检赛事 0 场.*报告共 3 场/);
  assert.equal(await page.locator('#market-paired-count').textContent(), '0 场');
  assert.equal(await page.locator('[data-fixture-id]').count(), 3);
  await page.clock.setFixedTime(new Date(NOW + 60000));
  state.report.generatedAt = new Date(NOW + 60000).toISOString();
  state.report.marketObservation.checkedAt = state.report.generatedAt;
  await refresh();
  assert.equal(await page.locator('#collected-at').textContent(), originalScheduleTime);
  assert.equal(await page.locator('#data-age').textContent(), '1 小时 1 分钟');
  assert.match(await page.locator('#updated').textContent(), /报告生成.*20:01 北京时间/);
  state.report.marketObservation.fixtureCount = 4;
  await refresh();
  assert.equal(await page.locator('#market-observation-content').isVisible(), false);
  assert.equal(await page.locator('[data-fixture-id]').count(), 3);
});

test('source UI: aged observation explicitly becomes historical while true source times remain unchanged', { timeout: 60000 }, async t => {
  const { page, open } = await dashboard(t); await open();
  const sourceTimes = await page.locator('#market-source-table').textContent();
  await page.clock.fastForward(300001);
  await page.waitForFunction(() => document.querySelector('#market-observation-state').textContent.includes('摘要已过期'));
  assert.equal(await page.locator('#market-source-table').textContent(), sourceTimes);
  assert.match(await page.locator('#market-scope').textContent(), /过期观察/);
  assert.equal(await page.locator('#market-observation-badge').textContent(), '未核验');
  assert.equal(await page.locator('#today-picks-count').textContent(), '0');
});
