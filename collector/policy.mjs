import { createHash } from 'node:crypto';

export const DEFAULT_POLICY = Object.freeze({
  version: 1, timezone: 'Asia/Shanghai', intervalMinutes: 60, days: 7,
  budgetMs: 1_200_000, maxFixtures: 3000, maxFixtureAgeMs: 86_400_000,
  maxQuoteAgeMs: 300_000, maxSignalAgeMs: 21_600_000,
  priceMin: 1.65, priceMax: 1.95, maxAbsHandicap: 1, maxPriceMovement: .15,
  minimumQuoteGroups: 2, requireOpening: true,
});

// Independence comes from this registry, never a provider-supplied vote count.
export const SOURCES = Object.freeze({
  hkjc: { group: 'hkjc-first-party', hosts: ['bet.hkjc.com'], freshness: 'publisher-live-snapshot' },
  sportmonks: { group: 'sportmonks-model', hosts: ['api.sportmonks.com'] },
  titan007: { group: 'titan007', hosts: ['live.titan007.com', 'livestatic.titan007.com'] },
  oddsgpt: { group: 'oddsgpt', hosts: ['oddsgpt.com', 'www.oddsgpt.com'] },
  oddstorm: { group: 'oddstorm', hosts: ['oddstorm.com', 'www.oddstorm.com'] },
  oddseek: { group: 'oddseek', hosts: ['oddseek.com', 'www.oddseek.com'] },
  oddspedia: { group: 'oddspedia', hosts: ['oddspedia.com', 'www.oddspedia.com'] },
  totalcorner: { group: 'totalcorner', hosts: ['totalcorner.com', 'www.totalcorner.com'] },
  oddsportal: { group: 'oddsportal', hosts: ['oddsportal.com', 'www.oddsportal.com'] },
  statarea: { group: 'statarea', hosts: ['statarea.com', 'www.statarea.com'] },
  forebet: { group: 'forebet', hosts: ['forebet.com', 'www.forebet.com'] },
  predictz: { group: 'web-analysis-solutions', hosts: ['predictz.com', 'www.predictz.com'] },
  windrawwin: { group: 'web-analysis-solutions', hosts: ['windrawwin.com', 'www.windrawwin.com'] },
  tipsme: { group: 'tipsme', hosts: ['tipsme.hk', 'www.tipsme.hk'] },
});

export function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function readPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_POLICY, key))) throw new Error('INVALID_POLICY');
  const p = { ...DEFAULT_POLICY, ...value };
  if (p.version !== 1 || p.timezone !== 'Asia/Shanghai' || p.minimumQuoteGroups < 2
    || !Number.isInteger(p.minimumQuoteGroups) || p.minimumQuoteGroups > 12 || p.requireOpening !== true
    || p.priceMin < 1.65 || p.priceMax > 1.95 || p.priceMin > p.priceMax
    || !Number.isFinite(p.priceMin) || !Number.isFinite(p.priceMax)
    || !Number.isFinite(p.maxAbsHandicap) || p.maxAbsHandicap <= 0 || p.maxAbsHandicap > 1
    || !Number.isFinite(p.maxPriceMovement) || p.maxPriceMovement < 0 || p.maxPriceMovement > .15) throw new Error('INVALID_POLICY');
  for (const [key, min, max] of [
    ['intervalMinutes', 5, 1440], ['days', 1, 14], ['budgetMs', 100, 1_200_000],
    ['maxFixtures', 1, 3000], ['maxFixtureAgeMs', 1, 86_400_000],
    ['maxQuoteAgeMs', 1, 300_000], ['maxSignalAgeMs', 1, 21_600_000],
  ]) if (!Number.isSafeInteger(p[key]) || p[key] < min || p[key] > max) throw new Error('INVALID_POLICY');
  return p;
}

export function isoMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
  const [y, m, d] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return NaN;
  const [h, minute, second] = value.slice(11, 19).split(':').map(Number);
  if (h > 23 || minute > 59 || second > 59) return NaN;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offset && (+offset[2] > 14 || +offset[3] > 59 || (+offset[2] === 14 && +offset[3] !== 0))) return NaN;
  return Date.parse(value);
}

const identityFields = ['id', 'league', 'home', 'away', 'kickoff', 'source'];
export function fixtureKey(fixture) { return digest(identityFields.map(key => fixture[key])); }
export function sameFixture(snapshot, fixture) {
  return Boolean(snapshot && identityFields.every(key => snapshot[key] === fixture[key]));
}

export function preparePool(input, policy = DEFAULT_POLICY) {
  if (!Array.isArray(input) || input.length > policy.maxFixtures) throw new Error('FIXTURE_POOL_INVALID_OR_TOO_LARGE');
  const fixtures = [], seen = new Map(); let duplicates = 0;
  for (const item of input) {
    if (!item || identityFields.some(key => typeof item[key] !== 'string' || !item[key].trim() || item[key].length > 200)
      || !/^[A-Za-z0-9_.:-]{1,160}$/.test(item.id) || !Number.isFinite(isoMillis(item.kickoff))
      || item.home === item.away || item.demo || item.source === 'fictional-demo'
      || !['SCHEDULED', 'TIMED', 'FINISHED', 'IN_PLAY', 'PAUSED', 'CANCELLED', 'POSTPONED', 'SUSPENDED'].includes(item.status)) throw new Error('INVALID_FIXTURE');
    const fixture = Object.fromEntries(identityFields.map(key => [key, item[key]]));
    fixture.status = item.status;
    fixture.updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : null;
    for (const key of ['homeTeamId', 'awayTeamId']) if (Object.hasOwn(item, key)) {
      if (typeof item[key] !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(item[key])) throw new Error('INVALID_FIXTURE');
      fixture[key] = item[key];
    }
    for (const key of ['observedAt', 'fetchedAt', 'sourceUpdatedAt']) if (Object.hasOwn(item, key)) fixture[key] = Number.isFinite(isoMillis(item[key])) ? item[key] : null;
    if (Object.hasOwn(item, 'season')) {
      const season = Number.isSafeInteger(item.season) ? String(item.season) : item.season;
      if (season !== null && (typeof season !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,79}$/.test(season))) throw new Error('INVALID_FIXTURE_IDENTITY');
      fixture.season = season;
    }
    // Identity fields are supplied by the source-scoped canonical identity layer.
    // Preserving them does not prove a cross-provider mapping.
    for (const [key, pattern] of Object.entries({ canonicalMatchId: /^evt_[a-f0-9]{64}$/,
      identityRevision: /^[a-f0-9]{64}$/, revisionId: /^[a-f0-9]{64}$/, recordHash: /^[a-f0-9]{64}$/, sourceFixtureId: /^[A-Za-z0-9_.:-]{1,160}$/ })) {
      if (!Object.hasOwn(item, key)) continue;
      if (typeof item[key] !== 'string' || !pattern.test(item[key])) throw new Error('INVALID_FIXTURE_IDENTITY');
      fixture[key] = item[key];
    }
    if (Object.hasOwn(item, 'identityScope')) {
      if (item.identityScope !== 'source') throw new Error('INVALID_FIXTURE_IDENTITY');
      fixture.identityScope = item.identityScope;
    }
    const fingerprint = digest(fixture);
    if (seen.has(item.id)) {
      if (seen.get(item.id) !== fingerprint) throw new Error('CONFLICTING_FIXTURE_ID');
      duplicates++; continue;
    }
    seen.set(item.id, fingerprint); fixtures.push(fixture);
  }
  return { fixtures: fixtures.sort((a, b) => isoMillis(a.kickoff) - isoMillis(b.kickoff) || a.id.localeCompare(b.id)), duplicates };
}

export function basicScreen(fixture, nowISO, policy = DEFAULT_POLICY) {
  const now = isoMillis(nowISO), kickoff = isoMillis(fixture.kickoff), updated = isoMillis(fixture.updatedAt);
  if (!Number.isFinite(now)) throw new Error('INVALID_NOW');
  if (!['SCHEDULED', 'TIMED'].includes(fixture.status) || kickoff <= now) return { status: 'avoid', reasons: ['NOT_PREMATCH'] };
  if (kickoff - now > policy.days * 86_400_000) return { status: 'avoid', reasons: ['OUTSIDE_WINDOW'] };
  if (!Number.isFinite(updated) || updated > now || now - updated > policy.maxFixtureAgeMs) return { status: 'source_insufficient', reasons: ['FIXTURE_FRESHNESS_UNVERIFIED'] };
  return null;
}

function publicUrl(value, source) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && source.hosts.includes(url.hostname)
      && ![...url.searchParams.keys()].some(key => /token|secret|key|auth|password/i.test(key));
  } catch { return false; }
}

function validEvidence(row, fixture, now, lifetime) {
  const source = SOURCES[row?.sourceId];
  const observed = isoMillis(row?.observedAt), expires = isoMillis(row?.validUntil);
  return Boolean(source && row.verified === true && ['automatic', 'owner-verified'].includes(row.verificationMethod)
    && sameFixture(row.fixtureSnapshot, fixture) && row.fixtureId === fixture.id
    && publicUrl(row.evidenceUrl, source) && Number.isFinite(observed) && observed <= now
    && now - observed <= lifetime && observed < isoMillis(fixture.kickoff) && expires > now);
}

const productionChannels = Object.freeze({ 'titan007-public-market': 'titan007', hkjc: 'hkjc', 'hkjc-first-party': 'hkjc' });
const titanCompanies = Object.freeze({ 17: 'M88', 24: '12Bet', 31: 'SBOBET' });

// A website label cannot turn a declared shared production channel into another
// independent source. Commercial reference providers are not formal quote feeds.
export function quoteSourceGroup(row) {
  if (!row || !Object.hasOwn(SOURCES, row.sourceId)) return null;
  if (row.provider !== undefined) {
    const producer = Object.hasOwn(productionChannels, row.provider) ? productionChannels[row.provider]
      : Object.hasOwn(SOURCES, row.provider) ? row.provider : null;
    if (producer !== row.sourceId) return null;
  }
  if (Object.hasOwn(productionChannels, row.source) && productionChannels[row.source] !== row.sourceId) return null;
  if (row.sourceId === 'hkjc' && row.bookmaker !== 'HKJC') return null;
  if (row.sourceId === 'titan007' && row.companyId !== undefined
    && (!Number.isSafeInteger(row.companyId) || !Object.hasOwn(titanCompanies, row.companyId) || titanCompanies[row.companyId] !== row.bookmaker)) return null;
  return SOURCES[row.sourceId].group;
}

export function validQuote(row, fixture, now, p = DEFAULT_POLICY) {
  const updated = isoMillis(row?.sourceUpdatedAt);
  const asOf = isoMillis(row?.sourceAsOf);
  const firstPartyLive = row?.sourceId === 'hkjc' && row.bookmaker === 'HKJC' && row.verificationMethod === 'automatic'
    && row.evidenceUrl === 'https://bet.hkjc.com/en/football/hdc' && row.freshnessBasis === 'publisher-live-snapshot'
    && row.providerPoolUpdatedAt === row.sourceUpdatedAt && Number.isFinite(asOf) && updated <= asOf
    && asOf <= isoMillis(row.observedAt) && now - asOf <= p.maxQuoteAgeMs
    && Number.isInteger(row.cacheMaxAgeSeconds) && row.cacheMaxAgeSeconds >= 0 && row.cacheMaxAgeSeconds <= 60;
  return validEvidence(row, fixture, now, p.maxQuoteAgeMs) && quoteSourceGroup(row) !== null && row.market === 'asian-handicap' && row.period === 'full-time'
    && typeof row.providerMatchId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(row.providerMatchId)
    && ['home', 'away'].includes(row.selection) && typeof row.bookmaker === 'string' && row.bookmaker.length > 0 && row.bookmaker.length <= 80 && !/[\u0000-\u001f]/u.test(row.bookmaker)
    && !/crown|皇冠|crow\*/i.test(row.bookmaker) && row.inPlay === false && row.closed === false
    && Number.isFinite(row.handicap) && Number.isInteger(row.handicap * 4) && Math.abs(row.handicap) <= 10
    && Number.isFinite(row.decimalOdds) && row.decimalOdds > 1 && row.decimalOdds <= 21
    && Number.isFinite(updated) && updated <= now && (row.sourceId === 'hkjc' ? firstPartyLive : now - updated <= p.maxQuoteAgeMs);
}

export function hasPair(quote, quotes) {
  return quotes.some(other => other !== quote && other.sourceId === quote.sourceId && other.bookmaker === quote.bookmaker
    && other.providerMatchId === quote.providerMatchId && other.providerPoolId === quote.providerPoolId
    && other.market === quote.market && other.period === quote.period
    && other.selection !== quote.selection && other.handicap === -quote.handicap
    && other.sourceAsOf === quote.sourceAsOf
    && other.observedAt === quote.observedAt && other.sourceUpdatedAt === quote.sourceUpdatedAt);
}

export function safeQuote(quote) {
  return Object.fromEntries(['sourceId', 'provider', 'bookmaker', 'companyId', 'providerMatchId', 'providerPoolId', 'market', 'period', 'selection', 'handicap', 'decimalOdds', 'observedAt', 'sourceUpdatedAt', 'validUntil', 'evidenceUrl', 'verificationMethod',
    'sourceAsOf', 'providerPoolUpdatedAt', 'freshnessBasis', 'cacheMaxAgeSeconds'].filter(key => Object.hasOwn(quote, key)).map(key => [key, quote[key]]));
}

export function validOpening(quote, fixture, nowISO) {
  const o = quote.opening, source = SOURCES[quote.sourceId], at = isoMillis(o?.observedAt), captured = isoMillis(o?.recordedAt);
  return Boolean(o && source && o.basis === 'provider-opening' && o.sourceId === quote.sourceId && o.bookmaker === quote.bookmaker
    && o.market === 'asian-handicap' && o.market === quote.market && o.period === 'full-time' && o.period === quote.period
    && typeof o.providerMatchId === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(o.providerMatchId) && o.providerMatchId === quote.providerMatchId
    && sameFixture(o.fixtureSnapshot, fixture)
    && (!fixture.canonicalMatchId || o.canonicalMatchId === fixture.canonicalMatchId)
    && (!fixture.identityRevision || o.identityRevision === fixture.identityRevision)
    && o.selection === quote.selection && o.fixtureId === fixture.id && publicUrl(o.evidenceUrl, source)
    && Number.isFinite(at) && at < isoMillis(quote.observedAt) && at <= isoMillis(quote.sourceUpdatedAt)
    && at < isoMillis(fixture.kickoff) && captured >= at && captured <= isoMillis(nowISO)
    && Number.isFinite(o.handicap) && Number.isInteger(o.handicap * 4) && Math.abs(o.handicap) <= 10
    && Number.isFinite(o.decimalOdds) && o.decimalOdds > 1 && o.decimalOdds <= 21);
}

export function safeOpening(opening) {
  const safe = Object.fromEntries(['basis', 'sourceId', 'bookmaker', 'selection', 'fixtureId', 'providerMatchId', 'market', 'period', 'canonicalMatchId', 'identityRevision', 'handicap', 'decimalOdds',
    'observedAt', 'recordedAt', 'evidenceUrl'].filter(key => Object.hasOwn(opening, key)).map(key => [key, opening[key]]));
  if (opening.fixtureSnapshot) safe.fixtureSnapshot = Object.fromEntries(identityFields.map(key => [key, opening.fixtureSnapshot[key]]));
  return safe;
}

export function openingIdentity(opening) {
  return digest(['sourceId', 'bookmaker', 'selection', 'fixtureId', 'providerMatchId', 'market', 'period', 'canonicalMatchId', 'identityRevision',
    'handicap', 'decimalOdds', 'observedAt'].map(key => opening?.[key]).concat([opening?.fixtureSnapshot ? fixtureKey(opening.fixtureSnapshot) : null]));
}

export function validOpeningTrajectory(quote, fixture, nowISO, policy = DEFAULT_POLICY) {
  return validOpening(quote, fixture, nowISO) && quote.opening.handicap === quote.handicap
    && Math.abs(quote.opening.decimalOdds - quote.decimalOdds) <= policy.maxPriceMovement;
}

// Resolve a source's latest snapshot before checking prices, availability or
// completeness. A newer closed/incomplete market must never revive an old price.
export function latestMarketQuotes(fixture, quotes, nowISO) {
  const grouped = new Map(), blockers = new Set(), now = isoMillis(nowISO);
  for (const row of quotes) {
    if (!row || !Object.hasOwn(SOURCES, row.sourceId) || row.verified !== true
      || !['automatic', 'owner-verified'].includes(row.verificationMethod) || row.fixtureId !== fixture.id
      || !sameFixture(row.fixtureSnapshot, fixture) || row.market !== 'asian-handicap' || row.period !== 'full-time'
      || typeof row.bookmaker !== 'string' || !row.bookmaker.trim() || row.bookmaker.length > 80) continue;
    const key = digest([row.sourceId, row.bookmaker, row.market, row.period]);
    const values = grouped.get(key) || []; values.push(row); grouped.set(key, values);
  }
  const current = [];
  for (const rows of grouped.values()) {
    if (rows.some(row => quoteSourceGroup(row) === null)) { blockers.add('SOURCE_CHANNEL_IDENTITY_CONFLICT'); continue; }
    const sourceTime = row => isoMillis(row.sourceId === 'hkjc' ? row.sourceAsOf : row.sourceUpdatedAt);
    if (rows.some(row => !Number.isFinite(sourceTime(row)) || !Number.isFinite(isoMillis(row.observedAt))
      || sourceTime(row) > isoMillis(row.observedAt) || isoMillis(row.observedAt) > now)) {
      blockers.add('MARKET_SNAPSHOT_TIMESTAMP_INVALID'); continue;
    }
    const observed = Math.max(...rows.map(row => isoMillis(row.observedAt)));
    const observedRows = rows.filter(row => isoMillis(row.observedAt) === observed), latestTime = Math.max(...observedRows.map(sourceTime));
    if (rows.some(row => sourceTime(row) > latestTime)) { blockers.add('MARKET_SNAPSHOT_REGRESSED'); continue; }
    const latest = rows.filter(row => sourceTime(row) === latestTime);
    const signature = row => digest(['providerMatchId', 'providerPoolId', 'selection', 'handicap', 'decimalOdds', 'inPlay', 'closed',
      'sourceUpdatedAt', 'sourceAsOf', 'validUntil', 'evidenceUrl', 'verificationMethod', 'freshnessBasis', 'providerPoolUpdatedAt', 'cacheMaxAgeSeconds'].map(key => row[key]));
    if (['home', 'away'].some(side => new Set(latest.filter(row => row.selection === side).map(signature)).size > 1)
      || new Set(latest.map(row => row.providerMatchId)).size !== 1 || new Set(latest.map(row => row.providerPoolId)).size !== 1) {
      blockers.add('CURRENT_MARKET_AMBIGUOUS'); continue;
    }
    const snapshot = latest.filter(row => isoMillis(row.observedAt) === observed);
    if (snapshot.some(row => ['closed', 'incomplete', 'unavailable'].includes(row.marketState))) {
      blockers.add('LATEST_MARKET_UNAVAILABLE'); continue;
    }
    if (snapshot.some(row => !['home', 'away'].includes(row.selection)) || ['home', 'away'].some(side => !snapshot.some(row => row.selection === side))) {
      blockers.add('LATEST_MARKET_INCOMPLETE'); continue;
    }
    for (const side of ['home', 'away']) {
      const sameSide = snapshot.filter(row => row.selection === side), claims = sameSide.filter(row => row.opening);
      // Reconciliation persists this conflict; direct policy callers also fail closed.
      const openingConflict = new Set(rows.filter(row => row.selection === side && validOpening(row, fixture, nowISO)).map(row => openingIdentity(row.opening))).size > 1;
      const chosen = claims.length ? [...claims].sort((a, b) => String(a.opening.recordedAt).localeCompare(String(b.opening.recordedAt)))[0] : sameSide[0];
      current.push(openingConflict ? { ...chosen, opening: undefined } : chosen);
    }
  }
  return { quotes: current, blockers: [...blockers].sort() };
}

// Shared market-only gates for formal evaluation and readiness diagnostics.
export function inspectMarket(fixture, quotes, nowISO, policy = DEFAULT_POLICY) {
  const screened = basicScreen(fixture, nowISO, policy), latest = latestMarketQuotes(fixture, quotes, nowISO);
  const valid = screened ? [] : latest.quotes.filter(row => validQuote(row, fixture, isoMillis(nowISO), policy));
  const paired = valid.filter(row => hasPair(row, valid));
  const eligible = paired.filter(row => row.decimalOdds >= policy.priceMin && row.decimalOdds <= policy.priceMax && Math.abs(row.handicap) <= policy.maxAbsHandicap);
  const groups = new Map();
  for (const quote of eligible) {
    const key = digest([quote.selection, quote.handicap]), rows = groups.get(key) || []; rows.push(quote); groups.set(key, rows);
  }
  const markets = [...groups.values()].map(rows => ({ selection: rows[0].selection, handicap: rows[0].handicap, quotes: rows,
    quoteGroups: [...new Set(rows.map(row => SOURCES[row.sourceId].group))].sort(),
    openingQuotes: rows.filter(row => validOpeningTrajectory(row, fixture, nowISO, policy)) }));
  return { screened, valid, paired, eligible, markets, snapshotBlockers: latest.blockers };
}

export function retainedEvidence(fixture, { quotes = [], signals = [] }, nowISO, p = DEFAULT_POLICY) {
  const now = isoMillis(nowISO);
  return {
    observedAt: nowISO,
    quotes: latestMarketQuotes(fixture, quotes, nowISO).quotes.filter(row => validQuote(row, fixture, now, p)).map(row => ({ ...safeQuote(row),
      ...(validOpening(row, fixture, nowISO) ? { opening: safeOpening(row.opening) } : {}) })),
    signals: signals.filter(row => validEvidence(row, fixture, now, p.maxSignalAgeMs)
      && ['1x2', 'asian-handicap'].includes(row.market) && ['home', 'draw', 'away'].includes(row.selection)
      && Number.isFinite(row.probability) && row.probability >= 0 && row.probability <= 1
      && (row.handicap === undefined || Number.isFinite(row.handicap))).map(row => Object.fromEntries(
      ['sourceId', 'market', 'selection', 'handicap', 'probability', 'observedAt', 'validUntil', 'evidenceUrl', 'verificationMethod'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))),
  };
}

export function evaluateFixture(fixture, { quotes = [], signals = [] } = {}, nowISO, policy = DEFAULT_POLICY) {
  const initial = basicScreen(fixture, nowISO, policy);
  if (initial) return initial;
  const now = isoMillis(nowISO);
  const { paired: complete, eligible, markets, snapshotBlockers } = inspectMarket(fixture, quotes, nowISO, policy);
  const forecasts = signals.filter(signal => validEvidence(signal, fixture, now, policy.maxSignalAgeMs)
    && ['home', 'draw', 'away'].includes(signal.selection)
    && ['1x2', 'asian-handicap'].includes(signal.market)
    && Number.isFinite(signal.probability) && signal.probability >= 0 && signal.probability <= 1);
  if (!complete.length) return { status: 'source_insufficient', reasons: ['NO_FRESH_COMPLETE_ASIAN_MARKET', ...snapshotBlockers] };
  if (!eligible.length) return { status: 'avoid', reasons: ['PRICE_OR_HANDICAP_OUTSIDE_POLICY'] };
  let best = null;
  const reasons = new Set();
  for (const quote of eligible) {
    const market = markets.find(item => item.selection === quote.selection && item.handicap === quote.handicap);
    const matching = market.quotes, groups = new Set(market.quoteGroups);
    if (groups.size < policy.minimumQuoteGroups) { reasons.add('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING'); continue; }
    const forecastRows = forecasts.filter(signal => !groups.has(SOURCES[signal.sourceId].group));
    if (forecastRows.some(signal => signal.selection !== quote.selection)) { reasons.add('FORECAST_CONFLICT'); continue; }
    if (!forecastRows.some(signal => signal.selection === quote.selection
      && (signal.market !== 'asian-handicap' || signal.handicap === quote.handicap))) { reasons.add('INDEPENDENT_FORECAST_MISSING'); continue; }
    const opening = quote.opening;
    if (!validOpeningTrajectory(quote, fixture, nowISO, policy)) { reasons.add('OPENING_TRAJECTORY_MISSING_OR_CHANGED'); continue; }
    if (!best || quote.decimalOdds > best.decimalOdds) best = {
      selection: quote.selection, handicap: quote.handicap, decimalOdds: quote.decimalOdds,
      quotes: matching.map(safeQuote), opening: safeOpening(opening),
      forecastSources: [...new Set(forecastRows.map(signal => signal.sourceId))],
      quoteGroups: [...groups], requiresReview: true,
      // A 1X2 forecast is auxiliary; never relabel it as Asian-cover probability.
      asianWinProbability: null, totalGoals: null, scorePrediction: null,
    };
  }
  if (best) return { status: 'candidate', reasons: ['EVIDENCE_GATE_PASSED_REQUIRES_REVIEW'], candidate: best };
  // A conflict for the opposite direction must not turn a supported direction
  // missing its opening evidence into an apparent negative prediction.
  return { status: reasons.size === 1 && reasons.has('FORECAST_CONFLICT') ? 'avoid' : 'source_insufficient', reasons: [...reasons] };
}
