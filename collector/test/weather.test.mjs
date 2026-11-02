import test from 'node:test';
import assert from 'node:assert/strict';
import { kickoffHourUTC, pickKickoffHour, weatherForMatch, attachWeather, weatherSummary } from '../sources/weather.mjs';
import { venueFor, venueCount } from '../sources/venue-coordinates.mjs';
import { renderDailyResearchMarkdown } from '../research-daily-report.mjs';

const HOUR = 3_600_000;
const payload = (times) => ({ model: 'best_match', hourly: {
  time: times,
  temperature_2m: times.map(() => 11.5),
  precipitation: times.map(() => 0.4),
  precipitation_probability: times.map(() => 35),
  wind_speed_10m: times.map(() => 12),
  weather_code: times.map(() => 3),
} });

test('kickoff rounds to the exact UTC hour and never to a neighbour', () => {
  assert.equal(kickoffHourUTC('2026-11-03T09:59:00Z'), '2026-11-03T09:00');
  assert.equal(kickoffHourUTC('2026-11-03T09:00:00Z'), '2026-11-03T09:00');
  assert.equal(kickoffHourUTC('not-a-time'), null);
});

test('pickKickoffHour matches only the identical hour, no interpolation', () => {
  const series = payload(['2026-11-03T08:00', '2026-11-03T09:00']);
  const hit = pickKickoffHour(series, '2026-11-03T09:00');
  assert.equal(hit.status, 'ok');
  assert.equal(hit.hourUTC, '2026-11-03T09:00');
  assert.equal(hit.temperatureC, 11.5);
  assert.equal(pickKickoffHour(series, '2026-11-03T09:30'), null);
  assert.equal(pickKickoffHour({ hourly: { time: [] } }, '2026-11-03T09:00'), null);
  assert.equal(pickKickoffHour({ hourly: { time: ['2026-11-03T09:00'], temperature_2m: [null] } },
    '2026-11-03T09:00'), null);
});

test('missing venue, missing kickoff and out-of-range hour all degrade without throwing', () => {
  assert.deepEqual(weatherForMatch(null, '2026-11-03T09:00:00Z', payload([])),
    { status: 'unavailable', reason: 'no-venue' });
  assert.deepEqual(weatherForMatch({ lat: 1, lon: 2 }, 'bad', payload([])),
    { status: 'unavailable', reason: 'no-kickoff' });
  assert.equal(weatherForMatch({ lat: 1, lon: 2 }, '2026-11-03T09:00:00Z', payload([])).reason, 'hour-out-of-range');
  assert.equal(weatherForMatch({ lat: 1, lon: 2 }, '2026-11-03T09:00:00Z', { error: 'timeout' }).reason, 'timeout');
  assert.equal(weatherForMatch({ lat: 1, lon: 2 }, '2026-11-03T09:00:00Z', { error: 'weird' }).reason,
    'invalid-response');
});

test('same city on the same day is fetched once, and a transport failure never escapes', async () => {
  const calls = [];
  const kickoff = new Date(Date.now() + 20 * HOUR).toISOString();
  const hour = kickoffHourUTC(kickoff);
  const fetchImpl = async (url) => { calls.push(url);
    return { ok: true, json: async () => payload([hour]) }; };
  const venues = { A: { lat: 51.5, lon: -0.12 }, B: { lat: 51.5, lon: -0.12 } };
  const result = await attachWeather([{ key: 'a', home: 'A', kickoff }, { key: 'b', home: 'B', kickoff }],
    { venueByKey: (home) => venues[home], fetchImpl });
  assert.equal(result.requests, 1);
  assert.equal(calls.length, 1);
  assert.equal(result.weather.a.status, 'ok');
  assert.equal(result.weather.b.status, 'ok');
  const broken = await attachWeather([{ key: 'a', home: 'A', kickoff }],
    { venueByKey: () => ({ lat: 1, lon: 2 }), fetchImpl: async () => { throw new Error('boom'); } });
  assert.equal(broken.weather.a.status, 'unavailable');
});

test('request budget is enforced instead of unbounded fan-out', async () => {
  const kickoff = new Date(Date.now() + 20 * HOUR).toISOString();
  const hour = kickoffHourUTC(kickoff);
  const matches = Array.from({ length: 4 }, (_, i) => ({ key: 'k' + i, home: 'H' + i, kickoff }));
  const result = await attachWeather(matches, { venueByKey: (home) => ({ lat: Number(home.slice(1)), lon: 0 }),
    maxRequests: 2, fetchImpl: async () => ({ ok: true, json: async () => payload([hour]) }) });
  assert.equal(result.requests, 2);
  assert.equal(result.weather.k2.reason, 'budget-exhausted');
});

test('venue lookup resolves aliases and refuses unknown clubs instead of guessing', () => {
  assert.ok(venueCount() >= 100);
  assert.equal(venueFor('Arsenal FC').city, 'London');
  assert.equal(venueFor('Bayern Munich').city, 'Munich');
  assert.equal(venueFor('No Such Club FC'), null);
  assert.equal(venueFor(''), null);
  assert.equal(venueFor(null), null);
});

test('weather summary never fabricates numbers for an unavailable row', () => {
  assert.deepEqual(weatherSummary({ status: 'unavailable', reason: 'no-venue' }), { cn: '—', available: false });
  assert.equal(weatherSummary(null).cn, '—');
  const row = { status: 'ok', temperatureC: 9.6, windKmh: 14.4, precipitationProbabilityPct: 0,
    precipitationMm: 0 };
  assert.equal(weatherSummary(row).cn, '10°C 风14km/h 雨0%');
});

test('rendered research markdown carries the weather column and the non-influence notice', () => {
  const report = { beijingDay: '2026-11-03', codeSha: 'a'.repeat(40), reportId: 'b'.repeat(64),
    state: 'frozen-research-forecasts', forecasts: { total: 1, candidates: [{
      home: 'Arsenal FC', away: 'Chelsea FC', kickoff: '2026-11-03T09:00:00Z',
      probabilities: { home: 0.5, draw: 0.3, away: 0.2 }, selection: 'home', expectedGoals: null,
      topScores: [], weather: { status: 'ok', temperatureC: 9.6, windKmh: 14.4,
        precipitationProbabilityPct: 0, precipitationMm: 0 } }] },
    prospective: { oneDay: { days: 1, eligibleFrozen: 0, scored: 0, pending: 0, voided: 0, hitRate: null,
      brier: null, logLoss: null }, sevenDays: { days: 7, eligibleFrozen: 0, scored: 0, pending: 0,
      voided: 0, hitRate: null, brier: null, logLoss: null }, thirtyDays: { days: 30, eligibleFrozen: 0,
      scored: 0, pending: 0, voided: 0, hitRate: null, brier: null, logLoss: null } } };
  const text = renderDailyResearchMarkdown(report);
  assert.match(text, /\| 天气\(开球时段\) \|/);
  assert.ok(text.includes('10°C 风14km/h 雨0%'));
  assert.ok(text.includes('不参与概率、预期进球、大小球或比分计算'));
  assert.ok(text.includes('研究参考，非投注建议'));
});