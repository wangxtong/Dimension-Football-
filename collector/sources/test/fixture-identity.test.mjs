import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSportmonksFixtures, sportmonksLeagues } from '../sportmonks.mjs';
import { fetchFootballFixtures } from '../fixtures.mjs';

const NOW = '2026-10-31T10:00:00.000Z', KICKOFF = '2026-11-01T18:00:00Z';
const json = data => new Response(JSON.stringify(data), { headers: { Date: new Date(NOW).toUTCString() } });
test('Sportmonks preserves participant IDs and rejects missing, repeated and reversed location identities', async () => {
  const participants = [{ id: 10, name: 'Home', meta: { location: 'home' } }, { id: 20, name: 'Away', meta: { location: 'away' } }];
  for (const patch of [null, 'missing', 'same', 'location']) {
    const result = await fetchSportmonksFixtures({ apiKey: 'offline-test', nowISO: NOW, fetchImpl: async url => {
      const league = Number(new URL(url).searchParams.get('filters').split(':')[1]), teams = structuredClone(participants);
      if (patch === 'missing') delete teams[0].id;
      if (patch === 'same') teams[1].id = teams[0].id;
      if (patch === 'location') teams[1].meta.location = 'home';
      return json({ data: [{ id: league, league_id: league, state_id: 1, starting_at_timestamp: Date.parse(KICKOFF) / 1000, participants: teams }],
        pagination: { current_page: 1, has_more: false } });
    } });
    assert.equal(result.fixtures.length, patch ? 0 : Object.keys(sportmonksLeagues).length);
    if (!patch) for (const fixture of result.fixtures) {
      assert.equal(fixture.homeTeamId, '10'); assert.equal(fixture.awayTeamId, '20');
      assert.match(fixture.canonicalMatchId, /^evt_[a-f0-9]{64}$/);
      assert.equal(fixture.sourceFixtureId, String(sportmonksLeagues[fixture.league]));
    }
  }
});

test('football-data rejects missing or equal team IDs instead of publishing unusable identity', async () => {
  for (const away of [{ name: 'Away' }, { id: 10, name: 'Away' }]) {
    const result = await fetchFootballFixtures({ apiKey: 'offline-test', nowISO: NOW, fetchImpl: async url => {
      const league = new URL(url).pathname.split('/')[3];
      return json({ matches: [{ id: 1, competition: { code: league }, homeTeam: { id: 10, name: 'Home' }, awayTeam: away,
        utcDate: KICKOFF, status: 'TIMED' }] });
    } });
    assert.equal(result.fixtures.length, 0);
    assert.ok(result.diagnostics.every(row => row.rejectedCount === 1));
  }
});
