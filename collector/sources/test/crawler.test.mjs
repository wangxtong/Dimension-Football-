import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPublicCrawler, readCrawlerPolicy, crawlerTarget, PUBLIC_PROBES } from '../crawler.mjs';
import { robotsPolicy } from '../robots.mjs';
import { collectCrawledEvidence } from '../index.mjs';
import { runCrawlCheck } from '../../crawl.mjs';

const NOW = '2026-10-27T08:30:00.000Z', TITAN = 'https://livestatic.titan007.com/vbsxml/goal17.xml';
const STATAREA = 'https://www.statarea.com/predictions', TTY = PUBLIC_PROBES.find(row => row.sourceId === 'tiantian');
const policy = readCrawlerPolicy({ minIntervalMs: 100, retryDelayMs: 100 });
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();
const page = (text = 'public content', status = 200, headers = {}) => new Response(status === 304 ? null : text,
  { status, headers: { Date: new Date(NOW).toUTCString(), ...headers } });
async function harness(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'football-crawler-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const statePath = join(cwd, 'crawl.json');
  return { cwd, statePath, run: (fetchImpl, operation, options = {}) => withPublicCrawler({ statePath, policy,
    clock: () => NOW, fetchImpl, ...options }, operation) };
}
const allowRobots = fetchData => async (url, init) => new URL(url).pathname === '/robots.txt'
  ? page('User-agent: *\nAllow: /') : fetchData(url, init);

test('robots rules select specific agent groups, longest paths, wildcard/end anchors and Allow ties', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: DimensionFootballCrawler\nDisallow: /predictions\nAllow: /predictions/date/\nCrawl-delay: 2\n';
  assert.deepEqual(robotsPolicy(text, STATAREA), { allowed: false, delayMs: 2000 });
  assert.equal(robotsPolicy(text, `${STATAREA}/date/2026-10-28/competition`).allowed, true);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /*.xml$\nAllow: /vbsxml/goal17.xml', TITAN).allowed, true);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /*.xml$', TITAN.replace('17', '24')).allowed, false);
  assert.equal(robotsPolicy('User-agent: *\nDisallow:', STATAREA).allowed, true);
  for (const rule of ['/%70redictions', '/predictions', '/%70%72edictions']) {
    assert.equal(robotsPolicy(`User-agent: *\nDisallow: ${rule}`, STATAREA).allowed, false);
  }
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /caf%C3%A9', 'https://www.statarea.com/café').allowed, false);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /café', 'https://www.statarea.com/caf%c3%a9').allowed, false);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /a%2fb', 'https://www.statarea.com/a/b').allowed, true);
  assert.equal(robotsPolicy('User-agent: *\nDisallow: /a%2fb', 'https://www.statarea.com/a%2Fb').allowed, false);
});

test('browser navigation and assets share robots, pacing and the exact HTTP request budget', async t => {
  const h = await harness(t), starts = [], outcomes = [];
  const browser = { matches: url => url === STATAREA, metadata: { engine: 'mock-browser' },
    fetch: async (url, init) => {
      for (const [target, navigation] of [[url, true], ['https://www.statarea.com/assets/blocked.js', false],
        ['https://www.statarea.com/assets/a.js', false], ['https://www.statarea.com/assets/b.js', false]]) {
        try {
          await init.requestPolicy.beforeRequest({ url: target, navigation, method: 'GET', resourceType: navigation ? 'document' : 'script' });
          starts.push(performance.now());
          await init.requestPolicy.afterResponse({ status: 200, headers: new Headers() });
          outcomes.push('fetched');
        } catch (error) { outcomes.push(error.code); }
      }
      return page();
    } };
  const result = await h.run(async () => page('User-agent: *\nDisallow: /assets/blocked.js\nCrawl-delay: 0.1'),
    fetchPublic => fetchPublic(STATAREA), { browser, policy: { ...policy, minIntervalMs: 100, maxRequests: 3 } });
  assert.deepEqual(outcomes, ['fetched', 'robots_denied', 'fetched', 'crawler_budget_exhausted']);
  assert.equal(result.crawler.networkRequests, 3); // robots + navigation + one permitted asset
  assert.ok(starts[1] - starts[0] >= 90);
});

test('browser resource Retry-After prevents later resources and survives the next round', async t => {
  const h = await harness(t); let fetches = 0;
  const browser = { matches: url => url === STATAREA,
    fetch: async (url, init) => {
      await init.requestPolicy.beforeRequest({ url, navigation: true, method: 'GET', resourceType: 'document' });
      fetches++;
      await init.requestPolicy.afterResponse({ status: 429, headers: new Headers({ 'retry-after': '7200' }) });
    } };
  await h.run(async () => page('User-agent: *\nAllow: /'), fetchPublic => assert.rejects(fetchPublic(STATAREA), { code: 'rate_limited' }), { browser });
  await h.run(() => assert.fail('cooldown must suppress all traffic'), fetchPublic => assert.rejects(fetchPublic(STATAREA), { code: 'crawler_cooldown' }), { browser });
  assert.equal(fetches, 1);
});

test('allowlist and credential boundary reject unknown URLs, write-like POSTs and secret headers before any network', async t => {
  const h = await harness(t); let calls = 0;
  await h.run(async () => { calls++; assert.fail('network forbidden'); }, async fetchPublic => {
    for (const url of ['http://www.statarea.com/predictions', 'https://127.0.0.1/', 'https://www.forebet.com/',
      'https://token@www.statarea.com/predictions', `${STATAREA}?token=secret`, TITAN.replace('17', '3')]) {
      await assert.rejects(fetchPublic(url), { code: 'crawler_target_denied' });
    }
    await assert.rejects(fetchPublic(STATAREA, { headers: { Authorization: 'secret' } }), { code: 'crawler_credentials_rejected' });
    await assert.rejects(fetchPublic(TTY.url, { method: 'POST', body: 'pageNo=999' }), { code: 'crawler_target_denied' });
  });
  assert.equal(calls, 0);
  for (const bad of [{ minIntervalMs: 0 }, { maxRequests: 101 }, { stealth: true }, { maxRetries: 9 }]) assert.throws(() => readCrawlerPolicy(bad));
  assert.equal(crawlerTarget(TITAN + '?r=007123').key, TITAN);
});

test('robots disallow, failed policy lookup and HTML challenges never issue the data request', async t => {
  for (const [text, status, code] of [['User-agent: *\nDisallow: /', 200, 'robots_denied'],
    ['Denied', 403, 'robots_denied'], ['upstream unavailable', 503, 'robots_unavailable'],
    ['<html>challenge</html>', 200, 'robots_unavailable']]) {
    const h = await harness(t), urls = [];
    await h.run(async url => { urls.push(url); return page(text, status); }, async fetchPublic => {
      await assert.rejects(fetchPublic(STATAREA), { code });
    });
    assert.deepEqual(urls, ['https://www.statarea.com/robots.txt']);
  }
  const h = await harness(t);
  const result = await h.run(async url => new URL(url).pathname === '/robots.txt' ? page('', 404) : page(), fetchPublic => fetchPublic(STATAREA));
  assert.equal(result.crawler.networkRequests, 2);
});

test('long Crawl-delay fails within the call budget without silently lowering the site interval', async t => {
  const h = await harness(t); let calls = 0;
  await h.run(async () => { calls++; return page('User-agent: *\nCrawl-delay: 60'); }, async fetchPublic => {
    await assert.rejects(fetchPublic(STATAREA), { code: 'crawl_delay_exceeds_budget' });
  });
  assert.equal(calls, 1);
});

test('GET transient failures retry once with identified user agent; read-only POST is never automatically replayed', async t => {
  const h = await harness(t); let getCalls = 0, postCalls = 0;
  const result = await h.run(allowRobots(async (url, init) => {
    assert.equal(init.redirect, 'manual'); assert.equal(init.headers.get('User-Agent'), 'DimensionFootballCrawler/1.0');
    if (init.method === 'POST') { postCalls++; return page('error', 503); }
    getCalls++; return page('data', getCalls === 1 ? 503 : 200);
  }), async fetchPublic => {
    assert.equal(await (await fetchPublic(STATAREA)).text(), 'data');
    await assert.rejects(fetchPublic(TTY.url, TTY.init), { code: 'http_unavailable' });
  });
  assert.equal(getCalls, 2); assert.equal(postCalls, 1);
  assert.equal(result.crawler.events[0].attempts, 2);
});

test('429 and 503 Retry-After survive persistence and suppress subsequent rounds without extra requests', async t => {
  for (const status of [429, 503]) {
    const h = await harness(t);
    await h.run(allowRobots(async () => page('busy', status, { 'Retry-After': '7200' })), async fetchPublic => {
      await assert.rejects(fetchPublic(STATAREA), { code: status === 429 ? 'rate_limited' : 'http_unavailable' });
    });
    const saved = JSON.parse(await readFile(h.statePath, 'utf8'));
    assert.equal(saved.origins['https://www.statarea.com'].nextAllowedAt, at(7_200_000));
    const skipped = await h.run(() => assert.fail('still cooling down'), async fetchPublic => {
      await assert.rejects(fetchPublic(STATAREA), { code: 'crawler_cooldown' });
    }, { clock: () => at(1000) });
    assert.equal(skipped.crawler.networkRequests, 0);
    const recovered = await h.run(allowRobots(async () => page('data', 200, { Date: new Date(at(7_200_000)).toUTCString() })),
      fetchPublic => fetchPublic(STATAREA), { clock: () => at(7_200_000) });
    assert.equal(recovered.crawler.origins[0].nextAllowedAt, null);
  }
});

test('200 verification/login pages and 401/403 are blocked, uncached and reported without response bodies', async t => {
  for (const [body, status, code] of [['<title>Just a moment...</title><form id="challenge-form">secret-page-body</form>', 200, 'access_challenge'],
    ['<input type="password">secret-page-body', 200, 'authorization_required'], ['secret-page-body', 401, 'authorization_required'],
    ['secret-page-body', 403, 'access_denied']]) {
    const h = await harness(t);
    const result = await h.run(allowRobots(async () => page(body, status)), async fetchPublic => {
      await assert.rejects(fetchPublic(STATAREA), { code });
    });
    assert.ok(!JSON.stringify(result.crawler).includes('secret-page-body'));
    assert.ok(!(await readFile(h.statePath, 'utf8')).includes('secret-page-body'));
    assert.equal(result.crawler.origins[0].code, code);
  }
});

test('fresh cache keeps original timestamps; expired cache requires live 304 with a valid HTTP date', async t => {
  const h = await harness(t), modified = 'Tue, 27 Oct 2026 08:29:00 GMT';
  const first = await h.run(allowRobots(async () => page('original', 200, { ETag: '"v1"', 'Last-Modified': modified })), async fetchPublic => {
    await fetchPublic(TITAN + '?r=001');
    const cached = await fetchPublic(TITAN + '?r=002');
    assert.equal(cached.headers.get('last-modified'), modified);
    assert.equal(cached.headers.get('date'), new Date(NOW).toUTCString());
  });
  assert.equal(first.crawler.networkRequests, 2); assert.equal(first.crawler.events[1].cache, 'hit');
  const next = at(20_000);
  const second = await h.run(async (url, init) => {
    assert.equal(init.headers.get('if-none-match'), '"v1"');
    return page('', 304, { Date: new Date(next).toUTCString() });
  }, async fetchPublic => {
    const response = await fetchPublic(TITAN); assert.equal(await response.text(), 'original');
    assert.equal(response.headers.get('last-modified'), modified);
    assert.equal(response.headers.get('date'), new Date(next).toUTCString());
  }, { clock: () => next });
  assert.equal(second.crawler.events[0].cache, 'revalidated');
  await h.run(async () => page('', 304, { Date: 'invalid' }), async fetchPublic => {
    await assert.rejects(fetchPublic(TITAN), { code: 'cache_validation_failed' });
  }, { clock: () => at(40_000) });
});

test('no-store pages are not persisted; redirects and oversized streams do not turn into cached success', async t => {
  const h = await harness(t);
  await h.run(allowRobots(async () => page('private-content', 200, { 'Cache-Control': 'no-store' })), fetchPublic => fetchPublic(STATAREA));
  assert.ok(!(await readFile(h.statePath, 'utf8')).includes('private-content'));
  for (const [response, code] of [[page('', 302, { Location: 'https://elsewhere.invalid/' }), 'redirect_blocked'],
    [page('x'.repeat(1_500_001)), 'crawler_response_too_large'], [page('', 304), 'cache_validation_failed']]) {
    const single = await harness(t); let dataCalls = 0;
    await single.run(allowRobots(async () => { dataCalls++; return response; }), async fetchPublic => {
      await assert.rejects(fetchPublic(STATAREA), { code });
    });
    assert.equal(dataCalls, 1);
  }
});

test('request budget remains global with concurrent origins and includes robots requests', async t => {
  const h = await harness(t); let calls = 0;
  const result = await h.run(async () => { calls++; return page('User-agent: *\nAllow: /'); }, async fetchPublic => {
    const outcomes = await Promise.allSettled([fetchPublic(TITAN), fetchPublic(STATAREA), fetchPublic(TTY.url, TTY.init)]);
    assert.ok(outcomes.every(row => row.status === 'rejected' && row.reason.code === 'crawler_budget_exhausted'));
  }, { policy: { ...policy, maxRequests: 3 } });
  assert.equal(calls, 3); assert.equal(result.crawler.networkRequests, 3);
});

test('an aborted queued waiter never releases another request past the active host owner', async t => {
  const h = await harness(t), controller = new AbortController();
  let entered, release, active = 0, maximum = 0;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await h.run(allowRobots(async url => {
    active++; maximum = Math.max(maximum, active);
    if (url === TITAN) { entered(); await gate; }
    active--; return page();
  }), async fetchPublic => {
    const first = fetchPublic(TITAN);
    const middle = fetchPublic(TITAN.replace('17', '24'), { signal: controller.signal }).catch(error => error);
    const last = fetchPublic(TITAN.replace('17', '31'));
    await started; controller.abort();
    assert.equal((await middle).code, 'crawler_cancelled');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(maximum, 1); release();
    await Promise.all([first, last]);
  });
  assert.equal(maximum, 1);
});

test('timeout cancels a fetch that ignores abort; local cancellation never becomes a source cooldown', async t => {
  const h = await harness(t);
  const result = await h.run(allowRobots(() => new Promise(() => {})), async fetchPublic => {
    await assert.rejects(fetchPublic(STATAREA), { code: 'crawler_timeout' });
  }, { policy: { ...policy, requestTimeoutMs: 100, maxRetries: 0 } });
  assert.equal(result.crawler.events[0].code, 'crawler_timeout');
  const other = await harness(t), controller = new AbortController(); controller.abort();
  await other.run(() => assert.fail('network forbidden'), async fetchPublic => {
    await assert.rejects(fetchPublic(STATAREA), { code: 'crawler_cancelled' });
  }, { signal: controller.signal });
  assert.deepEqual(JSON.parse(await readFile(other.statePath, 'utf8')).origins, {});
});

test('damaged crawler state fails closed and its lock is released for operator recovery', async t => {
  const h = await harness(t);
  await writeFile(h.statePath, '{');
  await assert.rejects(h.run(() => assert.fail('network forbidden'), () => {}), { message: 'CRAWLER_STATE_UNREADABLE' });
  await rm(h.statePath);
  assert.equal((await h.run(allowRobots(async () => page()), f => f(STATAREA))).crawler.events[0].code, 'ok');
});

test('real adapters consume crawled XML while stale revalidated quotes remain excluded and independence stays one group', async t => {
  const h = await harness(t);
  const fixture = { id: 'fd-1', league: 'SA', home: 'US Sassuolo Calcio', away: 'SS Lazio',
    kickoff: '2026-10-27T17:30:00.000Z', status: 'TIMED', source: 'football-data.org' };
  const row = Array(69).fill(''); Object.assign(row, { 0: '310001', 2: '意甲', 5: '萨索洛', 8: '拉齐奥', 11: '01:30', 13: '0', 36: '10-28', 43: '2026' });
  const market = Array(52).fill(''); Object.assign(market, { 0: '310001', 1: '1788000', 2: '-0.25', 3: '0.87', 4: '0.95', 13: '1', 14: '0' });
  const fetchImpl = allowRobots(async url => page(url.endsWith('/jdList') ? '{"isSuccess":true,"data":[]}'
    : url.includes('.js') ? `A[1]=${JSON.stringify(row.join('^'))}.split('^');`
      : url.includes('.xml') ? `<c><match><m>${market.join(',')}</m></match><isMaintain>0</isMaintain></c>` : '<html>format changed</html>',
  200, { ETag: '"data1"', 'Last-Modified': new Date(NOW).toUTCString() }));
  const options = { fixtures: [fixture], statePath: h.statePath, policy, nowISO: NOW, clock: () => NOW, fetchImpl };
  const first = await collectCrawledEvidence(options);
  assert.equal(first.quotes.length, 6); assert.equal(first.crawler.networkRequests, 9);
  assert.deepEqual([...new Set(first.quotes.map(quote => quote.independenceGroup))], ['titan007']);
  assert.ok(first.crawler.parserIssues.some(issue => issue.sourceId === 'statarea'));
  const later = at(400_000);
  const second = await collectCrawledEvidence({ ...options, nowISO: later, clock: () => later,
    fetchImpl: async (url, init) => init.method === 'POST' ? page('{"isSuccess":true,"data":[]}', 200, { Date: new Date(later).toUTCString() })
      : page('', 304, { Date: new Date(later).toUTCString() }) });
  assert.equal(second.quotes.length, 0);
  assert.ok(second.fixtureDiagnostics.every(row => row.code === 'stale_snapshot'));
  assert.ok(second.crawler.events.some(row => row.cache === 'revalidated'));
});

test('standalone crawl check uses fixed public endpoints, writes metadata only, and fails on denied collection', async t => {
  const h = await harness(t);
  const result = await runCrawlCheck(['--source', 'statarea'], { cwd: h.cwd, clock: () => NOW, stdout: () => {},
    fetchImpl: async () => page('User-agent: *\nDisallow: /') });
  assert.equal(result.exitCode, 1); assert.equal(result.report.crawler.events[0].code, 'robots_denied');
  assert.equal(result.report.kind, 'public-crawler-transport-check');
  assert.ok((await readFile(result.outputPath, 'utf8')).includes('robots_denied'));
  await assert.rejects(runCrawlCheck(['--source', 'https://unknown.invalid'], { cwd: h.cwd }), { message: 'INVALID_CRAWL_ARGUMENT' });
});
