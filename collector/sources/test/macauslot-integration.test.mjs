import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIntegratedEvidence } from '../index.mjs';
import { readCrawlerPolicy } from '../crawler.mjs';
import { MACAUSLOT_EVENTS, MACAUSLOT_ODDS } from '../macauslot.mjs';

const sample = JSON.parse(await readFile(new URL('./fixtures/macauslot-20261031.json', import.meta.url), 'utf8'));
const NOW = sample.options.observedAt, NEXT = '2026-10-31T12:00:00.000Z';
const policy = readCrawlerPolicy({ minIntervalMs: 100, maxRetries: 0 });
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'macau-integrated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { statePath: join(dir, 'crawler.json'), providerStatePath: join(dir, 'providers.json') };
}
function mockTransport(calls, { age, oddsStatus = 200 } = {}) {
  return async (url, init) => {
    calls.push(url);
    assert.equal(init.redirect, 'manual');
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return new Response(`User-agent: *\nDisallow: ${u.hostname === 'www.macauslot.com' ? '' : '/'}`,
      { headers: { Date: new Date(NOW).toUTCString() } });
    if (url === MACAUSLOT_EVENTS || url === MACAUSLOT_ODDS) {
      const odds = url === MACAUSLOT_ODDS;
      assert.equal(init.method, 'GET'); assert.equal(init.headers.get('authorization'), null);
      return new Response(JSON.stringify(odds ? sample.odds : sample.events), { status: odds ? oddsStatus : 200,
        headers: { 'Content-Type': 'application/json', Date: new Date(odds ? sample.options.sourceAsOf : sample.options.scheduleAsOf).toUTCString(),
          'Last-Modified': new Date(odds ? sample.options.sourceUpdatedAt : sample.options.scheduleUpdatedAt).toUTCString(),
          ...(oddsStatus === 429 && odds ? { 'Retry-After': '7200' } : {}), ...(age === undefined ? {} : { Age: String(age) }) } });
    }
    assert.equal(u.hostname, 'info.cld.hkjc.com');
    return new Response('unavailable', { status: 403 });
  };
}
const collect = (paths, fetchImpl, options = {}) => collectIntegratedEvidence({ ...paths, fixtures: structuredClone(sample.fixtures),
  nowISO: NOW, clock: () => NOW, env: {}, policy, fetchImpl, ...options });

test('integrated Macau collection shares crawler accounting and retains both quotes and unavailable market states', async t => {
  const paths = await workspace(t), calls = [];
  const result = await collect(paths, mockTransport(calls));
  assert.equal(result.quotes.length, 24); assert.equal(new Set(result.quotes.map(row => row.fixtureId)).size, 12);
  assert.equal(result.marketStates.filter(row => row.sourceId === 'macauslot').length, 1);
  assert.equal(result.fixtureDiagnostics.filter(row => row.id === 'macauslot').length, 13);
  assert.ok(result.quotes.every(row => row.sourceUpdatedAt === sample.options.sourceUpdatedAt && !row.opening));
  assert.equal(calls.filter(url => new URL(url).hostname === 'www.macauslot.com').length, 3);
  assert.equal(result.crawler.networkRequests, calls.filter(url => new URL(url).hostname !== 'info.cld.hkjc.com').length);
  assert.ok(result.diagnostics.some(row => row.id === 'hkjc' && row.status === 'unavailable'));
});

test('the independent persisted Macau cooldown suppresses requests while retaining other source diagnostics', async t => {
  const paths = await workspace(t), calls = [];
  await writeFile(`${paths.statePath}.macauslot-cooldown.json`, JSON.stringify({ version: 1, sources: { macauslot: {
    checkedAt: NOW, nextProbeAt: NEXT, code: 'rate_limited', httpStatus: 429,
  } } }));
  const result = await collect(paths, mockTransport(calls));
  assert.equal(result.quotes.length, 0);
  assert.ok(!calls.some(url => new URL(url).hostname === 'www.macauslot.com'));
  assert.ok(result.diagnostics.some(row => row.id === 'macauslot' && row.code === 'source_cooldown' && row.nextProbeAt === NEXT));
  assert.ok(result.diagnostics.some(row => row.id === 'hkjc'));
});

test('crawler Retry-After persists across integrated rounds and does not repeat Macau data requests', async t => {
  const paths = await workspace(t), calls = [];
  const first = await collect(paths, mockTransport(calls, { oddsStatus: 429 }));
  const second = await collect(paths, mockTransport(calls));
  assert.equal(calls.filter(url => url === MACAUSLOT_EVENTS).length, 1);
  assert.equal(calls.filter(url => url === MACAUSLOT_ODDS).length, 1);
  assert.ok(first.diagnostics.some(row => row.id === 'macauslot' && row.code === 'rate_limited'));
  assert.ok(second.diagnostics.some(row => row.id === 'macauslot' && row.code === 'crawler_cooldown'));
  assert.equal(first.quotes.length + second.quotes.length, 0);
});

test('Age remains available to the adapter freshness check and cannot be erased by crawler normalization', async t => {
  const paths = await workspace(t), calls = [];
  const result = await collect(paths, mockTransport(calls, { age: 600 }));
  assert.equal(result.quotes.length, 0);
  assert.ok(result.diagnostics.some(row => row.id === 'macauslot' && row.code === 'stale_snapshot'));
  assert.equal(calls.filter(url => url === MACAUSLOT_ODDS).length, 0);
});

test('a Macau parser failure retains legacy crawler diagnostics and remains visible in parser health', async t => {
  const paths = await workspace(t), calls = [], transport = mockTransport(calls);
  const result = await collect(paths, async (url, init) => {
    const response = await transport(url, init);
    return url === MACAUSLOT_ODDS ? new Response('{}', { headers: response.headers }) : response;
  });
  assert.equal(result.quotes.length, 0);
  assert.ok(result.diagnostics.some(row => row.id === 'macauslot' && row.code === 'invalid_snapshot'));
  assert.ok(result.diagnostics.some(row => row.id === 'm88'));
  assert.ok(result.crawler.parserIssues.some(row => row.sourceId === 'macauslot' && row.code === 'invalid_snapshot'));
});

test('adding Macau cannot create a second allocation of the crawler request budget', async t => {
  const paths = await workspace(t), calls = [];
  const result = await collect(paths, mockTransport(calls), { policy: { ...policy, maxRequests: 3 } });
  assert.equal(result.crawler.maxRequests, 3); assert.equal(result.crawler.networkRequests, 3);
  assert.equal(calls.filter(url => new URL(url).hostname !== 'info.cld.hkjc.com').length, 3);
  assert.ok(result.diagnostics.some(row => row.id === 'macauslot' && row.code === 'crawler_budget_exhausted'));
});
