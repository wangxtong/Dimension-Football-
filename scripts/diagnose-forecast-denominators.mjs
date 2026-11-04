import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = x => createHash('sha256').update(x).digest('hex');
const count = rows => Object.fromEntries([...new Set(rows)].sort().map(x => [x, rows.filter(y => y === x).length]));
const validRows = x => Array.isArray(x) ? x : null;
const label = x => typeof x === 'string' && x.length <= 200 ? x : null;

/** Preserve every observed input, candidate and rejection. Do not use this audit to grant publication. */
export function diagnoseForecastDenominators({ sourceManifest = null, document = null, daily = null,
  nowISO = new Date().toISOString(), codeSha = null, evidenceHashes = {} } = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now) || codeSha !== null && !/^[a-f0-9]{40}$/.test(codeSha)) throw Error('AUDIT_ARGUMENT_INVALID');
  const sources = validRows(sourceManifest?.fixtures);
  const sourceDiagnostics = validRows(sourceManifest?.diagnostics);
  const predictions = validRows(document?.fixtures);
  const reportValid = daily?.forecasts && Number.isSafeInteger(daily.forecasts.total)
    && daily.forecasts.total >= 0 && typeof daily.reportId === 'string';
  const within36h = kickoff => {
    const t = Date.parse(kickoff);
    return Number.isFinite(t) && t > now && t <= now + 36 * 3600000;
  };
  const sourceRows = (sources || []).map(row => ({
    source: label(row?.source), league: label(row?.league), fixtureId: label(row?.id),
    home: label(row?.home), away: label(row?.away), kickoff: label(row?.kickoff),
    dueWithin36h: within36h(row?.kickoff) }));
  const forecastRows = (predictions || []).map((row, i) => {
    const f = row?.fixture, pred = row?.forecast, market = row?.marketCandidate;
    const reasons = validRows(pred?.reasons)?.filter(x => typeof x === 'string' && x.length < 120) || [];
    const marketReasons = validRows(market?.reasons)?.filter(x => typeof x === 'string' && x.length < 120) || [];
    return { index: i, source: label(f?.source), league: label(f?.league), fixtureId: label(f?.id),
      home: label(f?.home), away: label(f?.away), kickoff: label(f?.kickoff),
      dueWithin36h: within36h(f?.kickoff), forecastStatus: label(pred?.status) || 'NOT_RECORDED',
      forecastReasons: reasons.length ? reasons : pred?.status === 'forecast' ? [] : ['REASON_NOT_RECORDED'],
      marketStatus: label(market?.status) || 'NOT_RECORDED', marketReasons,
      historySample: pred?.sample && typeof pred.sample === 'object' && !Array.isArray(pred.sample)
        ? Object.fromEntries(Object.entries(pred.sample).filter(([k, v]) => typeof k === 'string' && Number.isFinite(v))) : null,
      validationStatus: label(pred?.validation?.status) }};
  });
  const rejected = forecastRows.filter(x => x.forecastStatus !== 'forecast');
  const accepted = forecastRows.filter(x => x.forecastStatus === 'forecast');
  const sourceKeys = new Set(sourceRows.map(x => JSON.stringify([x.source, x.fixtureId])));
  const modeledKeys = new Set(forecastRows.map(x => JSON.stringify([x.source, x.fixtureId])));
  const byLeague = [...new Set([...sourceRows, ...forecastRows].map(x => x.league).filter(Boolean))].sort().map(league => ({
    league, sourceInputs: sourceRows.filter(x => x.league === league).length,
    pipelineInputs: forecastRows.filter(x => x.league === league).length,
    modelForecast: accepted.filter(x => x.league === league).length,
    modelUnavailable: rejected.filter(x => x.league === league).length,
    within36h: forecastRows.filter(x => x.league === league && x.dueWithin36h).length }));
  const sourcesSummary = (sourceDiagnostics || []).map(row => ({
    id: label(row?.id), league: label(row?.league), stage: label(row?.stage),
    status: label(row?.status), code: label(row?.code || row?.note),
    httpStatus: Number.isInteger(row?.httpStatus) ? row.httpStatus : null,
    matchedCount: Number.isSafeInteger(row?.matchedCount) ? row.matchedCount : null }));
  const complete = sources !== null && sourceDiagnostics !== null && predictions !== null && reportValid;
  return {
    version: 1, kind: 'real-fixture-forecast-denominator-audit', scope: 'GITHUB_EPHEMERAL_RESEARCH_ONLY',
    status: complete ? (document?.simulated === false ? 'EVIDENCE_OBSERVED_NONCOMMERCIAL' : 'SIMULATED_OR_UNVERIFIED_INPUT')
      : 'INCOMPLETE_EVIDENCE_NOT_ZERO_QUALIFIED',
    observedAt: nowISO, executingSha: codeSha, inputHashes: evidenceHashes,
    presence: { sourceManifest: sources !== null, sourceDiagnostics: sourceDiagnostics !== null,
      predictions: predictions !== null, researchDaily: !!reportValid },
    counts: { sourceFixtureInputs: sources?.length ?? null, sourceWithin36h: sourceRows.filter(x => x.dueWithin36h).length,
      pipelineFixtureInputs: predictions?.length ?? null, pipelineWithin36h: forecastRows.filter(x => x.dueWithin36h).length,
      modelForecasts: predictions !== null ? accepted.length : null,
      modelUnavailable: predictions !== null ? rejected.length : null,
      sourceRowsAbsentFromPipeline: sources !== null && predictions !== null
        ? sourceRows.filter(x => !modeledKeys.has(JSON.stringify([x.source, x.fixtureId]))).length : null,
      pipelineRowsAbsentFromPublicSourcePool: sources !== null && predictions !== null
        ? forecastRows.filter(x => !sourceKeys.has(JSON.stringify([x.source, x.fixtureId]))).length : null,
      frozenQualified: reportValid ? daily.forecasts.total : null,
      strictCandidates: Number.isSafeInteger(document?.summary?.strictCandidates) ? document.summary.strictCandidates : null },
    rejectionReasons: count(rejected.flatMap(x => x.forecastReasons)),
    marketRejectionReasons: count(forecastRows.flatMap(x => x.marketReasons)),
    byLeague, sourceDiagnostics: sourcesSummary,
    sourceFixtures: sourceRows, pipelineCandidates: forecastRows,
    report: reportValid ? { reportId: daily.reportId, codeSha: label(daily.codeSha),
      sourceReportId: label(daily.sourceReportId), state: label(daily.state),
      frozen: daily.forecasts.total, skipped: Number.isInteger(daily.forecasts.skipped) ? daily.forecasts.skipped : null,
      commercialReleaseGate: label(daily.commercialReleaseGate) } : null,
    disclaimer: 'SOURCE and PIPELINE counts are distinct pools; do not conflate missing source data, model rejections and research freeze. This audit is not a publish approval.'
  };
}

async function maybeRead(path) {
  try {
    const bytes = await readFile(path);
    return { data: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { data: null, sha256: null };
    throw error;
  }
}

export async function writeDenominatorAudit(root, out, codeSha, nowISO = new Date().toISOString()) {
  const base = resolve(root), target = resolve(out);
  if (target !== base && !target.startsWith(base + '/')) throw Error('AUDIT_OUTPUT_OUTSIDE_ROOT');
  const [source, document, daily] = await Promise.all([
    maybeRead(join(base, 'reports/public-source-fixtures.json')),
    maybeRead(join(base, 'reports/predictions.json')),
    maybeRead(join(base, 'reports/research-daily/latest.json')) ]);
  const data = diagnoseForecastDenominators({ sourceManifest: source.data, document: document.data,
    daily: daily.data, nowISO, codeSha,
    evidenceHashes: { sourceManifest: source.sha256, predictions: document.sha256, researchDaily: daily.sha256 } });
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  return data;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== '--root' || args[2] !== '--out' || args[4] !== '--code-sha') {
    console.error('AUDIT_ARGUMENT_INVALID'); process.exitCode = 2;
  } else {
    try {
      const result = await writeDenominatorAudit(args[1], args[3], args[5]);
      console.log(JSON.stringify({ status: result.status, counts: result.counts,
        rejectionReasons: result.rejectionReasons, byLeague: result.byLeague }));
    } catch (err) {
      console.error(/^(?:AUDIT|ENOENT)_/.test(err?.message || '') ? err.message : 'AUDIT_FAILED');
      process.exitCode = 1;
    }
  }
}
