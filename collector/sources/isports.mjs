import { ProviderError } from './provider-http.mjs';
import { safeId, safeName, number, quarter, timestamp, matchFixture, baseObservation, currentTime, diagnostic } from './provider-utils.mjs';

// Main odds: https://www.isportsapi.com/docs.html?id=24
// Only companies with a documented close flag. Crown is deliberately excluded.
const COMPANIES = Object.freeze({ 8: 'Bet365', 17: 'M88', 24: '12Bet', 31: 'SBOBET' });
const LEAGUE_CODES = Object.freeze({ 'ENG PR': 'PL', 'SPA D1': 'PD', 'ITA D1': 'SA', 'GER D1': 'BL1', 'FRA D1': 'FL1' });
const hk = value => { const n = number(value); return Number.isFinite(n) && n > 0 && n <= 20 ? Number((n + 1).toFixed(5)) : null; };
const falseFlag = value => value === 'false' || value === '0';

function unwrap(payload) {
  if (payload?.code !== 0 || payload.data === undefined) throw new ProviderError('api_error');
  return payload.data;
}

export async function fetchIsportsEvidence({ fixtures, nowISO, client }) {
  // The authenticated livescores endpoint covers the UTC day, not seven days.
  const target = fixtures.filter(f => f.kickoff.slice(0, 10) === nowISO.slice(0, 10));
  if (!target.length) return { observations: [], signals: [], diagnostics: [diagnostic('isports', nowISO,
    { status: 'pending', code: 'outside_today_coverage' })] };
  const scheduleResult = await client.get('/sport/football/livescores');
  const schedule = unwrap(scheduleResult.data);
  if (!Array.isArray(schedule) || schedule.length > 10000) throw new ProviderError('invalid_response');
  const matched = new Map(), ids = new Set();
  for (const event of schedule) {
    const league = LEAGUE_CODES[event?.leagueShortName];
    if (!league || event.status !== 0) continue;
    if (!safeId(event.matchId) || !safeId(event.leagueId) || !safeName(event.homeName) || !safeName(event.awayName)
      || !timestamp(event.matchTime)) throw new ProviderError('invalid_records');
    if (ids.has(String(event.matchId))) throw new ProviderError('duplicate_fixture_id'); ids.add(String(event.matchId));
    const kickoff = timestamp(event.matchTime);
    if (Date.parse(kickoff) <= Date.parse(nowISO)) continue;
    const fixture = matchFixture({ league, home: event.homeName, away: event.awayName, kickoff }, target);
    if (fixture) matched.set(String(event.matchId), fixture);
  }
  const fixtureIds = [...matched.values()].map(f => f.id);
  for (const [id, fixture] of matched) if (fixtureIds.filter(value => value === fixture.id).length !== 1) matched.delete(id);
  if (!matched.size) return { observations: [], signals: [], diagnostics: [diagnostic('isports', nowISO,
    { status: 'pending', code: 'no_matching_fixtures', httpStatus: 200 })] };
  // One full snapshot avoids violating the main endpoint's 10-second call limit.
  const result = await client.get('/sport/football/odds/main', { companyId: Object.keys(COMPANIES).join(',') });
  const odds = unwrap(result.data);
  if (!Array.isArray(odds?.handicap) || odds.handicap.length > 30000) throw new ProviderError('invalid_response');
  const observations = [], duplicateCounts = new Map(); let rejectedCount = 0;
  for (const entry of odds.handicap) {
    if (typeof entry !== 'string' || entry.length > 1000) throw new ProviderError('invalid_records');
    const fields = entry.split(',');
    const key = `${fields[0]}:${fields[1]}`;
    duplicateCounts.set(key, (duplicateCounts.get(key) || 0) + 1);
  }
  for (const entry of odds.handicap) {
    const row = entry.split(','), fixture = matched.get(row[0]), company = Object.hasOwn(COMPANIES, row[1]) ? COMPANIES[row[1]] : null;
    if (!fixture || !company) continue;
    const line = quarter(row[5]), home = hk(row[6]), away = hk(row[7]);
    const updated = timestamp(number(row[10]));
    if (row.length !== 13 || duplicateCounts.get(`${row[0]}:${row[1]}`) !== 1
      || line === null || home === null || away === null || !falseFlag(row[8]) || !falseFlag(row[9])
      || !falseFlag(row[11]) || !['1', '2'].includes(row[12]) || !updated || !currentTime(updated, result.fetchedAt)) { rejectedCount++; continue; }
    const initialLine = quarter(row[2]), initialHome = hk(row[3]), initialAway = hk(row[4]);
    const initial = initialLine !== null && initialHome !== null && initialAway !== null
      ? { homeHandicap: -initialLine || 0, awayHandicap: initialLine || 0,
        homeDecimalOdds: initialHome, awayDecimalOdds: initialAway, observedAt: null, basis: 'provider-initial-fields-time-unknown' } : null;
    observations.push({ ...baseObservation(fixture, 'isports', row[0], result.fetchedAt, 'https://www.isportsapi.com/docs.html?id=24'),
      bookmaker: company, bookmakerId: row[1], market: 'asian-handicap', kind: 'market-price', sourceUpdatedAt: updated,
      outcomes: [{ selection: 'home', line: -line || 0, decimalOdds: home }, { selection: 'away', line: line || 0, decimalOdds: away }],
      openingReference: initial, closed: false, independenceGroup: 'unverified-commercial-odds',
      validUntil: new Date(Math.min(Date.parse(updated) + 300000, Date.parse(fixture.kickoff))).toISOString(),
      blockers: ['UPSTREAM_INDEPENDENCE_UNVERIFIED', 'OPENING_TIMESTAMP_MISSING'] });
  }
  return { observations, signals: [], diagnostics: [diagnostic('isports', nowISO, { httpStatus: 200,
    status: rejectedCount ? 'partial' : observations.length ? 'available' : 'pending',
    code: rejectedCount ? 'invalid_or_stale_markets' : observations.length ? 'ok' : 'no_matching_markets',
    matchedCount: new Set(observations.map(row => row.fixtureId)).size })] };
}
