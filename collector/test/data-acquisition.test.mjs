import test from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisitionSnapshot, verifyAcquisitionSnapshot } from '../data/acquisition-snapshot.mjs';
import { DEFAULT_POLICY } from '../policy.mjs';

// Deliberately synthetic, offline evidence; no real supplier times or matches.
const NOW = '2026-10-31T10:00:00.000Z';
const BEFORE = '2026-10-31T09:59:59.000Z';
const AFTER = '2026-10-31T10:00:01.000Z';

const fixture = () => ({
  id: 'oldb-7', sourceFixtureId: '7', source: 'openligadb', league: 'BL1',
  season: '2026', home: 'Home', away: 'Away', homeTeamId: '1', awayTeamId: '2',
  kickoff: '2026-11-01T14:30:00.000Z', status: 'SCHEDULED',
  updatedAt: NOW, fetchedAt: NOW, observedAt: NOW, sourceUpdatedAt: null,
});
const result = () => ({
  id: 'oldb-8', sourceFixtureId: '8', source: 'openligadb', league: 'BL1',
  season: '2026', home: 'Past Home', away: 'Past Away', homeTeamId: '3', awayTeamId: '4',
  kickoff: '2026-10-01T14:30:00.000Z', status: 'FINISHED', period: 'full-time',
  homeGoals: 2, awayGoals: 1,
  fetchedAt: NOW, observedAt: BEFORE, resultObservedAt: BEFORE, sourceUpdatedAt: BEFORE,
});
function snapshot(row = fixture(), history = []) {
  return createAcquisitionSnapshot({ fixtures: [row], history, checkedAt: NOW,
    poolComplete: true, policy: DEFAULT_POLICY });
}
const verify = input => verifyAcquisitionSnapshot(input, { nowISO: NOW, policy: DEFAULT_POLICY });

test('a fresh legitimate acquisition and earlier observed history remain verifiable', () => {
  const clean = verify(snapshot(fixture(), [result()]));
  assert.equal(clean.fixtures.length, 1);
  assert.equal(clean.history.length, 1);
  assert.equal(clean.fixtures[0].observedAt, NOW);
  // Missing historical capture clocks remain legacy/unknown, not fabricated.
  const legacy = result();
  for (const key of ['fetchedAt', 'observedAt', 'resultObservedAt', 'sourceUpdatedAt']) delete legacy[key];
  assert.equal(verify(snapshot(fixture(), [legacy])).history.length, 1);
});

test('a valid digest cannot make future fixture observation/provider/update clocks current', async t => {
  for (const key of ['updatedAt', 'observedAt', 'sourceUpdatedAt', 'fetchedAt']) {
    await t.test(key, () => {
      const archived = snapshot({ ...fixture(), [key]: AFTER });
      assert.throws(() => verify(archived), /FIXTURE_CACHE_EXPIRED/);
    });
  }
  assert.throws(() => verify(snapshot({ ...fixture(), fetchedAt: BEFORE, observedAt: NOW })),
    /FIXTURE_CACHE_EXPIRED/, 'observation after retrieval is causally impossible');
});

test('history versions fetched or revised after read cutoff cannot travel backward through a hashed snapshot', async t => {
  for (const key of ['observedAt', 'resultObservedAt', 'sourceUpdatedAt', 'fetchedAt']) {
    await t.test(key, () => {
      const later = { ...result(), fetchedAt: key === 'sourceUpdatedAt' ? NOW : AFTER };
      if (key === 'observedAt' || key === 'resultObservedAt') later[key] = AFTER;
      if (key === 'sourceUpdatedAt') later.sourceUpdatedAt = AFTER;
      const archived = snapshot(fixture(), [later]);
      assert.equal(archived.history.length, 1);
      assert.throws(() => verify(archived), /INVALID_ACQUISITION_SNAPSHOT/);
    });
  }
  assert.throws(() => verify(snapshot(fixture(), [{ ...result(), fetchedAt: BEFORE, sourceUpdatedAt: NOW }])),
    /INVALID_ACQUISITION_SNAPSHOT/, 'provider revision after its recorded retrieval cannot be known');
  assert.equal(verify(snapshot(fixture(), [{ ...result(), sourceUpdatedAt: NOW }])).history.length, 1);
});
