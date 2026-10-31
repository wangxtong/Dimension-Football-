// A7 standalone gate for source admission; A1/A2 must integrate at collector boundary.
// This module NEVER authorizes a forecast release, deployment, or API usage rights.
const iso = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const nonempty = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 256;
export function quoteAdmission(quote, nowISO, { maxAgeMs = 300000, maxFutureSkewMs = 5000 } = {}) {
  if (!iso(nowISO) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || !Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0) throw new TypeError('INVALID_ADMISSION_POLICY');
  if (!quote || typeof quote !== 'object' || !nonempty(quote.fixtureId) || !nonempty(quote.sourceId) ||
    !nonempty(quote.independenceGroup) || !nonempty(quote.bookmaker) || !nonempty(quote.selection) ||
    !['1x2','ou','ah'].includes(quote.market) || !Number.isFinite(quote.decimalOdds) || quote.decimalOdds <= 1 ||
    (quote.market !== '1x2' && (!Number.isFinite(quote.handicap) || Math.abs(quote.handicap) > 30))) return 'INVALID_MARKET';
  if (quote.commercialRightsVerified !== true) return 'RIGHTS_UNVERIFIED';
  if (quote.bookmakerVerified !== true) return 'BOOKMAKER_UNVERIFIED';
  if (quote.inPlay !== false || quote.closed !== false) return 'NOT_OPEN_PREMATCH';
  if (!iso(quote.observedAt) || !iso(quote.sourceUpdatedAt)) return 'UPSTREAM_TIME_UNKNOWN';
  const now = Date.parse(nowISO), observed = Date.parse(quote.observedAt), updated = Date.parse(quote.sourceUpdatedAt);
  if (observed > now + maxFutureSkewMs || updated > observed + maxFutureSkewMs) return 'FUTURE_TIMESTAMP';
  if (now - observed > maxAgeMs || now - updated > maxAgeMs) return 'STALE_QUOTE';
  return 'ELIGIBLE';
}
const keyFor = q => JSON.stringify([q.fixtureId,q.market,q.selection,q.market === '1x2' ? null : q.handicap]);
/** Match one selection+handicap across at least two independent upstream groups.
 * Contradictory prices are diagnostic, never automatically considered consensus.
 */
export function crossCheckQuotes(quotes, nowISO, options = {}) {
  if (!Array.isArray(quotes) || quotes.length > 10000) throw new TypeError('INVALID_QUOTES');
  const eligible = [], rejected = {};
  for (const quote of quotes) {
    const status = quoteAdmission(quote,nowISO,options);
    if (status === 'ELIGIBLE') eligible.push(quote);
    else rejected[status] = (rejected[status] || 0) + 1;
  }
  const groups = new Map();
  for (const q of eligible) {
    const key = keyFor(q);
    if (!groups.has(key)) groups.set(key,new Set());
    groups.get(key).add(q.independenceGroup);
  }
  return { eligibleCount:eligible.length, rejected, matchingSelections:[...groups.entries()].filter(([,g])=>g.size>=2).map(([key,g])=>({key,independentGroups:g.size})),
    // Two sources are necessary, not sufficient for prediction release authorization.
    dualSourceEvidencePresent:[...groups.values()].some(g=>g.size>=2) };
}
