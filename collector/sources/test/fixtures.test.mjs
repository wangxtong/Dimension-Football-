import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchFootballFixtures, fixtureLeagues} from '../fixtures.mjs';

const nowISO = '2026-10-29T08:30:00.000Z';
function match(league, changes = {}) {
  return {id: fixtureLeagues.indexOf(league) + 1, competition: {code: league},
    homeTeam: {id: 1, name: 'Home FC'}, awayTeam: {id: 2, name: 'Away FC'},
    utcDate: '2026-10-30T18:00:00Z', status: 'TIMED', lastUpdated: '2026-10-28T10:00:00Z', ...changes};
}
function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {status, headers: {
    'Content-Type': 'application/json', Date: new Date(nowISO).toUTCString(), ...headers,
  }});
}

test('five authenticated official requests use explicit exclusive-date window and retain partial successes', async () => {
  const calls = [];
  const result = await fetchFootballFixtures({apiKey: 'test-token', nowISO, fetchImpl: async (url, options) => {
    calls.push({url, options});
    const league = new URL(url).pathname.split('/')[3];
    return league === 'FL1' ? json({}, 403) : json({matches: [match(league)]});
  }});
  assert.equal(calls.length, 5);
  for (const {url, options} of calls) {
    const request = new URL(url);
    assert.equal(request.origin, 'https://api.football-data.org');
    assert.equal(request.searchParams.get('dateFrom'), '2026-10-29');
    assert.equal(request.searchParams.get('dateTo'), '2026-11-06');
    assert.equal(options.headers['X-Auth-Token'], 'test-token');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(result.fixtures.length, 4);
  assert.equal(result.diagnostics.find(d => d.league === 'FL1').note, 'access_denied');
  assert.equal(result.window.to, '2026-11-05T08:30:00.000Z');
  assert.equal(result.window.dateToExclusive, true);
  assert.equal(result.fixtures[0].updatedAt, nowISO);
  assert.equal(result.fixtures[0].fetchedAt, nowISO);
  assert.equal(result.fixtures[0].sourceUpdatedAt, '2026-10-28T10:00:00.000Z');
  assert.equal(result.fixtures[0].source, 'football-data.org');
  assert.equal(result.fixtures[0].homeTeamId, '1');
  assert.equal(result.fixtures[0].awayTeamId, '2');
  assert.equal(JSON.stringify(result).includes('test-token'), false);
});

test('keeps only correctly identified upcoming scheduled or timed fixtures within exact rolling window', async () => {
  const result = await fetchFootballFixtures({apiKey: 'test-token', nowISO, days: 1, fetchImpl: async url => {
    const league = new URL(url).pathname.split('/')[3];
    if (league !== 'PL') return json({matches: []});
    return json({matches: [
      match('PL', {id: 11, status: 'SCHEDULED', utcDate: '2026-10-29T10:00:00Z', lastUpdated: undefined}),
      match('PL', {id: 12, status: 'TIMED', utcDate: '2026-10-30T08:30:00Z'}),
      match('PL', {id: 13, utcDate: nowISO}),
      match('PL', {id: 14, utcDate: '2026-10-30T08:30:01Z'}),
      match('PL', {id: 15, status: 'IN_PLAY'}),
      match('PL', {id: 16, status: 'FINISHED'}),
      match('PL', {id: 17, competition: {code: 'CL'}}),
      match('PL', {id: 18, homeTeam: {name: ''}}),
      match('PL', {id: 19, utcDate: '2026-02-30T10:00:00Z'}),
    ]});
  }});
  assert.deepEqual(result.fixtures.map(f => f.id), ['fd-11', 'fd-12']);
  assert.equal(result.fixtures[0].sourceUpdatedAt, null);
  const diagnostic = result.diagnostics.find(d => d.league === 'PL');
  assert.equal(diagnostic.receivedCount, 9);
  assert.equal(diagnostic.rejectedCount, 3);
  assert.equal(diagnostic.matchedCount, 2);
  assert.equal(diagnostic.status, 'partial');
});

test('missing credentials reports five authorization blockers without an upstream call', async () => {
  let calls = 0;
  const result = await fetchFootballFixtures({nowISO, fetchImpl: async () => { calls++; throw new Error('must not fetch'); }});
  assert.equal(calls, 0);
  assert.deepEqual(result.fixtures, []);
  assert.equal(result.diagnostics.length, 5);
  assert.ok(result.diagnostics.every(d => d.note === 'authorization_required' && d.fetchedAt === null));
});

test('API failure and malformed responses retain explicit league diagnostics and never synthesize fixtures', async () => {
  const result = await fetchFootballFixtures({apiKey: 'test-token', nowISO, fetchImpl: async url => {
    const league = new URL(url).pathname.split('/')[3];
    if (league === 'PL') return json({}, 429);
    if (league === 'PD') return new Response('not json', {headers: {Date: new Date(nowISO).toUTCString()}});
    if (league === 'SA') return json({matches: [match('SA'), match('SA')]});
    if (league === 'BL1') return json({matches: Array.from({length: 3001}, () => match('BL1'))});
    return json({matches: []});
  }});
  assert.deepEqual(result.fixtures, []);
  assert.deepEqual(result.diagnostics.map(d => d.note), [
    'rate_limited', 'invalid_json', 'duplicate_fixture_id', 'too_many_fixtures', 'no_upcoming_fixtures',
  ]);
  assert.equal(result.diagnostics.find(d => d.league === 'FL1').status, 'complete');
});

test('a fresh successful empty schedule is complete, while malformed entries remain partial', async () => {
  const result = await fetchFootballFixtures({apiKey: 'test-token', nowISO, fetchImpl: async url => {
    const league = new URL(url).pathname.split('/')[3];
    return json({matches: league === 'PL' ? [{id: 101}] : []});
  }});
  assert.deepEqual(result.fixtures, []);
  assert.equal(result.diagnostics[0].status, 'partial');
  assert.equal(result.diagnostics[0].rejectedCount, 1);
  for (const diagnostic of result.diagnostics.slice(1)) {
    assert.equal(diagnostic.status, 'complete');
    assert.equal(diagnostic.note, 'no_upcoming_fixtures');
    assert.equal(diagnostic.matchedCount, 0);
    assert.equal(diagnostic.responseAt, nowISO);
  }
});

test('missing, invalid, or more than five-minute HTTP dates fail closed without refreshing cached fixtures', async () => {
  const dates = new Map([
    ['PL', null], ['PD', 'not-a-date'], ['SA', 'Thu, 29 Oct 2026 08:24:59 GMT'],
    ['BL1', 'Thu, 29 Oct 2026 08:35:01 GMT'], ['FL1', 'Thu, 29 Oct 2026 08:25:00 GMT'],
  ]);
  const result = await fetchFootballFixtures({apiKey: 'test-token', nowISO, fetchImpl: async url => {
    const league = new URL(url).pathname.split('/')[3];
    const response = json({matches: [match(league)]});
    if (dates.get(league) === null) response.headers.delete('date');
    else response.headers.set('date', dates.get(league));
    return response;
  }});
  assert.deepEqual(result.fixtures.map(f => f.league), ['FL1']);
  for (const diagnostic of result.diagnostics.slice(0, 4)) {
    assert.equal(diagnostic.status, 'unavailable');
    assert.equal(diagnostic.note, 'stale_response');
    assert.equal(diagnostic.matchedCount, 0);
  }
  assert.equal(result.fixtures[0].updatedAt, nowISO);
  assert.equal(result.fixtures[0].sourceUpdatedAt, '2026-10-28T10:00:00.000Z');
});

test('invalid request fails before network; an exact midnight endpoint remains covered by exclusive API dates', async () => {
  const fetchImpl = async () => { throw new Error('must not fetch'); };
  for (const input of [{days: 0}, {days: 15}, {days: 1.5}, {nowISO: 'invalid'}, {apiKey: 'x\r\ny'}]) {
    await assert.rejects(() => fetchFootballFixtures({nowISO, fetchImpl, ...input}), TypeError);
  }
  const result = await fetchFootballFixtures({nowISO: '2026-10-29T00:00:00Z', days: 1, fetchImpl});
  assert.equal(result.window.dateTo, '2026-10-31');
  assert.equal(result.window.to, '2026-10-30T00:00:00.000Z');
  assert.equal(result.window.toInclusive, true);
});

test('each official league request has a six-second deadline even if fetch ignores its abort signal', async () => {
  const started = Date.now();
  const result = await fetchFootballFixtures({apiKey: 'test-token', nowISO, fetchImpl: () => new Promise(() => {})});
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 5900 && elapsed < 9000, `elapsed=${elapsed}`);
  assert.ok(result.diagnostics.every(d => d.note === 'timeout'));
  assert.deepEqual(result.fixtures, []);
});
