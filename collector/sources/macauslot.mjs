import { isoMillis } from '../policy.mjs';
import { safeName } from './provider-utils.mjs';
import { SourceCooldownError, withSourceCooldown } from './cooldown.mjs';

export const MACAUSLOT_PAGE = 'https://www.macauslot.com/content/page/soccer/odds/all.html?sport=1&lang=cn';
export const MACAUSLOT_EVENTS = 'https://www.macauslot.com/soccer/json/realtime/threeinone_event_cn_fb.json';
export const MACAUSLOT_ODDS = 'https://www.macauslot.com/soccer/json/realtime/threeinone_odds_cn_fb.json';
const identity = { sourceId: 'macauslot', provider: 'macauslot-official', bookmaker: 'Macau SLOT' };
const leagues = { PL: ['ENG1', '英超', '英格蘭超級聯賽'], PD: ['SPN1', '西甲', '西班牙甲組聯賽'],
  SA: ['ITA1', '意甲', '意大利甲組聯賽'], BL1: ['GER1', '德甲', '德國甲組聯賽'], FL1: ['FRA1', '法甲', '法國甲組聯賽'] };
const normal = value => safeName(value) ? value.normalize('NFKD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ') : '';
// Exact bilingual names corroborated by the official 2026-10-31 and 2026-11-01
// event excerpts retained under sources/test/fixtures/macauslot-*.json.
// Unknown teams are not inferred from substrings, rankings or keyword searches.
const names = [
  ['Chelsea', '車路士'], ['Manchester United', 'Manchester Utd', '曼聯'], ['Levante', '利雲特'],
  ['Atletico Madrid', '馬德里體育會'], ['Bologna', '博洛尼亞'], ['Monza', '蒙沙'],
  ['Bayer 04 Leverkusen', '利華古遜'], ['VfB Stuttgart', '史特加'], ['FC Augsburg', 'Augsburg', '奧格斯堡'],
  ['SC Freiburg', '費雷堡'], ['Borussia Monchengladbach', '慕遜加柏'], ['SC Paderborn 07', '柏德博恩'],
  ['SV Werder Bremen', 'Werder Bremen', '雲達不萊梅'], ['TSG Hoffenheim', '賀芬咸'],
  ['FC Schalke 04', 'Schalke 04', '史浩克零四'], ['RB Leipzig', 'RB萊比錫'],
  ['FC Bayern Munchen', 'Bayern Munich', '拜仁慕尼黑'], ['Borussia Dortmund', '多蒙特'],
  ['Troyes', '特魯瓦'], ['Le Mans', '勒芒'], ['1. FC Union Berlin', 'Union Berlin', '柏林聯'],
  ['1. FC Koln', 'Koln', '科隆'], ['Eintracht Frankfurt', '法蘭克福'], ['Hamburger SV', '漢堡'],
  ['Sassuolo', '莎索羅'], ['Fiorentina', '費倫天拿'], ['Lorient', '羅連安特'], ['Brest', '比斯特'],
  ['Newcastle United', 'Newcastle Utd', '紐卡素'], ['Everton', '愛華頓'],
  ['Deportivo de A Coruña', 'Deportivo A Coruna', '拉科魯尼亞'], ['Osasuna', '奧沙辛拿'],
];
const nameMap = new Map(names.flatMap(group => group.map(name => [normal(name), normal(group[0])])));
const team = value => nameMap.get(normal(value)) || normal(value);
const id = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
const active = row => row?.displayed === 'Y' && row.status === 'A';
const snapshot = fixture => Object.fromEntries(['id', 'home', 'away', 'league', 'kickoff', 'source'].map(key => [key, fixture[key]]));
const fresh = (value, now, limit = 300_000) => Number.isFinite(isoMillis(value)) && isoMillis(value) <= now && now - isoMillis(value) <= limit;
const diag = (checkedAt, values) => ({ id: 'macauslot', ...identity, checkedAt, ...values });

// The official local clock and fixture dates use Macau time. Each snapshot also
// checks its local systime against native HTTP timestamps; it is never a quote
// update or an opening time. No host/browser timezone or skew correction is used.
export function macauslotTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = isoMillis(value.replace(' ', 'T') + '+08:00');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
export function macauslotHandicap(value) {
  if (typeof value !== 'string' || !/^[+-]?\d{1,2}(?:\.5)?(?:\/[+-]?\d{1,2}(?:\.5)?)?$/.test(value)) return null;
  const parts = value.split('/').map(Number);
  if (parts.some(n => Math.abs(n) > 10) || parts.length === 2 && Math.abs(parts[0] - parts[1]) !== .5) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length || 0;
}
function price(row) {
  // all.js AddP: (lp_num + lp_den) / lp_den. Decimal .000 is in the real feed.
  const integer = value => typeof value === 'string' && /^\d{1,9}(?:\.0+)?$/.test(value) ? Number(value) : NaN;
  const numerator = integer(row?.lp_num), denominator = integer(row?.lp_den), result = 1 + numerator / denominator;
  const shown = typeof row?.rate === 'string' && /^\d+(?:\.\d+)?$/.test(row.rate) ? Number(row.rate) : NaN;
  return numerator > 0 && denominator > 0 && result > 1 && result <= 21 && Math.abs(shown - result) < 1e-9 ? result : null;
}
function eligible(fixture, now) {
  return fixture && Object.hasOwn(leagues, fixture.league) && ['SCHEDULED', 'TIMED'].includes(fixture.status)
    && isoMillis(fixture.kickoff) > now && isoMillis(fixture.kickoff) - now <= 14 * 86400_000
    && team(fixture.home) && team(fixture.away) && team(fixture.home) !== team(fixture.away);
}

export function parseMacauslot(eventsPayload, oddsPayload, { fixtures, observedAt, sourceUpdatedAt, scheduleUpdatedAt,
  sourceAsOf, scheduleAsOf, scheduleObservedAt = observedAt }) {
  const now = isoMillis(observedAt);
  if (!Array.isArray(fixtures) || fixtures.length > 3000 || !Number.isFinite(now)) throw new Error('invalid_request');
  if (!Array.isArray(eventsPayload?.data) || eventsPayload.data.length > 3000 || !Array.isArray(eventsPayload.odds_config)
    || eventsPayload.odds_config.length > 4000 || oddsPayload?.errorCode !== 'success'
    || !Array.isArray(oddsPayload.data) || oddsPayload.data.length > 3000) throw new Error('invalid_snapshot');
  if (!fresh(sourceUpdatedAt, now) || !fresh(sourceAsOf, now) || isoMillis(sourceUpdatedAt) > isoMillis(sourceAsOf)
    || !fresh(scheduleObservedAt, now) || !fresh(scheduleAsOf, isoMillis(scheduleObservedAt))
    || !fresh(scheduleUpdatedAt, now, 86400_000) || isoMillis(scheduleUpdatedAt) > isoMillis(scheduleAsOf)
    || !fresh(macauslotTime(eventsPayload.systime), isoMillis(scheduleAsOf), 86400_000)) throw new Error('stale_snapshot');
  const quotes = [], marketStates = [], fixtureDiagnostics = [], mapped = [];
  for (const fixture of fixtures) {
    if (!eligible(fixture, now)) { fixtureDiagnostics.push(diag(observedAt, { fixtureId: fixture?.id, status: 'pending', code: 'fixture_ineligible' })); continue; }
    const league = leagues[fixture.league];
    const matches = eventsPayload.data.filter(({ event: e } = {}) => e && id(e.ev_id) && e.eventType?.name === league[2]
      && team(e.home_team) === team(fixture.home) && team(e.away_team) === team(fixture.away)
      && Math.abs(isoMillis(macauslotTime(e.start_time)) - isoMillis(fixture.kickoff)) <= 300_000);
    mapped.push({ fixture, event: matches.length === 1 ? matches[0].event : null,
      reason: matches.length === 1 ? null : matches.length ? 'fixture_identity_ambiguous' : 'fixture_identity_unmatched' });
  }
  const used = new Map();
  for (const row of mapped) if (row.event) used.set(row.event.ev_id, (used.get(row.event.ev_id) || 0) + 1);
  for (const row of mapped) {
    const { fixture, event } = row;
    let reason = row.reason, pair = null, market;
    if (event && used.get(event.ev_id) !== 1) reason = 'fixture_identity_ambiguous';
    if (!reason) {
      const configs = eventsPayload.odds_config.filter(c => c?.BETTING_ID === event.ev_id);
      const league = leagues[fixture.league];
      if (configs.length !== 1 || configs[0].ES !== league[0] || configs[0].TS !== league[1]
        || !id(event.ev_type_id) || event.eventType.ev_type_id !== event.ev_type_id
        || !Number.isSafeInteger(configs[0].FIXTURE_ID) || configs[0].FIXTURE_ID <= 0) reason = 'fixture_identity_ambiguous';
      else if (!active(event) || event.state !== '-' || event.currentState !== '0' || configs[0].S !== 2
        || !id(event.home_team_id) || !id(event.away_team_Id) || event.home_team_id === event.away_team_Id
        || isoMillis(macauslotTime(event.start_time)) <= now) reason = 'not_prematch';
      else {
        const batches = oddsPayload.data.filter(batch => batch?.ev_id === event.ev_id);
        if (batches.length !== 1) reason = batches.length ? 'market_ambiguous' : 'market_not_published';
        else if (!active(batches[0])) reason = 'market_suspended';
        else if (!Array.isArray(batches[0].markets) || batches[0].markets.length > 100) reason = 'invalid_market_fields';
        else {
          // is_current=0 / hilo_type=±1 denotes alternative current lines, never an opening.
          const mains = batches[0].markets.filter(m => m?.sort === 'AH' && m.is_current === '1');
          if (mains.length !== 1) reason = mains.length ? 'market_ambiguous' : 'market_not_published';
          else {
            market = mains[0];
            const home = macauslotHandicap(market.hcap_disp), away = macauslotHandicap(market.away_hcap_disp);
            if (!active(market)) reason = 'market_suspended';
            else if (market.ev_id !== event.ev_id || !id(market.ev_mkt_id) || market.outcomeGroup?.sort !== 'AH'
              || market.hilo_type !== '0' || home === null || away === null || home !== -away) reason = 'invalid_market_fields';
            else if (!Array.isArray(market.outcomes) || market.outcomes.length !== 2 || new Set(market.outcomes.map(o => o?.type)).size !== 2
              || market.outcomes.some(o => !['H', 'A'].includes(o?.type) || o.fb_result !== o.type || o.ev_id !== event.ev_id
                || team(o.desc) !== team(o.type === 'H' ? event.home_team : event.away_team)
                || !active(o) || price(o) === null)) reason = 'incomplete_market';
            else pair = market.outcomes.map(o => ({ fixtureId: fixture.id, fixtureSnapshot: snapshot(fixture), ...identity,
              providerMatchId: event.ev_id, providerPoolId: market.ev_mkt_id, providerFixtureId: String(configs[0].FIXTURE_ID),
              market: 'asian-handicap', period: 'full-time', selection: o.type === 'H' ? 'home' : 'away',
              handicap: o.type === 'H' ? home : away, decimalOdds: price(o), observedAt, sourceUpdatedAt, sourceAsOf,
              scheduleUpdatedAt, freshnessBasis: 'publisher-file-last-modified', quoteTimeBasis: 'whole-file-update',
              transactionUpdatedAt: null, validUntil: new Date(Math.min(isoMillis(sourceUpdatedAt) + 300_000, isoMillis(fixture.kickoff))).toISOString(),
              evidenceUrl: MACAUSLOT_PAGE, inPlay: false, closed: false, verified: true, verificationMethod: 'automatic' }));
          }
        }
      }
    }
    fixtureDiagnostics.push(diag(observedAt, { fixtureId: fixture.id, httpStatus: 200, sourceUpdatedAt, scheduleUpdatedAt,
      status: pair ? 'available' : 'pending', code: reason || 'matched', matchedCount: pair ? 1 : 0 }));
    if (pair) quotes.push(...pair);
    else marketStates.push({ fixtureId: fixture.id, fixtureSnapshot: snapshot(fixture), ...identity,
      providerMatchId: event?.ev_id || null, market: 'asian-handicap', period: 'full-time', marketState: 'unavailable', stateReason: reason,
      observedAt, sourceUpdatedAt, sourceAsOf, evidenceUrl: MACAUSLOT_PAGE, verified: true, verificationMethod: 'automatic' });
  }
  return { quotes, marketStates, signals: [], fixtureDiagnostics, diagnostics: [diag(observedAt, { status: 'partial',
    code: 'public_snapshot_partial_coverage', httpStatus: 200, parsedCount: eventsPayload.data.length,
    matchedCount: quotes.length / 2, sourceUpdatedAt, scheduleUpdatedAt, responseAt: sourceAsOf,
    quoteTimeBasis: 'whole-file-update', transactionUpdatedAt: null, openingStatus: 'not_provided' })] };
}

const allowedErrors = new Set(['invalid_request', 'invalid_snapshot', 'stale_snapshot', 'empty_snapshot', 'snapshot_too_large',
  'authorization_required', 'rate_limited', 'http_unavailable', 'timeout', 'source_cooldown', 'crawler_budget_exhausted', 'crawler_cancelled']);
async function readSnapshot(url, { fetchImpl, clock, signal, remaining }) {
  const controller = new AbortController(), timeout = Math.min(fetchImpl.timeoutMs || 25_000, remaining());
  if (signal?.aborted || timeout <= 0) throw new Error('crawler_budget_exhausted');
  const joined = AbortSignal.any([controller.signal, signal].filter(Boolean));
  let timer, onAbort;
  const operation = (async () => {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: joined,
      headers: { Accept: 'application/json', 'User-Agent': 'DimensionFootball-Collector/1.0' } });
    const rejectResponse = async code => { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error(code), { status: response.status }); };
    if (joined.aborted) return rejectResponse('timeout');
    if (!response.ok) return rejectResponse(response.status === 401 || response.status === 403 ? 'authorization_required' : response.status === 429 ? 'rate_limited' : 'http_unavailable');
    if (!/application\/json/i.test(response.headers.get('content-type') || '')) return rejectResponse('invalid_snapshot');
    const limit = url === MACAUSLOT_ODDS ? 4 * 1024 * 1024 : 1_500_000;
    if (Number(response.headers.get('content-length')) > limit) return rejectResponse('snapshot_too_large');
    const reader = response.body?.getReader(); if (!reader) throw new Error('empty_snapshot');
    const decoder = new TextDecoder(); let text = '', bytes = 0;
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength;
        if (bytes > limit) throw new Error('snapshot_too_large'); text += decoder.decode(part.value, { stream: true }); }
      text += decoder.decode();
    } finally { await reader.cancel().catch(() => {}); }
    const observedAt = clock(), now = isoMillis(observedAt), updated = Date.parse(response.headers.get('last-modified')),
      served = Date.parse(response.headers.get('date')), age = Number(response.headers.get('age') || 0);
    if (!Number.isFinite(now) || !Number.isFinite(updated) || !Number.isFinite(served) || !Number.isSafeInteger(age) || age < 0
      || updated > served || served > now || now - served + age * 1000 > 300_000
      || now - updated > (url === MACAUSLOT_ODDS ? 300_000 : 86400_000)) throw new Error('stale_snapshot');
    if (!text) throw new Error('empty_snapshot');
    let payload; try { payload = JSON.parse(text); } catch { throw new Error('invalid_snapshot'); }
    return { payload, observedAt, sourceUpdatedAt: new Date(updated).toISOString(), sourceAsOf: new Date(served).toISOString() };
  })();
  try {
    timer = setTimeout(() => controller.abort(), timeout);
    return await Promise.race([operation, new Promise((_, reject) => {
      onAbort = () => reject(new Error('timeout'));
      if (joined.aborted) onAbort(); else joined.addEventListener('abort', onAbort, { once: true });
    })]);
  } finally { clearTimeout(timer); joined.removeEventListener('abort', onAbort); controller.abort(); }
}

// fetchImpl is the public crawler transport: it owns robots, host spacing and
// request budgets. No private endpoints, credentials, browser bypass or POST.
export async function fetchMacauslotEvidence({ fixtures = [], nowISO, fetchImpl, clock = () => new Date().toISOString(), signal,
  remaining = () => Infinity, cooldownStatePath }) {
  if (!Array.isArray(fixtures) || fixtures.length > 3000 || !Number.isFinite(isoMillis(nowISO))) throw new Error('invalid_request');
  if (!fixtures.some(f => eligible(f, isoMillis(nowISO)))) return { quotes: [], marketStates: [], signals: [], diagnostics: [], fixtureDiagnostics: [] };
  if (typeof fetchImpl !== 'function') throw new Error('controlled_transport_required');
  try {
    return await withSourceCooldown({ statePath: cooldownStatePath, clock, signal, remaining }, async cooldown => {
      const guarded = (url, init) => cooldown.fetch('macauslot', fetchImpl, url, init);
      guarded.timeoutMs = fetchImpl.timeoutMs;
      const options = { fetchImpl: guarded, clock, signal, remaining };
      const events = await readSnapshot(MACAUSLOT_EVENTS, options);
      const odds = await readSnapshot(MACAUSLOT_ODDS, options);
      return parseMacauslot(events.payload, odds.payload, { fixtures, observedAt: odds.observedAt,
        sourceUpdatedAt: odds.sourceUpdatedAt, sourceAsOf: odds.sourceAsOf,
        scheduleUpdatedAt: events.sourceUpdatedAt, scheduleAsOf: events.sourceAsOf, scheduleObservedAt: events.observedAt });
    });
  } catch (error) {
    const code = signal?.aborted ? 'crawler_cancelled' : allowedErrors.has(error?.message) ? error.message
      : /^crawler_|^robots_|^crawl_delay_|^access_|^redirect_|^cache_validation_/.test(error?.code || '') ? error.code : 'network_unavailable';
    const cooldown = error instanceof SourceCooldownError ? error : null, checkedAt = clock();
    return { quotes: [], marketStates: [], signals: [], diagnostics: [diag(checkedAt, { status: 'unavailable', code,
      httpStatus: cooldown?.httpStatus ?? error.status ?? null, retryAfterMs: cooldown?.retryAfterMs ?? null,
      nextProbeAt: cooldown?.nextProbeAt ?? null, matchedCount: 0 })],
      fixtureDiagnostics: fixtures.map(f => diag(checkedAt, { fixtureId: f.id, status: 'unavailable', code })) };
  }
}
