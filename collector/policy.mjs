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
    for (const key of ['fetchedAt', 'sourceUpdatedAt']) if (Object.hasOwn(item, key)) fixture[key] = Number.isFinite(isoMillis(item[key])) ? item[key] : null;
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

function validQuote(row, fixture, now, p) {
  const updated = isoMillis(row?.sourceUpdatedAt);
  return validEvidence(row, fixture, now, p.maxQuoteAgeMs) && row.market === 'asian-handicap' && row.period === 'full-time'
    && ['home', 'away'].includes(row.selection) && typeof row.bookmaker === 'string' && row.bookmaker.length > 0 && row.bookmaker.length <= 80 && !/[\u0000-\u001f]/u.test(row.bookmaker)
    && !/crown|皇冠|crow\*/i.test(row.bookmaker) && row.inPlay === false && row.closed === false
    && Number.isFinite(row.handicap) && Number.isInteger(row.handicap * 4) && Math.abs(row.handicap) <= 10
    && Number.isFinite(row.decimalOdds) && row.decimalOdds > 1 && row.decimalOdds <= 21
    && Number.isFinite(updated) && updated <= now && now - updated <= p.maxQuoteAgeMs;
}

function hasPair(quote, quotes) {
  return quotes.some(other => other !== quote && other.sourceId === quote.sourceId && other.bookmaker === quote.bookmaker
    && other.selection !== quote.selection && other.handicap === -quote.handicap
    && other.observedAt === quote.observedAt && other.sourceUpdatedAt === quote.sourceUpdatedAt);
}

function safeQuote(quote) {
  return Object.fromEntries(['sourceId', 'bookmaker', 'selection', 'handicap', 'decimalOdds', 'observedAt', 'sourceUpdatedAt', 'validUntil', 'evidenceUrl', 'verificationMethod'].map(key => [key, quote[key]]));
}

export function retainedEvidence(fixture, { quotes = [], signals = [] }, nowISO, p = DEFAULT_POLICY) {
  const now = isoMillis(nowISO);
  return {
    observedAt: nowISO,
    quotes: quotes.filter(row => validQuote(row, fixture, now, p)).map(safeQuote),
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
  const valid = quotes.filter(quote => validQuote(quote, fixture, now, policy));
  const complete = valid.filter(quote => hasPair(quote, valid));
  const forecasts = signals.filter(signal => validEvidence(signal, fixture, now, policy.maxSignalAgeMs)
    && ['home', 'draw', 'away'].includes(signal.selection)
    && ['1x2', 'asian-handicap'].includes(signal.market)
    && Number.isFinite(signal.probability) && signal.probability >= 0 && signal.probability <= 1);
  if (!complete.length) return { status: 'source_insufficient', reasons: ['NO_FRESH_COMPLETE_ASIAN_MARKET'] };
  const eligible = complete.filter(quote => quote.decimalOdds >= policy.priceMin && quote.decimalOdds <= policy.priceMax
    && Math.abs(quote.handicap) <= policy.maxAbsHandicap);
  if (!eligible.length) return { status: 'avoid', reasons: ['PRICE_OR_HANDICAP_OUTSIDE_POLICY'] };
  let best = null;
  const reasons = new Set();
  for (const quote of eligible) {
    const matching = eligible.filter(other => other.selection === quote.selection && other.handicap === quote.handicap);
    const groups = new Set(matching.map(other => SOURCES[other.sourceId].group));
    if (groups.size < policy.minimumQuoteGroups) { reasons.add('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING'); continue; }
    const forecastRows = forecasts.filter(signal => !groups.has(SOURCES[signal.sourceId].group));
    if (forecastRows.some(signal => signal.selection !== quote.selection)) { reasons.add('FORECAST_CONFLICT'); continue; }
    if (!forecastRows.some(signal => signal.selection === quote.selection
      && (signal.market !== 'asian-handicap' || signal.handicap === quote.handicap))) { reasons.add('INDEPENDENT_FORECAST_MISSING'); continue; }
    const opening = quote.opening, openingAt = isoMillis(opening?.observedAt);
    if (!opening || !Number.isFinite(opening.handicap) || !Number.isInteger(opening.handicap * 4) || opening.handicap !== quote.handicap
      || !Number.isFinite(opening.decimalOdds) || opening.decimalOdds <= 1 || opening.decimalOdds > 21 || !(openingAt < isoMillis(quote.observedAt))
      || Math.abs(opening.decimalOdds - quote.decimalOdds) > policy.maxPriceMovement) { reasons.add('OPENING_TRAJECTORY_MISSING_OR_CHANGED'); continue; }
    if (!best || quote.decimalOdds > best.decimalOdds) best = {
      selection: quote.selection, handicap: quote.handicap, decimalOdds: quote.decimalOdds,
      quotes: matching.map(safeQuote), opening: { sourceId: quote.sourceId, bookmaker: quote.bookmaker,
        ...Object.fromEntries(['handicap', 'decimalOdds', 'observedAt'].map(key => [key, opening[key]])) },
      forecastSources: [...new Set(forecastRows.map(signal => signal.sourceId))],
      quoteGroups: [...groups], requiresReview: true,
      // A 1X2 forecast is auxiliary; never relabel it as Asian-cover probability.
      asianWinProbability: null, totalGoals: null, scorePrediction: null,
    };
  }
  if (best) return { status: 'candidate', reasons: ['EVIDENCE_GATE_PASSED_REQUIRES_REVIEW'], candidate: best };
  return { status: reasons.has('FORECAST_CONFLICT') ? 'avoid' : 'source_insufficient', reasons: [...reasons] };
}
