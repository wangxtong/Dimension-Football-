import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectManagedFixtures, DEFAULT_SOURCE_POLICY, readSourcePolicy, readSourceHealth,
  publicSourceHealth, sourceHealthSnapshot } from '../manager.mjs';
import { retryAfterMs } from '../health.mjs';

const NOW = '2026-10-29T08:00:00.000Z', AF = 'api-football', FD = 'football-data.org';
const LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1'], AF_IDS = [39, 140, 135, 78, 61];
const KEYS = { [FD]: 'fd-secret-must-not-persist', [AF]: 'af-secret-must-not-persist' };
const advance = ms => new Date(Date.parse(NOW) + ms).toISOString();
const provider = url => new URL(url).host === 'api.football-data.org' ? FD : AF;
const leagueOf = url => provider(url) === FD ? new URL(url).pathname.split('/')[3]
  : LEAGUES[AF_IDS.indexOf(Number(new URL(url).searchParams.get('league')))];

function response(url, { status = 200, now = NOW, date = now, rows = 0, headers = {}, malformed = false } = {}) {
  const league = leagueOf(url), index = LEAGUES.indexOf(league), id = index + 100;
  const matches = rows ? provider(url) === FD ? [{ id, competition: { code: league },
    homeTeam: { name: `Home ${league}` }, awayTeam: { name: `Away ${league}` },
    utcDate: advance(86_400_000), status: 'TIMED' }] : [{ fixture: { id,
    date: advance(86_400_000), timestamp: Date.parse(advance(86_400_000)) / 1000, status: { short: 'NS' } },
    league: { id: AF_IDS[index] }, teams: { home: { id: 1, name: `Home ${league}` }, away: { id: 2, name: `Away ${league}` } } }] : [];
  const body = malformed ? { unexpected: true } : provider(url) === FD ? { matches }
    : { get: 'fixtures', errors: [], results: matches.length, paging: { current: 1, total: 1 }, response: matches };
  return new Response(JSON.stringify(body), { status, headers: { Date: new Date(date).toUTCString(), ...headers } });
}

async function harness(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dimension-sources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json.sources.json');
  return { statePath, run: (fetchImpl, options = {}) => collectManagedFixtures({ statePath, credentials: KEYS,
    nowISO: options.nowISO || NOW, clock: () => options.nowISO || NOW, fetchImpl, ...options }) };
}

test('healthy preferred source including a genuine empty window never spends backup quota', async t => {
  const h = await harness(t), calls = [];
  const result = await h.run(async (url, init) => {
    calls.push(url); assert.equal(provider(url), FD); assert.equal(init.headers['X-Auth-Token'], KEYS[FD]);
    assert.equal(init.redirect, 'manual'); return response(url);
  });
  assert.equal(calls.length, 5); assert.equal(result.poolComplete, true);
  assert.deepEqual(result.fixtures, []); assert.equal(result.management.selectedSource, FD);
  assert.equal(result.management.attempts.length, 1);
  assert.equal((await readSourceHealth(h.statePath)).sources[FD].lastSuccessAt, NOW);
});

test('HTTP 503, stale data, malformed schemas and 401 switch to an independently keyed compatible provider', async t => {
  for (const failure of [{ status: 503 }, { date: advance(-300_001) }, { malformed: true }, { status: 401 }]) {
    const h = await harness(t), calls = [];
    const result = await h.run(async (url, init) => {
      calls.push(url);
      const id = provider(url);
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers[id === FD ? 'X-Auth-Token' : 'x-apisports-key'], KEYS[id]);
      assert.ok(!JSON.stringify(init.headers).includes(KEYS[id === FD ? AF : FD]));
      return response(url, id === FD ? failure : { rows: 1 });
    });
    assert.equal(calls.length, 10); assert.equal(result.poolComplete, true);
    assert.equal(result.management.selectedSource, AF); assert.equal(result.management.fallbackUsed, true);
    assert.equal(result.fixtures.length, 5); assert.ok(result.fixtures.every(f => f.id.startsWith('af-') && f.source === AF));
    const saved = await readFile(h.statePath, 'utf8');
    for (const key of Object.values(KEYS)) assert.ok(!saved.includes(key) && !JSON.stringify(result).includes(key));
  }
});

test('reverse priority is supported; only registered adapters and bounded policy values are accepted', async t => {
  const h = await harness(t), calls = [];
  const policy = readSourcePolicy({ fixturePriority: [AF, FD] });
  const result = await h.run(async url => { calls.push(provider(url)); return response(url, { status: provider(url) === AF ? 503 : 200 }); }, { policy });
  assert.deepEqual(calls, [...Array(5).fill(AF), ...Array(5).fill(FD)]);
  assert.equal(result.management.selectedSource, FD);
  for (const bad of [{ fixturePriority: [] }, { fixturePriority: [FD, FD] }, { fixturePriority: ['https://evil.invalid'] },
    { baseUrl: 'https://evil.invalid' }, { failureThreshold: 0 }, { cooldownMs: 1 }, { maxCooldownMs: 60_000 }]) {
    assert.throws(() => readSourcePolicy(bad), { message: 'INVALID_SOURCE_POLICY' });
  }
});

test('partial pools are compared by league completeness without mixing IDs or losing the better pool', async t => {
  for (const backupBetter of [false, true]) {
    const h = await harness(t);
    const result = await h.run(async url => {
      const id = provider(url), league = leagueOf(url);
      const bad = id === FD ? league === 'FL1' : !backupBetter && ['SA', 'BL1', 'FL1'].includes(league);
      return response(url, { status: bad ? 403 : 200, rows: 1 });
    });
    assert.equal(result.management.selectedSource, backupBetter ? AF : FD);
    assert.equal(result.fixtures.length, backupBetter ? 5 : 4);
    assert.equal(result.poolComplete, backupBetter);
    const saved = await readSourceHealth(h.statePath);
    assert.equal(saved.sources[FD].status, 'degraded');
    assert.equal(saved.sources[FD].nextProbeAt, null, 'one inaccessible league cannot disable four good ones');
  }
});

test('two failures open exponential cooldown; due probes restore primary automatically', async t => {
  const h = await harness(t);
  const failing = async url => response(url, { status: provider(url) === FD ? 503 : 200 });
  await h.run(failing); await h.run(failing);
  let saved = await readSourceHealth(h.statePath);
  assert.equal(saved.sources[FD].consecutiveFailures, 2);
  assert.equal(saved.sources[FD].nextProbeAt, advance(300_000));
  let calls = [];
  const skipped = await h.run(async url => { calls.push(provider(url)); return response(url); }, { nowISO: advance(1) });
  assert.deepEqual(calls, Array(5).fill(AF)); assert.equal(skipped.management.attempts[0].code, 'cooldown');
  const third = await h.run(async url => response(url, { now: advance(300_000), status: provider(url) === FD ? 503 : 200 }), { nowISO: advance(300_000) });
  assert.equal(third.management.sources[0].nextProbeAt, advance(900_000));
  calls = [];
  const recovered = await h.run(async url => { calls.push(provider(url)); return response(url, { now: advance(900_000) }); }, { nowISO: advance(900_000) });
  assert.deepEqual(calls, Array(5).fill(FD)); assert.equal(recovered.management.selectedSource, FD);
  saved = await readSourceHealth(h.statePath);
  assert.equal(saved.sources[FD].consecutiveFailures, 0); assert.equal(saved.sources[FD].nextProbeAt, null);
  assert.equal(saved.events.at(-1).reason, 'preferred');
});

test('429 Retry-After, auth failure and API quota errors impose distinct persistent cooldowns', async t => {
  const scenarios = [
    { failure: { status: 429, headers: { 'Retry-After': '7200' } }, delay: 7_200_000 },
    { failure: { status: 503, headers: { 'Retry-After': new Date(Date.parse(NOW) + 600_000).toUTCString() } }, delay: 600_000 },
    { failure: { status: 401 }, delay: DEFAULT_SOURCE_POLICY.authCooldownMs },
  ];
  for (const scenario of scenarios) {
    const h = await harness(t);
    await h.run(async url => response(url, provider(url) === FD ? scenario.failure : {}));
    assert.equal((await readSourceHealth(h.statePath)).sources[FD].nextProbeAt, advance(scenario.delay));
  }
  const h = await harness(t);
  const result = await h.run(async () => new Response(JSON.stringify({ get: 'fixtures', errors: { requests: KEYS[AF] },
    results: 0, paging: { current: 1, total: 1 }, response: [] }), { headers: { Date: new Date(NOW).toUTCString() } }), { requiredSource: AF });
  assert.equal(result.management.selectedSource, null);
  assert.equal((await readSourceHealth(h.statePath)).sources[AF].nextProbeAt, advance(86_400_000));
  assert.ok(!(await readFile(h.statePath, 'utf8')).includes(KEYS[AF]));
});

test('provider pinning never falls back to incompatible deep-analysis fixture IDs', async t => {
  const h = await harness(t), calls = [];
  const result = await h.run(async url => { calls.push(provider(url)); return response(url, { status: 503 }); }, { requiredSource: AF });
  assert.deepEqual(calls, Array(5).fill(AF)); assert.deepEqual(result.fixtures, []);
  assert.equal(result.management.mode, 'provider-pinned'); assert.equal(result.poolComplete, false);
  await assert.rejects(h.run(() => assert.fail('network forbidden'), { requiredSource: AF,
    policy: readSourcePolicy({ fixturePriority: [FD] }) }), { message: 'REQUIRED_SOURCE_DISABLED' });
});

test('missing backup and both providers down yield honest unavailable state, never synthetic or stale fixtures', async t => {
  const h = await harness(t), calls = [];
  const result = await h.run(async url => { calls.push(url); const error = new Error(KEYS[FD]); error.code = KEYS[FD]; throw error; }, { credentials: { [FD]: KEYS[FD] } });
  assert.equal(calls.length, 5); assert.equal(result.management.attempts[1].code, 'not_configured');
  assert.equal(result.management.attempts[0].code, 'network_unavailable');
  assert.equal(result.management.selectedSource, null); assert.deepEqual(result.fixtures, []);
  assert.ok(!(await readFile(h.statePath, 'utf8')).includes(KEYS[FD]));
  await assert.rejects(h.run(() => assert.fail('network forbidden'), { credentials: {} }), { message: 'FIXTURE_API_KEY_OR_INPUT_REQUIRED' });
  await h.run(async url => response(url, { status: 401 }));
  let skipped = 0;
  const none = await h.run(async () => { skipped++; assert.fail('cooldown must suppress both providers'); });
  assert.equal(skipped, 0); assert.equal(none.management.selectedSource, null);
  assert.equal(none.poolComplete, false); assert.deepEqual(none.fixtures, []);
});

test('cancellation and exhausted budget stop fallback without poisoning provider health', async t => {
  for (const cancel of [true, false]) {
    const h = await harness(t), controller = new AbortController();
    let budget = 1000, calls = 0;
    const result = await h.run(async url => {
      calls++; if (cancel) controller.abort(); else budget = 0;
      return response(url, { status: 503 });
    }, { signal: controller.signal, remaining: () => budget });
    assert.equal(calls, 5); assert.equal(result.management.interrupted, cancel ? 'cancelled' : 'budget_exhausted');
    assert.deepEqual((await readSourceHealth(h.statePath)).sources, {});
  }
});

test('health state lock excludes concurrent fixture acquisition and releases after completion', async t => {
  const h = await harness(t);
  let unblock, started;
  const gate = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const first = h.run(async url => { started(); await gate; return response(url); });
  await entered;
  await assert.rejects(h.run(() => assert.fail('second acquisition must not start')), { message: 'COLLECTION_ALREADY_LOCKED' });
  unblock(); await first;
  assert.equal((await h.run(async url => response(url))).poolComplete, true);
});

test('corrupt state fails closed; unknown stored fields are not replayed into reports', async t => {
  const h = await harness(t);
  await writeFile(h.statePath, '{');
  await assert.rejects(h.run(() => assert.fail('network forbidden')), { message: 'SOURCE_STATE_UNREADABLE' });
  await writeFile(h.statePath, JSON.stringify({ version: 5 }));
  await assert.rejects(readSourceHealth(h.statePath), { message: 'SOURCE_STATE_INVALID' });
  await rm(h.statePath);
  await h.run(async url => response(url));
  const state = JSON.parse(await readFile(h.statePath, 'utf8'));
  state.secret = KEYS[FD]; state.sources[FD].headers = KEYS[AF];
  await writeFile(h.statePath, JSON.stringify(state));
  const snapshot = sourceHealthSnapshot(await readSourceHealth(h.statePath), DEFAULT_SOURCE_POLICY, NOW);
  for (const key of Object.values(KEYS)) assert.ok(!JSON.stringify(snapshot).includes(key));
});

test('Retry-After parsing is bounded and public monitoring keeps shared channel independence and missing backups', () => {
  for (const invalid of [null, '', '-1', 'secret-value', '0']) assert.equal(retryAfterMs(invalid, Date.parse(NOW)), null);
  assert.equal(retryAfterMs('999999999999999', Date.parse(NOW)), 86_400_000);
  const rows = ['m88', '12bet', 'sbobet'].map(id => ({ id, sourceId: 'titan007', status: 'available', checkedAt: NOW }));
  const health = publicSourceHealth(rows);
  assert.equal(health.filter(row => row.independenceGroup === 'titan007').length, 1);
  assert.equal(health[0].automaticFallback, false); assert.equal(health[0].status, 'available');
  assert.equal(health.find(row => row.id === 'statarea').status, 'not_checked');
});
