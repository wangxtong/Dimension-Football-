import { digest, fixtureKey, basicScreen, evaluateFixture, retainedEvidence, isoMillis, DEFAULT_POLICY } from './policy.mjs';
import { acquireLock, readState, atomicJson } from './storage.mjs';
import { writeReports } from './report.mjs';
import { publicSourceHealth } from './sources/manager.mjs';
import { CRAWLER_CODES } from './sources/crawler.mjs';
import { PUBLIC_FIXTURE_SOURCES } from './sources/public-fixtures.mjs';
import { buildForecasts, finalizeForecasts } from './forecast.mjs';
import { reconcileMarketEvidence, marketReadiness } from './market-evidence.mjs';
import { prepareAcquiredPool } from './data/acquisition-snapshot.mjs';
import { prepareForecastHistory } from './forecast.mjs';

// Persist only diagnostic metadata, never headers, response bodies or thrown messages.
export function safeDiagnostics(rows = []) {
  return rows.map(row => ({
    id: /^[A-Za-z0-9_.:-]{1,80}$/.test(row.id || '') ? row.id : 'source',
    status: ['available', 'complete', 'partial', 'pending', 'unavailable', 'failed', 'restricted', 'not_implemented', 'simulated'].includes(row.status) ? row.status : 'unavailable',
    code: /^[A-Za-z0-9_.:-]{1,100}$/.test(row.code || row.note || '') ? (row.code || row.note) : 'SOURCE_STATUS_UNKNOWN',
    checkedAt: Number.isFinite(isoMillis(row.checkedAt)) ? row.checkedAt : null,
    league: /^[A-Z0-9]{1,8}$/.test(row.league || '') ? row.league : null,
    httpStatus: Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599 ? row.httpStatus : null,
    responseAt: Number.isFinite(isoMillis(row.responseAt)) ? row.responseAt : null,
    matchedCount: Number.isSafeInteger(row.matchedCount) && row.matchedCount >= 0 ? row.matchedCount : 0,
    ...Object.fromEntries(['parsedCount', 'scheduleParsedCount', 'requestedFixtureCount', 'eligibleFixtureCount', 'unmatchedFixtureCount',
      'receivedCount', 'rejectedCount', 'historyCount', 'historyRejectedCount']
      .filter(key => Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 3000).map(key => [key, row[key]])),
    ...Object.fromEntries(['sourceUpdatedAt', 'scheduleUpdatedAt', 'scheduleCoverageFrom', 'scheduleCoverageTo', 'fetchedAt', 'nextProbeAt']
      .filter(key => Number.isFinite(isoMillis(row[key]))).map(key => [key, row[key]])),
    ...(Number.isSafeInteger(row.retryAfterMs) && row.retryAfterMs >= 0 ? { retryAfterMs: row.retryAfterMs } : {}),
    ...(['history', 'fixtures'].includes(row.purpose) ? { purpose: row.purpose } : {}),
    ...(typeof row.historyRequested === 'boolean' ? { historyRequested: row.historyRequested } : {}),
    ...(typeof row.cacheHit === 'boolean' ? { cacheHit: row.cacheHit } : {}),
    ...(typeof row.season === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,79}$/.test(row.season) ? { season: row.season } : {}),
  }));
}

const marketDiagnosticCodes = new Set(['fixture_ineligible', 'fixture_identity_unmatched', 'fixture_identity_ambiguous',
  'not_prematch', 'market_not_published', 'market_ambiguous', 'invalid_market_fields', 'incomplete_market',
  'quote_expired', 'quote_validation_failed', 'matched', 'access_denied', 'authorization_required', 'rate_limited', 'http_unavailable',
  ...CRAWLER_CODES, 'stale_snapshot', 'empty_snapshot', 'snapshot_too_large', 'timeout', 'network_unavailable', 'invalid_schedule',
  'invalid_snapshot', 'maintenance']);
const marketCompanies = { m88: ['M88', 17], '12bet': ['12Bet', 24], sbobet: ['SBOBET', 31], hkjc: ['HKJC', null] };

// Keep per-fixture failure facts before the adapter discards unusable prices.
// Provider bodies, URLs, arbitrary error text and credentials are never retained.
export function safeMarketDiagnostics(rows = [], fixtures = []) {
  if (!Array.isArray(rows)) return [];
  const ids = new Set(fixtures.map(f => f.id));
  return rows.slice(0, 9000).filter(row => row && ids.has(row.fixtureId) && Object.hasOwn(marketCompanies, row.id)).map(row => {
    const [bookmaker, companyId] = marketCompanies[row.id], code = row.code || row.note;
    return {
      ...safeDiagnostics([{ ...row, code: marketDiagnosticCodes.has(code) ? code : 'SOURCE_STATUS_UNKNOWN' }])[0],
      fixtureId: row.fixtureId, sourceId: row.id === 'hkjc' ? 'hkjc' : 'titan007', bookmaker, companyId,
      ...Object.fromEntries(['leagueCandidateCount', 'teamCandidateCount', 'scheduleCandidateCount', 'marketRowCount']
        .filter(key => Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 3000).map(key => [key, row[key]])),
    };
  });
}

const LIMITATIONS = [
  '赛程支持 football-data.org、API-Football、Sportmonks；公开证据沿用 Titan007 / Statarea。配置凭据后增加 Sportmonks 模型、The Odds API 市场参考及 iSports 当日亚洲盘。',
  'M88、12bet、SBOBET 在 Titan007 的展示合计只算一个独立来源；HKJC 官方 HDC 为另一组。逐场仍需两组同方向同盘口报价及真实初盘。',
  '赛前胜平负、预期进球和比分参考来自历史比分泊松基线，独立于严格盘口筛选；未做概率校准，不承诺命中率。',
  '报告通过独立发布步骤更新网站数据；Telegram 仅配置凭据后发送通知，不调用投注或结算接口。',
  '商业赔率参考不自动增加独立报价票；初盘时间和上游独立性未核实前，不进入正式亚洲盘候选。',
];

export async function runCollection({
  fixtures, statePath, outDir, collectEvidence, policy = DEFAULT_POLICY, simulated = false,
  fixtureDiagnostics = [], poolComplete = true, sourceManagement = null, importedEvidence = { quotes: [], signals: [] }, history = [],
  coverage = [], codeVersion = null, prospectiveEvaluation = null,
  clock = () => new Date().toISOString(), monotonic = () => performance.now(), startedTick = monotonic(),
  checkpoint = atomicJson, signal,
}) {
  if (!simulated && fixtures.some(f => ['simulation', 'owner-supplied-example'].includes(f.source))) throw new Error('EXAMPLE_FIXTURES_REQUIRE_DEMO');
  const pool = prepareAcquiredPool(fixtures, policy), startedAt = clock(), release = await acquireLock(statePath);
  if (pool.conflicts.length) {
    poolComplete = false;
    fixtureDiagnostics = [...fixtureDiagnostics, { id: 'data-identity', status: 'partial', code: 'logical_fixture_conflict', checkedAt: startedAt, rejectedCount: pool.rejected }];
  }
  const deadline = startedTick + policy.budgetMs;
  const remaining = () => signal?.aborted ? 0 : Math.max(0, deadline - monotonic());
  try {
    const state = await readState(statePath, simulated), policyHash = digest(policy);
    // Statistical forecasts do not wait for an optional odds website to respond.
    const initialForecasts = buildForecasts({ fixtures: pool.fixtures, history, nowISO: startedAt, policy, simulated, remaining });
    // Full-pool basic screening happens before slow network collection.
    for (const fixture of pool.fixtures) {
      const key = fixtureKey(fixture), old = state.entries[key], result = basicScreen(fixture, startedAt, policy);
      const archive = { openingRecords: old?.openingRecords || [], marketHistory: old?.marketHistory || [] };
      if (result) state.entries[key] = { fixture, result, checkedAt: startedAt, nextReviewAt: null, evidenceHash: null, ...archive };
      else if (!old || state.policyHash !== policyHash) {
        state.entries[key] = { fixture, result: { status: 'pending', reasons: [] }, checkedAt: null, nextReviewAt: null, evidenceHash: null, ...archive };
      } else old.fixture = fixture;
    }
    state.policyHash = policyHash;
    // Bound retained history; current pool is always retained, even outside the normal horizon.
    const currentKeys = new Set(pool.fixtures.map(fixtureKey));
    for (const key of Object.keys(state.entries)) if (!currentKeys.has(key) && isoMillis(state.entries[key]?.fixture?.kickoff) < isoMillis(startedAt) - 7 * 86_400_000) delete state.entries[key];
    state.currentPool = [...currentKeys];
    await checkpoint(statePath, state);
    let evidence = { quotes: [], signals: [], diagnostics: [] }, sourceFailed = false;
    const eligible = pool.fixtures.filter(f => !basicScreen(f, startedAt, policy));
    if (eligible.length && remaining() > 0) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining());
      try {
        evidence = await collectEvidence({ fixtures: eligible, nowISO: clock(), signal: controller.signal });
        if (!evidence || !Array.isArray(evidence.quotes) || !Array.isArray(evidence.signals) || !Array.isArray(evidence.diagnostics)
          || evidence.marketStates !== undefined && !Array.isArray(evidence.marketStates)) throw new Error('EVIDENCE_SCHEMA_INVALID');
      } catch { sourceFailed = true; evidence = { quotes: [], signals: [], diagnostics: [{ id: 'collection', status: 'failed', code: controller.signal.aborted ? 'BUDGET_EXHAUSTED' : 'SOURCE_COLLECTION_FAILED', checkedAt: clock() }] }; }
      finally { clearTimeout(timer); }
    }
    evidence.quotes.push(...(evidence.marketStates || []), ...importedEvidence.quotes);
    evidence.signals.push(...importedEvidence.signals);
    for (const fixture of eligible) {
      const entry = state.entries[fixtureKey(fixture)];
      const merged = reconcileMarketEvidence(fixture, evidence.quotes.filter(q => q?.fixtureId === fixture.id), entry.openingRecords, clock(), policy);
      entry.openingRecords = merged.records;
      evidence.quotes = [...evidence.quotes.filter(q => q?.fixtureId !== fixture.id), ...merged.quotes];
    }
    const marketDiagnostics = safeMarketDiagnostics(evidence.fixtureDiagnostics, eligible), marketDiagnosticIndex = new Map();
    for (const row of marketDiagnostics) {
      const values = marketDiagnosticIndex.get(row.fixtureId) || []; values.push(row); marketDiagnosticIndex.set(row.fixtureId, values);
    }
    const quoteIndex = new Map(), signalIndex = new Map();
    for (const [rows, index] of [[evidence.quotes, quoteIndex], [evidence.signals, signalIndex]]) for (const row of rows) {
      const values = index.get(row?.fixtureId) || []; values.push(row); index.set(row?.fixtureId, values);
    }
    const queue = eligible.map(fixture => ({ fixture, entry: state.entries[fixtureKey(fixture)] }))
      .sort((a, b) => Number(a.entry.result.status !== 'pending') - Number(b.entry.result.status !== 'pending')
        || (isoMillis(a.entry.checkedAt) || 0) - (isoMillis(b.entry.checkedAt) || 0));
    let processed = 0, reused = 0;
    for (const { fixture, entry } of queue) {
      if (remaining() <= 0) { entry.result = { status: 'pending', reasons: ['BUDGET_EXHAUSTED'] }; continue; }
      const now = clock(), rows = { quotes: quoteIndex.get(fixture.id) || [], signals: signalIndex.get(fixture.id) || [] };
      entry.marketDiagnostics = marketDiagnosticIndex.get(fixture.id) || [];
      const hash = digest({ rows, identity: fixtureKey(fixture), status: fixture.status, policyHash });
      if (entry.result.status !== 'pending' && entry.evidenceHash === hash && isoMillis(entry.nextReviewAt) > isoMillis(now)) { reused++; continue; }
      const result = evaluateFixture(fixture, rows, now, policy);
      if (simulated && result.status === 'candidate') result.status = 'simulated_candidate';
      const next = Math.min(isoMillis(now) + policy.maxQuoteAgeMs, isoMillis(fixture.kickoff));
      Object.assign(entry, { fixture, result, lastEvidence: retainedEvidence(fixture, rows, now, policy),
        evidenceHash: hash, checkedAt: now, nextReviewAt: new Date(next).toISOString() });
      processed++;
      await checkpoint(statePath, state);
    }
    // A long run must not publish a candidate whose evidence expired while other matches were checked.
    const completedAt = clock();
    for (const fixture of pool.fixtures) {
      const entry = state.entries[fixtureKey(fixture)];
      if (!['candidate', 'simulated_candidate'].includes(entry.result.status)) continue;
      const result = evaluateFixture(fixture, { quotes: quoteIndex.get(fixture.id) || [], signals: signalIndex.get(fixture.id) || [] }, completedAt, policy);
      if (simulated && result.status === 'candidate') result.status = 'simulated_candidate';
      entry.result = result;
    }
    const forecasts = finalizeForecasts(initialForecasts, pool.fixtures, completedAt, policy);
    const forecastMap = new Map(forecasts.rows.map(row => [row.fixtureId, row]));
    const results = pool.fixtures.map(fixture => {
      const entry = state.entries[fixtureKey(fixture)];
      entry.forecast = forecastMap.get(fixture.id);
      entry.marketReadiness = marketReadiness(fixture, quoteIndex.get(fixture.id) || [], completedAt, policy);
      const { quotes: snapshotQuotes, ...readiness } = entry.marketReadiness;
      const snapshot = { ...readiness, quoteHash: digest(snapshotQuotes), meaning: 'collection-observation-not-provider-opening' };
      entry.marketHistory = [...(entry.marketHistory || []).slice(-23), snapshot];
      return { fixture, ...entry };
    });
    const count = status => results.filter(row => row.result.status === status).length;
    const diagnostics = safeDiagnostics([...fixtureDiagnostics, ...evidence.diagnostics]);
    const hasSourceIssue = diagnostics.some(d => ['failed', 'unavailable', 'partial', 'restricted', 'not_implemented'].includes(d.status));
    const summary = { total: results.length, basicScreened: results.length, duplicates: pool.duplicates, processed, reused, pending: count('pending'),
      candidates: count('candidate'), simulatedCandidates: count('simulated_candidate'), avoid: count('avoid'), sourceInsufficient: count('source_insufficient'),
      forecasts: forecasts.summary.forecasts, forecastUnavailable: forecasts.summary.unavailable };
    const report = { version: 1, task: '维度足球长期公开信息采集', simulated, timezone: 'Asia/Shanghai', startedAt, completedAt,
      poolComplete, status: sourceFailed ? 'failed' : summary.pending || hasSourceIssue || !poolComplete ? 'partial' : 'complete',
      summary, diagnostics, marketDiagnostics, results, limitations: LIMITATIONS, policy, coverage,
      identityConflicts: pool.conflicts, prospectiveEvaluation,
      forecasts,
      publicFixtureSources: PUBLIC_FIXTURE_SOURCES.filter(source => pool.fixtures.some(fixture => fixture.source === source.id)),
      crawler: evidence.crawler || null,
      providers: evidence.providers ? { ...evidence.providers, observations: evidence.providers.observations.map(row => ({ ...row,
        currentAtPublication: Date.parse(row.validUntil) > Date.parse(completedAt) })) } : null,
      sourceManagement: sourceManagement ? { ...sourceManagement, publicSources: publicSourceHealth(evidence.diagnostics) } : null,
      candidates: simulated ? [] : results.filter(row => row.result.status === 'candidate') };
    state.runs = [...state.runs.slice(-49), { startedAt, completedAt, status: report.status, summary }];
    await checkpoint(statePath, state);
    const files = await writeReports(report, outDir, { history: prepareForecastHistory(history).matches, codeVersion, clock });
    return { report, files };
  } finally { await release(); }
}
