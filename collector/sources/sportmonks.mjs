import { createProviderClient, ProviderError, collectProviderLeagues } from './provider-http.mjs';
import { LEAGUES, safeName, timestamp, matchFixture, baseObservation, diagnostic } from './provider-utils.mjs';
import { withEventIdentity } from '../data/identity.mjs';

export const sportmonksLeagues = Object.freeze({ PL: 8, PD: 564, SA: 384, BL1: 82, FL1: 301 });
const fatal = new Set(['authorization_required', 'subscription_required', 'plan_restricted', 'rate_limited', 'request_limit', 'cancelled', 'budget_exhausted']);

function eventIdentity(row, league) {
  const participants = row?.participants;
  if (!Number.isSafeInteger(row?.id) || row.id <= 0 || row.league_id !== sportmonksLeagues[league]
    || !Array.isArray(participants) || participants.length !== 2 || !Number.isInteger(row.state_id)) throw new ProviderError('invalid_records');
  const home = participants.filter(p => p?.meta?.location === 'home'), away = participants.filter(p => p?.meta?.location === 'away');
  const kickoff = timestamp(row.starting_at_timestamp);
  if (home.length !== 1 || away.length !== 1 || !safeName(home[0].name) || !safeName(away[0].name)
    || !Number.isSafeInteger(home[0].id) || home[0].id <= 0 || !Number.isSafeInteger(away[0].id) || away[0].id <= 0 || home[0].id === away[0].id
    || home[0].name === away[0].name || !kickoff) throw new ProviderError('invalid_records');
  return { id: row.id, league, home: home[0].name.trim(), away: away[0].name.trim(),
    homeTeamId: String(home[0].id), awayTeamId: String(away[0].id), kickoff, state: row.state_id };
}

async function readLeague(client, league, from, to, include, maxPages) {
  const rows = [], seen = new Set(); let fetchedAt, responseAt;
  for (let page = 1; page <= maxPages; page++) {
    const result = await client.get(`/v3/football/fixtures/between/${from}/${to}`, {
      include, filters: `fixtureLeagues:${sportmonksLeagues[league]}`, per_page: 50, page,
    });
    const payload = result.data;
    if (!Array.isArray(payload?.data) || payload.data.length > 50 || payload.pagination?.current_page !== page
      || typeof payload.pagination?.has_more !== 'boolean') throw new ProviderError('incomplete_response');
    for (const row of payload.data) {
      const identity = eventIdentity(row, league);
      if (seen.has(identity.id)) throw new ProviderError('duplicate_fixture_id');
      seen.add(identity.id); rows.push({ row, identity });
    }
    fetchedAt = result.fetchedAt; responseAt = result.responseAt;
    if (!payload.pagination.has_more) return { rows, fetchedAt, responseAt };
    if (!payload.data.length) throw new ProviderError('incomplete_response');
    // Increment our own page number. Never fetch a provider-supplied URL.
  }
  throw new ProviderError('incomplete_response');
}

export async function fetchSportmonksFixtures({ apiKey = '', nowISO = new Date().toISOString(), fetchImpl = fetch,
  days = 7, signal, remaining, clock = () => nowISO, maxRequests = 50, maxPages = 10 } = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now) || !Number.isInteger(days) || days < 1 || days > 14) throw new TypeError('Invalid fixture request');
  const client = createProviderClient({ provider: 'sportmonks', apiKey, nowISO, clock, fetchImpl, signal, remaining, maxRequests });
  const fixtures = [], diagnostics = []; let stopped;
  for (const league of LEAGUES) {
    try {
      if (stopped) throw stopped;
      const result = await readLeague(client, league, nowISO.slice(0, 10), new Date(now + days * 86400000).toISOString().slice(0, 10), 'participants', maxPages);
      const accepted = result.rows.filter(({ identity: e }) => e.state === 1 && Date.parse(e.kickoff) > now && Date.parse(e.kickoff) <= now + days * 86400000);
      for (const { identity: e } of accepted) fixtures.push(withEventIdentity({ id: `sm-${e.id}`, sourceFixtureId: String(e.id), league, home: e.home, away: e.away,
        homeTeamId: e.homeTeamId, awayTeamId: e.awayTeamId,
        kickoff: e.kickoff, status: 'SCHEDULED', source: 'sportmonks', updatedAt: result.fetchedAt,
        fetchedAt: result.fetchedAt, sourceUpdatedAt: null }));
      diagnostics.push(diagnostic('sportmonks', nowISO, { league, status: accepted.length ? 'available' : 'complete',
        httpStatus: 200, responseAt: result.responseAt, matchedCount: accepted.length }));
    } catch (error) {
      if (fatal.has(error.code)) stopped = error;
      diagnostics.push(diagnostic('sportmonks', nowISO, { league, status: 'unavailable', code: error.code || 'network_unavailable',
        note: error.code || 'network_unavailable', httpStatus: error.httpStatus ?? null, retryAfterMs: error.retryAfterMs ?? null }));
    }
  }
  if (new Set(fixtures.map(f => f.id)).size !== fixtures.length) throw new ProviderError('duplicate_fixture_id');
  return { fixtures, diagnostics };
}

export async function fetchSportmonksEvidence({ fixtures, nowISO, client, maxPages = 10, leagueHealth, clock }) {
  return collectProviderLeagues({ provider: 'sportmonks', nowISO, clock, leagueHealth,
    leagues: LEAGUES.filter(code => fixtures.some(f => f.league === code)), collect: async league => {
    const observations = [], signals = [], diagnostics = [];
    const target = fixtures.filter(f => f.league === league), dates = target.map(f => f.kickoff.slice(0, 10)).sort();
    const result = await readLeague(client, league, dates[0], dates.at(-1), 'participants;predictions.type', maxPages);
    const mappings = result.rows.map(({ identity }) => matchFixture(identity, target)?.id);
    let matched = 0;
    for (const { row, identity: event } of result.rows) {
      if (event.state !== 1 || Date.parse(event.kickoff) <= Date.parse(nowISO)) continue;
      const fixture = matchFixture(event, target); if (!fixture) continue;
      if (mappings.filter(id => id === fixture.id).length !== 1) continue;
      const predictions = Array.isArray(row.predictions) ? row.predictions.filter(p => p?.fixture_id === event.id
        && p?.type?.developer_name === 'FULLTIME_RESULT_PROBABILITY' && p.type.model_type === 'prediction') : [];
      if (predictions.length !== 1) continue;
      const values = predictions[0].predictions, selections = ['home', 'draw', 'away'];
      if (!values || selections.some(k => typeof values[k] !== 'number' || !Number.isFinite(values[k]) || values[k] < 0 || values[k] > 100)
        || Math.abs(selections.reduce((sum, k) => sum + values[k], 0) - 100) > .1) continue;
      const probabilities = Object.fromEntries(selections.map(k => [k, values[k] / 100]));
      const leaders = selections.filter(k => values[k] === Math.max(...selections.map(s => values[s])));
      const base = baseObservation(fixture, 'sportmonks', event.id, result.fetchedAt, `https://api.sportmonks.com/v3/football/fixtures/${event.id}`);
      const validUntil = new Date(Math.min(Date.parse(result.fetchedAt) + 6 * 3600000, Date.parse(fixture.kickoff))).toISOString();
      observations.push({ ...base, market: '1x2', kind: 'model-probability', probabilities, sourceUpdatedAt: null,
        freshnessBasis: 'retrieved-current-model', modelCadence: 'daily-prematch', validUntil });
      if (leaders.length === 1) signals.push({ ...base, sourceId: 'sportmonks', independenceGroup: 'sportmonks-model',
        market: '1x2', selection: leaders[0], probability: probabilities[leaders[0]], validUntil,
        verified: true, verificationMethod: 'automatic' });
      matched++;
    }
    diagnostics.push(diagnostic('sportmonks', nowISO, { league, matchedCount: matched, httpStatus: 200,
      status: matched ? 'available' : 'pending', code: matched ? 'ok' : 'no_matching_predictions' }));
    return { observations, signals, diagnostics };
  } });
}
