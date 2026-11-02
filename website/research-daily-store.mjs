import { bucketPutCAS } from './hosted-publications.mjs';

const ID = /^[a-f0-9]{64}$/, SHA = /^[a-f0-9]{40}$/;
// 'football-data.org' 才是采集端写入 fixture.source 的真实值；只认 'football-data'
// 会让该来源的比赛在研究日报里整批被跳过（每天表现为 0 场）。
const SOURCES = new Set(['openligadb', 'thesportsdb-free', 'api-football', 'football-data', 'football-data.org']);
const LEAGUES = new Set(['PL', 'PD', 'SA', 'BL1', 'FL1']);
const KEYS = 'beijingDay,codeSha,commercialReleaseGate,disclaimer,externalTelegramSent,forecasts,generatedAt,kind,limitations,mode,prospective,reportId,researchGate,sourceReportId,sourceReportSha256,state,strictMarkets,version';
const MIN_REPORT_BYTES = 150;
const MAX_REPORT_BYTES = 750_000;
const goodTime = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const count = v => Number.isSafeInteger(v) && v >= 0;
const prob = v => Number.isFinite(v) && v >= 0 && v <= 1;
const fail = (code, status = 400) => { const error = new Error(code); error.code = code; error.status = status; throw error; };
const stamp = value => new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10);
const sha = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))))]
  .map(x => x.toString(16).padStart(2, '0')).join('');
const validStats = row => row && [row.eligibleFrozen, row.scored, row.pending, row.voided].every(count)
  && row.eligibleFrozen === row.scored + row.pending + row.voided
  && (row.scored ? prob(row.hitRate) && Number.isFinite(row.brier) && row.brier >= 0 && row.brier <= 2
    && Number.isFinite(row.logLoss) && row.logLoss >= 0 : row.hitRate === null && row.brier === null && row.logLoss === null)
  && Number.isSafeInteger(row.days) && row.days >= 1 && row.days <= 30
  && /^\d{4}-\d\d-\d\d$/.test(row.fromDay) && /^\d{4}-\d\d-\d\d$/.test(row.toDay)
  && ['descriptive-only', 'insufficient-prospective-sample'].includes(row.sampleStatus);

export async function validateDailyResearch(report, { now = Date.now(), fresh = false } = {}) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || Object.keys(report).sort().join(',') !== KEYS
    || JSON.stringify(report).length > MAX_REPORT_BYTES || JSON.stringify(report).length < MIN_REPORT_BYTES
    || report.version !== 1 || report.kind !== 'research-daily-1x2'
    || report.mode !== 'research-reference' || report.researchGate !== 'INDEPENDENT_OF_COMMERCIAL'
    || report.commercialReleaseGate !== 'BLOCKED' || report.externalTelegramSent !== false
    || typeof report.disclaimer !== 'string' || !report.disclaimer.includes('非投注建议') || report.disclaimer.length > 500
    || !SHA.test(report.codeSha || '') || !goodTime(report.generatedAt)
    || stamp(report.generatedAt) !== report.beijingDay || !ID.test(report.reportId || '')
    || (report.sourceReportId !== null && !ID.test(report.sourceReportId || ''))
    || (report.sourceReportSha256 !== null && !ID.test(report.sourceReportSha256 || ''))
    || !report.forecasts || !count(report.forecasts.total) || !Array.isArray(report.forecasts.candidates)
    || report.forecasts.total !== report.forecasts.candidates.length || !count(report.forecasts.skipped)
    || report.forecasts.isPublishedRecommendation !== false
    || !['no-today-source-report','ledger-not-restored','zero-qualified-forecasts','frozen-research-forecasts'].includes(report.state)
    || !report.strictMarkets || report.strictMarkets.releasedCandidates !== 0 || report.strictMarkets.reviewed !== false
    || !['independent-dual-source-and-provider-opening'].includes(report.strictMarkets.separation)
    || !report.prospective || report.prospective.provenance !== 'immutable-prematch-ledger-plus-observed-full-time'
    || !count(report.prospective.retainedFrozen) || !validStats(report.prospective.oneDay)
    || !validStats(report.prospective.sevenDays) || !validStats(report.prospective.thirtyDays)
    || !Array.isArray(report.prospective.byLeague30Days) || report.prospective.byLeague30Days.length !== 5
    || !report.prospective.byLeague30Days.every(row => LEAGUES.has(row.league) && validStats(row))
    || !Array.isArray(report.limitations) || report.limitations.length > 16 || !report.limitations.every(s => typeof s === 'string' && s.length < 500))
    fail('RESEARCH_REPORT_INVALID');
  if (report.forecasts.total > 3000 || report.state !== 'frozen-research-forecasts' && report.forecasts.total > 0
    || report.forecasts.total > 0 && !report.sourceReportId) fail('RESEARCH_REPORT_INVALID');
  const seen = new Set();
  for (const row of report.forecasts.candidates) {
    if (!row || !SOURCES.has(row.source) || !LEAGUES.has(row.league) || !ID.test(row.predictionId || '')
      || !ID.test(row.modelHash || '') || !ID.test(row.trainingHash || '')
      || row.sourceReportId !== report.sourceReportId || typeof row.fixtureId !== 'string' || !row.fixtureId || row.fixtureId.length > 160
      || typeof row.home !== 'string' || row.home.length > 200 || typeof row.away !== 'string' || row.away.length > 200
      || !goodTime(row.kickoff) || !goodTime(row.recordedAt) || Date.parse(row.recordedAt) >= Date.parse(row.kickoff)
      || Date.parse(row.recordedAt) > Date.parse(report.generatedAt)
      || row.calibrated !== false || typeof row.modelId !== 'string' || !count(row.modelVersion)
      || !['home','draw','away'].includes(row.selection) || !row.probabilities
      || !['home','draw','away'].every(k => prob(row.probabilities[k]))
      || Math.abs(row.probabilities.home + row.probabilities.draw + row.probabilities.away - 1) > 1e-6)
      fail('RESEARCH_FORECAST_INVALID');
    const key = row.source + ':' + row.fixtureId;
    if (seen.has(key)) fail('RESEARCH_DUPLICATE_FIXTURE');
    seen.add(key);
  }
  const withoutId = { ...report }; delete withoutId.reportId;
  if (await sha(withoutId) !== report.reportId) fail('RESEARCH_REPORT_HASH_MISMATCH', 409);
  if (fresh && (Date.parse(report.generatedAt) > now + 60_000 || now - Date.parse(report.generatedAt) > 3600_000))
    fail('RESEARCH_REPORT_STALE', 409);
  return report;
}

async function getObject(env, key) {
  if (!env.BUCKET?.get || !env.BUCKET?.put) fail('RESEARCH_STORAGE_UNAVAILABLE', 503);
  const value = await env.BUCKET.get(key);
  if (!value) return null;
  if (value.size > MAX_REPORT_BYTES + 2000 || typeof value.etag !== 'string') fail('RESEARCH_STORAGE_INVALID', 503);
  try { return { data: JSON.parse(await value.text()), etag: value.etag }; }
  catch { fail('RESEARCH_STORAGE_INVALID', 503); }
}
const reportPath = id => 'research-daily/reports/' + id + '.json';
const pointerPath = 'research-daily/current.json';

export async function saveDailyResearch(env, report, { now = Date.now() } = {}) {
  await validateDailyResearch(report, { now, fresh: true });
  const key = reportPath(report.reportId);
  const inserted = await bucketPutCAS(env, key, report);
  const stored = await getObject(env, key);
  if (!stored || await sha(stored.data) !== await sha(report)) fail('RESEARCH_REPORT_CONFLICT', 409);
  if (!inserted && stored.data.reportId !== report.reportId) fail('RESEARCH_REPORT_CONFLICT', 409);
  for (let i = 0; i < 4; i++) {
    const prior = await getObject(env, pointerPath);
    if (prior && (!ID.test(prior.data?.reportId || '') || !goodTime(prior.data?.generatedAt))) fail('RESEARCH_STORAGE_INVALID', 503);
    if (prior && Date.parse(prior.data.generatedAt) > Date.parse(report.generatedAt)) fail('RESEARCH_REPORT_ORDER_CONFLICT', 409);
    if (prior && prior.data.reportId === report.reportId) return { version: 1, status: 'research-available',
      reportId: report.reportId, beijingDay: report.beijingDay, sha256: report.reportId, commercialReleaseGate: 'BLOCKED' };
    const pointer = { version: 1, reportId: report.reportId, generatedAt: report.generatedAt,
      beijingDay: report.beijingDay };
    if (await bucketPutCAS(env, pointerPath, pointer, prior?.etag || null))
      return { version: 1, status: 'research-available', reportId: report.reportId, beijingDay: report.beijingDay,
        sha256: report.reportId, commercialReleaseGate: 'BLOCKED' };
  }
  fail('RESEARCH_POINTER_CONFLICT', 409);
}

const MAX_PANEL_CANDIDATES = 120;
const panelStats = row => ({ days: row.days, fromDay: row.fromDay, toDay: row.toDay,
  eligibleFrozen: row.eligibleFrozen, scored: row.scored, pending: row.pending, voided: row.voided,
  hitRate: row.hitRate, brier: row.brier, logLoss: row.logLoss, sampleStatus: row.sampleStatus });
const panelCandidate = row => row && LEAGUES.has(row.league) && SOURCES.has(row.source)
  && typeof row.home === 'string' && row.home.length <= 200 && typeof row.away === 'string' && row.away.length <= 200
  && goodTime(row.kickoff) && ['home', 'draw', 'away'].includes(row.selection) && row.probabilities
  && ['home', 'draw', 'away'].every(key => prob(row.probabilities[key]));

/** Read-only projection of an already-validated research report for presentation.
 * It carries no release authority: callers must keep the BLOCKED / 非投注建议 wording.
 * Returns null instead of guessing when any displayed statistic is malformed. */
export function researchPanelData(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.version !== 1 || report.kind !== 'research-daily-1x2' || report.mode !== 'research-reference'
    || report.researchGate !== 'INDEPENDENT_OF_COMMERCIAL' || report.commercialReleaseGate !== 'BLOCKED'
    || report.externalTelegramSent !== false || typeof report.disclaimer !== 'string'
    || !report.disclaimer.includes('非投注建议') || !ID.test(report.reportId || '')
    || !goodTime(report.generatedAt) || typeof report.beijingDay !== 'string'
    || !report.forecasts || !count(report.forecasts.total) || !Array.isArray(report.forecasts.candidates)
    || report.forecasts.total !== report.forecasts.candidates.length
    || report.forecasts.isPublishedRecommendation !== false || !count(report.forecasts.skipped)
    || !report.strictMarkets || report.strictMarkets.releasedCandidates !== 0
    || !report.prospective || !count(report.prospective.retainedFrozen)
    || ![report.prospective.oneDay, report.prospective.sevenDays, report.prospective.thirtyDays].every(validStats)
    || !Array.isArray(report.prospective.byLeague30Days) || report.prospective.byLeague30Days.length !== 5
    || !report.prospective.byLeague30Days.every(row => row && LEAGUES.has(row.league) && validStats(row))
    || !report.forecasts.candidates.every(panelCandidate)) return null;
  const candidates = report.forecasts.candidates.slice(0, MAX_PANEL_CANDIDATES).map(row => ({
    source: row.source, league: row.league, home: row.home, away: row.away, kickoff: row.kickoff,
    recordedAt: row.recordedAt, selection: row.selection,
    probabilities: { home: row.probabilities.home, draw: row.probabilities.draw, away: row.probabilities.away } }));
  const { oneDay, sevenDays, thirtyDays, byLeague30Days } = report.prospective;
  return { reportId: report.reportId, generatedAt: report.generatedAt, beijingDay: report.beijingDay,
    state: report.state, disclaimer: report.disclaimer, total: report.forecasts.total,
    skipped: report.forecasts.skipped, shown: candidates.length, truncated: report.forecasts.total > candidates.length,
    candidates,
    prospective: { retainedFrozen: report.prospective.retainedFrozen,
      provenance: report.prospective.provenance, uniqueFixtureRule: report.prospective.uniqueFixtureRule,
      oneDay: panelStats(oneDay), sevenDays: panelStats(sevenDays), thirtyDays: panelStats(thirtyDays),
      byLeague30Days: byLeague30Days.map(row => ({ league: row.league, ...panelStats(row) })) } };
}

export async function readDailyResearch(env) {
  const pointer = await getObject(env, pointerPath);
  if (!pointer) return null;
  if (!ID.test(pointer.data?.reportId || '') || pointer.data?.version !== 1) fail('RESEARCH_STORAGE_INVALID', 503);
  const record = await getObject(env, reportPath(pointer.data.reportId));
  if (!record) fail('RESEARCH_STORAGE_INVALID', 503);
  try { await validateDailyResearch(record.data); }
  catch { fail('RESEARCH_STORAGE_INVALID', 503); }
  if (record.data.beijingDay !== pointer.data.beijingDay || record.data.generatedAt !== pointer.data.generatedAt)
    fail('RESEARCH_STORAGE_INVALID', 503);
  return record.data;
}
