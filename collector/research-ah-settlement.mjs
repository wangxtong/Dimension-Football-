/**
 * Research-only two-way Asian handicap (AH) settlement.
 * homeHandicap ALWAYS applies to the home team; the away selection takes its opposite.
 * No sports-lottery hhad / 1X2 three-way markets may call this module.
 * Does not certify the origin, timing, entitlement, or authenticity of input evidence.
 */
const MAX_ABS_HANDICAP = 8;
// Conservative research-only ceiling: stale quote snapshots must not inflate scored returns.
const MAX_QUOTE_AGE_MS = 60 * 60 * 1000;
const six = n => Math.round((n + Number.EPSILON) * 1e6) / 1e6;
const isGoals = n => Number.isSafeInteger(n) && n >= 0 && n <= 30;
const isOdds = n => typeof n === 'number' && Number.isFinite(n) && n > 1 && n <= 100;
const isQuarterLine = n => typeof n === 'number' && Number.isFinite(n)
  && Math.abs(n) <= MAX_ABS_HANDICAP && Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const asUtc = x => typeof x === 'string' && ISO_UTC.test(x) ? Date.parse(x) : NaN;
const isId = x => typeof x === 'string' && /^[\w.:-]{1,160}$/.test(x);
const isHash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);

export function settleAsianHandicap({ homeGoals, awayGoals, homeHandicap, selection, decimalOdds } = {}) {
  if (!isGoals(homeGoals) || !isGoals(awayGoals) || !isQuarterLine(homeHandicap)
      || !['home', 'away'].includes(selection) || !isOdds(decimalOdds)) return null;
  const pickedMargin = selection === 'home' ? homeGoals - awayGoals : awayGoals - homeGoals;
  const pickedLine = selection === 'home' ? homeHandicap : -homeHandicap;
  // A quarter-ball line splits equally between the adjacent half-ball lines.
  const lo = Math.floor(pickedLine * 2) / 2;
  const hi = Math.ceil(pickedLine * 2) / 2;
  const lines = (lo === hi ? [lo, lo] : [lo, hi]).map(n => Object.is(n, -0) ? 0 : n);
  const legs = lines.map(line => {
    const adjusted = pickedMargin + line;
    const result = adjusted > 0 ? 'WIN' : adjusted < 0 ? 'LOSS' : 'PUSH';
    const profitUnits = result === 'WIN' ? (decimalOdds - 1) / 2 : result === 'LOSS' ? -0.5 : 0;
    return { line, result, profitUnits: six(profitUnits) };
  });
  const wins = legs.filter(x => x.result === 'WIN').length;
  const losses = legs.filter(x => x.result === 'LOSS').length;
  const outcome = wins === 2 ? 'FULL_WIN' : losses === 2 ? 'FULL_LOSS'
    : wins === 1 && losses === 0 ? 'HALF_WIN'
    : losses === 1 && wins === 0 ? 'HALF_LOSS'
    : wins === 0 && losses === 0 ? 'PUSH' : null;
  if (!outcome) return null;
  return { market: 'AH_TWO_WAY', selection, homeHandicap, pickedLine, decimalOdds,
    outcome, profitUnits: six(legs.reduce((sum, x) => sum + x.profitUnits, 0)), legs };
}

/**
 * Protect a frozen AH research ledger from future/contradictory observations.
 * fixture, quote, forecast and result are immutable archival inputs.
 * Hex digests are required for traceability, but are NOT provenance verification.
 */
export function settleFrozenAhResearch({ fixture, quote, forecast, result } = {}) {
  const blocked = reason => ({ status: 'BLOCKED', reason, researchOnly: true, commercialReleaseGate: 'BLOCKED' });
  if (!fixture || !quote || !forecast || !result) return blocked('MISSING_EVIDENCE');
  if (!isId(fixture.matchId) || !isId(fixture.source) || !isId(quote.source)
      || !isId(quote.marketId) || !isId(forecast.modelVersion)
      || typeof fixture.home !== 'string' || !fixture.home.trim()
      || typeof fixture.away !== 'string' || !fixture.away.trim()
      || fixture.home === fixture.away) return blocked('INVALID_IDENTITY');
  if (quote.pool !== 'ah' || !isQuarterLine(quote.homeHandicap)
      || !isOdds(quote.homeOdds) || !isOdds(quote.awayOdds)) return blocked('MARKET_NOT_AH');
  if (forecast.matchId !== fixture.matchId || quote.matchId !== fixture.matchId
      || result.matchId !== fixture.matchId || result.home !== fixture.home
      || result.away !== fixture.away || result.kickoff !== fixture.kickoff)
    return blocked('FIXTURE_MISMATCH');
  if (!['home', 'away'].includes(forecast.selection) || forecast.pool !== 'ah'
      || forecast.marketId !== quote.marketId || forecast.homeHandicap !== quote.homeHandicap)
    return blocked('SELECTION_MISMATCH');
  if (![quote.rawSha256, forecast.rawSha256, result.rawSha256].every(isHash))
    return blocked('RAW_HASH_REQUIRED');
  // A frozen selection must bind the exact quoted side, price, and quote digest.
  // Digest format alone does not prove upstream provenance or source entitlement.
  const selectedOdds = forecast.selection === 'home' ? quote.homeOdds : quote.awayOdds;
  if (!isHash(forecast.quoteRawSha256) || forecast.quoteRawSha256 !== quote.rawSha256
      || !isOdds(forecast.decimalOdds) || forecast.decimalOdds !== selectedOdds)
    return blocked('FROZEN_QUOTE_MISMATCH');
  const start = asUtc(fixture.kickoff), observed = asUtc(quote.observedAt);
  const created = asUtc(forecast.generatedAt), frozen = asUtc(forecast.frozenAt);
  const finalized = asUtc(result.observedAt);
  if (![start, observed, created, frozen, finalized].every(Number.isFinite)
      || observed > frozen || created > frozen || frozen >= start
      || finalized < start + 90 * 60 * 1000)
    return blocked('TIME_CAUSALITY_INVALID');
  // A later official result cannot rehabilitate a market quote that was stale at freeze.
  if (frozen - observed > MAX_QUOTE_AGE_MS) return blocked('QUOTE_STALE_AT_FREEZE');
  if (result.status !== 'FT') return blocked('RESULT_NOT_FT');
  const decimalOdds = selectedOdds;
  const settled = settleAsianHandicap({ homeGoals: result.homeGoals,
    awayGoals: result.awayGoals, homeHandicap: quote.homeHandicap,
    selection: forecast.selection, decimalOdds });
  if (!settled) return blocked('SCORE_INVALID');
  return { status: 'SCORED', researchOnly: true, commercialReleaseGate: 'BLOCKED',
    fixture: { matchId: fixture.matchId, source: fixture.source, kickoff: fixture.kickoff },
    evidence: { quoteSource: quote.source, marketId: quote.marketId,
      quoteRawSha256: quote.rawSha256, forecastRawSha256: forecast.rawSha256,
      resultRawSha256: result.rawSha256, observedAt: quote.observedAt,
      frozenAt: forecast.frozenAt, resultObservedAt: result.observedAt,
      provenance: 'RAW_HASH_FORMAT_ONLY_NOT_EXTERNALLY_VERIFIED' },
    modelVersion: forecast.modelVersion, ...settled };
}
