import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataHash, canonicalTimestamp, validDataToken } from './data/identity.mjs';
import { scoreProbabilities } from './forecast-evaluation.mjs';
import { calibrationDiagnostics } from './evaluation-quality.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-12;
const fail = () => { throw new Error('INVALID_MODEL_EXPERIMENT_EVIDENCE'); };
const metrics = value => ({ accuracy: value.accuracy, brier: value.brier, logLoss: value.logLoss });
function interval(value, estimate) {
  if (!value || !same(value.estimate, estimate) || !Number.isFinite(value.lower) || !Number.isFinite(value.upper) || value.lower > value.upper) fail();
  return { estimate: value.estimate, lower: value.lower, upper: value.upper };
}

/** Summarizes the frozen first experiment; no fitting, forecasting or bootstrap is invoked. */
export function buildModelExperimentEvidence({ protocol, result, protocolFileSha256, resultFileSha256 }) {
  const { protocolHash, ...body } = protocol || {};
  if (!isHash(protocolHash) || dataHash(body) !== protocolHash || !isHash(protocolFileSha256) || !isHash(resultFileSha256)
    || protocol.version !== 1 || protocol.kind !== 'model-experiment-protocol' || protocol.releaseGate !== 'BLOCKED'
    || result?.version !== 1 || result.kind !== 'model-experiment-result' || result.protocolHash !== protocolHash
    || result.releaseGate !== 'BLOCKED' || result.canRelease !== false || result.calibrated !== false || result.independentEvidence !== false
    || !canonicalTimestamp(result.executedAt) || !canonicalTimestamp(protocol.createdAt) || !canonicalTimestamp(protocol.asOf)
    || Date.parse(result.executedAt) < Date.parse(protocol.createdAt) || dataHash(result.split) !== dataHash(protocol.split)
    || ['rawInputSha256', 'normalizedHistoryHash', 'experimentCodeHash'].some(key => !isHash(protocol[key]) || result.bindings?.[key] !== protocol[key])
    || dataHash(result.bindings.baseline) !== dataHash(protocol.baseline) || protocol.baseline.id !== 'venue-poisson-v2' || protocol.baseline.version !== 2
    || result.candidate !== 'poisson-temperature-v1' || protocol.rules.candidate !== result.candidate
    || !validDataToken(protocol.source) || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(protocol.league) || protocol.rules.horizonHours !== 24) fail();
  const snapshot = result.snapshot, heldout = snapshot?.holdout, fit = snapshot?.calibration?.fitted;
  const coverage = heldout?.coverage, rows = heldout?.evaluations, quality = heldout?.quality;
  if (snapshot?.visibility !== 'snapshot' || snapshot.evidence !== 'revised-snapshot-retrospective'
    || !Array.isArray(rows) || !rows.length || new Set(rows.map(row => row.fixtureId)).size !== rows.length
    || !coverage || !['eligible', 'evaluated', 'skipped', 'pending'].every(key => count(coverage[key])) || coverage.pending !== 0
    || coverage.evaluated !== rows.length || coverage.eligible !== coverage.evaluated + coverage.skipped
    || !same(coverage.rate, coverage.evaluated / coverage.eligible) || heldout.exclusions.length !== coverage.skipped
    || snapshot.calibration.eligible !== snapshot.calibration.evaluated + snapshot.calibration.skipped
    || snapshot.calibration.evaluated !== fit?.count || fit?.status !== 'fitted-internal-research-only' || fit.calibrated !== false
    || fit.count < protocol.rules.minimumCalibration || coverage.evaluated < protocol.rules.minimumHoldout
    || !same(fit.temperature * fit.inverseTemperature, 1) || fit.inverseTemperature < protocol.rules.inverseTemperatureMinimum
    || fit.inverseTemperature > protocol.rules.inverseTemperatureMaximum || fit.fitCutoff !== protocol.split.fitCutoff
    || quality?.evaluated !== coverage.evaluated || quality.releaseGate !== 'BLOCKED' || quality.visibility !== 'snapshot') fail();
  const baseline = metrics(heldout.baseline.metrics), candidate = metrics(heldout.candidate.metrics);
  for (const [name, field, expected] of [['poisson', 'baselineProbabilities', baseline], ['candidate', 'candidateProbabilities', candidate]]) {
    const scored = rows.map(row => {
      const score = scoreProbabilities(row[field], row.actual);
      if (Object.keys(score).some(key => !same(score[key], row.scores?.[name]?.[key]))) fail();
      return score;
    });
    for (const key of ['accuracy', 'brier', 'logLoss']) if (!same(scored.reduce((sum, row) => sum + row[key], 0) / rows.length, expected[key])) fail();
  }
  const eceRows = rows.map(row => ({ probabilities: row.candidateProbabilities, baseline: row.baselineProbabilities, actual: row.actual }));
  if (!same(calibrationDiagnostics(eceRows).macroECE, quality.calibration.model.macroECE)
    || !same(calibrationDiagnostics(eceRows, 'baseline').macroECE, quality.calibration.baseline.macroECE)) fail();
  baseline.macroECE = quality.calibration.baseline.macroECE; candidate.macroECE = quality.calibration.model.macroECE;
  const delta = Object.fromEntries(Object.keys(baseline).map(key => [key, candidate[key] - baseline[key]]));
  for (const key of ['accuracy', 'brier', 'logLoss']) if (!same(delta[key], heldout.candidateMinusPoisson[key])) fail();
  const split = protocol.split.segments, observations = result.asObserved;
  if (!['warmup', 'calibration', 'holdout'].every(key => count(split[key].count))
    || split.warmup.count + split.calibration.count + split.holdout.count !== protocol.history.accepted
    || split.calibration.count !== snapshot.calibration.eligible || split.holdout.count !== coverage.eligible
    || !count(observations?.calibration?.evaluated) || !count(observations?.holdout?.coverage?.evaluated)) fail();
  const uncertainty = quality.uncertainty;
  if (uncertainty.method !== 'paired-UTC-week-cluster-percentile-bootstrap' || !count(uncertainty.blocks)
    || uncertainty.blocks < 8 || uncertainty.replicates !== 2000 || uncertainty.confidenceLevel !== .95) fail();
  const asset = { version: 1, kind: 'model-experiment-evidence', historicalOnly: true, releaseGate: 'BLOCKED',
    calibrated: false, independentEvidence: false, generatedAt: result.executedAt, protocolCreatedAt: protocol.createdAt, dataAsOf: protocol.asOf,
    scope: { source: protocol.source, league: protocol.league, horizonHours: protocol.rules.horizonHours },
    binding: { protocolHash, protocolFileSha256, resultFileSha256, rawInputSha256: protocol.rawInputSha256,
      normalizedHistoryHash: protocol.normalizedHistoryHash, experimentCodeHash: protocol.experimentCodeHash, baselineModelHash: protocol.baseline.configurationHash },
    samples: { input: protocol.history.accepted, warmup: split.warmup.count,
      calibration: { eligible: snapshot.calibration.eligible, evaluated: snapshot.calibration.evaluated, skipped: snapshot.calibration.skipped },
      holdout: { eligible: coverage.eligible, evaluated: coverage.evaluated, skipped: coverage.skipped, rate: coverage.rate },
      asObserved: { calibration: observations.calibration.evaluated, holdout: observations.holdout.coverage.evaluated } },
    models: { baseline: { id: protocol.baseline.id, version: protocol.baseline.version },
      candidate: { id: result.candidate, temperature: fit.temperature, inverseTemperature: fit.inverseTemperature } },
    holdout: { baseline, candidate, candidateMinusBaseline: delta,
      pairedIntervals: { brier: interval(uncertainty.pairedBrierDifference, delta.brier), logLoss: interval(uncertainty.pairedLogLossDifference, delta.logLoss) },
      uncertainty: { method: uncertainty.method, blocks: uncertainty.blocks, replicates: uncertainty.replicates, confidenceLevel: uncertainty.confidenceLevel } },
    decision: { status: 'NOT_ADOPTED', candidateAdopted: false, retainedModel: protocol.baseline.id,
      reasons: [...(delta.brier >= 0 && delta.logLoss >= 0 ? ['NO_PROPER_SCORE_IMPROVEMENT'] : []), 'NO_INDEPENDENT_CONFIRMATION', 'FORMAL_RELEASE_BLOCKED'] },
    limitations: [`${protocol.history.accepted}是历史输入数量，不是留出评估样本；各阶段不可相加作为独立验证。`,
      `${coverage.evaluated}/${coverage.eligible}表示预先固定的${coverage.eligible}场留出中${coverage.evaluated}场可评估、${coverage.skipped}场因缺项排除；当前赛事预测不在此资产中。`,
      `这是已修订历史快照；本次获取时间不能证明过去的数据可见性，严格asObserved校准${observations.calibration.evaluated}场、留出${observations.holdout.coverage.evaluated}场。`,
      '留出历史此前已被查看，结果不是独立确认；首次结果完整保留，没有根据留出成绩重复调参。',
      '温度缩放保留方向排序，不能提升argmax方向命中率；ECE略降不等于已校准。',
      '差值为候选减基线，Brier和Log loss负值才较好；近似区间不能消除跨周球队相关或跨赛季变化。'] };
  if (Buffer.byteLength(JSON.stringify(asset, null, 2)) >= 20000) fail();
  return asset;
}

export async function exportModelExperimentEvidence({ protocolFile, resultFile, outputFile }) {
  const paths = [protocolFile, resultFile, outputFile].map(value => resolve(value));
  if (new Set(paths).size !== 3) fail();
  const [protocolText, resultText] = await Promise.all(paths.slice(0, 2).map(path => readFile(path, 'utf8')));
  const asset = buildModelExperimentEvidence({ protocol: JSON.parse(protocolText), result: JSON.parse(resultText),
    protocolFileSha256: sha256(protocolText), resultFileSha256: sha256(resultText) });
  await writeFile(paths[2], JSON.stringify(asset, null, 2) + '\n', { mode: 0o644 });
  return asset;
}

export async function runExportModelExperimentCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--protocol', '--result', '--output'].includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i])) fail();
      flags[args[i]] = args[i + 1];
    }
    if (!flags['--protocol'] || !flags['--result'] || !flags['--output']) fail();
    const asset = await exportModelExperimentEvidence({ protocolFile: flags['--protocol'], resultFile: flags['--result'], outputFile: flags['--output'] });
    stdout(JSON.stringify({ kind: asset.kind, protocolHash: asset.binding.protocolHash, releaseGate: asset.releaseGate }) + '\n'); return 0;
  } catch { stderr('MODEL_EXPERIMENT_EVIDENCE_EXPORT_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runExportModelExperimentCli(process.argv.slice(2));
