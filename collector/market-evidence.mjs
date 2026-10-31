import { digest, fixtureKey, validQuote, safeQuote, validOpening, safeOpening, openingIdentity, inspectMarket, SOURCES, DEFAULT_POLICY, isoMillis } from './policy.mjs';

const keyOf = q => digest([q.sourceId, q.bookmaker, q.selection]);

// Only verified provider openings can be replayed. Legacy identity is never
// repaired by copying fields from a current quote.
export function reconcileMarketEvidence(fixture, quotes, previous = [], nowISO, policy = DEFAULT_POLICY) {
  const records = new Map(), pending = new Map(), conflicts = new Set(), fixtureIdentity = fixtureKey(fixture);
  let overflow = false;
  for (const r of Array.isArray(previous) ? previous : []) {
    if (r?.fixtureKey !== fixtureIdentity) continue;
    if (r.archiveStatus === 'capacity_exceeded') { overflow = true; continue; }
    if (!r.opening || typeof r.opening !== 'object') continue;
    const opening = safeOpening(r.opening), key = keyOf(opening);
    const hash = typeof r.hash === 'string' && /^[a-f0-9]{64}$/.test(r.hash) ? r.hash : null;
    const integrityFailure = hash !== digest(r.opening) || r.archiveStatus === 'integrity_failure';
    const probe = { ...opening, opening, observedAt: nowISO, sourceUpdatedAt: nowISO };
    const verified = validOpening(probe, fixture, nowISO);
    const record = { version: 2, fixtureKey: fixtureIdentity, opening, hash: integrityFailure ? hash : digest(opening),
      ...(!integrityFailure && hash !== digest(opening) ? { migratedFromHash: hash } : {}),
      firstRecordedAt: Number.isFinite(isoMillis(r.firstRecordedAt)) ? r.firstRecordedAt : opening.recordedAt,
      conflict: r.conflict === true || integrityFailure,
      archiveStatus: integrityFailure ? 'integrity_failure' : r.conflict === true ? 'conflict' : verified ? 'verified' : 'pending_verification' };
    if (!verified && !record.conflict) {
      pending.set(digest([key, openingIdentity(opening)]), record); continue;
    }
    const old = records.get(key);
    if (record.conflict || old?.conflict || old && openingIdentity(old.opening) !== openingIdentity(opening)) {
      conflicts.add(key);
      records.set(key, { ...(old || record), conflict: true,
        archiveStatus: integrityFailure || old?.archiveStatus === 'integrity_failure' ? 'integrity_failure' : 'conflict' });
    } else if (!old) records.set(key, record);
  }
  // Reconcile every declaration before snapshot deduplication, preserving
  // conflicts even when a later quote does not repeat its opening claim.
  for (const quote of quotes) {
    if (!validQuote(quote, fixture, isoMillis(nowISO), policy) || !validOpening(quote, fixture, nowISO)) continue;
    const key = keyOf(quote), old = records.get(key), opening = safeOpening(quote.opening);
    if (old && (old.conflict || openingIdentity(old.opening) !== openingIdentity(opening))) {
      records.set(key, { ...old, conflict: true, archiveStatus: old.archiveStatus === 'integrity_failure' ? 'integrity_failure' : 'conflict' });
      conflicts.add(key);
    } else if (!old) records.set(key, { version: 2, fixtureKey: fixtureIdentity, opening, hash: digest(opening),
      firstRecordedAt: nowISO, conflict: false, archiveStatus: 'verified' });
  }
  const allRecords = [...records.values(), ...pending.values()];
  // A bounded archive must not silently forget discarded conflicts. Overflow
  // remains blocked across runs until an explicit archive review.
  overflow ||= allRecords.length > 200;
  const saved = overflow ? [{ version: 2, fixtureKey: fixtureIdentity, archiveStatus: 'capacity_exceeded', conflict: true },
    ...allRecords.sort((a, b) => Number(b.conflict) - Number(a.conflict)).slice(0, 199)] : allRecords;
  const result = quotes.map(quote => {
    if (!validQuote(quote, fixture, isoMillis(nowISO), policy)) return quote;
    const key = keyOf(quote), old = records.get(key);
    if (overflow || conflicts.has(key) || old?.conflict) return { ...quote, opening: undefined };
    // Never replace an explicitly supplied but invalid opening with an archive.
    if (!quote.opening && old?.archiveStatus === 'verified' && validOpening({ ...quote, opening: old.opening }, fixture, nowISO)) return { ...quote, opening: old.opening };
    return quote;
  });
  return { quotes: result, records: saved };
}

export function marketReadiness(fixture, quotes, nowISO, policy = DEFAULT_POLICY) {
  const inspected = inspectMarket(fixture, quotes, nowISO, policy), { screened, paired, eligible, markets } = inspected;
  const groups = [...new Set(paired.map(q => SOURCES[q.sourceId].group))].sort();
  const openings = paired.filter(q => validOpening(q, fixture, nowISO));
  const crossChecked = markets.filter(market => market.quoteGroups.length >= policy.minimumQuoteGroups);
  const relevant = crossChecked.length ? crossChecked : markets;
  const marketReady = !screened && crossChecked.some(market => market.openingQuotes.length);
  const blockers = [...(screened?.reasons || []), ...(marketReady ? [] : inspected.snapshotBlockers)];
  if (!paired.length) blockers.push('NO_FRESH_COMPLETE_ASIAN_MARKET');
  else if (!eligible.length) blockers.push('PRICE_OR_HANDICAP_OUTSIDE_POLICY');
  if (!crossChecked.length) blockers.push('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING');
  if (!openings.length) blockers.push('TRUE_OPENING_RECORD_MISSING');
  else if (!relevant.some(market => market.openingQuotes.length)) blockers.push('OPENING_TRAJECTORY_MISSING_OR_CHANGED');
  return { checkedAt: nowISO, scope: 'market-only', quoteGroups: groups, requiredQuoteGroups: policy.minimumQuoteGroups,
    pairedQuoteCount: paired.length, verifiedOpeningCount: openings.length, blockers: [...new Set(blockers)],
    sourceIssues: inspected.snapshotBlockers,
    matchingMarkets: markets.map(({ selection, handicap, quoteGroups, openingQuotes }) => ({ selection, handicap, quoteGroups,
      verifiedTrajectoryCount: openingQuotes.length, crossChecked: quoteGroups.length >= policy.minimumQuoteGroups })),
    quotes: paired.map(q => ({ ...safeQuote(q), ...(validOpening(q, fixture, nowISO) ? { opening: safeOpening(q.opening) } : {}) })) };
}
