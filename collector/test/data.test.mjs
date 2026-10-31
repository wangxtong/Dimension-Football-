import test from 'node:test';
import assert from 'node:assert/strict';
import { withEventIdentity, partitionLogicalMatches, logicalMatchKey } from '../data/identity.mjs';

const fixture = () => ({ id: 'fd-1', sourceFixtureId: '1', source: 'football-data.org', league: 'PL', season: '2026',
  homeTeamId: '10', awayTeamId: '20', home: 'Home', away: 'Away', kickoff: '2026-11-01T18:00:00Z', status: 'TIMED' });

test('source identity survives rename and reschedule, while evidence revision changes only with identity', () => {
  const row = withEventIdentity(fixture()), renamed = withEventIdentity({ ...fixture(), home: 'Renamed' });
  const moved = withEventIdentity({ ...fixture(), kickoff: '2026-11-02T18:00:00Z' });
  assert.equal(renamed.canonicalMatchId, row.canonicalMatchId);
  assert.equal(renamed.identityRevision, row.identityRevision);
  assert.notEqual(renamed.recordHash, row.recordHash);
  assert.equal(moved.canonicalMatchId, row.canonicalMatchId);
  assert.notEqual(moved.identityRevision, row.identityRevision);
  assert.notEqual(withEventIdentity({ ...fixture(), source: 'other' }).canonicalMatchId, row.canonicalMatchId);
  assert.notEqual(withEventIdentity({ ...fixture(), homeTeamId: '20', awayTeamId: '10' }).identityRevision, row.identityRevision);
  assert.equal(withEventIdentity({ ...fixture(), kickoff: '2026-11-02T02:00:00+08:00' }).identityRevision, row.identityRevision);
});

test('logical aliases are quarantined without combining unrelated venues, legs or providers', () => {
  const row = fixture(), duplicate = structuredClone(row);
  const alias = { ...row, id: 'fd-2', sourceFixtureId: '2' };
  assert.equal(partitionLogicalMatches([row, duplicate]).duplicates, 1);
  const conflict = partitionLogicalMatches([row, alias]);
  assert.equal(conflict.records.length, 0);
  assert.equal(conflict.conflicts[0].code, 'logical_fixture_conflict');
  assert.equal(partitionLogicalMatches([row, { ...alias, kickoff: '2026-11-08T18:00:00Z' }]).records.length, 2);
  assert.equal(partitionLogicalMatches([row, { ...alias, source: 'other' }]).records.length, 2);
  assert.equal(partitionLogicalMatches([row, { ...alias, homeTeamId: '20', awayTeamId: '10' }]).records.length, 2);
  assert.equal(logicalMatchKey({ ...row, homeTeamId: undefined }), null);
  assert.equal(partitionLogicalMatches([{ ...row, homeTeamId: undefined }]).records.length, 0);
  assert.throws(() => withEventIdentity({ ...row, kickoff: '2026-02-30T18:00:00Z' }), /INVALID_EVENT_IDENTITY/);
});
