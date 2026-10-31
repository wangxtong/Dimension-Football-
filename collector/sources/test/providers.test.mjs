import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderClient } from '../provider-http.mjs';
import { fetchSportmonksFixtures, fetchSportmonksEvidence, sportmonksLeagues } from '../sportmonks.mjs';
import { fetchOddsApiEvidence } from '../odds-api.mjs';
import { fetchIsportsEvidence } from '../isports.mjs';
import { collectProviderEvidence, readProviderPolicy, providerStatus, readProviderHealth } from '../providers.mjs';
import { collectManagedFixtures } from '../manager.mjs';
import { runCli } from '../../run.mjs';
import { evaluateFixture, retainedEvidence } from '../../policy.mjs';

const NOW = '2026-10-31T10:00:00.000Z', KICKOFF = '2026-10-31T18:00:00.000Z';
const fixture = { id: 'fd-1', league: 'PL', home: 'Arsenal FC', away: 'Chelsea FC', kickoff: KICKOFF,
  status: 'TIMED', source: 'football-data.org', updatedAt: NOW };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { date: new Date(NOW).toUTCString(), ...headers } });
const smEvent = (league = 8, id = league) => ({ id, league_id: league, state_id: 1,
  starting_at_timestamp: Date.parse(KICKOFF) / 1000,
  participants: [{ id: 1, name: 'Arsenal', meta: { location: 'home' } }, { id: 2, name: 'Chelsea', meta: { location: 'away' } }],
  predictions: [{ fixture_id: id, predictions: { home: 55, draw: 25, away: 20 },
    type: { developer_name: 'FULLTIME_RESULT_PROBABILITY', model_type: 'prediction' } }] });
const page = (rows, current = 1, more = false) => ({ data: rows, pagination: { current_page: current, has_more: more } });
const client = (provider, fetchImpl, options = {}) => createProviderClient({ provider, apiKey: 'test-private-key', nowISO: NOW, fetchImpl, ...options });
async function workspace(t) { const path = await mkdtemp(join(tmpdir(), 'providers-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }

test('provider requests use fixed hosts, correct authentication and never follow a redirect', async () => {
  for (const provider of ['sportmonks', 'the-odds-api', 'isports']) {
    let calls = 0;
    const c = client(provider, async (value, init) => {
      calls++; const url = new URL(value);
      assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET');
      assert.equal(url.origin, { sportmonks: 'https://api.sportmonks.com', 'the-odds-api': 'https://api.the-odds-api.com', isports: 'https://api.isportsapi.com' }[provider]);
      if (provider === 'sportmonks') { assert.equal(init.headers.Authorization, 'test-private-key'); assert.ok(!url.href.includes('test-private-key')); }
      else assert.equal(url.searchParams.get(provider === 'isports' ? 'api_key' : 'apiKey'), 'test-private-key');
      return new Response('', { status: 302, headers: { location: 'https://attacker.invalid/' } });
    });
    await assert.rejects(c.get('/allowed'), { code: 'redirect_blocked' }); assert.equal(calls, 1);
    await assert.rejects(c.get('//attacker.invalid/'), { code: 'invalid_endpoint' }); assert.equal(calls, 1);
  }
});

test('transport bounds body size, timestamps, JSON, request counts and credential errors', async () => {
  const cases = [
    [() => new Response('x', { headers: { date: new Date(NOW).toUTCString(), 'content-length': '2000001' } }), 'response_too_large'],
    [() => new Response('x'.repeat(2000001), { headers: { date: new Date(NOW).toUTCString() } }), 'response_too_large'],
    [() => json({}, 200, { date: 'Wed, 01 Jan 2020 00:00:00 GMT' }), 'stale_response'],
    [() => new Response('<html>login</html>', { headers: { date: new Date(NOW).toUTCString() } }), 'invalid_json'],
    [() => { throw new Error('apiKey=test-private-key'); }, 'network_unavailable'],
  ];
  for (const [fetchImpl, code] of cases) await assert.rejects(client('isports', fetchImpl).get('/allowed'), e => e.code === code && !e.message.includes('test-private-key'));
  const c = client('sportmonks', async () => json({}), { maxRequests: 1 });
  await c.get('/allowed'); await assert.rejects(c.get('/allowed'), { code: 'request_limit' });
  assert.throws(() => client('sportmonks', fetch, { apiKey: 'key\r\nInjected: yes' }), { code: 'invalid_credentials' });
});

test('deadlines and cancellation work even when the fetch implementation ignores AbortSignal', async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(client('sportmonks', never, { timeoutMs: 10 }).get('/allowed'), { code: 'timeout' });
  const controller = new AbortController(), c = client('isports', never, { signal: controller.signal });
  const pending = c.get('/allowed'); controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
});

test('Sportmonks is a complete fixture fallback with distinct identities and bounded pagination', async t => {
  const cwd = await workspace(t); let calls = 0;
  const fetchImpl = async (value, init) => {
    calls++; const url = new URL(value);
    assert.equal(init.headers.Authorization, 'sm-secret');
    const leagueId = Number(url.searchParams.get('filters').split(':')[1]);
    return json(page([smEvent(leagueId)]));
  };
  const result = await collectManagedFixtures({ statePath: join(cwd, 'source.json'), credentials: { sportmonks: 'sm-secret' },
    nowISO: NOW, clock: () => NOW, fetchImpl });
  assert.equal(calls, 5); assert.equal(result.management.selectedSource, 'sportmonks'); assert.equal(result.poolComplete, true);
  assert.equal(result.fixtures.length, 5); assert.ok(result.fixtures.every(f => f.id.startsWith('sm-') && f.source === 'sportmonks'));
  assert.ok(!JSON.stringify(result).includes('sm-secret'));
});

test('Sportmonks never follows next_page and discards an incomplete league rather than truncating it', async () => {
  const calls = [];
  const result = await fetchSportmonksFixtures({ apiKey: 'key', nowISO: NOW, maxPages: 1, fetchImpl: async value => {
    const url = new URL(value); calls.push(url); const league = Number(url.searchParams.get('filters').split(':')[1]);
    return json({ ...page([smEvent(league)], 1, league === 8), next_page: 'https://attacker.invalid/?api_token=key' });
  } });
  assert.equal(result.fixtures.length, 4); assert.equal(result.diagnostics[0].note, 'incomplete_response');
  assert.ok(calls.every(url => url.host === 'api.sportmonks.com'));
  const duplicate = await fetchSportmonksFixtures({ apiKey: 'key', nowISO: NOW, fetchImpl: async value => {
    const url = new URL(value), league = Number(url.searchParams.get('filters').split(':')[1]);
    return json(page([smEvent(league), smEvent(league)]));
  } });
  assert.equal(duplicate.fixtures.length, 0); assert.ok(duplicate.diagnostics.every(row => row.note === 'duplicate_fixture_id'));
});

test('Sportmonks 401/402/403/429 stops subsequent league requests', async () => {
  for (const status of [401, 402, 403, 429]) {
    let calls = 0;
    const result = await fetchSportmonksFixtures({ apiKey: 'key', nowISO: NOW, fetchImpl: async () => { calls++; return json({}, status); } });
    assert.equal(calls, 1); assert.equal(result.fixtures.length, 0); assert.equal(result.diagnostics.length, 5);
  }
});

test('Sportmonks model is matched by league, teams and time and remains a 1X2 auxiliary signal', async () => {
  const result = await fetchSportmonksEvidence({ fixtures: [fixture], nowISO: NOW,
    client: client('sportmonks', async () => json(page([smEvent()]))) });
  assert.equal(result.signals.length, 1); assert.equal(result.signals[0].market, '1x2'); assert.equal(result.signals[0].probability, .55);
  assert.equal(result.observations[0].sourceUpdatedAt, null); assert.equal(result.observations[0].modelCadence, 'daily-prematch');
  assert.equal(retainedEvidence(fixture, { signals: result.signals }, NOW).signals.length, 1);
  assert.equal(evaluateFixture(fixture, { signals: result.signals }, NOW).status, 'source_insufficient');
  for (const mutate of [row => row.participants.reverse().forEach(p => p.meta.location = p.meta.location === 'home' ? 'away' : 'home'),
    row => row.starting_at_timestamp += 3600, row => row.predictions[0].predictions.home = 99,
    row => row.state_id = 2, row => row.predictions[0].type.developer_name = 'VALUE_BET']) {
    const row = smEvent(); mutate(row);
    const bad = await fetchSportmonksEvidence({ fixtures: [fixture], nowISO: NOW, client: client('sportmonks', async () => json(page([row]))) });
    assert.equal(bad.signals.length, 0);
  }
  const duplicate = await fetchSportmonksEvidence({ fixtures: [fixture], nowISO: NOW,
    client: client('sportmonks', async () => json(page([smEvent(8, 1), smEvent(8, 2)]))) });
  assert.equal(duplicate.signals.length, 0);
});

function oddsEvent() {
  return { id: 'event-1', sport_key: 'soccer_epl', home_team: 'Arsenal', away_team: 'Chelsea', commence_time: KICKOFF,
    bookmakers: [{ key: 'bet365', title: 'Bet365', last_update: NOW, markets: [
      { key: 'h2h', outcomes: [{ name: 'Arsenal', price: 2 }, { name: 'Draw', price: 3 }, { name: 'Chelsea', price: 4 }] },
      { key: 'spreads', outcomes: [{ name: 'Arsenal', price: 1.9, point: -.5 }, { name: 'Chelsea', price: 1.9, point: .5 }] },
      { key: 'totals', outcomes: [{ name: 'Over', price: 1.9, point: 2.5 }, { name: 'Under', price: 1.9, point: 2.5 }] },
    ] }] };
}
test('The Odds API preserves coherent market prices, normalization and settlement limitations', async () => {
  const result = await fetchOddsApiEvidence({ fixtures: [fixture], nowISO: NOW, client: client('the-odds-api', async value => {
    const url = new URL(value); assert.equal(url.searchParams.get('markets'), 'h2h,spreads,totals');
    return json([oddsEvent()]);
  }) });
  assert.equal(result.observations.length, 3); assert.equal(result.signals.length, 0);
  const h2h = result.observations[0]; assert.ok(Math.abs(Object.values(h2h.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-10);
  assert.equal(h2h.formalEligible, false); assert.equal(h2h.probabilityMeaning, 'market-implied-not-model');
  assert.ok(result.observations[1].blockers.includes('HANDICAP_SETTLEMENT_REQUIRES_VERIFICATION'));
});

test('The Odds API rejects stale, reversed, duplicate or Crown evidence', async () => {
  for (const mutate of [row => row.bookmakers[0].last_update = '2026-10-31T09:00:00.000Z',
    row => [row.home_team, row.away_team] = [row.away_team, row.home_team], row => row.commence_time = '2026-10-31T19:00:00.000Z',
    row => row.bookmakers[0].title = 'Crown']) {
    const row = oddsEvent(); mutate(row);
    const result = await fetchOddsApiEvidence({ fixtures: [fixture], nowISO: NOW, client: client('the-odds-api', async () => json([row])) });
    assert.equal(result.observations.length, 0);
  }
  const row = oddsEvent(); row.bookmakers[0].markets[1].outcomes[1].point = 1;
  const result = await fetchOddsApiEvidence({ fixtures: [fixture], nowISO: NOW, client: client('the-odds-api', async () => json([row])) });
  assert.equal(result.observations.length, 2);
  const other = oddsEvent(); other.id = 'duplicate-identity';
  const ambiguous = await fetchOddsApiEvidence({ fixtures: [fixture], nowISO: NOW, client: client('the-odds-api', async () => json([oddsEvent(), other])) });
  assert.equal(ambiguous.observations.length, 0);
});

const isSchedule = () => ({ code: 0, data: [{ matchId: '101', leagueId: '36', leagueShortName: 'ENG PR',
  homeName: 'Arsenal', awayName: 'Chelsea', matchTime: Date.parse(KICKOFF) / 1000, status: 0 }] });
const isOdds = () => ['101', '17', '0.5', '0.85', '0.95', '0.5', '0.9', '0.92', 'false', 'false', String(Date.parse(NOW) / 1000), 'false', '1'];
test('iSports parses documented HK odds/signs and never invents an opening timestamp', async () => {
  let calls = 0;
  const result = await fetchIsportsEvidence({ fixtures: [fixture], nowISO: NOW, client: client('isports', async value => {
    calls++; const url = new URL(value);
    return json(url.pathname.endsWith('livescores') ? isSchedule() : { code: 0, data: { handicap: [isOdds().join(',')] } });
  }) });
  assert.equal(calls, 2); assert.equal(result.observations.length, 1);
  const quote = result.observations[0]; assert.equal(quote.outcomes[0].line, -.5); assert.equal(quote.outcomes[0].decimalOdds, 1.9);
  assert.equal(quote.outcomes[1].line, .5); assert.equal(quote.openingReference.observedAt, null); assert.equal(quote.formalEligible, false);
  assert.equal(result.signals.length, 0);
});

test('iSports rejects suspended, in-play, stale, malformed, ambiguous and excluded-company markets', async () => {
  for (const [index, value] of [[1, '3'], [8, 'true'], [9, 'true'], [11, 'true'], [12, '3'], [6, ''], [10, '1']]) {
    const row = isOdds(); row[index] = value;
    const result = await fetchIsportsEvidence({ fixtures: [fixture], nowISO: NOW, client: client('isports', async url =>
      json(new URL(url).pathname.endsWith('livescores') ? isSchedule() : { code: 0, data: { handicap: [row.join(',')] } })) });
    assert.equal(result.observations.length, 0);
  }
  const duplicate = await fetchIsportsEvidence({ fixtures: [fixture], nowISO: NOW, client: client('isports', async url =>
    json(new URL(url).pathname.endsWith('livescores') ? isSchedule() : { code: 0, data: { handicap: [isOdds().join(','), isOdds().join(',')] } })) });
  assert.equal(duplicate.observations.length, 0);
  const tomorrow = await fetchIsportsEvidence({ fixtures: [{ ...fixture, kickoff: '2026-11-01T18:00:00.000Z' }], nowISO: NOW,
    client: client('isports', () => assert.fail('out of coverage must not fetch')) });
  assert.equal(tomorrow.diagnostics[0].code, 'outside_today_coverage');
});

test('missing keys and contract-only providers generate no API requests and status never contains credentials', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'state.providers.json');
  const result = await collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, env: {}, statePath,
    fetchImpl: () => assert.fail('no credentials means no request') });
  assert.equal(result.providers.attempts.filter(row => row.status === 'not_configured').length, 3);
  assert.equal(result.providers.attempts.find(row => row.id === 'nami').status, 'contract_required');
  assert.equal(providerStatus({ env: { SPORTMONKS_API_TOKEN: 'do-not-print' }, nowISO: NOW })[0].configured, true);
  assert.ok(!JSON.stringify(providerStatus({ env: { SPORTMONKS_API_TOKEN: 'do-not-print' }, nowISO: NOW })).includes('do-not-print'));
  const output = [];
  const status = await runCli(['--provider-status'], { cwd, env: {}, clock: () => NOW, stdout: text => output.push(text), fetchImpl: () => assert.fail('offline only') });
  assert.equal(status.exitCode, 0); assert.equal(JSON.parse(output.join('')).length, 8);
});

test('paid access errors persist cooldown, skip further attempts and never invoke a credential bypass', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'state.providers.json'), env = { THE_ODDS_API_KEY: 'private-query-secret' };
  let calls = 0;
  const run = () => collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, env, statePath,
    fetchImpl: async () => { calls++; return json({ message: 'private-query-secret' }, 402); } });
  const first = await run(); const second = await run();
  assert.equal(calls, 1); assert.equal(first.providers.attempts.find(row => row.id === 'the-odds-api').status, 'subscription_required');
  assert.equal(second.providers.attempts.find(row => row.id === 'the-odds-api').status, 'cooldown');
  const saved = await readFile(statePath, 'utf8'); assert.ok(!saved.includes('private-query-secret'));
  assert.ok(!JSON.stringify(first).includes('private-query-secret'));
});

test('Retry-After persists, expired circuits recover, and corrupt state does not silently reset', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'state.providers.json'), env = { THE_ODDS_API_KEY: 'secret' };
  const first = await collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, env, statePath,
    fetchImpl: async () => json({}, 429, { 'retry-after': '7200' }) });
  assert.equal(first.providers.attempts.find(row => row.id === 'the-odds-api').nextProbeAt, '2026-10-31T12:00:00.000Z');
  const next = '2026-10-31T12:01:00.000Z';
  await collectProviderEvidence({ fixtures: [fixture], nowISO: next, env, statePath,
    fetchImpl: async () => json([], 200, { date: new Date(next).toUTCString() }) });
  assert.equal((await readProviderHealth(statePath)).sources['the-odds-api'].failures, 0);
  await writeFile(statePath, '{bad');
  await assert.rejects(collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, env, statePath,
    fetchImpl: () => assert.fail('corrupt state must not fetch') }), { message: 'PROVIDER_STATE_UNREADABLE' });
});

test('provider budget exhaustion is local, records no supplier failure and does not leak a partial page', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'state.providers.json');
  const result = await collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, statePath, env: { SPORTMONKS_API_TOKEN: 'private' },
    policy: readProviderPolicy({ maxRequestsPerProvider: 1 }), fetchImpl: async () => json(page([smEvent()], 1, true)) });
  assert.equal(result.providers.observations.length, 0); assert.equal(result.signals.length, 0);
  assert.equal(result.providers.attempts[0].status, 'request_limit');
  assert.equal((await readProviderHealth(statePath)).sources.sportmonks, undefined);
});

test('configuration cannot add hosts, unsupported sources or unbounded request budgets', () => {
  for (const input of [{ baseUrl: 'https://attacker.invalid' }, { enabled: ['nami'] }, { enabled: ['sportmonks', 'sportmonks'] },
    { maxRequestsPerProvider: 1000 }, { oddsRegions: 'eu,us' }, { maxPages: 0 }]) assert.throws(() => readProviderPolicy(input), { message: 'INVALID_PROVIDER_POLICY' });
});

test('CLI merges all three providers into actual JSON/Markdown reports without changing formal gates or leaking keys', async t => {
  const cwd = await workspace(t), env = { SPORTMONKS_API_TOKEN: 'sm-secret-private', THE_ODDS_API_KEY: 'odds-secret-private', ISPORTS_API_KEY: 'is-secret-private' };
  await writeFile(join(cwd, 'fixtures.json'), JSON.stringify([fixture]));
  const called = [];
  const result = await runCli(['--input', 'fixtures.json', '--state', 'state.json', '--out', 'reports'], { cwd, env, clock: () => NOW, stdout: () => {},
    fetchImpl: async value => {
      const url = new URL(value); called.push(url.host);
      if (url.host === 'api.sportmonks.com') return json(page([smEvent()]));
      if (url.host === 'api.the-odds-api.com') return json([oddsEvent()]);
      if (url.host === 'api.isportsapi.com') return json(url.pathname.endsWith('livescores') ? isSchedule() : { code: 0, data: { handicap: [isOdds().join(',')] } });
      if (url.pathname === '/robots.txt') return new Response('User-agent: *\nDisallow: /\n', { headers: { date: new Date(NOW).toUTCString() } });
      assert.fail('public crawler must honor robots');
    } });
  assert.equal(result.exitCode, 0); assert.equal(result.report.providers.observations.length, 5);
  assert.ok(result.report.providers.observations.every(row => row.currentAtPublication));
  assert.equal(result.report.summary.candidates, 0); assert.equal(result.report.results[0].lastEvidence.signals[0].sourceId, 'sportmonks');
  const files = await Promise.all([result.files.jsonPath, result.files.messagePath, join(cwd, 'state.json'), join(cwd, 'state.json.providers.json')].map(path => readFile(path, 'utf8')));
  for (const content of files) for (const key of Object.values(env)) assert.ok(!content.includes(key));
  assert.ok(files[1].includes('商业数据来源')); assert.ok(files[1].includes('55.00%')); assert.ok(files[1].includes('home -0.5 @ 1.9'));
  assert.ok(called.includes('api.sportmonks.com') && called.includes('api.the-odds-api.com') && called.includes('api.isportsapi.com'));
});

test('a model subscription failure does not suppress a usable independent market-reference provider', async t => {
  const cwd = await workspace(t);
  const result = await collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, statePath: join(cwd, 'providers.json'),
    env: { SPORTMONKS_API_TOKEN: 'sm-key', THE_ODDS_API_KEY: 'odds-key' }, fetchImpl: async value =>
      new URL(value).host === 'api.sportmonks.com' ? json({}, 403) : json([oddsEvent()]) });
  assert.equal(result.providers.attempts[0].status, 'plan_restricted');
  assert.equal(result.providers.observations.length, 3); assert.equal(result.providers.attempts[1].status, 'checked');
});

test('empty matched coverage remains degraded despite a healthy HTTP transport', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'empty.json');
  const result = await collectProviderEvidence({ fixtures: [fixture], nowISO: NOW, statePath,
    env: { THE_ODDS_API_KEY: 'synthetic' }, fetchImpl: async () => json([]) });
  const health = (await readProviderHealth(statePath)).sources['the-odds-api'];
  assert.equal(health.status, 'degraded'); assert.equal(health.transportStatus, 'healthy');
  assert.equal(health.coverageStatus, 'empty'); assert.equal(health.matchedCount, 0);
  assert.equal(health.lastDataAt, null); assert.equal(health.code, 'empty_coverage');
  assert.equal(result.diagnostics[0].code, 'no_matching_markets');
});

test('one unavailable league preserves verified markets and cools only that league', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'partial.json');
  const fixtures = [fixture, { ...fixture, id: 'fd-2', league: 'PD' }];
  const urls = [];
  const run = () => collectProviderEvidence({ fixtures, nowISO: NOW, statePath, env: { THE_ODDS_API_KEY: 'synthetic' }, fetchImpl: async value => {
    const url = new URL(value); urls.push(url.pathname);
    return url.pathname.includes('soccer_epl') ? json([oddsEvent()]) : json({}, 403);
  } });
  const first = await run(), second = await run();
  assert.equal(first.providers.observations.length, 3); assert.equal(second.providers.observations.length, 3);
  assert.equal(urls.filter(url => url.includes('soccer_epl')).length, 2);
  assert.equal(urls.filter(url => url.includes('soccer_spain')).length, 1);
  const health = (await readProviderHealth(statePath)).sources['the-odds-api'];
  assert.equal(health.status, 'degraded'); assert.equal(health.coverageStatus, 'partial');
  assert.equal(health.nextProbeAt, null); assert.equal(health.lastDataAt, NOW);
  assert.equal(health.leagues.PD.nextProbeAt, '2026-10-31T16:00:00.000Z');
  assert.equal(second.diagnostics.find(row => row.league === 'PD').code, 'cooldown');
});

test('later account rate limiting preserves earlier data but stops later requests and persists cooldown', async t => {
  const cwd = await workspace(t), statePath = join(cwd, 'limited.json'); let calls = 0;
  const result = await collectProviderEvidence({ fixtures: [fixture, { ...fixture, id: 'pd', league: 'PD' }, { ...fixture, id: 'sa', league: 'SA' }],
    nowISO: NOW, statePath, env: { THE_ODDS_API_KEY: 'synthetic' }, fetchImpl: async () => {
      calls++; return calls === 1 ? json([oddsEvent()]) : json({}, 429, { 'retry-after': '7200' });
    } });
  assert.equal(calls, 2); assert.equal(result.providers.observations.length, 3);
  const health = (await readProviderHealth(statePath)).sources['the-odds-api'];
  assert.equal(health.transportStatus, 'degraded'); assert.equal(health.coverageStatus, 'partial');
  assert.equal(health.code, 'rate_limited'); assert.equal(health.nextProbeAt, '2026-10-31T12:00:00.000Z');
});

test('Sportmonks keeps a complete earlier league while rejecting an incomplete later league atomically', async () => {
  const result = await fetchSportmonksEvidence({ fixtures: [fixture, { ...fixture, id: 'pd', league: 'PD' }], nowISO: NOW,
    client: client('sportmonks', async value => {
      const league = new URL(value).searchParams.get('filters');
      return league === 'fixtureLeagues:8' ? json(page([smEvent()])) : json({ data: [smEvent(564)] });
    }) });
  assert.equal(result.observations.length, 1); assert.equal(result.signals.length, 1);
  assert.equal(result.diagnostics.find(row => row.league === 'PD').code, 'incomplete_response');
});
