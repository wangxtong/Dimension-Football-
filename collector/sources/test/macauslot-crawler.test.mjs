import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { crawlerTarget, withPublicCrawler, readCrawlerPolicy } from '../crawler.mjs';

const NOW = '2026-10-31T10:05:17.264Z', ORIGIN = 'https://www.macauslot.com';
const EVENT = `${ORIGIN}/soccer/json/realtime/threeinone_event_cn_fb.json`;
const ODDS = `${ORIGIN}/soccer/json/realtime/threeinone_odds_cn_fb.json`;
const policy = readCrawlerPolicy({ minIntervalMs: 100, maxRetries: 0 });
const page = (body, headers = {}, status = 200) => new Response(body, { status,
  headers: { Date: new Date(NOW).toUTCString(), 'Last-Modified': 'Sat, 31 Oct 2026 10:04:36 GMT', ...headers } });
async function state(t) {
  const path = await mkdtemp(join(tmpdir(), 'macau-crawler-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return join(path, 'crawl.json');
}

test('Macau capability permits only the two exact read-only JSON routes', () => {
  assert.equal(crawlerTarget(EVENT).responseMaxBytes, 1_500_000);
  assert.equal(crawlerTarget(ODDS).responseMaxBytes, 4 * 1024 * 1024);
  assert.equal(crawlerTarget(ODDS).responseTimeoutMs, 12_000);
  assert.equal(crawlerTarget('https://www.statarea.com/predictions').responseTimeoutMs, undefined);
  for (const url of [ODDS + '?token=', ODDS + '?r=1', ODDS + '#fragment', ODDS.replace('www.macauslot.com', 'www.macau-slot.com'),
    ODDS.replace('www.macauslot.com', 'macauslot.com'), `${ORIGIN}/soccer/json/realtime/private.json`, `${ORIGIN}/account`, `${ORIGIN}/robots.txt`]) {
    assert.throws(() => crawlerTarget(url), { code: 'crawler_target_denied' });
  }
  assert.throws(() => crawlerTarget(ODDS, 'POST', 'token='), { code: 'crawler_target_denied' });
  assert.throws(() => crawlerTarget(ODDS, 'GET', ''), { code: 'crawler_target_denied' });
});

test('ten-second robots spacing is enforced between Macau requests and shares the request budget', async t => {
  const statePath = await state(t), calls = [], controller = new AbortController();
  t.after(() => controller.abort());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = withPublicCrawler({ statePath, policy: { ...policy, maxRequests: 3 }, clock: () => NOW,
    signal: controller.signal, fetchImpl: async url => { calls.push(url); return page(url.endsWith('/robots.txt') ? 'User-agent: *\nCrawl-delay: 10' : '{}'); } },
  async fetchPublic => {
    await fetchPublic(EVENT); await fetchPublic(ODDS);
    await assert.rejects(fetchPublic('https://www.statarea.com/predictions'), { code: 'crawler_budget_exhausted' });
  });
  while (!calls.length) await nextTurn();
  await nextTurn(); t.mock.timers.tick(9000); await nextTurn();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1100); await nextTurn();
  assert.equal(calls.length, 2);
  t.mock.timers.tick(9000); await nextTurn(); assert.equal(calls.length, 2);
  t.mock.timers.tick(1100); const result = await pending;
  assert.deepEqual(calls, [`${ORIGIN}/robots.txt`, EVENT, ODDS]);
  assert.equal(result.crawler.networkRequests, 3);
});

test('Macau robots delay cannot exceed remaining budget or silently accept a longer site interval', async t => {
  for (const [seconds, remaining] of [[10, 5000], [11, Infinity]]) {
    const statePath = await state(t), calls = [];
    await withPublicCrawler({ statePath, policy, clock: () => NOW, remaining: () => remaining,
      fetchImpl: async url => { calls.push(url); return page(`User-agent: *\nCrawl-delay: ${seconds}`); } },
    fetchPublic => assert.rejects(fetchPublic(ODDS), { code: 'crawl_delay_exceeds_budget' }));
    assert.deepEqual(calls, [`${ORIGIN}/robots.txt`]);
  }
});

test('only registered Macau responses may take twelve seconds, always bounded by the remaining run budget', async t => {
  const statePath = await state(t); let requested = false, expired = false;
  let robotsReady, dataReady;
  const robotsSeen = new Promise(resolve => { robotsReady = resolve; }), dataSeen = new Promise(resolve => { dataReady = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = withPublicCrawler({ statePath, policy, clock: () => NOW, fetchImpl: async url => {
    if (url.endsWith('/robots.txt')) { robotsReady(); return page('User-agent: *\nDisallow:'); }
    requested = true; dataReady();
    return new Promise(resolve => setTimeout(() => resolve(page('{}')), 8000));
  } }, async fetchPublic => { await fetchPublic(ODDS); expired = true; });
  await robotsSeen; await nextTurn(); t.mock.timers.tick(100); await dataSeen;
  assert.equal(requested, true);
  t.mock.timers.tick(4000); await nextTurn(); assert.equal(expired, false);
  t.mock.timers.tick(4000); await pending; assert.equal(expired, true);

  const otherState = await state(t); let dataCall = false;
  let otherRobotsReady, otherDataReady;
  const otherRobots = new Promise(resolve => { otherRobotsReady = resolve; }), otherData = new Promise(resolve => { otherDataReady = resolve; });
  const bounded = withPublicCrawler({ statePath: otherState, policy, clock: () => NOW, remaining: () => 5000,
    fetchImpl: async url => {
      if (url.endsWith('/robots.txt')) { otherRobotsReady(); return page('User-agent: *\nDisallow:'); }
      dataCall = true; otherDataReady(); return new Promise(() => {});
    } }, fetchPublic => assert.rejects(fetchPublic(ODDS), { code: 'crawler_timeout' }));
  await otherRobots; await nextTurn(); t.mock.timers.tick(100); await otherData;
  assert.equal(dataCall, true); t.mock.timers.tick(5000); await bounded;
});

test('only Macau odds receive a four-MiB limit; cached bodies preserve source times across restart', async t => {
  const statePath = await state(t), payload = 'x'.repeat(2_198_145); let calls = 0;
  const options = { statePath, policy, clock: () => NOW, fetchImpl: async url => {
    calls++; return page(url.endsWith('/robots.txt') ? 'User-agent: *\nDisallow:' : payload);
  } };
  await withPublicCrawler(options, async fetchPublic => {
    const response = await fetchPublic(ODDS); assert.equal((await response.text()).length, payload.length);
    assert.equal(response.headers.get('last-modified'), 'Sat, 31 Oct 2026 10:04:36 GMT');
    await assert.rejects(fetchPublic(EVENT), { code: 'crawler_response_too_large' });
  });
  assert.equal(calls, 3);
  await withPublicCrawler({ ...options, fetchImpl: () => assert.fail('cache must not re-fetch') }, async fetchPublic => {
    const response = await fetchPublic(ODDS); assert.equal((await response.text()).length, payload.length);
    assert.equal(response.headers.get('date'), new Date(NOW).toUTCString());
  });
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.cache[ODDS].fetchedAt, NOW);
  assert.equal(saved.cache[EVENT], undefined);
});

test('oversized Macau odds and robots-denied data fail without widening access', async t => {
  for (const denied of [true, false]) {
    const statePath = await state(t), calls = [];
    await withPublicCrawler({ statePath, policy, clock: () => NOW, fetchImpl: async url => {
      calls.push(url);
      return url.endsWith('/robots.txt') ? page(`User-agent: *\nDisallow: ${denied ? '/soccer/' : ''}`)
        : page('', { 'Content-Length': String(4 * 1024 * 1024 + 1) });
    } }, fetchPublic => assert.rejects(fetchPublic(ODDS), { code: denied ? 'robots_denied' : 'crawler_response_too_large' }));
    assert.equal(calls.length, denied ? 1 : 2);
  }
});
