import { digest, fixtureKey, validQuote, hasPair, safeQuote, validOpening, safeOpening, basicScreen, SOURCES, DEFAULT_POLICY } from './policy.mjs';

const keyOf = q => digest([q.sourceId, q.bookmaker, q.selection]);
const identity = o => digest([o.sourceId, o.bookmaker, o.selection, o.fixtureId, o.handicap, o.decimalOdds, o.observedAt]);

// Persist provider-declared openings separately from our first observation.
// History cannot supply a current quote or invent a second independent feed.
export function reconcileMarketEvidence(fixture, quotes, previous = [], nowISO, policy = DEFAULT_POLICY) {
  const records = new Map(), conflicts = new Set();
  for (const r of previous.slice(-200)) {
    if (r?.fixtureKey !== fixtureKey(fixture) || !r.opening) continue;
    const probe = { ...r.opening, opening: r.opening, observedAt: nowISO, sourceUpdatedAt: nowISO };
    if (validOpening(probe, fixture, nowISO)) {
      const opening = safeOpening(r.opening);
      records.set(keyOf(probe), { fixtureKey: fixtureKey(fixture), opening, hash: digest(opening),
        firstRecordedAt: Number.isFinite(Date.parse(r.firstRecordedAt)) ? r.firstRecordedAt : opening.recordedAt, conflict: r.conflict === true });
    }
  }
  const result = quotes.map(quote => {
    if (!validQuote(quote, fixture, Date.parse(nowISO), policy)) return quote;
    const key = keyOf(quote), old = records.get(key);
    if (validOpening(quote, fixture, nowISO)) {
      const opening = safeOpening(quote.opening);
      if (old && (old.conflict || identity(old.opening) !== identity(opening))) {
        records.set(key, { ...old, conflict: true }); conflicts.add(key);
      } else records.set(key, old || { fixtureKey: fixtureKey(fixture), opening, hash: digest(opening), firstRecordedAt: nowISO, conflict: false });
    }
    if (records.get(key)?.conflict) return { ...quote, opening: undefined };
    // Never replace an explicitly supplied but invalid opening with an archived one.
    if (!quote.opening && old && validOpening({ ...quote, opening: old.opening }, fixture, nowISO)) return { ...quote, opening: old.opening };
    return quote;
  });
  // An inconsistency invalidates every quote of that key in this batch.
  return { quotes: result.map(q => conflicts.has(keyOf(q)) ? { ...q, opening: undefined } : q), records: [...records.values()].slice(-200) };
}

export function marketReadiness(fixture, quotes, nowISO, policy = DEFAULT_POLICY) {
  const screened = basicScreen(fixture, nowISO, policy);
  const valid = screened ? [] : quotes.filter(q => validQuote(q, fixture, Date.parse(nowISO), policy));
  const paired = valid.filter(q => hasPair(q, valid));
  const groups = [...new Set(paired.map(q => SOURCES[q.sourceId].group))];
  const openings = paired.filter(q => validOpening(q, fixture, nowISO));
  const blockers = [...(screened?.reasons || [])];
  if (!paired.length) blockers.push('NO_FRESH_COMPLETE_ASIAN_MARKET');
  if (groups.length < policy.minimumQuoteGroups) blockers.push('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING');
  if (!openings.length) blockers.push('TRUE_OPENING_RECORD_MISSING');
  return { checkedAt: nowISO, quoteGroups: groups, requiredQuoteGroups: policy.minimumQuoteGroups,
    pairedQuoteCount: paired.length, verifiedOpeningCount: openings.length, blockers,
    quotes: paired.map(q => ({ ...safeQuote(q), ...(validOpening(q, fixture, nowISO) ? { opening: safeOpening(q.opening) } : {}) })) };
}
