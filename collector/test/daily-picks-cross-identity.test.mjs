import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyPicks, settleDailyPicks } from '../daily-picks.mjs';

// Regression for PR #91: a forecast carrying contradictory matchId and
// fixtureKey must never be attributed to either match, or counted as a win.
const nowISO = '2026-11-03T08:00:00.000Z';
const match = id => ({
  matchId: id, league: 'PL', home: 'Home ' + id, away: 'Away ' + id,
  kickoff: '2026-11-03T16:00:00.000Z',
  handicap: { pool: 'hhad', source: 'sporttery-jc', goalLine: -1,
    home: 2.07, draw: 3.4, away: 2.76, updatedAt: '2026-11-03T07:30:00.000Z' },
});
const model = (matchId, extra = {}) => ({
  matchId, generatedAt: '2026-11-03T07:50:00.000Z',
  probabilities: { home: .65, draw: .2, away: .15 }, ...extra,
});

test('contradictory matchId 222 / fixtureKey jc-111 quarantines BOTH and retains rejected denominator', () => {
  const x = buildDailyPicks({
    matches: [match(111), match(222), match(333)],
    forecasts: [model(222, { fixtureKey: 'jc-111',
      probabilities: { home: .95, draw: .02, away: .03 } }), model(333)],
    nowISO,
  });
  assert.equal(x.inputTotal, 3);
  assert.equal(x.forecastInputTotal, 2);
  assert.equal(x.total, 1);
  assert.equal(x.selectedAll, 1);
  assert.equal(x.allPicks[0].matchId, 333);
  assert.deepEqual(x.excludedCandidates.map(row => [row.matchId, row.reason]), [
    [111, 'FORECAST_IDENTITY_MISMATCH'], [222, 'FORECAST_IDENTITY_MISMATCH'],
  ]);
  assert.equal(x.excludedForecasts.length, 1);
  assert.equal(x.excludedForecasts[0].reason, 'FORECAST_IDENTITY_MISMATCH');
  assert.equal(x.excludedForecasts[0].probabilities.home, .95);
});

test('an otherwise valid forecast cannot override the quarantine of an ambiguous identity', () => {
  const x = buildDailyPicks({
    matches: [match(111), match(222)],
    forecasts: [model(111), model(222), model(222, { fixtureKey: 'jc-111' })],
    nowISO,
  });
  assert.equal(x.inputTotal, 2);
  assert.equal(x.selectedAll, 0);
  assert.equal(x.total, 0);
  assert.deepEqual(x.excludedCandidates.map(row => row.reason),
    ['FORECAST_IDENTITY_MISMATCH', 'FORECAST_IDENTITY_MISMATCH']);
});

test('consistent jc aliases do not accidentally block legitimate forecasts', () => {
  const x = buildDailyPicks({
    matches: [match(111)],
    forecasts: [model(111, { fixtureKey: 'jc-111' })], nowISO,
  });
  assert.equal(x.selectedAll, 1);
  assert.equal(x.allPicks[0].matchId, 111);
  assert.equal(x.excludedForecasts.length, 0);
});

const frozenHhadPick = () => ({
  ...match(111),
  modelGeneratedAt: '2026-11-03T07:50:00.000Z',
  quoteObservedAt: nowISO,
  predictionFrozenAt: nowISO,
  pick: { market: 'hhad', side: 'home', decimalOdds: 2.07 },
});
const validFt = () => ({
  matchId: 111, fixtureKey: 'jc-111',
  home: 'Home 111', away: 'Away 111',
  kickoff: '2026-11-03T16:00:00.000Z',
  status: 'FT', resultObservedAt: '2026-11-03T18:00:00.000Z',
  homeGoals: 2, awayGoals: 0,
});

test('contradictory FT matchId 111 / fixtureKey jc-222 is quarantined before scoring', () => {
  const x = settleDailyPicks({
    picks: [frozenHhadPick()],
    results: [{ ...validFt(), fixtureKey: 'jc-222' }],
  });
  assert.equal(x.total, 0);
  assert.equal(x.wins, 0);
  assert.equal(x.coverage.inputPicks, 1);
  assert.equal(x.coverage.selected, 1);
  assert.equal(x.coverage.invalid, 1);
  assert.equal(x.coverage.pending, 0);
});

test('a valid FT does not override a contradictory FT for the same identity', () => {
  const x = settleDailyPicks({
    picks: [frozenHhadPick()],
    results: [validFt(), { ...validFt(), fixtureKey: 'jc-222' }],
  });
  assert.equal(x.total, 0);
  assert.equal(x.coverage.invalid, 1);
});

test('legitimate FT jc-111 alias still settles in the hhad three-way pool', () => {
  const x = settleDailyPicks({ picks: [frozenHhadPick()], results: [validFt()] });
  assert.equal(x.total, 1);
  assert.equal(x.wins, 1);
  assert.equal(x.coverage.invalid, 0);
  assert.equal(x.market, 'hhad-three-way');
});
