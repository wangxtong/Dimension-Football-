import { pathToFileURL } from 'node:url';
import { evaluatePredictionLedger } from './prediction-ledger.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const plain = value => typeof value === 'string' && value.length > 0 && value.length < 200;
const OUTCOMES = ['home', 'draw', 'away'];

/** 单场三分类 Brier 与对数损失；平局不预测不代表不算误差。 */
export function scoreRow({ probabilities, actual }) {
  if (!probabilities || typeof probabilities !== 'object' || !OUTCOMES.includes(actual)) throw new Error('INVALID_EVALUATION_ROW');
  const p = OUTCOMES.map(key => probabilities[key]);
  if (p.some(value => !finite(value) || value < 0 || value > 1)) throw new Error('INVALID_EVALUATION_ROW');
  const total = p.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-6) throw new Error('INVALID_EVALUATION_ROW');
  let brier = 0;
  OUTCOMES.forEach((key, index) => { const observed = key === actual ? 1 : 0; brier += (p[index] - observed) ** 2; });
  const actualProbability = probabilities[actual];
  const selected = OUTCOMES.reduce((best, key) => (probabilities[key] > probabilities[best] ? key : best), 'home');
  return { brier, logLoss: -Math.log(Math.max(actualProbability, 1e-15)), hit: selected === actual, selected };
}

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
function aggregate(rows) {
  if (!rows.length) return { n: 0, brier: null, brierSE: null, accuracy: null, logLoss: null, predictedDrawCount: 0, actualDrawCount: 0 };
  const briers = rows.map(row => row.scored.brier);
  const n = rows.length;
  const average = mean(briers);
  const variance = n > 1 ? briers.reduce((sum, value) => sum + (value - average) ** 2, 0) / (n - 1) : null;
  return { n, brier: average, brierSE: variance === null ? null : Math.sqrt(variance / n),
    accuracy: rows.filter(row => row.scored.hit).length / n, logLoss: mean(rows.map(row => row.scored.logLoss)),
    predictedDrawCount: rows.filter(row => row.scored.selected === 'draw').length,
    actualDrawCount: rows.filter(row => row.actual === 'draw').length };
}
export const HORIZON_BUCKETS = ['h<2', 'h2-6', 'h6-24', 'h24-48', 'h48+', 'unknown'];
const horizonBucket = hours => {
  if (!finite(hours) || hours < 0) return 'unknown';
  if (hours < 2) return 'h<2';
  if (hours < 6) return 'h2-6';
  if (hours < 24) return 'h6-24';
  if (hours < 48) return 'h24-48';
  return 'h48+';
};

/**
 * 把逐场评估记录汇成可复算证据：总体、逐赛季、按提前量、按模型哈希、按来源、按联赛。
 * 分维度输出是为了把“回测与生产差异”拆到具体成因上，而不是只报一个总体 Brier。
 */
export function rollupProspectiveEvidence({ evaluations, seasonOf } = {}) {
  if (!Array.isArray(evaluations)) throw new Error('INVALID_EVALUATION_LIST');
  if (seasonOf !== undefined && typeof seasonOf !== 'function') throw new Error('INVALID_SEASON_FUNCTION');
  const rows = [];
  for (const row of evaluations) {
    if (!row || row.provenance !== 'prospective-ledger') continue;
    if (!plain(row.league) || !plain(row.source)) continue;
    const scored = scoreRow(row);
    const kickoffMs = Date.parse(row.kickoff);
    if (!Number.isFinite(kickoffMs)) continue;
    const season = seasonOf ? String(seasonOf(row)) : String(new Date(kickoffMs).getUTCFullYear());
    rows.push({ league: row.league, source: row.source, season, modelHash: plain(row.modelHash) ? row.modelHash : 'unknown',
      horizonHours: finite(row.horizonHours) ? row.horizonHours : null, actual: row.actual, scored });
  }
  const group = keyOf => {
    const buckets = new Map();
    rows.forEach(row => { const key = keyOf(row); if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(row); });
    return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, bucket]) => ({ key, ...aggregate(bucket) }));
  };
  const overall = aggregate(rows);
  const blockers = [];
  if (!rows.length) blockers.push('NO_SCORED_PROSPECTIVE_ROWS');
  if (overall.n > 0 && overall.brierSE === null) blockers.push('VARIANCE_NOT_COMPUTABLE');
  if (rows.length > 0 && rows.filter(row => row.scored.selected === 'draw').length === 0) blockers.push('MODEL_NEVER_SELECTS_DRAW');
  return { version: 1, kind: 'research-evidence-rollup', seasonDefinition: seasonOf ? 'custom' : 'kickoff-utc-year',
    horizonBuckets: [...HORIZON_BUCKETS],
    overall, bySeason: group(row => row.season), byHorizon: group(row => horizonBucket(row.horizonHours)),
    byModel: group(row => row.modelHash.slice(0, 8)), bySource: group(row => row.source), byLeague: group(row => row.league),
    excluded: evaluations.length - rows.length, blockers };
}

/** 从不可变账本目录构建同一份汇总；不做网络请求，不改任何记录。 */
export async function buildRollupFromLedger({ directory, nowISO, horizonHours = 1, toleranceHours = 1 } = {}) {
  if (!plain(directory) || !Number.isFinite(Date.parse(nowISO))) throw new Error('INVALID_ROLLUP_OPTIONS');
  const evaluation = await evaluatePredictionLedger({ directory, nowISO, horizonHours, toleranceHours });
  const rollup = rollupProspectiveEvidence({ evaluations: evaluation.evaluations });
  return { ...rollup, ledger: { assessmentStatus: evaluation.assessmentStatus, cohorts: evaluation.cohorts,
    coverage: evaluation.coverage ?? null,
    metricsWithheldByMixedCohorts: evaluation.assessmentStatus === 'blocked-mixed-cohorts' },
    blockers: [...rollup.blockers, ...(evaluation.assessmentStatus === 'blocked-mixed-cohorts' ? ['MIXED_MODEL_COHORTS'] : [])] };
}

function usage() { return 'Usage: node collector/research-evidence-rollup.mjs --ledger DIR --now ISO [--horizon-hours 1]\nOffline read-only rollup of the immutable prediction ledger. No network, no writes, never authorizes release.\n'; }

export async function runRollupCli(args, { stdout = v => process.stdout.write(v), stderr = v => process.stderr.write(v) } = {}) {
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--ledger', '--now', '--horizon-hours', '--help'].includes(args[i]) || (!args[i + 1] && args[i] !== '--help')) throw new Error('INVALID_ROLLUP_ARGUMENT');
      if (Object.hasOwn(options, args[i])) throw new Error('INVALID_ROLLUP_ARGUMENT');
      options[args[i]] = args[i + 1];
    }
    if (Object.hasOwn(options, '--help')) { stdout(usage()); return 0; }
    if (!options['--ledger'] || !options['--now']) throw new Error('INVALID_ROLLUP_ARGUMENT');
    const horizon = options['--horizon-hours'] ? Number(options['--horizon-hours']) : 1;
    const result = await buildRollupFromLedger({ directory: options['--ledger'], nowISO: options['--now'], horizonHours: horizon });
    stdout(JSON.stringify(result, null, 2) + '\n');
    return result.overall.n > 0 ? 0 : 2;
  } catch { stderr('RESEARCH_EVIDENCE_ROLLUP_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runRollupCli(process.argv.slice(2));
}
