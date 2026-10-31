const choices = { home: '主胜', draw: '平局', away: '客胜' };
export const MAX_REPORT_FIXTURES = 3000;
// One actual lead time per fixture plus four reference horizons per source/league group.
export const MAX_REPORT_BACKTESTS = MAX_REPORT_FIXTURES * 5;
// Must match the existing Worker feed's decoded UTF-8 response budget.
export const MAX_REPORT_BUNDLE_BYTES = 4_000_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 300) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const number = (value, min = 0, max = 1e9) => Number.isFinite(value) && value >= min && value <= max;
const integer = (value, max = 1e9) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const list = (value, check, max = 100) => Array.isArray(value) && value.length <= max && value.every(check);
const strings = value => list(value, v => text(v));
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const https = value => {
  if (!text(value, 2048)) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
};
export function validDate(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour < 24 && minute < 60 && second < 60;
}
const optional = (row, key, check) => row[key] === undefined || row[key] === null || check(row[key]);
const metrics = m => object(m) && number(m.brier, 0, 2) && number(m.baselineBrier, 0, 2) && number(m.logLoss)
  && optional(m, 'baselineLogLoss', number) && optional(m, 'accuracy', n => number(n, 0, 1));
const counts = row => object(row) && Object.values(row).every(n => integer(n));
const quote = q => object(q) && text(q.sourceId) && text(q.bookmaker) && ['home', 'away'].includes(q.selection)
  && number(q.handicap, -10, 10) && Number.isInteger(q.handicap * 4) && number(q.decimalOdds, 1.000001, 21)
  && validDate(q.observedAt) && validDate(q.sourceUpdatedAt) && validDate(q.validUntil)
  && Date.parse(q.sourceUpdatedAt) <= Date.parse(q.observedAt) && Date.parse(q.validUntil) > Date.parse(q.observedAt) && https(q.evidenceUrl);
function validForecast(p) {
  if (!object(p) || !['forecast', 'unavailable'].includes(p.status) || !strings(p.reasons)
    || !optional(p, 'sample', counts) || !optional(p, 'generatedAt', validDate)) return false;
  if (p.status !== 'forecast') return p.reasons.length > 0;
  const probabilities = p.probabilities;
  return object(probabilities) && Object.keys(choices).every(key => number(probabilities[key], 0, 1))
    && Math.abs(Object.keys(choices).reduce((sum, key) => sum + probabilities[key], 0) - 1) <= 0.00001
    && (p.selection === null || Object.hasOwn(choices, p.selection))
    && object(p.expectedGoals) && ['home', 'away'].every(key => number(p.expectedGoals[key], 0, 100))
    && counts(p.sample) && integer(p.sample.home) && integer(p.sample.away)
    && list(p.topScores, s => object(s) && integer(s.home, 100) && integer(s.away, 100) && number(s.probability, 0, 1), 100)
    && object(p.freshness) && validDate(p.freshness.validUntil)
    && ['generatedAt', 'fixtureFetchedAt', 'fixtureSourceUpdatedAt'].every(key => optional(p.freshness, key, validDate))
    && object(p.completeness) && integer(p.completeness.total) && integer(p.completeness.passed, p.completeness.total)
    && object(p.strength) && number(p.strength.homeAttack) && number(p.strength.awayAttack)
    && object(p.validation) && integer(p.validation.evaluated) && integer(p.validation.skipped)
    && optional(p.validation, 'metrics', metrics);
}
function validMarket(m, fixture) {
  if (!object(m) || !['pending', 'candidate', 'avoid', 'source_insufficient'].includes(m.status)
    || !optional(m, 'reasons', strings)) return false;
  if (m.readiness != null && (!object(m.readiness) || !strings(m.readiness.quoteGroups)
    || !integer(m.readiness.verifiedOpeningCount) || !strings(m.readiness.blockers)
    || !optional(m.readiness, 'checkedAt', validDate) || !optional(m.readiness, 'quotes', rows => list(rows, quote)))) return false;
  if (m.status !== 'candidate') return m.candidate == null;
  const c = m.candidate, o = c?.opening;
  return object(c) && ['home', 'away'].includes(c.selection) && number(c.handicap, -10, 10) && Number.isInteger(c.handicap * 4)
    && number(c.decimalOdds, 1.000001, 21) && strings(c.quoteGroups) && new Set(c.quoteGroups).size >= 2
    && list(c.quotes, quote) && c.quotes.length >= 2 && c.quotes.every(q => q.selection === c.selection && q.handicap === c.handicap)
    && c.requiresReview === true && object(o) && o.basis === 'provider-opening' && o.fixtureId === fixture.id
    && o.selection === c.selection && o.handicap === c.handicap && number(o.decimalOdds, 1.000001, 21)
    && validDate(o.observedAt) && validDate(o.recordedAt) && Date.parse(o.observedAt) <= Date.parse(o.recordedAt)
    && Date.parse(o.observedAt) < Date.parse(fixture.kickoff) && https(o.evidenceUrl)
    && c.quotes.some(q => q.sourceId === o.sourceId && q.bookmaker === o.bookmaker && Date.parse(o.observedAt) < Date.parse(q.observedAt));
}
export function validateReport(data) {
  const valid = object(data) && data.version === 1 && data.kind === 'prematch-forecast-report' && data.simulated === false
    && validDate(data.generatedAt) && id(data.publication?.reportId) && object(data.summary)
    && list(data.fixtures, row => object(row) && object(row.fixture) && text(row.fixture.id) && text(row.fixture.league)
      && text(row.fixture.home) && text(row.fixture.away) && validDate(row.fixture.kickoff)
      && optional(row.fixture, 'status', v => text(v)) && validForecast(row.forecast) && validMarket(row.marketCandidate, row.fixture), MAX_REPORT_FIXTURES)
    && integer(data.summary.fixtures, MAX_REPORT_FIXTURES) && data.summary.fixtures === data.fixtures.length
    && Object.values(data.summary).every(n => integer(n, MAX_REPORT_FIXTURES))
    && new Set(data.fixtures.map(row => row.fixture.id)).size === data.fixtures.length
    && list(data.backtests, b => object(b) && text(b.league) && integer(b.evaluated) && integer(b.skipped) && optional(b, 'metrics', metrics), MAX_REPORT_BACKTESTS)
    && list(data.attribution, a => object(a) && text(a.name) && text(a.license) && https(a.url));
  if (!valid) throw Error('REPORT_SCHEMA_INVALID');
  return data;
}
const channelStatuses = ['generating', 'pending', 'published', 'accepted', 'failed', 'not_configured', 'not_attempted', 'skipped', 'unknown'];
export function validateReceipt(value, report, expectedReportHash) {
  if (!object(value) || value.version !== 1 || value.simulated !== false || value.reportId !== report.publication.reportId
    || !validDate(value.generatedAt) || Date.parse(value.generatedAt) !== Date.parse(report.generatedAt)
    || !object(value.channels) || Object.keys(value.channels).length > 20
    || !['files', 'githubArtifact', 'externalWebsite', 'notifications'].every(key => object(value.channels[key]))
    || !Object.values(value.channels).every(c => object(c) && channelStatuses.includes(c.status)
      && optional(c, 'checkedAt', validDate) && optional(c, 'url', https)
      // Channel receipts are evidence about this report, never a different report.
      && optional(c, 'reportId', channelId => channelId === value.reportId)
      && optional(c, 'reportHash', channelHash => id(channelHash)
        && (typeof expectedReportHash !== 'string' || channelHash === expectedReportHash)))) throw Error('RECEIPT_SCHEMA_INVALID');
  return value;
}
export function validateBundle(value) {
  if (!object(value) || value.version !== 1 || !id(value.reportId) || value.reportId !== value.report?.publication?.reportId
    || !Object.hasOwn(value, 'receipt') || !optional(value, 'reportHash', id)
    || !optional(value, 'freshness', object) || !optional(value, 'health', object)) throw Error('SNAPSHOT_SCHEMA_INVALID');
  const report = validateReport(value.report);
  if (value.receipt !== null) validateReceipt(value.receipt, report, value.reportHash);
  return value;
}
