import { readFile } from 'node:fs/promises';
import { isoMillis, validQuote, DEFAULT_POLICY } from '../policy.mjs';
import { safeName, safeId } from './provider-utils.mjs';
import { SourceCooldownError, withSourceCooldown } from './cooldown.mjs';

export const HKJC_ENDPOINT = 'https://info.cld.hkjc.com/graphql/base-get/';
export const HKJC_PAGE = 'https://bet.hkjc.com/en/football/hdc';
const codes = { EPL: 'PL', SFL: 'PD', ISA: 'SA', GSL: 'BL1', FFL: 'FL1' };
const names = { PL: ['English Premier League'], PD: ['Spanish Division 1'], SA: ['Italian Division 1'], BL1: ['German Division 1'], FL1: ['French Division 1'] };
const aliases = {
  BL1: [['Bayer 04 Leverkusen', 'Leverkusen'], ['VfB Stuttgart', 'Stuttgart'], ['FC Augsburg', 'Augsburg'], ['SC Freiburg', 'Freiburg'],
    ['Borussia Mönchengladbach', 'Monchengladbach'], ['SC Paderborn 07', 'Paderborn'], ['SV Werder Bremen', 'Werder Bremen'],
    ['TSG Hoffenheim', 'Hoffenheim'], ['FC Schalke 04', 'Schalke 04'], ['FC Bayern München', 'Bayern Munich'],
    ['Borussia Dortmund', 'Dortmund'], ['1. FC Köln', 'Cologne'], ['1. FC Union Berlin', 'Union Berlin'], ['Eintracht Frankfurt', 'Frankfurt'], ['Hamburger SV', 'Hamburg']],
  PL: [['Manchester United', 'Manchester Utd']], PD: [['Atletico Madrid', 'Atlético Madrid']], SA: [], FL1: [],
};
const normal = name => safeName(name) ? name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim() : '';
export function hkjcTeamName(name, league) {
  const value = normal(name);
  return aliases[league]?.find(pair => pair.map(normal).includes(value))?.map(normal)[0] || value;
}
export function hkjcHandicap(value) {
  if (typeof value !== 'string' || !/^[+-]?\d(?:\.\d+)?(?:\/[+-]?\d(?:\.\d+)?)?$/.test(value)) return null;
  const parts = value.split('/').map(Number);
  if (parts.some(n => Math.abs(n) > 10 || !Number.isInteger(n * 2)) || parts.length === 2 && Math.abs(parts[0] - parts[1]) !== .5) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length || 0;
}
const expiry = (now, kickoff) => new Date(Math.min(Date.parse(now) + 300000, Date.parse(kickoff))).toISOString();
const diagnostic = (now, values) => ({ id: 'hkjc', sourceId: 'hkjc', checkedAt: now, ...values });

export function parseHkjc(payload, { fixtures, observedAt, sourceAsOf, cacheMaxAgeSeconds }) {
  if (payload?.errors != null && (!Array.isArray(payload.errors) || payload.errors.length) || !Array.isArray(payload?.data?.matches) || payload.data.matches.length > 3000) throw new Error('invalid_snapshot');
  if (!Number.isFinite(isoMillis(observedAt)) || !Number.isFinite(isoMillis(sourceAsOf)) || isoMillis(sourceAsOf) > isoMillis(observedAt) || isoMillis(observedAt) - isoMillis(sourceAsOf) > 60000
    || !Number.isInteger(cacheMaxAgeSeconds) || cacheMaxAgeSeconds < 0 || cacheMaxAgeSeconds > 60) throw new Error('stale_snapshot');
  const events = payload.data.matches, quotes = [], fixtureDiagnostics = [], mappings = new Map();
  const ids = events.map(e => e?.id);
  if (new Set(ids).size !== ids.length) throw new Error('invalid_schedule');
  for (const fixture of fixtures) {
    const base = { fixtureId: fixture.id, id: 'hkjc', sourceId: 'hkjc', bookmaker: 'HKJC', checkedAt: observedAt, httpStatus: 200 };
    if (!['SCHEDULED', 'TIMED'].includes(fixture.status) || Date.parse(fixture.kickoff) <= Date.parse(observedAt) || !aliases[fixture.league]) {
      fixtureDiagnostics.push({ ...base, status: 'pending', code: 'fixture_ineligible' }); continue;
    }
    const matches = events.filter(e => codes[e?.tournament?.code] === fixture.league && names[fixture.league].includes(e.tournament.name_en)
      && hkjcTeamName(e.homeTeam?.name_en, fixture.league) === hkjcTeamName(fixture.home, fixture.league)
      && hkjcTeamName(e.awayTeam?.name_en, fixture.league) === hkjcTeamName(fixture.away, fixture.league)
      && Number.isFinite(isoMillis(e.kickOffTime)) && Math.abs(Date.parse(e.kickOffTime) - Date.parse(fixture.kickoff)) <= 300000);
    if (matches.length !== 1) { fixtureDiagnostics.push({ ...base, status: 'pending', code: matches.length ? 'fixture_identity_ambiguous' : 'fixture_identity_unmatched' }); continue; }
    const event = matches[0]; mappings.set(fixture.id, event.id);
    if (event.status !== 'PREEVENT' || !safeId(event.id) || !safeId(event.homeTeam?.id) || !safeId(event.awayTeam?.id)
      || event.homeTeam.id === event.awayTeam.id || Date.parse(event.kickOffTime) <= Date.parse(observedAt)) {
      fixtureDiagnostics.push({ ...base, status: 'pending', code: 'not_prematch' }); continue;
    }
    const pools = event.foPools?.filter(p => p.oddsType === 'HDC' && p.inplay === false && p.instNo === 0);
    if (!Array.isArray(pools) || pools.length !== 1) { fixtureDiagnostics.push({ ...base, status: 'pending', code: pools?.length ? 'market_ambiguous' : 'market_not_published' }); continue; }
    const p = pools[0], lines = p.lines?.filter(l => l.main === true);
    const updated = isoMillis(p.updateAt);
    if (p.status !== 'SELLINGSTARTED' || !Number.isFinite(updated) || updated > Date.parse(sourceAsOf) || !safeId(p.id)
      || !Array.isArray(lines) || lines.length !== 1 || lines[0].status !== 'AVAILABLE') {
      fixtureDiagnostics.push({ ...base, status: 'pending', code: 'invalid_market_fields' }); continue;
    }
    const line = lines[0], handicap = hkjcHandicap(line.condition), combinations = line.combinations;
    if (handicap === null || !Array.isArray(combinations) || combinations.length !== 2 || new Set(combinations.map(c => c.str)).size !== 2
      || combinations.some(c => !['H', 'A'].includes(c.str) || c.status !== 'AVAILABLE' || !/^\d+(?:\.\d+)?$/.test(c.currentOdds)
        || !(Number(c.currentOdds) > 1 && Number(c.currentOdds) <= 21))) {
      fixtureDiagnostics.push({ ...base, status: 'pending', code: 'incomplete_market' }); continue;
    }
    const pair = combinations.map(c => ({ fixtureId: fixture.id,
      fixtureSnapshot: Object.fromEntries(['id', 'home', 'away', 'league', 'kickoff', 'source'].map(k => [k, fixture[k]])),
      sourceId: 'hkjc', bookmaker: 'HKJC', market: 'asian-handicap', period: 'full-time',
      selection: c.str === 'H' ? 'home' : 'away', handicap: c.str === 'H' ? handicap : -handicap || 0, decimalOdds: Number(c.currentOdds),
      observedAt, sourceUpdatedAt: new Date(updated).toISOString(), providerPoolUpdatedAt: new Date(updated).toISOString(), sourceAsOf,
      freshnessBasis: 'publisher-live-snapshot', cacheMaxAgeSeconds, validUntil: expiry(sourceAsOf, fixture.kickoff),
      providerMatchId: String(event.id), providerPoolId: String(p.id), evidenceUrl: HKJC_PAGE,
      inPlay: false, closed: false, verified: true, verificationMethod: 'automatic' }));
    if (!pair.every(q => validQuote(q, fixture, Date.parse(observedAt), DEFAULT_POLICY))) {
      fixtureDiagnostics.push({ ...base, status: 'pending', code: 'quote_validation_failed' }); continue;
    }
    quotes.push(...pair); fixtureDiagnostics.push({ ...base, status: 'available', code: 'matched', matchedCount: 1 });
  }
  const repeated = new Set([...mappings.values()].filter((id, i, all) => all.indexOf(id) !== i));
  const clean = quotes.filter(q => !repeated.has(q.providerMatchId));
  for (const d of fixtureDiagnostics) if (repeated.has(mappings.get(d.fixtureId))) Object.assign(d, { status: 'pending', code: 'fixture_identity_ambiguous', matchedCount: 0 });
  // A successful publisher snapshot that no longer verifies a market must
  // suppress older imported prices. This state is never itself a quotation.
  const marketStates = fixtureDiagnostics.filter(d => d.status !== 'available' && d.code !== 'fixture_ineligible').map(d => {
    const fixture = fixtures.find(f => f.id === d.fixtureId);
    return { fixtureId: fixture.id, fixtureSnapshot: Object.fromEntries(['id', 'home', 'away', 'league', 'kickoff', 'source'].map(k => [k, fixture[k]])),
      sourceId: 'hkjc', bookmaker: 'HKJC', providerMatchId: safeId(mappings.get(fixture.id)) ? String(mappings.get(fixture.id)) : null,
      market: 'asian-handicap', period: 'full-time', marketState: 'unavailable', stateReason: d.code,
      observedAt, sourceAsOf, evidenceUrl: HKJC_PAGE, verified: true, verificationMethod: 'automatic' };
  });
  return { quotes: clean, marketStates, signals: [], fixtureDiagnostics, diagnostics: [diagnostic(observedAt, { status: 'partial', code: 'public_live_snapshot_partial_coverage',
    responseAt: sourceAsOf, httpStatus: 200, parsedCount: events.length, matchedCount: new Set(clean.map(q => q.fixtureId)).size })] };
}

// Exact public frontend operation, with one HDC market. Never authenticate, submit
// bets, introspect private fields, or change variables to evade page limitations.
export async function fetchHkjcEvidence({ cooldownStatePath, fetchImpl = fetch, clock = () => new Date().toISOString(), signal, remaining = () => Infinity, ...options }) {
  return withSourceCooldown({ statePath: cooldownStatePath, clock, signal, remaining }, cooldown =>
    fetchHkjcSnapshot({ ...options, clock, signal, remaining,
      fetchImpl: (url, init) => cooldown.fetch('hkjc', fetchImpl, url, init) }));
}

async function fetchHkjcSnapshot({ fixtures, nowISO, fetchImpl, clock, signal, remaining }) {
  if (!fixtures.length || !fixtures.some(f => aliases[f.league] && ['SCHEDULED', 'TIMED'].includes(f.status) && Date.parse(f.kickoff) > Date.parse(nowISO))) return { quotes: [], signals: [], diagnostics: [], fixtureDiagnostics: [] };
  let status = null; const controller = new AbortController(); let timer;
  try {
    if (signal?.aborted || remaining() <= 0) throw new Error('crawler_budget_exhausted');
    const query = (await readFile(new URL('./hkjc-query.graphql', import.meta.url), 'utf8')).replace(/[\s,]+/g, ' ').trim();
    const variables = { fbOddsTypes: ['HDC'], fbOddsTypesM: ['HDC'], featuredMatchesOnly: false, startDate: null, endDate: null,
      tournIds: null, matchIds: null, startIndex: null, endIndex: null, frontEndIds: null, earlySettlementOnly: false, showAllMatch: false };
    const url = new URL(HKJC_ENDPOINT); url.searchParams.set('query', query); url.searchParams.set('variables', JSON.stringify(variables));
    timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(8000, remaining())));
    const operation = (async () => {
    const response = await fetchImpl(url.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([controller.signal, signal].filter(Boolean)),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'DimensionFootball-Collector/1.0' } });
    status = response.status;
    if (!response.ok) throw new Error(status === 401 || status === 403 ? 'authorization_required' : status === 429 ? 'rate_limited' : 'http_unavailable');
    const cache = response.headers.get('cache-control') || '', maxAge = cache.match(/(?:^|,)\s*max-age=(\d+)(?:,|$)/i);
    const age = Number(response.headers.get('age') || 0), served = Date.parse(response.headers.get('date'));
    if (!maxAge || +maxAge[1] > 60 || !Number.isInteger(age) || age < 0 || age > 60 || !Number.isFinite(served)) throw new Error('stale_snapshot');
    if (!/application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('invalid_snapshot');
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty_snapshot');
    let bytes = 0, text = ''; const decoder = new TextDecoder();
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 2000000) throw new Error('snapshot_too_large'); text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); }
    finally { await reader.cancel().catch(() => {}); }
    const observedAt = clock();
    if (Date.parse(observedAt) - served + age * 1000 > 60000) throw new Error('stale_snapshot');
    return parseHkjc(JSON.parse(text), { fixtures, observedAt, sourceAsOf: new Date(served).toISOString(), cacheMaxAgeSeconds: +maxAge[1] });
    })();
    const joined = AbortSignal.any([controller.signal, signal].filter(Boolean));
    return await Promise.race([operation, new Promise((_, reject) => {
      if (joined.aborted) reject(new Error('timeout'));
      else joined.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    })]);
  } catch (error) {
    const allowed = ['authorization_required', 'rate_limited', 'source_cooldown', 'http_unavailable', 'stale_snapshot', 'invalid_snapshot', 'invalid_schedule', 'empty_snapshot', 'snapshot_too_large', 'crawler_budget_exhausted'];
    const code = signal?.aborted ? 'crawler_cancelled' : controller.signal.aborted ? 'timeout' : allowed.includes(error?.message) ? error.message : 'network_unavailable';
    const cooldown = error instanceof SourceCooldownError ? error : null;
    return { quotes: [], signals: [], diagnostics: [diagnostic(clock(), { status: 'unavailable', code,
      httpStatus: cooldown?.httpStatus ?? status, retryAfterMs: cooldown?.retryAfterMs ?? null, nextProbeAt: cooldown?.nextProbeAt ?? null, matchedCount: 0 })],
      fixtureDiagnostics: fixtures.map(f => ({ fixtureId: f.id, id: 'hkjc', status: 'unavailable', code, checkedAt: clock() })) };
  } finally { clearTimeout(timer); controller.abort(); }
}
