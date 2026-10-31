import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchApiFootballFixtures} from '../api-football.mjs';

const nowISO = '2026-10-29T08:30:00.000Z';
const leagues = {PL: 39, PD: 140, SA: 135, BL1: 78, FL1: 61};
const testKey = 'not-a-real-api-key';

function leagueFrom(url) {
  const id = Number(new URL(url).searchParams.get('league'));
  return Object.keys(leagues).find(league => leagues[league] === id);
}
function match(league, id = leagues[league], changes = {}) {
  const date = changes.date ?? '2026-10-30T18:00:00+00:00';
  const {date: ignored, fixture, ...rest} = changes;
  return {
    fixture: {id, date, timestamp: Date.parse(date) / 1000, status: {short: 'NS'}, ...fixture},
    league: {id: leagues[league]},
    teams: {home: {id: 1, name: 'Home FC'}, away: {id: 2, name: 'Away FC'}},
    ...rest,
  };
}
function payload(response = [], changes = {}) {
  return {get: 'fixtures', parameters: {}, errors: [], results: response.length,
    paging: {current: 1, total: 1}, response, ...changes};
}
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {status, headers: {
    'Content-Type': 'application/json', Date: new Date(nowISO).toUTCString(), ...headers,
  }});
}

test('five concurrent authenticated requests use only the official fixture endpoint and keep partial successes', async () => {
  const calls = [], pending = [];
  const operation = fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: (url, options) => {
    calls.push({url, options});
    return new Promise(resolve => pending.push(() => {
      const league = leagueFrom(url);
      resolve(league === 'FL1' ? json({}, 403) : json(payload([match(league)])));
    }));
  }});
  assert.equal(calls.length, 5, 'all leagues start before any response completes');
  pending.forEach(resolve => resolve());
  const result = await operation;
  assert.deepEqual(calls.map(({url}) => leagueFrom(url)), Object.keys(leagues));
  for (const {url, options} of calls) {
    const request = new URL(url);
    assert.equal(request.origin, 'https://v3.football.api-sports.io');
    assert.equal(request.pathname, '/fixtures');
    assert.equal(request.searchParams.get('next'), '99');
    assert.equal(request.searchParams.get('timezone'), 'UTC');
    assert.equal(request.searchParams.size, 3);
    assert.equal(options.headers['x-apisports-key'], testKey);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(url.includes(testKey), false);
  }
  assert.equal(result.fixtures.length, 4);
  assert.equal(result.diagnostics.find(d => d.league === 'FL1').note, 'access_denied');
  assert.deepEqual(result.window, {from: nowISO, to: '2026-11-05T08:30:00.000Z',
    timezone: 'UTC', fromExclusive: true, toInclusive: true});
  assert.equal(result.checkedAt, nowISO);
  for (const fixture of result.fixtures) {
    assert.equal(fixture.id, `af-${fixture.providerMatchId}`);
    assert.equal(fixture.source, 'api-football');
    assert.equal(fixture.sourceId, 'api-football');
    assert.equal(fixture.status, 'SCHEDULED');
    assert.equal(fixture.updatedAt, nowISO);
    assert.equal(fixture.fetchedAt, nowISO);
    assert.equal(fixture.sourceUpdatedAt, null);
    assert.equal(fixture.homeTeamId, '1');
    assert.equal(fixture.awayTeamId, '2');
  }
  assert.equal(JSON.stringify(result).includes(testKey), false);
});

test('keeps confirmed NS fixtures inside the exact rolling window and rejects malformed identities', async () => {
  const rows = [
    match('PL', 11, {date: '2026-10-29T10:00:00+00:00'}),
    match('PL', 12, {date: '2026-10-30T16:30:00+08:00'}),
    match('PL', 13, {date: nowISO}),
    match('PL', 14, {date: '2026-10-30T08:30:01+00:00'}),
    match('PL', 15, {fixture: {status: {short: 'TBD'}}}),
    match('PL', 16, {fixture: {status: {short: '1H'}}}),
    match('PL', 17, {fixture: {status: {short: 'FT'}}}),
    match('PL', 18, {league: {id: leagues.PD}}),
    match('PL', 19, {teams: {home: {id: 1, name: ''}, away: {id: 2, name: 'Away FC'}}}),
    match('PL', 20, {fixture: {timestamp: 1}}),
    match('PL', 21, {date: '2026-02-30T10:00:00+00:00'}),
    match('PL', 22, {teams: {home: {id: 1, name: 'Same FC'}, away: {id: 1, name: 'Same FC'}}}),
  ];
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, days: 1,
    fetchImpl: async url => json(payload(leagueFrom(url) === 'PL' ? rows : []))});
  assert.deepEqual(result.fixtures.map(f => f.id), ['af-11', 'af-12']);
  assert.equal(result.fixtures[1].kickoff, '2026-10-30T08:30:00.000Z');
  const diagnostic = result.diagnostics.find(d => d.league === 'PL');
  assert.equal(diagnostic.status, 'partial');
  assert.equal(diagnostic.receivedCount, rows.length);
  assert.equal(diagnostic.rejectedCount, 5);
  assert.equal(diagnostic.matchedCount, 2);
});

test('missing or whitespace credentials produce five authorization blockers without network requests', async () => {
  let calls = 0;
  for (const apiKey of [undefined, '   ']) {
    const result = await fetchApiFootballFixtures({apiKey, nowISO, fetchImpl: async () => {
      calls++;
      throw new Error('must not fetch');
    }});
    assert.deepEqual(result.fixtures, []);
    assert.equal(result.diagnostics.length, 5);
    assert.ok(result.diagnostics.every(d => d.note === 'authorization_required' && d.fetchedAt === null));
  }
  assert.equal(calls, 0);
});

test('API error fields map to safe diagnostics and never retain reflected credential text', async () => {
  const fields = {PL: 'plan', PD: 'token', SA: 'rateLimit', BL1: 'requests', FL1: 'unexpected'};
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: async url => {
    const league = leagueFrom(url);
    return json(payload([match(league)], {errors: {[fields[league]]: `rejected ${testKey}`}}));
  }});
  assert.deepEqual(result.fixtures, []);
  assert.deepEqual(result.diagnostics.map(d => d.note), [
    'plan_restricted', 'authorization_required', 'rate_limited', 'quota_exceeded', 'api_error',
  ]);
  assert.ok(result.diagnostics.every(d => d.status === 'unavailable' && d.matchedCount === 0));
  assert.equal(JSON.stringify(result).includes(testKey), false);
});

test('malformed payloads and incomplete paging cannot synthesize valid fixtures', async () => {
  const bodies = {
    PL: payload([match('PL')], {results: 0}),
    PD: payload([match('PD')], {paging: {current: 1, total: 2}}),
    SA: payload([match('SA')], {get: 'status'}),
    BL1: payload([match('BL1')], {errors: null}),
    FL1: payload([match('FL1')], {response: {}}),
  };
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO,
    fetchImpl: async url => json(bodies[leagueFrom(url)])});
  assert.deepEqual(result.fixtures, []);
  assert.deepEqual(result.diagnostics.map(d => d.note), [
    'invalid_response', 'incomplete_response', 'invalid_response', 'invalid_response', 'invalid_response',
  ]);
});

test('duplicate fixture IDs invalidate the league and over-limit payloads are never silently truncated', async () => {
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: async url => {
    const league = leagueFrom(url);
    if (league === 'PL') return json(payload([match('PL'), match('PL')]));
    if (league === 'PD') return json(payload(Array.from({length: 100}, (_, index) => match('PD', 1000 + index))));
    return json(payload([]));
  }});
  assert.deepEqual(result.fixtures, []);
  assert.equal(result.diagnostics[0].note, 'duplicate_fixture_id');
  assert.equal(result.diagnostics[1].note, 'too_many_fixtures');
  for (const diagnostic of result.diagnostics.slice(2)) {
    assert.equal(diagnostic.status, 'complete');
    assert.equal(diagnostic.note, 'no_upcoming_fixtures');
    assert.equal(diagnostic.responseAt, nowISO);
  }
});

test('99 returned games remain partial unless the response extends beyond the requested window', async () => {
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: async url => {
    const league = leagueFrom(url);
    if (!['PL', 'PD'].includes(league)) return json(payload([]));
    const rows = Array.from({length: 99}, (_, index) => match(league, leagues[league] * 1000 + index));
    if (league === 'PD') rows[98] = match('PD', 999999, {date: '2026-11-06T00:00:00+00:00'});
    return json(payload(rows));
  }});
  assert.equal(result.diagnostics[0].status, 'partial');
  assert.equal(result.diagnostics[0].note, 'fixture_limit_reached');
  assert.equal(result.diagnostics[0].matchedCount, 99);
  assert.equal(result.diagnostics[1].status, 'available');
  assert.equal(result.diagnostics[1].matchedCount, 98);
});

test('missing, invalid and stale HTTP dates fail closed while the exact five-minute boundary is accepted', async () => {
  const dates = {PL: null, PD: 'not-a-date', SA: 'Thu, 29 Oct 2026 08:24:59 GMT',
    BL1: 'Thu, 29 Oct 2026 08:35:01 GMT', FL1: 'Thu, 29 Oct 2026 08:25:00 GMT'};
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: async url => {
    const league = leagueFrom(url), response = json(payload([match(league)]));
    if (dates[league] === null) response.headers.delete('date');
    else response.headers.set('date', dates[league]);
    return response;
  }});
  assert.deepEqual(result.fixtures.map(f => f.league), ['FL1']);
  assert.ok(result.diagnostics.slice(0, 4).every(d => d.status === 'unavailable'
    && d.note === 'stale_response' && d.matchedCount === 0));
});

test('HTTP failures, invalid JSON and untrusted network errors expose only stable error codes', async () => {
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: async url => {
    const league = leagueFrom(url);
    if (league === 'PL') return json({}, 401);
    if (league === 'PD') return json({}, 429);
    if (league === 'SA') return json({}, 302, {Location: `https://other.invalid/?key=${testKey}`});
    if (league === 'BL1') return new Response('not json', {headers: {Date: new Date(nowISO).toUTCString()}});
    throw Object.assign(new Error(`reflected ${testKey}`), {code: testKey});
  }});
  assert.deepEqual(result.fixtures, []);
  assert.deepEqual(result.diagnostics.map(d => d.note), [
    'authorization_required', 'rate_limited', 'http_unavailable', 'invalid_json', 'network_unavailable',
  ]);
  assert.equal(JSON.stringify(result).includes(testKey), false);
  assert.equal(JSON.stringify(result).includes('other.invalid'), false);
});

test('declared and streamed bodies above two megabytes fail closed', async () => {
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: async url => {
    const league = leagueFrom(url);
    if (league === 'PL') return json(payload([match('PL')]), 200, {'Content-Length': '2000001'});
    if (league === 'PD') return new Response('x'.repeat(2_000_001), {headers: {
      'Content-Type': 'application/json', Date: new Date(nowISO).toUTCString(),
    }});
    return json(payload([]));
  }});
  assert.deepEqual(result.fixtures, []);
  assert.equal(result.diagnostics[0].note, 'response_too_large');
  assert.equal(result.diagnostics[1].note, 'response_too_large');
  assert.ok(result.diagnostics.slice(2).every(d => d.status === 'complete'));
});

test('invalid request arguments fail before network access', async () => {
  let calls = 0;
  const fetchImpl = async () => {calls++; throw new Error('must not fetch');};
  for (const input of [
    {days: 0}, {days: 15}, {days: 1.5}, {nowISO: 'invalid'}, {nowISO: '2026-02-30T10:00:00Z'},
    {apiKey: 'x\r\ny'}, {apiKey: 'x'.repeat(257)}, {apiKey: 123}, {fetchImpl: null},
  ]) {
    await assert.rejects(() => fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl, ...input}), TypeError);
  }
  assert.equal(calls, 0);
});

test('all five requests have a six-second deadline even when fetch ignores cancellation', async () => {
  const started = Date.now();
  const result = await fetchApiFootballFixtures({apiKey: testKey, nowISO, fetchImpl: () => new Promise(() => {})});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 5900 && elapsed < 9000, `elapsed=${elapsed}`);
  assert.deepEqual(result.fixtures, []);
  assert.ok(result.diagnostics.every(d => d.note === 'timeout'));
});
