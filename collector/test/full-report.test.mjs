import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { buildFullAnalysis, renderFullAnalysisHtml } from '../full-report.mjs';

const NOW = '2026-10-30T12:00:00.000Z';
const DAY = 86_400_000;
const hash = 'a'.repeat(64);
const steps = ['identity', 'recentForm', 'venueForm', 'headToHead', 'rest', 'injuries', 'lineups',
  'matchWinner', 'goalsOverUnder25', 'asianHandicap', 'independentForecast', 'recommendationGate'];
const at = ms => new Date(Date.parse(NOW) + ms).toISOString();

function request(kind, response, { fixtureId, fetchedAt = NOW, ...changes } = {}) {
  const endpoint = kind === 'history' ? 'fixtures' : kind === 'lineups' ? 'fixtures/lineups' : kind;
  return { kind, fixtureId, url: `https://v3.football.api-sports.io/${endpoint}?fixture=1000`,
    httpStatus: 200, fetchedAt, httpDate: new Date(fetchedAt).toUTCString(), sha256: hash,
    data: { get: endpoint, parameters: {}, errors: [], results: response.length,
      paging: { current: 1, total: 1 }, response }, ...changes };
}

function target(fixture, id, homeId, awayId) {
  return { fixture: { id, date: fixture.kickoff, timestamp: Date.parse(fixture.kickoff) / 1000, status: { short: 'NS' } },
    league: { id: 39 }, teams: { home: { id: homeId, name: fixture.home }, away: { id: awayId, name: fixture.away } },
    goals: { home: null, away: null } };
}

function marketPage(fixture, raw, { bookmakerName = 'Company 1' } = {}) {
  return { url: `https://v3.football.api-sports.io/odds?fixture=${raw.fixture.id}`, fetchedAt: NOW,
    httpDate: new Date(NOW).toUTCString(), sha256: hash,
    data: { get: 'odds', parameters: { fixture: String(raw.fixture.id) }, errors: [], results: 1,
      paging: { current: 1, total: 1 }, response: [{ fixture: { id: raw.fixture.id, date: fixture.kickoff,
        timestamp: Date.parse(fixture.kickoff) / 1000 }, league: { id: 39 }, update: at(-60_000),
      bookmakers: [1, 2, 3].map(id => ({ id, name: id === 1 ? bookmakerName : `Company ${id}`, bets: [
        { id: 1, values: [{ value: 'Home', odd: '1.85' }, { value: 'Draw', odd: '3.8' }, { value: 'Away', odd: '4.5' }] },
        { id: 5, values: [{ value: 'Over 2.5', odd: '1.85' }, { value: 'Under 2.5', odd: '2.0' }] },
      ] })) }] } };
}

function historyFor(raw, index) {
  return Array.from({ length: 10 }, (_, i) => {
    const row = structuredClone(raw), home = raw.teams.home, away = raw.teams.away;
    row.fixture = { id: 500_000 + index * 20 + i, date: at(-(i + 1) * DAY),
      timestamp: Date.parse(at(-(i + 1) * DAY)) / 1000, status: { short: 'FT' } };
    row.teams = i % 2 ? { home: away, away: home } : { home, away };
    row.goals = { home: 2, away: 1 };
    return row;
  });
}

function input(count = 1, { includeHistory = false } = {}) {
  const fixtures = [], targets = [], markets = [], histories = [];
  for (let i = 0; i < count; i++) {
    const fixture = { id: `af-${1000 + i}`, league: 'PL', home: `Home ${i}`, away: `Away ${i}`,
      kickoff: at(DAY + i * 60_000), status: 'SCHEDULED', source: 'api-football', updatedAt: NOW };
    const raw = target(fixture, 1000 + i, 10_000 + 2 * i, 10_001 + 2 * i);
    fixtures.push(fixture); targets.push(raw); markets.push({ fixture: structuredClone(fixture), pages: [marketPage(fixture, raw)] });
    if (includeHistory) histories.push(...historyFor(raw, i));
  }
  return { evidence: { provider: 'API-Football', capturedAt: NOW, fixtures,
    evidence: [request('fixtures', targets), request('history', histories),
      ...fixtures.flatMap(fixture => [request('injuries', [], { fixtureId: fixture.id }), request('lineups', [], { fixtureId: fixture.id })])] },
    marketSnapshot: { provider: 'API-Football', fetchedAt: NOW, fixtures: markets }, priorHistory: [] };
}

const first = value => buildFullAnalysis(value).matches[0];
const fixtureRequest = value => value.evidence.evidence.find(row => row.kind === 'fixtures');
const rawTarget = value => fixtureRequest(value).data.response[0];
function replaceRequest(value, kind, response, changes = {}) {
  const fixtureId = value.evidence.fixtures[0].id;
  value.evidence.evidence = value.evidence.evidence.filter(row => !(row.kind === kind && row.fixtureId === fixtureId));
  const row = request(kind, response, { fixtureId, ...changes });
  value.evidence.evidence.push(row);
  return row;
}
function injury(raw, overrides = {}) {
  return { fixture: { id: raw.fixture.id }, team: structuredClone(raw.teams.home),
    player: { id: 77, name: 'Reported player', type: 'Missing Fixture', reason: 'Injury' }, ...overrides };
}
function lineup(team, idOffset = 0) {
  return { team: structuredClone(team), formation: '4-3-3', startXI: Array.from({ length: 11 }, (_, i) => ({
    player: { id: idOffset + i + 1, name: `Player ${i + 1}` },
  })) };
}
function independent(value, changes = {}, fixtureChanges = {}) {
  value.independentReport = { results: [{ fixture: { ...value.evidence.fixtures[0], ...fixtureChanges },
    lastEvidence: { signals: [{ sourceId: 'statarea', market: '1x2', selection: 'home', probability: .6,
      observedAt: at(-60_000), validUntil: at(3_600_000), verificationMethod: 'automatic', ...changes }] } }] };
}

test('all 48 fixtures receive all 12 dimensions despite absent Asian odds, injuries and lineups', () => {
  const value = input(48, { includeHistory: true }), before = JSON.stringify(value), report = buildFullAnalysis(value);
  assert.equal(JSON.stringify(value), before);
  assert.equal(report.summary.fixtures, 48);
  assert.equal(report.summary.processedAllDimensions, 48);
  assert.equal(report.summary.identityVerified, 48);
  assert.equal(report.summary.withRecentFiveBothTeams, 48);
  assert.equal(report.summary.withVenueFiveBothTeams, 48);
  assert.equal(report.summary.withMatchWinnerMarket, 48);
  assert.equal(report.summary.withGoalsMarket, 48);
  assert.equal(report.summary.formalRecommendations, 0);
  for (const match of report.matches) {
    assert.deepEqual(match.analysisStepsCompleted, steps);
    assert.equal(match.markets.asianHandicap.companyCount, 0);
    assert.equal(match.markets.matchWinner.companyCount, 3);
    assert.equal(match.markets.goalsOverUnder25.companyCount, 3);
    assert.equal(match.injuries.status, 'not_reported');
    assert.equal(match.lineups.status, 'unconfirmed');
    assert.equal(match.actions.matchWinner.action, '不下注');
    assert.equal(match.actions.goalsOverUnder25.action, '不下注');
  }
});

test('official rescheduling replaces the fixture date and rejects odds attached to its old kickoff', () => {
  const value = input(2, { includeHistory: true }), original = value.evidence.fixtures[0].kickoff;
  const raw = rawTarget(value); raw.fixture.date = at(2 * DAY); raw.fixture.timestamp = Date.parse(raw.fixture.date) / 1000;
  independent(value);
  const report = buildFullAnalysis(value), match = report.matches[0];
  assert.equal(match.identityVerified, true);
  assert.equal(match.scheduleChanged, true);
  assert.equal(match.originalKickoff, original);
  assert.equal(match.fixture.kickoff, at(2 * DAY));
  for (const market of [match.markets.matchWinner, match.markets.goalsOverUnder25]) {
    assert.equal(market.companyCount, 0);
    assert.ok(market.blockers.includes('RESPONSE_FIXTURE_IDENTITY_MISMATCH'));
  }
  assert.equal(match.independentForecast.signals.length, 0);
  assert.equal(match.analysisStepsCompleted.length, 12);
  assert.equal(report.matches[1].markets.matchWinner.companyCount, 3);
});

test('missing or malformed market entries do not prevent the other fixture dimensions from being reported', () => {
  for (const mutate of [
    value => { value.marketSnapshot.fixtures.shift(); },
    value => { value.marketSnapshot.fixtures[0] = { pages: [] }; },
  ]) {
    const value = input(2, { includeHistory: true }); mutate(value);
    let report;
    assert.doesNotThrow(() => { report = buildFullAnalysis(value); });
    assert.equal(report.matches.length, 2);
    assert.ok(report.matches.every(match => match.analysisStepsCompleted.length === 12));
    assert.equal(report.matches[0].history.home.last5.sampleCount, 5);
    assert.equal(report.matches[1].markets.matchWinner.companyCount, 3);
    assert.equal(report.matches[0].actions.matchWinner.action, '不下注');
  }
});

test('fixtures must pass endpoint, API errors, response count and timestamp validation', () => {
  const mutations = [
    row => { row.data.get = 'wrong-endpoint'; },
    row => { row.data.errors = { fixtures: 'upstream-private-error-body' }; },
    row => { row.data.errors = null; },
    row => { row.data.results++; },
    row => { row.data.response[0].fixture.timestamp++; },
  ];
  for (const mutate of mutations) {
    const value = input(); mutate(fixtureRequest(value));
    const match = first(value);
    assert.equal(match.identityVerified, false);
    assert.equal(match.analysisStepsCompleted.length, 12);
    assert.ok(match.actions.matchWinner.reasons.includes('FIXTURE_IDENTITY_UNVERIFIED'));
    assert.ok(!JSON.stringify(match).includes('upstream-private-error-body'));
  }
});

test('empty injury responses do not assert that a team has no injuries; invalid players are counted', () => {
  const empty = buildFullAnalysis(input());
  assert.equal(empty.matches[0].injuries.status, 'not_reported');
  assert.match(empty.matches[0].injuries.note, /无记录不代表没有伤停/);
  assert.match(renderFullAnalysisHtml(empty), /不能认定无人伤停/);
  const value = input(), raw = rawTarget(value);
  replaceRequest(value, 'injuries', [injury(raw), injury(raw, { player: undefined })]);
  const match = first(value);
  assert.equal(match.injuries.status, 'reported');
  assert.equal(match.injuries.records.length, 1);
  assert.equal(match.injuries.invalidRecordCount, 1);
  assert.equal(match.analysisStepsCompleted.length, 12);
});

test('unknown fixture identity and malformed ancillary rows cannot stop every other analysis dimension', () => {
  const value = input(2);
  fixtureRequest(value).data.errors = { fixtures: 'unavailable' };
  const raw = rawTarget(value);
  replaceRequest(value, 'injuries', [injury(raw, { team: undefined })]);
  replaceRequest(value, 'lineups', [lineup(undefinedTeam()), lineup(undefinedTeam(), 20)]);
  let report;
  assert.doesNotThrow(() => { report = buildFullAnalysis(value); });
  assert.equal(report.matches.length, 2);
  assert.ok(report.matches.every(match => match.analysisStepsCompleted.length === 12));
  assert.equal(report.matches[0].injuries.records.length, 0);
  assert.equal(report.matches[0].lineups.status, 'unconfirmed');
});
function undefinedTeam() { return {}; }

test('lineups require both distinct target teams and eleven distinct positive player IDs each', () => {
  const mutations = [
    (home, away) => [{ ...home, startXI: [] }, { ...away, startXI: [] }],
    home => [home, structuredClone(home)],
    (home, away) => [home, { ...away, team: { id: 999_999 } }],
    (home, away) => [home, { ...away, startXI: away.startXI.slice(0, 10) }],
    (home, away) => [home, { ...away, startXI: Array(11).fill(away.startXI[0]) }],
  ];
  for (const mutate of mutations) {
    const value = input(), raw = rawTarget(value);
    replaceRequest(value, 'lineups', mutate(lineup(raw.teams.home), lineup(raw.teams.away, 20)));
    assert.equal(first(value).lineups.status, 'unconfirmed');
    assert.deepEqual(first(value).lineups.teams, []);
  }
  const valid = input(), raw = rawTarget(valid);
  replaceRequest(valid, 'lineups', [lineup(raw.teams.home), lineup(raw.teams.away, 20)]);
  assert.equal(first(valid).lineups.status, 'reported');
  assert.equal(first(valid).lineups.teams.length, 2);
});

test('API error bodies are not adopted as injuries, lineups or predictions', () => {
  const value = input(), raw = rawTarget(value);
  const predictions = { league: { id: 39 }, teams: structuredClone(raw.teams), predictions: { percent: { home: '60%', draw: '20%', away: '20%' } } };
  for (const [kind, response] of [
    ['injuries', [injury(raw)]], ['lineups', [lineup(raw.teams.home), lineup(raw.teams.away, 20)]], ['predictions', [predictions]],
  ]) replaceRequest(value, kind, response).data.errors = { source: 'do-not-copy-private-upstream-error' };
  const report = buildFullAnalysis(value), match = report.matches[0];
  assert.equal(match.injuries.status, 'unavailable');
  assert.equal(match.injuries.records.length, 0);
  assert.equal(match.lineups.status, 'unconfirmed');
  assert.equal(match.providerPrediction.status, 'unverified');
  assert.equal(match.providerPrediction.prediction, null);
  assert.ok(!JSON.stringify(report).includes('do-not-copy-private-upstream-error'));
});

test('Statarea uses bound fixture identity, verified 1X2 and six-hour timestamps, and never fills goals evidence', () => {
  for (const changes of [
    { sourceId: 'unverified-source' }, { market: 'goals-over-under' }, { selection: 'over' }, { probability: 1.1 },
    { probability: NaN }, { verificationMethod: 'unverified' }, { observedAt: at(1) },
    { observedAt: at(-21_600_001) }, { validUntil: NOW },
  ]) {
    const value = input(); independent(value, changes);
    assert.equal(first(value).independentForecast.signals.length, 0);
  }
  for (const fixtureChanges of [{ kickoff: at(2 * DAY) }, { away: 'Wrong opponent' }, { source: 'other-provider' }]) {
    const value = input(); independent(value, {}, fixtureChanges);
    assert.equal(first(value).independentForecast.signals.length, 0);
  }
  for (const verificationMethod of ['automatic', 'owner-verified']) {
    const value = input(); independent(value, { verificationMethod, observedAt: at(-21_600_000) });
    const match = first(value);
    assert.equal(match.independentForecast.signals.length, 1);
    assert.equal(match.independentForecast.comparison, 'same_direction');
    assert.ok(!match.actions.matchWinner.reasons.includes('INDEPENDENT_FORECAST_NOT_IN_SNAPSHOT'));
    assert.ok(!match.actions.matchWinner.reasons.includes('INDEPENDENT_FORECAST_MISSING'));
    assert.ok(match.actions.goalsOverUnder25.reasons.includes('INDEPENDENT_FORECAST_NOT_IN_SNAPSHOT'));
    assert.equal(match.actions.matchWinner.action, '不下注');
  }
  const conflict = input(); independent(conflict, { selection: 'away' });
  assert.equal(first(conflict).independentForecast.comparison, 'conflict');
  assert.ok(first(conflict).actions.matchWinner.reasons.includes('INDEPENDENT_FORECAST_CONFLICT'));
});

test('analysis cutoff includes later supplied valid history; explicit replay excludes evidence fetched afterward', () => {
  const value = input(), raw = rawTarget(value), later = at(3_600_000);
  value.priorHistory.push(request('history', historyFor(raw, 0), { fetchedAt: later }));
  const current = buildFullAnalysis(value);
  assert.equal(current.analyzedAt, later);
  assert.equal(current.matches[0].history.home.last5.sampleCount, 5);
  const replay = buildFullAnalysis({ ...value, nowISO: NOW });
  assert.equal(replay.analyzedAt, NOW);
  assert.equal(replay.matches[0].history.home.last5.sampleCount, 0);
});

test('source metadata preserves actual safe response fields and does not fabricate missing HTTP dates', () => {
  const value = input(), row = value.evidence.evidence.find(item => item.kind === 'injuries');
  delete row.httpDate;
  row.url = 'https://v3.football.api-sports.io/injuries?fixture=1000&token=do-not-export-this-query';
  const report = buildFullAnalysis(value);
  assert.ok(Array.isArray(report.sourceMetadata));
  const source = report.sourceMetadata.find(item => item.kind === 'injuries');
  assert.equal(source.fetchedAt, NOW);
  assert.equal(source.httpStatus, 200);
  assert.equal(source.httpDate, null);
  assert.equal(source.sha256, hash);
  assert.equal(source.note, 'HTTP_DATE_NOT_RETAINED');
  assert.ok(!JSON.stringify(report.sourceMetadata).includes('do-not-export-this-query'));
  assert.ok(report.sourceMetadata.some(item => item.httpDate === new Date(NOW).toUTCString()));
});

test('HTML escapes real text fields and remains readable when any fixture time is invalid', () => {
  const value = input(), raw = rawTarget(value), text = '<img src=x onerror="injected()"> & "quoted"';
  value.evidence.fixtures[0].home = text; raw.teams.home.name = text; value.marketSnapshot.fixtures[0].fixture.home = text;
  value.marketSnapshot.fixtures[0].pages[0].data.response[0].bookmakers[0].name = text;
  replaceRequest(value, 'injuries', [injury(raw, { player: { id: 77, name: text, type: text, reason: text } })]);
  replaceRequest(value, 'predictions', [{ league: { id: 39 }, teams: raw.teams, predictions: { percent: { home: text } } }]);
  const html = renderFullAnalysisHtml(buildFullAnalysis(value));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img src=x onerror=&quot;injected\(\)&quot;&gt; &amp; &quot;quoted&quot;/);
  assert.match(html, /<title>1场逐项分析/);
  const invalid = input(2);
  invalid.evidence.fixtures[0].kickoff = 'invalid';
  invalid.marketSnapshot.fixtures[0].fixture.kickoff = 'invalid';
  fixtureRequest(invalid).data.response = fixtureRequest(invalid).data.response.slice(1);
  fixtureRequest(invalid).data.results = 1;
  const report = buildFullAnalysis(invalid);
  assert.equal(report.matches[0].scheduleChanged, false);
  assert.doesNotThrow(() => renderFullAnalysisHtml(report));
  assert.match(renderFullAnalysisHtml(report), /未知/);
  assert.equal(report.summary.processedAllDimensions, 2);
});

test('offline CLI writes complete JSON and HTML using only synthetic evidence files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dimension-full-report-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = input(2, { includeHistory: true });
  const evidencePath = join(root, 'evidence.json'), marketPath = join(root, 'markets.json'), out = join(root, 'out');
  await writeFile(evidencePath, JSON.stringify(value.evidence));
  await writeFile(marketPath, JSON.stringify(value.marketSnapshot));
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../analyze.mjs', import.meta.url)),
    '--evidence', evidencePath, '--markets', marketPath, '--out', out], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(JSON.parse(output).summary.processedAllDimensions, 2);
  const report = JSON.parse(await readFile(join(out, '逐场深度分析.json'), 'utf8'));
  assert.equal(report.matches.length, 2);
  assert.equal(report.summary.withRecentFiveBothTeams, 2);
  assert.match(await readFile(join(out, '逐场深度分析.html'), 'utf8'), /<title>2场逐项分析/);
});
