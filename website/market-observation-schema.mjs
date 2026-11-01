import { validDate, MAX_REPORT_FIXTURES } from './report-schema.mjs';

const origins = Object.freeze({ hkjc: ['hkjc-first-party', 1], macauslot: ['macauslot-official', 1], titan007: ['titan007', 3] });
const rootKeys = ['version', 'checkedAt', 'expiresAt', 'fixtureCount', 'sources', 'dualSourceFixtureCount', 'alignedEligibleFixtureCount', 'trueOpeningFixtureCount', 'releaseGate'];
const sourceKeys = ['id', 'group', 'status', 'quoteCount', 'pairedFixtureCount', 'latestSourceUpdatedAt', 'openingCount'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function invalid(code = 'MARKET_OBSERVATION_SCHEMA_INVALID', status = 400) { throw Object.assign(Error(code), { code, status }); }

export function validateObservationAcquisition(value) {
  if (!exact(value, ['snapshotHash', 'checkedAt', 'commit']) || !/^[a-f0-9]{64}$/.test(value.snapshotHash || '')
    || !/^[a-f0-9]{40}$/.test(value.commit || '') || !validDate(value.checkedAt)) invalid();
  return { snapshotHash: value.snapshotHash, checkedAt: value.checkedAt, commit: value.commit };
}

// This validates a bounded public aggregate, never the truth of raw market evidence
// or model-release eligibility. Older reports without this extension stay valid.
export function validateMarketObservation(value, { fixtureCount, generatedAt, acquisition } = {}) {
  if (!exact(value, rootKeys) || value.version !== 1 || value.releaseGate !== 'BLOCKED'
    || !count(fixtureCount, MAX_REPORT_FIXTURES) || !count(value.fixtureCount, fixtureCount)
    || !validDate(value.checkedAt) || !validDate(value.expiresAt) || value.checkedAt !== generatedAt) invalid();
  const acquired = validateObservationAcquisition(acquisition), checked = Date.parse(value.checkedAt), expires = Date.parse(value.expiresAt);
  if (Date.parse(acquired.checkedAt) > checked || expires < checked || expires > checked + 300000
    || !Array.isArray(value.sources) || value.sources.length !== 3) invalid();
  const seen = new Set(), n = value.fixtureCount, sources = [];
  for (const row of value.sources) {
    if (!exact(row, sourceKeys) || !Object.hasOwn(origins, row.id) || seen.has(row.id)) invalid();
    seen.add(row.id);
    const [group, books] = origins[row.id];
    if (row.group !== group || !count(row.quoteCount, 2 * books * n)
      || !count(row.pairedFixtureCount, Math.min(n, Math.floor(row.quoteCount / 2)))
      || !count(row.openingCount, Math.min(row.quoteCount, 2 * books * row.pairedFixtureCount))
      || !(row.latestSourceUpdatedAt === null || validDate(row.latestSourceUpdatedAt)
        && Date.parse(row.latestSourceUpdatedAt) <= checked)) invalid();
    if (row.pairedFixtureCount > 0 ? row.status !== 'available' : row.quoteCount > 0 ? row.status !== 'partial'
      : !['stale', 'unavailable', 'missing'].includes(row.status)) invalid();
    if (row.quoteCount > 0 && (!validDate(row.latestSourceUpdatedAt)
      || row.id !== 'hkjc' && (checked - Date.parse(row.latestSourceUpdatedAt) > 300000
        || expires > Date.parse(row.latestSourceUpdatedAt) + 300000))) invalid();
    sources.push({ id: row.id, group: row.group, status: row.status, quoteCount: row.quoteCount,
      pairedFixtureCount: row.pairedFixtureCount, latestSourceUpdatedAt: row.latestSourceUpdatedAt, openingCount: row.openingCount });
  }
  const paired = sources.map(row => row.pairedFixtureCount), sum = paired.reduce((a, b) => a + b, 0);
  if (!count(value.dualSourceFixtureCount, Math.min(n, Math.floor(sum / 2), sum - Math.max(...paired)))
    || !count(value.alignedEligibleFixtureCount, value.dualSourceFixtureCount)
    || !count(value.trueOpeningFixtureCount, Math.min(value.alignedEligibleFixtureCount,
      sources.reduce((total, row) => total + row.openingCount, 0)))) invalid();
  return { version: 1, checkedAt: value.checkedAt, expiresAt: value.expiresAt, fixtureCount: n, sources,
    dualSourceFixtureCount: value.dualSourceFixtureCount, alignedEligibleFixtureCount: value.alignedEligibleFixtureCount,
    trueOpeningFixtureCount: value.trueOpeningFixtureCount, releaseGate: 'BLOCKED' };
}

// Apply wall-clock freshness only on new publication. Historical reads keep the
// original source times so the UI can display an expired observation honestly.
export function assertMarketObservationFreshness(report, now) {
  if (report.marketObservation == null) return;
  const summary = validateMarketObservation(report.marketObservation,
    { fixtureCount: report.fixtures.length, generatedAt: report.generatedAt, acquisition: report.acquisition });
  const age = now - Date.parse(report.acquisition.checkedAt), marketAge = now - Date.parse(summary.checkedAt);
  if (!Number.isFinite(now) || age < 0 || age > 1200000 || marketAge < 0 || marketAge > 300000) invalid('MARKET_OBSERVATION_STALE', 409);
  for (const { fixture } of report.fixtures) {
    const stamp = fixture.fetchedAt || fixture.updatedAt;
    if (!validDate(stamp) || Date.parse(stamp) > Date.parse(summary.checkedAt)
      || now - Date.parse(stamp) < 0 || now - Date.parse(stamp) > 1200000) invalid('MARKET_FIXTURE_STALE', 409);
  }
  if (summary.sources.some(row => row.quoteCount > 0) && now > Date.parse(summary.expiresAt)) invalid('MARKET_OBSERVATION_EXPIRED', 409);
}
