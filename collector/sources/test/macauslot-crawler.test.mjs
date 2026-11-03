import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawlerTarget, withPublicCrawler, readCrawlerPolicy } from '../crawler.mjs';

const NOW = '2026-10-31T10:05:17.264Z';
const ORIGIN = 'https://www.macauslot.com';
const EVENT = ORIGIN + '/soccer/json/realtime/threeinone_event_cn_fb.json';
const ODDS = ORIGIN + '/soccer/json/realtime/threeinone_odds_cn_fb.json';
const policy = readCrawlerPolicy({ minIntervalMs: 100, maxRetries: 0 });

test('P0 explicit exact Macau endpoints are not crawler capabilities', () => {
  for (const url of [EVENT, ODDS, EVENT + '?r=1', ODDS + '#fragment',
    ORIGIN + '/robots.txt', ORIGIN + '/account']) {
    assert.throws(() => crawlerTarget(url), { code: 'crawler_target_denied' });
  }
  assert.throws(() => crawlerTarget(ODDS, 'POST'), { code: 'crawler_target_denied' });
  assert.equal(crawlerTarget('https://www.statarea.com/predictions').id, 'statarea');
});

test('cached blocked source does not revive and healthy source remains callable', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'macau-deny-cache-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const statePath = join(folder, 'crawler.json'), visited = [];
  await writeFile(statePath, JSON.stringify({ version: 1,
    origins: { [ORIGIN]: { code: 'ok', checkedAt: NOW, nextAllowedAt: null } },
    robots: { [ORIGIN]: { checkedAt: NOW, text: 'User-agent: *\\nDisallow:' } },
    cache: { [ODDS]: { fetchedAt: NOW, text: '{"mock":"old-unapproved-odds"}',
      headers: { date: new Date(NOW).toUTCString() }, engine: 'http' } },
  }));
  await withPublicCrawler({ statePath, policy, clock: () => NOW,
    fetchImpl: async url => {
      visited.push(url);
      if (url.endsWith('/robots.txt')) return new Response('User-agent: *\\nDisallow:', { headers: {
        date: new Date(NOW).toUTCString(), 'content-type': 'text/plain' } });
      return new Response('healthy-allowed-source', { headers: { date: new Date(NOW).toUTCString() } });
    } }, async fetchPublic => {
    await assert.rejects(fetchPublic(ODDS), { code: 'crawler_target_denied' });
    await assert.rejects(fetchPublic(EVENT), { code: 'crawler_target_denied' });
    const result = await fetchPublic('https://www.statarea.com/predictions');
    assert.equal(await result.text(), 'healthy-allowed-source');
  });
  assert.ok(visited.length >= 2);
  assert.ok(visited.every(url => !url.startsWith(ORIGIN)));
  const saved = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(saved.cache[ODDS], undefined);
  assert.equal(saved.origins[ORIGIN], undefined);
  assert.equal(saved.robots[ORIGIN], undefined);
});

test('denied source never dispatches even without a persisted state', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'macau-no-fetch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let calls = 0;
  await withPublicCrawler({ statePath: join(folder, 'crawler.json'), policy,
    clock: () => NOW, fetchImpl: async () => { calls++; throw Error('network-dispatch'); } },
  async fetchPublic => {
    for (const url of [EVENT, ODDS]) await assert.rejects(fetchPublic(url), { code: 'crawler_target_denied' });
  });
  assert.equal(calls, 0);
});
