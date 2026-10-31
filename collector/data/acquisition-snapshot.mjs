import { preparePool } from '../policy.mjs';
import { prepareForecastHistory } from '../forecast.mjs';
import { dataHash, canonicalTimestamp, partitionLogicalMatches, withEventIdentity, normalizeSeason } from './identity.mjs';

export function prepareAcquiredPool(fixtures, policy) {
  const prepared = preparePool(fixtures, policy), verified = [], legacy = [], original = new Map(fixtures.map(row => [row.id, row]));
  for (const fixture of prepared.fixtures) {
    if (!fixture.homeTeamId || !fixture.awayTeamId) legacy.push(fixture);
    else {
      const raw = original.get(fixture.id), season = normalizeSeason(raw.season);
      verified.push(withEventIdentity({ ...fixture, sourceFixtureId: String(raw.sourceFixtureId ?? raw.providerMatchId ?? raw.id),
        ...(season === null ? {} : { season }), ...(canonicalTimestamp(raw.observedAt) ? { observedAt: canonicalTimestamp(raw.observedAt) } : {}) }));
    }
  }
  const partition = partitionLogicalMatches(verified);
  const conflicts = partition.conflicts;
  return { fixtures: [...legacy, ...partition.records].sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.id.localeCompare(b.id)),
    duplicates: prepared.duplicates + partition.duplicates, conflicts,
    rejected: conflicts.reduce((sum, row) => sum + row.ids.length, 0) };
}

export function createAcquisitionSnapshot({ fixtures, history, checkedAt, diagnostics = [], coverage = [], poolComplete = false, reportId = null, policy }) {
  if (!canonicalTimestamp(checkedAt)) throw new Error('INVALID_ACQUISITION_SNAPSHOT');
  const pool = prepareAcquiredPool(fixtures, policy), clean = prepareForecastHistory(history);
  const body = { version: 1, kind: 'collection-fixture-snapshot', checkedAt: canonicalTimestamp(checkedAt), reportId,
    simulated: false, poolComplete: poolComplete === true && !pool.conflicts.length,
    fixtures: pool.fixtures, history: clean.matches, diagnostics, coverage,
    inputQuality: { fixtureConflicts: pool.rejected, historyRejected: clean.rejected, historyDuplicates: clean.duplicates, historyConflicts: clean.logicalConflicts } };
  return { ...body, snapshotHash: dataHash(body) };
}

export function verifyAcquisitionSnapshot(input, { nowISO, maxAgeMs = 1200000, policy } = {}) {
  if (input?.version !== 1 || input.kind !== 'collection-fixture-snapshot' || input.simulated !== false
    || !canonicalTimestamp(input.checkedAt) || !canonicalTimestamp(nowISO) || !Array.isArray(input.diagnostics)
    || !Array.isArray(input.coverage) || typeof input.poolComplete !== 'boolean') throw new Error('INVALID_ACQUISITION_SNAPSHOT');
  const { snapshotHash, ...body } = input;
  if (!/^[a-f0-9]{64}$/.test(snapshotHash || '') || dataHash(body) !== snapshotHash) throw new Error('ACQUISITION_SNAPSHOT_CHANGED');
  const age = Date.parse(nowISO) - Date.parse(input.checkedAt);
  if (age < 0 || !Number.isSafeInteger(maxAgeMs) || age > maxAgeMs) throw new Error('FIXTURE_CACHE_EXPIRED');
  if (input.fixtures.some(row => !canonicalTimestamp(row.fetchedAt || row.updatedAt)
    || Date.parse(row.fetchedAt || row.updatedAt) > Date.parse(nowISO)
    || Date.parse(nowISO) - Date.parse(row.fetchedAt || row.updatedAt) > maxAgeMs)) throw new Error('FIXTURE_CACHE_EXPIRED');
  const pool = prepareAcquiredPool(input.fixtures, policy), history = prepareForecastHistory(input.history);
  if (pool.conflicts.length || history.rejected || history.logicalConflicts) throw new Error('INVALID_ACQUISITION_SNAPSHOT');
  return { ...input, fixtures: pool.fixtures, history: history.matches };
}
