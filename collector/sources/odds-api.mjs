import { ProviderError, collectProviderLeagues } from './provider-http.mjs';
import { safeId, safeName, decimal, quarter, timestamp, matchFixture, baseObservation, impliedProbabilities, currentTime, diagnostic } from './provider-utils.mjs';

export const oddsApiLeagues = Object.freeze({ PL: 'soccer_epl', PD: 'soccer_spain_la_liga', SA: 'soccer_italy_serie_a', BL1: 'soccer_germany_bundesliga', FL1: 'soccer_france_ligue_one' });

function outcomesFor(market, event) {
  if (!Array.isArray(market.outcomes) || market.outcomes.length !== (market.key === 'h2h' ? 3 : 2)) return null;
  const rows = market.outcomes.map(row => {
    const selection = market.key === 'totals' ? row.name === 'Over' ? 'over' : row.name === 'Under' ? 'under' : null
      : row.name === event.home_team ? 'home' : row.name === event.away_team ? 'away' : row.name === 'Draw' ? 'draw' : null;
    return { selection, decimalOdds: decimal(row.price), ...(market.key === 'h2h' ? {} : { line: quarter(row.point) }) };
  });
  if (rows.some(row => !row.selection || !row.decimalOdds || (market.key !== 'h2h' && row.line === null))
    || new Set(rows.map(row => row.selection)).size !== rows.length) return null;
  if (market.key === 'spreads' && (rows.some(row => !['home', 'away'].includes(row.selection)) || rows[0].line !== -rows[1].line)) return null;
  if (market.key === 'totals' && (rows[0].line !== rows[1].line || rows[0].line < 0)) return null;
  return rows;
}

export async function fetchOddsApiEvidence({ fixtures, nowISO, client, regions = 'eu', leagueHealth, clock }) {
  return collectProviderLeagues({ provider: 'the-odds-api', nowISO, clock, leagueHealth,
    leagues: Object.keys(oddsApiLeagues).filter(league => fixtures.some(f => f.league === league)),
    collect: async league => {
    const observations = [], diagnostics = [], sport = oddsApiLeagues[league];
    const target = fixtures.filter(f => f.league === league);
    const times = target.map(f => Date.parse(f.kickoff));
    const result = await client.get(`/v4/sports/${sport}/odds`, { regions, markets: 'h2h,spreads,totals', oddsFormat: 'decimal', dateFormat: 'iso',
      commenceTimeFrom: new Date(Math.max(Date.parse(nowISO), Math.min(...times) - 300000)).toISOString().replace('.000Z', 'Z'),
      commenceTimeTo: new Date(Math.max(...times) + 300000).toISOString().replace('.000Z', 'Z') });
    if (!Array.isArray(result.data) || result.data.length > 3000) throw new ProviderError('invalid_response');
    const mappings = result.data.map(event => matchFixture({ league, home: event?.home_team, away: event?.away_team, kickoff: event?.commence_time }, target)?.id);
    const ids = new Set(), matched = new Set(); let rejectedCount = 0;
    for (const event of result.data) {
      if (!safeId(event?.id) || event.sport_key !== sport || !safeName(event.home_team) || !safeName(event.away_team)
        || !timestamp(event.commence_time) || !Array.isArray(event.bookmakers) || event.bookmakers.length > 200) throw new ProviderError('invalid_records');
      if (ids.has(event.id)) throw new ProviderError('duplicate_fixture_id'); ids.add(event.id);
      if (Date.parse(event.commence_time) <= Date.parse(nowISO)) continue;
      const fixture = matchFixture({ league, home: event.home_team, away: event.away_team, kickoff: event.commence_time }, target);
      if (!fixture) continue;
      if (mappings.filter(id => id === fixture.id).length !== 1) continue;
      const bookIds = event.bookmakers.map(b => b?.key);
      if (new Set(bookIds).size !== bookIds.length) throw new ProviderError('invalid_records');
      for (const book of event.bookmakers) {
        if (!safeId(book.key) || !safeName(book.title) || /crown|皇冠|crow\*/iu.test(`${book.key} ${book.title}`)) continue;
        if (!Array.isArray(book.markets) || book.markets.length > 20) continue;
        for (const market of book.markets) {
          if (!['h2h', 'spreads', 'totals'].includes(market.key)) continue;
          if (book.markets.filter(m => m.key === market.key).length !== 1) { rejectedCount++; continue; }
          const updated = timestamp(market.last_update ?? book.last_update), outcomes = outcomesFor(market, event);
          if (!updated || !currentTime(updated, result.fetchedAt) || !outcomes) { rejectedCount++; continue; }
          observations.push({ ...baseObservation(fixture, 'the-odds-api', event.id, result.fetchedAt, 'https://the-odds-api.com/liveapi/guides/v4/'),
            bookmaker: book.title, bookmakerId: book.key, market: market.key === 'h2h' ? '1x2' : market.key === 'spreads' ? 'handicap' : 'goals-over-under',
            kind: 'market-price', sourceUpdatedAt: updated, outcomes, probabilities: impliedProbabilities(outcomes),
            probabilityMeaning: 'market-implied-not-model', independenceGroup: 'unverified-commercial-odds',
            validUntil: new Date(Math.min(Date.parse(updated) + 300000, Date.parse(fixture.kickoff))).toISOString(),
            blockers: ['UPSTREAM_INDEPENDENCE_UNVERIFIED', 'OPENING_TRAJECTORY_MISSING', ...(market.key === 'spreads' ? ['HANDICAP_SETTLEMENT_REQUIRES_VERIFICATION'] : [])] });
          matched.add(fixture.id);
        }
      }
    }
    diagnostics.push(diagnostic('the-odds-api', nowISO, { league, httpStatus: 200, matchedCount: matched.size,
      status: rejectedCount ? 'partial' : matched.size ? 'available' : 'pending', code: rejectedCount ? 'invalid_or_stale_markets' : matched.size ? 'ok' : 'no_matching_markets' }));
    return { observations, signals: [], diagnostics };
  } });
}
