import { teamName } from './team-names.mjs';
import { isoMillis } from '../policy.mjs';

export const LEAGUES = Object.freeze(['PL', 'PD', 'SA', 'BL1', 'FL1']);
export const safeName = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 200 && !/[\x00-\x1f\x7f<>]/u.test(value);
export const safeId = value => /^(?:[A-Za-z0-9_-]{1,80})$/u.test(String(value ?? ''));
export const number = value => typeof value === 'number' ? value
  : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : NaN;
export const decimal = value => { const n = number(value); return Number.isFinite(n) && n > 1 && n <= 1000 ? n : null; };
export const quarter = value => { const n = number(value); return Number.isFinite(n) && Math.abs(n) <= 20 && Number.isInteger(n * 4) ? n : null; };
export function canonicalName(value) {
  return safeName(value) ? teamName(value.trim().normalize('NFKC')).toLowerCase().replace(/\s+/gu, ' ') : '';
}
export function timestamp(value) {
  const ms = typeof value === 'number' && Number.isSafeInteger(value) ? value * 1000 : isoMillis(value);
  return Number.isFinite(ms) && ms >= Date.UTC(2000, 0, 1) && ms < Date.UTC(2100, 0, 1) ? new Date(ms).toISOString() : null;
}
export function matchFixture(event, fixtures) {
  if (!LEAGUES.includes(event.league) || !safeName(event.home) || !safeName(event.away) || !timestamp(event.kickoff)) return null;
  if (canonicalName(event.home) === canonicalName(event.away)) return null;
  const candidates = fixtures.filter(f => f.league === event.league
    && canonicalName(f.home) === canonicalName(event.home) && canonicalName(f.away) === canonicalName(event.away)
    && Math.abs(Date.parse(f.kickoff) - Date.parse(event.kickoff)) <= 300_000);
  return candidates.length === 1 ? candidates[0] : null;
}
export function currentTime(value, nowISO, maxAge = 300_000) {
  const ms = isoMillis(value), now = isoMillis(nowISO);
  return Number.isFinite(ms) && ms <= now && now - ms <= maxAge;
}
export function baseObservation(fixture, provider, eventId, nowISO, evidenceUrl) {
  return { fixtureId: fixture.id, fixtureSnapshot: Object.fromEntries(['id', 'league', 'home', 'away', 'kickoff', 'source'].map(k => [k, fixture[k]])),
    provider, providerMatchId: String(eventId), observedAt: nowISO, evidenceUrl,
    period: 'full-time', inPlay: false, formalEligible: false };
}
export function impliedProbabilities(outcomes) {
  const total = outcomes.reduce((sum, row) => sum + 1 / row.decimalOdds, 0);
  return Object.fromEntries(outcomes.map(row => [row.selection, (1 / row.decimalOdds) / total]));
}
export const diagnostic = (id, nowISO, values = {}) => ({ id, sourceId: id, checkedAt: nowISO,
  status: 'complete', code: 'ok', matchedCount: 0, ...values });
