import { digest, fixtureKey, preparePool, basicScreen, evaluateFixture, retainedEvidence, isoMillis, DEFAULT_POLICY } from './policy.mjs';
import { acquireLock, readState, atomicJson } from './storage.mjs';
import { writeReports } from './report.mjs';

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
  }));
}

const LIMITATIONS = [
  '内置自动解析：football-data.org 五大联赛赛程、Titan007 的 M88/12bet/SBOBET 亚洲盘、Statarea 胜平负辅助；其他站点尚未自动解析。',
  'M88、12bet、SBOBET 在 Titan007 的展示合计只算一个独立网站来源。无第二报价源或初盘轨迹时保持来源不足。',
  '未把胜平负概率改写成亚洲盘赢盘率；不自动生成大小球或比分，也不承诺命中率。',
  '本项目不向旧站点写回、不冻结预测、不调用 Telegram、投注或结算接口。',
];

export async function runCollection({
  fixtures, statePath, outDir, collectEvidence, policy = DEFAULT_POLICY, simulated = false,
  fixtureDiagnostics = [], poolComplete = true, importedEvidence = { quotes: [], signals: [] },
  clock = () => new Date().toISOString(), monotonic = () => performance.now(), startedTick = monotonic(),
  checkpoint = atomicJson, signal,
}) {
  if (!simulated && fixtures.some(f => ['simulation', 'owner-supplied-example'].includes(f.source))) throw new Error('EXAMPLE_FIXTURES_REQUIRE_DEMO');
  const pool = preparePool(fixtures, policy), startedAt = clock(), release = await acquireLock(statePath);
  const deadline = startedTick + policy.budgetMs;
  const remaining = () => signal?.aborted ? 0 : Math.max(0, deadline - monotonic());
  try {
    const state = await readState(statePath, simulated), policyHash = digest(policy);
    // Full-pool basic screening happens before slow network collection.
    for (const fixture of pool.fixtures) {
      const key = fixtureKey(fixture), old = state.entries[key], result = basicScreen(fixture, startedAt, policy);
      if (result) state.entries[key] = { fixture, result, checkedAt: startedAt, nextReviewAt: null, evidenceHash: null };
      else if (!old || state.policyHash !== policyHash) {
        state.entries[key] = { fixture, result: { status: 'pending', reasons: [] }, checkedAt: null, nextReviewAt: null, evidenceHash: null };
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
        if (!evidence || !Array.isArray(evidence.quotes) || !Array.isArray(evidence.signals) || !Array.isArray(evidence.diagnostics)) throw new Error('EVIDENCE_SCHEMA_INVALID');
      } catch { sourceFailed = true; evidence = { quotes: [], signals: [], diagnostics: [{ id: 'collection', status: 'failed', code: controller.signal.aborted ? 'BUDGET_EXHAUSTED' : 'SOURCE_COLLECTION_FAILED', checkedAt: clock() }] }; }
      finally { clearTimeout(timer); }
    }
    evidence.quotes.push(...importedEvidence.quotes);
    evidence.signals.push(...importedEvidence.signals);
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
    const results = pool.fixtures.map(fixture => ({ fixture, ...state.entries[fixtureKey(fixture)] }));
    const count = status => results.filter(row => row.result.status === status).length;
    const diagnostics = safeDiagnostics([...fixtureDiagnostics, ...evidence.diagnostics]);
    const hasSourceIssue = diagnostics.some(d => ['failed', 'unavailable', 'partial', 'restricted', 'not_implemented'].includes(d.status));
    const summary = { total: results.length, basicScreened: results.length, duplicates: pool.duplicates, processed, reused, pending: count('pending'),
      candidates: count('candidate'), simulatedCandidates: count('simulated_candidate'), avoid: count('avoid'), sourceInsufficient: count('source_insufficient') };
    const report = { version: 1, task: '维度足球长期公开信息采集', simulated, timezone: 'Asia/Shanghai', startedAt, completedAt,
      poolComplete, status: sourceFailed ? 'failed' : summary.pending || hasSourceIssue || !poolComplete ? 'partial' : 'complete',
      summary, diagnostics, results, limitations: LIMITATIONS, policy,
      candidates: simulated ? [] : results.filter(row => row.result.status === 'candidate') };
    state.runs = [...state.runs.slice(-49), { startedAt, completedAt, status: report.status, summary }];
    await checkpoint(statePath, state);
    const files = await writeReports(report, outDir);
    return { report, files };
  } finally { await release(); }
}
