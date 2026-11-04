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

test('P0 disabled source never reaches integrated network or cached quotation', async t => {
  const paths = await workspace(t), calls = [];
  await writeFile(`${paths.statePath}.macauslot-cooldown.json`,
    JSON.stringify({ version: 1, sources: { macauslot: {
      checkedAt: NOW, nextProbeAt: NEXT, code: 'rate_limited', httpStatus: 429,
    } } }));
  const evidence = await collect(paths, mockTransport(calls));
  assert.equal(calls.filter(url => new URL(url).hostname === 'www.macauslot.com').length, 0);
  assert.equal(evidence.quotes.filter(row => row.sourceId === 'macauslot').length, 0);
  assert.equal(evidence.marketStates.filter(row => row.sourceId === 'macauslot').length, 0);
  assert.equal(evidence.diagnostics.filter(row => row.id === 'macauslot' && row.code === 'ACCESS_BLOCKED').length, 1);
  assert.ok(evidence.diagnostics.some(row => row.id === 'hkjc'));
});

test('explicit optional Macau collection is rejected before any fetch', async () => {
  const { collectCrawledEvidence } = await import('../index.mjs');
  let requests = 0;
  await assert.rejects(collectCrawledEvidence({ fixtures: structuredClone(sample.fixtures),
    nowISO: NOW, includeMacauslot: true, fetchImpl: () => { requests++; throw Error('unexpected'); } }), /ACCESS_BLOCKED/);
  assert.equal(requests, 0);
});

test('arbitrary integrated options cannot turn blocked source on', async t => {
  const paths = await workspace(t), calls = [];
  const evidence = await collect(paths, mockTransport(calls), { includeMacauslot: true });
  assert.equal(calls.filter(url => new URL(url).hostname === 'www.macauslot.com').length, 0);
  assert.equal(evidence.diagnostics.find(row => row.id === 'macauslot').code, 'ACCESS_BLOCKED');
  assert.equal(evidence.quotes.some(row => row.sourceId === 'macauslot'), false);
});
