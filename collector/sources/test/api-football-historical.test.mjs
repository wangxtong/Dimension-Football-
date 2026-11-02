import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchApiFootballHistoricalMonth, parseApiFootballHistoricalSnapshot } from '../api-football-historical.mjs';

const nowISO = '2026-11-02T03:00:00.000Z';
const opts = { league: 'PL', season: 2023, from: '2023-10-01', to: '2023-10-31', nowISO };
const testKey = 'TEST_ONLY_NOT_A_REAL_KEY';
function match(overrides = {}) {
  const { fixture: fixtureOverrides = {}, ...rest } = overrides;
  const when = '2023-10-12T16:00:00+00:00';
  return {
    fixture: { id: 123456, date: when, timestamp: Date.parse(when) / 1000,
      status: { short: 'FT' }, ...fixtureOverrides },
    league: { id: 39, season: 2023 }, teams: { home: { id: 1, name: 'Home Club' },
      away: { id: 2, name: 'Away Club' } }, goals: { home: 2, away: 1 },
    score: { fulltime: { home: 2, away: 1 } }, ...rest,
  };
}
const payload = (rows = [match()], extra = {}) => ({
  get: 'fixtures', errors: [], results: rows.length,
  paging: { current: 1, total: 1 }, response: rows, ...extra,
});
const respond = (body = payload(), status = 200) => new Response(JSON.stringify(body), {
  status, headers: { Date: new Date(nowISO).toUTCString(), 'Content-Type': 'application/json' },
});
test('no existing safe key means NOT_RUN and zero network calls, not a new authorization request', async () => {
  let calls = 0;
  const result = await fetchApiFootballHistoricalMonth({ ...opts, fetchImpl: () => { calls++; throw Error('unexpected'); } });
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.requestAttempted, false);
  assert.equal(calls, 0);
});

test('reads exactly one bounded official month and keeps immutable raw SHA with provider fixture IDs', async () => {
  let calls = 0;
  const result = await fetchApiFootballHistoricalMonth({ ...opts, apiKey: testKey,
    clock: () => nowISO,
    fetchImpl: async (url, options) => {
      calls++;
      const u = new URL(url);
      assert.equal(u.origin, 'https://v3.football.api-sports.io');
      assert.equal(u.pathname, '/fixtures');
      assert.deepEqual([...u.searchParams.entries()].sort(), [
        ['from', opts.from], ['league', '39'], ['season', '2023'], ['to', opts.to], ['timezone', 'UTC'],
      ].sort());
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers['x-apisports-key'], testKey);
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(url.includes(testKey), false);
      return respond();
    } });
  assert.equal(calls, 1);
  assert.equal(result.kind, 'api-football-bounded-retrospective-history');
  assert.equal(result.received, 1);
  assert.equal(result.acceptedFT, 1);
  assert.equal(result.records[0].fixtureId, 123456);
  assert.equal(result.records[0].kickoffUTC, '2023-10-12T16:00:00.000Z');
  assert.equal(result.records[0].sourceUpdatedAt, null);
  assert.equal(result.records[0].actualPregameVisibleAt, null);
  assert.equal(result.records[0].historicalBackfill, true);
  assert.equal(result.modelReadyForProspective, false);
  assert.equal(result.releaseGate, 'BLOCKED');
  assert.equal(result.rawSha256, createHash('sha256').update(result.rawBody).digest('hex'));
  assert.equal(JSON.stringify(result.records).includes(testKey), false);
});


test('HTTP RAW completion timestamp follows the response body, never request initiation', async () => {
  const receivedAt = '2026-11-02T03:00:08.000Z';
  const raw = Buffer.from(JSON.stringify(payload()));
  let bodyClosed = false;
  const responseBody = new ReadableStream({
    start(controller) { controller.enqueue(raw); },
    pull(controller) { controller.close(); bodyClosed = true; },
  });
  const response = {
    ok: true, status: 200, headers: new Headers({ Date: new Date(receivedAt).toUTCString() }),
    body: responseBody,
  };
  const result = await fetchApiFootballHistoricalMonth({ ...opts, apiKey: testKey,
    fetchImpl: async () => response,
    clock: () => {
      assert.equal(bodyClosed, true, 'complete observation cannot precede stream EOF');
      return receivedAt;
    },
  });
  assert.equal(result.sourceRequestStartedAt, nowISO);
  assert.equal(result.sourceFetchedAt, receivedAt);
  assert.equal(result.responseAt, receivedAt);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.records[0].sourceObservedAt, receivedAt);
  assert.equal(result.modelReadyForProspective, false);
  assert.equal(result.releaseGate, 'BLOCKED');
  assert.equal(result.rawSha256, createHash('sha256').update(raw).digest('hex'));
});

test('clock rollback and impossible completion window fail before persisting provider facts', async () => {
  for (const completed of ['2026-11-02T02:59:59.000Z', '2026-11-02T03:01:01.000Z']) {
    await assert.rejects(fetchApiFootballHistoricalMonth({ ...opts, apiKey: testKey,
      fetchImpl: async () => respond(), clock: () => completed,
    }), /HISTORY_OBSERVATION_CLOCK_INVALID/);
  }
  assert.throws(() => parseApiFootballHistoricalSnapshot(Buffer.from(JSON.stringify(payload())), {
    ...opts, responseAt: nowISO, requestStartedAt: '2026-11-02T03:05:00.000Z',
  }), /HISTORY_TIME_UNVERIFIED/);
});

test('AET, missing or unverified full-time scores are excluded without fabricating FT', () => {
  const rows = [match({ fixture: { id: 1, status: { short: 'AET' } } }),
    match({ fixture: { id: 2 }, score: { fulltime: { home: null, away: null } } }),
    match({ fixture: { id: 3 }, goals: { home: 3, away: 1 } }),
    match({ fixture: { id: 4 } })];
  const raw = Buffer.from(JSON.stringify(payload(rows)));
  const result = parseApiFootballHistoricalSnapshot(raw, { ...opts, responseAt: nowISO });
  assert.equal(result.received, 4);
  assert.equal(result.acceptedFT, 1);
  assert.equal(result.excluded, 3);
  assert.deepEqual(result.exclusions.map(x => x.reason),
    ['NOT_REGULAR_TIME_FT', 'FT_SCORE_UNVERIFIED', 'FT_SCORE_UNVERIFIED']);
});

test('provider pagination and missing response counts cannot pretend complete history', () => {
  for (const body of [payload([match()], { paging: { current: 1, total: 2 } }),
    payload([match()], { results: 3 }),
    payload([match()], { errors: { plan: 'not allowed' } })]) {
    assert.throws(() => parseApiFootballHistoricalSnapshot(Buffer.from(JSON.stringify(body)),
      { ...opts, responseAt: nowISO }), /HISTORY_(INCOMPLETE_PAGE|PROVIDER_ERROR)/);
  }
});

test('invalid month, incomplete API key and bad server time fail safely', async () => {
  await assert.rejects(fetchApiFootballHistoricalMonth({ ...opts, from: '2023-09-01', apiKey: testKey,
    fetchImpl: async () => respond() }), /INVALID_HISTORICAL_WINDOW/);
  await assert.rejects(fetchApiFootballHistoricalMonth({ ...opts, to: '2023-11-02', apiKey: testKey,
    fetchImpl: async () => respond() }), /INVALID_HISTORICAL_WINDOW/);
  await assert.rejects(fetchApiFootballHistoricalMonth({ ...opts, apiKey: testKey,
    clock: () => nowISO,
    fetchImpl: async () => new Response(JSON.stringify(payload()), {
      status: 200, headers: { Date: 'Wed, 01 Jan 2020 00:00:00 GMT' },
    }) }), /HISTORY_SERVER_TIME_UNVERIFIED/);
  await assert.rejects(fetchApiFootballHistoricalMonth({ ...opts, apiKey: testKey,
    fetchImpl: async () => respond({}, 403) }), error =>
      error.code === 'HISTORY_PLAN_DENIED' && error.httpStatus === 403);
});

test('mixed wrong identities and duplicates are excluded, not counted as usable history', () => {
  const items = [match(), match({ fixture: { id: 123456 } }),
    match({ fixture: { id: 789, timestamp: 1 } }),
    match({ fixture: { id: 987 }, league: { id: 78, season: 2023 } })];
  const r = parseApiFootballHistoricalSnapshot(Buffer.from(JSON.stringify(payload(items))),
    { ...opts, responseAt: nowISO });
  assert.equal(r.received, 4);
  assert.equal(r.acceptedFT, 1);
  assert.equal(r.excluded, 3);
  assert.ok(r.exclusions.every(x => x.reason === 'INVALID_OR_DUPLICATE_IDENTITY'));
});
