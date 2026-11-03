import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyPicks } from '../daily-picks.mjs';

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
