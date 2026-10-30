import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFixtureHistory } from '../team-analysis.mjs';

const fixture = { id: 'af-999', home: 'Home FC', away: 'Away FC', kickoff: '2026-11-10T12:00:00.000Z', leagueId: 39 };
const teamIds = { home: 10, away: 20 };
const nowISO = '2026-11-09T12:00:00.000Z';
function match(id, date, homeId, awayId, homeGoals, awayGoals, overrides = {}) {
  return { fixture: { id, date, timestamp: Date.parse(date) / 1000, status: { short: 'FT' } },
    league: { id: 39 }, teams: { home: { id: homeId, name: `Team ${homeId}` }, away: { id: awayId, name: `Team ${awayId}` } },
    goals: { home: homeGoals, away: awayGoals }, ...overrides };
}
const at = day => `2026-11-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const analyze = (history, options = {}) => analyzeFixtureHistory({ fixture, history, teamIds, nowISO, ...options });

test('summarizes five newest team results, separate venue form and kickoff rest intervals without mutating inputs', () => {
  const history = [
    match(1, at(8), 10, 30, 2, 1), match(2, at(7), 31, 10, 0, 0),
    match(3, at(6), 10, 32, 1, 3), match(4, at(5), 33, 10, 2, 4),
    match(5, at(4), 10, 34, 0, 1), match(6, at(3), 35, 10, 1, 2),
    match(7, at(2), 10, 36, 3, 0), match(8, at(1), 10, 37, 1, 1),
    match(9, '2026-10-31T12:00:00Z', 10, 38, 2, 0),
    match(20, '2026-11-08T18:00:00Z', 40, 20, 1, 2), match(21, at(7), 20, 41, 0, 2),
    match(22, at(6), 42, 20, 1, 1), match(23, at(5), 20, 43, 2, 0),
    match(24, at(4), 44, 20, 3, 1), match(25, at(3), 45, 20, 0, 1), match(26, at(2), 46, 20, 2, 2),
  ].reverse();
  const before = JSON.stringify(history), result = analyze(history);
  assert.equal(JSON.stringify(history), before);
  assert.deepEqual(result.home.last5.form, ['W', 'D', 'L', 'W', 'L']);
  assert.deepEqual([result.home.last5.wins, result.home.last5.draws, result.home.last5.losses], [2, 1, 2]);
  assert.deepEqual([result.home.last5.goalsFor, result.home.last5.goalsAgainst], [7, 7]);
  assert.deepEqual(result.home.venueLast5.matches.map(row => row.fixtureId), [1, 3, 5, 7, 8]);
  assert.deepEqual([result.home.venueLast5.goalsFor, result.home.venueLast5.goalsAgainst], [7, 6]);
  assert.deepEqual(result.away.last5.form, ['W', 'L', 'D', 'W', 'L']);
  assert.deepEqual([result.away.last5.goalsFor, result.away.last5.goalsAgainst], [6, 7]);
  assert.deepEqual(result.away.venueLast5.matches.map(row => row.fixtureId), [20, 22, 24, 25, 26]);
  assert.equal(result.home.last5.limited, false);
  assert.equal(result.home.venueLast5.limited, false);
  assert.equal(result.away.venueLast5.limited, false);
  assert.equal(result.home.restDays, 2);
  assert.equal(result.away.restDays, 1.75);
  assert.equal(result.home.restBasis, 'kickoff-to-kickoff');
});

test('excludes unfinished, future, same-cutoff and target fixtures', () => {
  const unfinished = match(2, at(7), 10, 30, 2, 0);
  unfinished.fixture.status.short = 'NS';
  const result = analyze([
    match(1, at(8), 10, 30, 1, 0), unfinished,
    match(3, at(9), 10, 31, 9, 0), match(4, '2026-11-09T13:00:00Z', 32, 10, 0, 9),
    match(999, at(1), 10, 20, 9, 9),
  ]);
  assert.equal(result.home.last5.sampleCount, 1);
  assert.equal(result.home.last5.goalsFor, 1);
  assert.equal(result.dataQuality.excluded.notFinished, 1);
  assert.equal(result.dataQuality.excluded.atOrAfterCutoff, 2);
  assert.equal(result.dataQuality.excluded.targetFixture, 1);
  const retrospective = analyze([match(5, at(11), 10, 31, 9, 0), match(6, at(9), 10, 32, 2, 0)], { nowISO: at(20) });
  assert.equal(retrospective.cutoff, fixture.kickoff);
  assert.deepEqual(retrospective.home.last5.matches.map(row => row.fixtureId), [6]);
});

test('same-league head to head is capped at five and follows the target home team perspective', () => {
  const history = Array.from({ length: 6 }, (_, i) => match(i + 1, at(8 - i), i % 2 ? 20 : 10, i % 2 ? 10 : 20, 2, 0));
  history.push(match(50, '2026-11-08T18:00:00Z', 10, 20, 8, 0, { league: { id: 140 } }));
  const result = analyze(history);
  assert.equal(result.headToHead.sampleCount, 5);
  assert.equal(result.headToHead.limited, false);
  assert.deepEqual(result.headToHead.matches.map(row => row.fixtureId), [1, 2, 3, 4, 5]);
  assert.deepEqual(result.headToHead.form, ['W', 'L', 'W', 'L', 'W']);
  assert.deepEqual([result.headToHead.wins, result.headToHead.draws, result.headToHead.losses], [3, 0, 2]);
  assert.equal(result.home.last5.matches[0].fixtureId, 50); // Overall form includes supplied competitions.
});

test('deduplicates overlapping responses and excludes conflicting versions rather than picking one', () => {
  const first = match(1, at(8), 10, 30, 2, 0), conflict = match(2, at(7), 10, 31, 1, 0);
  const result = analyze([first, structuredClone(first), conflict, { ...conflict, goals: { home: 9, away: 0 } }]);
  assert.equal(result.home.last5.sampleCount, 1);
  assert.equal(result.home.last5.goalsFor, 2);
  assert.equal(result.dataQuality.excluded.duplicate, 2);
  assert.equal(result.dataQuality.excluded.conflictingIds, 1);
  assert.ok(result.missing.includes('HISTORY_CONFLICTING_FIXTURES_EXCLUDED'));
});

test('validates history time, identity and integer final scores', () => {
  const badTime = match(2, at(7), 10, 31, 1, 0); badTime.fixture.timestamp++;
  const invalidDate = match(3, '2026-02-30T12:00:00Z', 10, 31, 1, 0);
  const result = analyze([
    match(1, at(8), 10, 30, 0, 0), badTime, invalidDate,
    match(4, at(7), 10, 10, 1, 0), match(5, at(7), 10, 31, null, 0), match(6, at(7), 10, 31, -1, 0),
  ]);
  assert.equal(result.home.last5.sampleCount, 1);
  assert.deepEqual(result.home.last5.form, ['D']);
  assert.equal(result.dataQuality.excluded.invalidTime, 2);
  assert.equal(result.dataQuality.excluded.invalidIdentity, 1);
  assert.equal(result.dataQuality.excluded.invalidScore, 2);
  assert.ok(result.missing.includes('HISTORY_INVALID_ROWS_REJECTED'));
});

test('limited samples and absent data remain explicit, with no fabricated zero-goal history', () => {
  const result = analyze([match(1, at(8), 10, 30, 1, 0)]);
  assert.equal(result.status, 'limited');
  assert.equal(result.home.last5.sampleCount, 1);
  assert.equal(result.home.last5.limited, true);
  assert.ok(result.home.missing.includes('HOME_FINISHED_MATCHES_LT_5'));
  assert.equal(result.away.last5.goalsFor, null);
  assert.equal(result.away.restDays, null);
  assert.ok(result.missing.includes('AWAY_HISTORY_UNAVAILABLE'));
  assert.ok(result.headToHead.missing.includes('SAME_LEAGUE_HEAD_TO_HEAD_LT_5'));
  const empty = analyze([]);
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.home.last5.wins, null);
  assert.equal(empty.home.last5.goalsAgainst, null);
});

test('joins only numeric team IDs and can derive target IDs from a raw API fixture', () => {
  const target = match(999, fixture.kickoff, 10, 20, null, null);
  const history = [match(1, at(8), 10, 30, 2, 0)];
  history[0].teams.home.name = 'Different provider spelling';
  const result = analyzeFixtureHistory({ fixture: target, history, nowISO });
  assert.equal(result.home.teamId, 10);
  assert.equal(result.home.last5.sampleCount, 1);
  assert.equal(result.fixtureId, 999);
  const mismatch = analyzeFixtureHistory({ fixture: target, history, teamIds: { home: 11, away: 20 }, nowISO });
  assert.equal(mismatch.status, 'unavailable');
  assert.ok(mismatch.missing.includes('TARGET_TEAM_IDS_MISMATCH'));
  assert.equal(mismatch.home.last5.sampleCount, 0);
});

test('missing IDs, league, reference time and API source failures have explicit diagnostics', () => {
  const history = [match(1, at(8), 10, 30, 2, 0)];
  const missingIds = analyze(history, { teamIds: undefined });
  assert.ok(missingIds.missing.includes('TARGET_TEAM_IDS_UNAVAILABLE'));
  const noLeague = analyze(history, { fixture: { ...fixture, leagueId: undefined } });
  assert.equal(noLeague.home.last5.sampleCount, 1);
  assert.ok(noLeague.headToHead.missing.includes('TARGET_LEAGUE_ID_UNAVAILABLE'));
  const noTime = analyze(history, { nowISO: 'invalid' });
  assert.equal(noTime.status, 'unavailable');
  assert.ok(noTime.missing.includes('REFERENCE_TIME_UNAVAILABLE'));
  const sourceError = analyze({ get: 'fixtures', errors: { token: 'do not expose this upstream text' }, response: history });
  assert.equal(sourceError.status, 'unavailable');
  assert.ok(sourceError.missing.includes('HISTORY_SOURCE_ERROR'));
  assert.ok(!JSON.stringify(sourceError).includes('do not expose'));
});

test('supports fixture envelopes and marks incomplete pagination without treating it as a complete history', () => {
  const response = [match(1, at(8), 10, 30, 2, 0)];
  const result = analyze({ get: 'fixtures', errors: [], results: 1, paging: { total: 2 }, response });
  assert.equal(result.home.last5.sampleCount, 1);
  assert.equal(result.status, 'limited');
  assert.ok(result.missing.includes('HISTORY_PAGINATION_INCOMPLETE'));
  const invalid = analyze({ get: 'fixtures', errors: [], results: 2, response });
  assert.equal(invalid.status, 'unavailable');
  assert.ok(invalid.missing.includes('HISTORY_RESPONSE_COUNT_MISMATCH'));
});

test('a full set of five-match samples is available and AET/PEN records are outside FT coverage', () => {
  const latest = Date.parse(at(8));
  const history = Array.from({ length: 10 }, (_, i) => match(i + 1,
    new Date(latest - i * 3 * 86_400_000).toISOString(), i % 2 ? 20 : 10, i % 2 ? 10 : 20, 1, 0));
  for (const [i, status] of ['AET', 'PEN'].entries()) {
    const extra = match(100 + i, at(8), 10, 20, 9, 0);
    extra.fixture.status.short = status;
    history.push(extra);
  }
  const result = analyze(history);
  assert.equal(result.status, 'available');
  assert.deepEqual(result.missing, []);
  for (const sample of [result.home.last5, result.away.last5, result.home.venueLast5, result.away.venueLast5, result.headToHead]) {
    assert.equal(sample.sampleCount, 5);
    assert.equal(sample.limited, false);
  }
  assert.equal(result.dataQuality.excluded.notFinished, 2);
  assert.ok(result.notes.includes('ONLY_FT_MATCHES_AET_PEN_EXCLUDED'));
});
