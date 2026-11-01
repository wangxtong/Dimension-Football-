import { DEFAULT_POLICY, inspectMarket, isoMillis, preparePool, quoteSourceGroup, sameFixture, validOpeningTrajectory } from './policy.mjs';
import { QUOTE_ORIGINS } from './sources/independence-registry.mjs';
import { collectIntegratedEvidence } from './sources/index.mjs';

// This observation contract deliberately covers the three implemented market
// channels. Reference-provider observations and model signals remain private.
const IDS = Object.freeze(['hkjc', 'macauslot', 'titan007']);
const FAILED = new Set(['failed', 'unavailable', 'cooldown', 'cancelled', 'budget_exhausted', 'blocked']);
const arrays = ['quotes', 'marketStates', 'signals', 'diagnostics', 'fixtureDiagnostics'];

function checkedTime(value) {
  const time = isoMillis(value);
  if (!Number.isFinite(time)) throw new Error('MARKET_OBSERVATION_TIME_INVALID');
  return time;
}

function privateProjection(evidence = {}) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('MARKET_EVIDENCE_INVALID');
  const result = {};
  for (const key of arrays) {
    if (evidence[key] !== undefined && !Array.isArray(evidence[key])) throw new Error('MARKET_EVIDENCE_INVALID');
    result[key] = evidence[key] || [];
  }
  result.crawler = evidence.crawler || null;
  result.providers = evidence.providers || null;
  return result;
}

function diagnosticsFor(evidence, id) {
  return evidence.diagnostics.filter(row => row && (row.sourceId === id || row.id === id
    || (['macauslot', 'titan007'].includes(id) && row.id === 'public-crawler')));
}

function freshnessTime(row) {
  return isoMillis(row.sourceId === 'hkjc' ? row.sourceAsOf : row.sourceUpdatedAt);
}

/** A fixed, public-safe aggregate. Never return a quote, selection, odds,
 * probability, raw diagnostic or provider-supplied independence count here.
 * Counts are observation readiness, not prediction/release authorization.
 */
export function summarizeMarketObservation({ fixtures = [], evidence = {}, checkedAt } = {}) {
  const now = checkedTime(checkedAt), pool = preparePool(fixtures).fixtures;
  const data = privateProjection(evidence), byFixture = new Map(pool.map(fixture => [fixture.id, []]));
  for (const row of [...data.quotes, ...data.marketStates]) {
    if (row && IDS.includes(row.sourceId) && byFixture.has(row.fixtureId)) byFixture.get(row.fixtureId).push(row);
  }
  const counts = new Map(IDS.map(id => [id, { valid: [], raw: [], pairedFixtures: new Set(), openingCount: 0 }]));
  let dualSourceFixtureCount = 0, alignedEligibleFixtureCount = 0, trueOpeningFixtureCount = 0;
  let expires = now + DEFAULT_POLICY.maxQuoteAgeMs;
  for (const fixture of pool) {
    const rows = byFixture.get(fixture.id);
    for (const row of rows) {
      if (quoteSourceGroup(row) === QUOTE_ORIGINS[row.sourceId].group && sameFixture(row.fixtureSnapshot, fixture)
        && row.verified === true && ['automatic', 'owner-verified'].includes(row.verificationMethod)) counts.get(row.sourceId).raw.push(row);
    }
    // inspectMarket invokes latestMarketQuotes, validQuote, hasPair and the
    // same price/line/opening policy as formal evaluation. Negative snapshots
    // must participate before eligibility so old valid prices never revive.
    const market = inspectMarket(fixture, rows, checkedAt);
    for (const row of market.valid) {
      const count = counts.get(row.sourceId);
      count.valid.push(row);
      expires = Math.min(expires, isoMillis(row.observedAt) + DEFAULT_POLICY.maxQuoteAgeMs,
        freshnessTime(row) + DEFAULT_POLICY.maxQuoteAgeMs, isoMillis(row.validUntil),
        isoMillis(fixture.kickoff), isoMillis(fixture.updatedAt) + DEFAULT_POLICY.maxFixtureAgeMs);
    }
    for (const row of market.paired) {
      const count = counts.get(row.sourceId);
      count.pairedFixtures.add(fixture.id);
      // An opening cannot make an incomplete current market ready. Keep the
      // source count on the same paired evidence used by formal eligibility.
      if (validOpeningTrajectory(row, fixture, checkedAt)) count.openingCount++;
    }
    if (new Set(market.paired.map(quoteSourceGroup)).size >= DEFAULT_POLICY.minimumQuoteGroups) dualSourceFixtureCount++;
    const aligned = market.markets.filter(item => new Set(item.quotes.map(quoteSourceGroup)).size >= DEFAULT_POLICY.minimumQuoteGroups);
    if (aligned.length) alignedEligibleFixtureCount++;
    if (aligned.some(item => item.openingQuotes.length > 0)) trueOpeningFixtureCount++;
  }
  const sources = IDS.map(id => {
    const count = counts.get(id), diagnostics = diagnosticsFor(data, id);
    const dated = count.raw.filter(row => Number.isFinite(isoMillis(row.sourceUpdatedAt))
      && isoMillis(row.sourceUpdatedAt) <= isoMillis(row.observedAt) && isoMillis(row.observedAt) <= now);
    const latest = dated.reduce((best, row) => !best || isoMillis(row.sourceUpdatedAt) > isoMillis(best) ? row.sourceUpdatedAt : best, null);
    const stale = dated.some(row => (Number.isFinite(freshnessTime(row)) && now - freshnessTime(row) > DEFAULT_POLICY.maxQuoteAgeMs)
      || now - isoMillis(row.observedAt) > DEFAULT_POLICY.maxQuoteAgeMs || isoMillis(row.validUntil) <= now)
      || diagnostics.some(row => typeof row.code === 'string' && /(?:^|_)stale(?:_|$)/.test(row.code));
    const status = count.pairedFixtures.size ? 'available' : count.valid.length ? 'partial'
      : stale ? 'stale' : count.raw.length || diagnostics.some(row => FAILED.has(row.status)) ? 'unavailable' : 'missing';
    return { id, group: QUOTE_ORIGINS[id].group, status, quoteCount: count.valid.length,
      pairedFixtureCount: count.pairedFixtures.size, latestSourceUpdatedAt: latest, openingCount: count.openingCount };
  });
  return { version: 1, checkedAt, expiresAt: new Date(expires).toISOString(), fixtureCount: pool.length, sources,
    dualSourceFixtureCount, alignedEligibleFixtureCount, trueOpeningFixtureCount, releaseGate: 'BLOCKED' };
}

/** Uses the existing integrated crawler/provider policies. The caller owns the
 * observation checkpoint/cadence; state paths here persist crawler/cooldowns.
 * Injecting collectEvidence permits deterministic tests without live requests.
 */
export async function collectMarketObservation({ fixtures = [], statePath, crawlerStatePath = statePath,
  providerStatePath = crawlerStatePath ? `${crawlerStatePath}.providers.json` : undefined,
  providerPolicy, clock = () => new Date().toISOString(), remaining = () => Infinity,
  signal, fetchImpl = fetch, env = {} } = {}, { collectEvidence = collectIntegratedEvidence } = {}) {
  const pool = preparePool(fixtures).fixtures, startedAt = clock();
  checkedTime(startedAt);
  let collected;
  try {
    collected = pool.length ? await collectEvidence({ fixtures: pool, nowISO: startedAt, statePath: crawlerStatePath,
      providerStatePath, providerPolicy, clock, remaining, signal, fetchImpl, env }) : {};
  } catch {
    // Arbitrary errors may contain credentials/URLs. Do not persist their text.
    collected = { diagnostics: IDS.map(id => ({ id, status: 'unavailable', code: 'COLLECTION_FAILED', checkedAt: startedAt })) };
  }
  const checkedAt = clock();
  if (checkedTime(checkedAt) < checkedTime(startedAt)) throw new Error('MARKET_OBSERVATION_CLOCK_REGRESSED');
  const privateEvidence = privateProjection(collected);
  return { privateEvidence, summary: summarizeMarketObservation({ fixtures: pool, evidence: privateEvidence, checkedAt }) };
}
