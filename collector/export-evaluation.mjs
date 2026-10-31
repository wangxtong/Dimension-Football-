import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dataHash, canonicalTimestamp, validDataToken } from './data/identity.mjs';
import { verifyReplayBundle } from './data/run-manifest.mjs';
import { digest } from './policy.mjs';
import { scoreProbabilities, summarizeEvaluations } from './forecast-evaluation.mjs';
import { buildModelReadiness, READINESS_LEAGUES } from './model-readiness.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;
const fail = () => { throw new Error('INVALID_HISTORICAL_EVALUATION_EVIDENCE'); };
const actual = row => row.homeGoals > row.awayGoals ? 'home' : row.homeGoals === row.awayGoals ? 'draw' : 'away';
const key = row => JSON.stringify([row.source, row.league, row.horizonHours, row.visibility]);
const sameNumber = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-12;
const interval = value => value ? { estimate: value.estimate, lower: value.lower, upper: value.upper } : null;
const referenceHorizons = [1, 24, 72, 168];

/** Exports aggregate historical evidence only. It never invokes a forecast or changes release authority. */
export function buildEvaluationEvidence({ report, document, manifest, inputs, readiness, exportedAt, sourceHashes = {} }) {
  verifyReplayBundle({ manifest, inputs });
  const model = report?.forecasts?.model;
  if (!canonicalTimestamp(exportedAt) || Date.parse(exportedAt) < Date.parse(manifest.generatedAt)
    || manifest.simulated || report?.simulated !== false || document?.simulated !== false
    || model?.id !== 'venue-poisson-v2' || model.version !== 2 || model.calibrated !== false
    || dataHash(model) !== manifest.modelHash || dataHash(document.model) !== manifest.modelHash
    || report.publication?.reportId !== manifest.reportId || document.publication?.reportId !== manifest.reportId
    || report.completedAt !== manifest.generatedAt || document.generatedAt !== manifest.generatedAt
    || report.forecasts.generatedAt !== manifest.cutoff || !/^[a-f0-9]{40}$/.test(manifest.codeVersion || '')
    || Object.values(sourceHashes).some(value => !/^[a-f0-9]{64}$/.test(value))
    || readiness?.kind !== 'model-readiness' || readiness.generatedAt !== exportedAt
    || readiness.model.configurationHash !== digest(model) || readiness.releaseGate !== 'BLOCKED') fail();
  const identity = [report.completedAt, report.simulated, report.summary, report.results.map(row => [row.fixture.id, row.forecast, row.result])];
  if (report.inputHash !== undefined) identity.push(report.inputHash);
  if (digest(identity) !== manifest.reportId) fail();
  const backtests = report.forecasts.backtests;
  if (!Array.isArray(backtests) || backtests.length > 100 || !Array.isArray(document.backtests)
    || dataHash(document.backtests) !== dataHash(backtests.map(({ evaluations, exclusions, ...summary }) => summary))
    || document.backtestDetails?.reportId !== manifest.reportId
    || document.backtestDetails?.sha256 !== sha256(JSON.stringify(backtests))) fail();
  const history = new Map(inputs.history.map(row => [`${row.source}:${row.id}`, row]));
  if (new Set(backtests.map(key)).size !== backtests.length) fail();
  const groups = backtests.map(group => {
    if (!validDataToken(group.source) || !READINESS_LEAGUES.includes(group.league) || group.visibility !== 'snapshot'
      || group.method !== 'chronological-walk-forward' || !Number.isFinite(group.horizonHours) || group.horizonHours < 0 || group.horizonHours > 336
      || !['reference-horizon', 'actual-publication-horizon'].includes(group.purpose)
      || !Array.isArray(group.evaluations) || !Array.isArray(group.exclusions)
      || !integer(group.evaluated) || !integer(group.skipped) || group.evaluated !== group.evaluations.length
      || group.skipped !== group.exclusions.length || typeof group.interrupted !== 'boolean'
      || new Set(group.evaluations.map(row => row.fixtureId)).size !== group.evaluated) fail();
    for (const row of group.evaluations) {
      const result = history.get(`${group.source}:${row.fixtureId}`);
      if (!result || row.source !== group.source || row.league !== group.league || result.league !== group.league
        || row.provenance !== 'revised-snapshot-retrospective' || row.kickoff !== result.kickoff || row.actual !== actual(result)
        || !canonicalTimestamp(row.generatedAt) || !/^[a-f0-9]{64}$/.test(row.trainingHash || '')
        || !sameNumber(row.horizonHours, group.horizonHours)
        || Math.abs(Date.parse(row.kickoff) - Date.parse(row.generatedAt) - group.horizonHours * 3600000) > 1
        || Date.parse(row.kickoff) >= Date.parse(manifest.cutoff)) fail();
    }
    const assessed = summarizeEvaluations(group.evaluations, group.coverage);
    for (const name of ['brier', 'logLoss', 'accuracy', 'baselineBrier', 'baselineLogLoss']) {
      if (group.evaluated ? !sameNumber(group.metrics?.[name], assessed.metrics?.[name]) : group.metrics !== null) fail();
    }
    if (dataHash(assessed.coverage) !== dataHash(group.coverage)) fail();
    const metrics = assessed.metrics ? { accuracy: assessed.metrics.accuracy, brier: assessed.metrics.brier, logLoss: assessed.metrics.logLoss } : null;
    const baseline = metrics ? { accuracy: group.evaluations.reduce((sum, row) => sum + scoreProbabilities(row.baseline, row.actual).accuracy, 0) / group.evaluated,
      brier: assessed.metrics.baselineBrier, logLoss: assessed.metrics.baselineLogLoss } : null;
    const reasons = ['RETROSPECTIVE_SNAPSHOT', 'UNCALIBRATED'];
    if (group.evaluated) reasons.push('SMALL_SAMPLE');
    if (group.evaluated < 30) reasons.push('INSUFFICIENT_VALIDATION');
    if (!inputs.history.some(row => row.source === group.source && row.league === group.league)) reasons.push('HISTORY_UNAVAILABLE');
    if (group.interrupted) reasons.push('INCOMPLETE_BACKTEST');
    return { source: group.source, league: group.league, horizonHours: group.horizonHours, purpose: group.purpose,
      visibility: 'snapshot', status: group.interrupted ? 'incomplete' : group.evaluated >= 30 ? 'evaluated-small-sample' : 'insufficient-validation',
      evaluated: group.evaluated, skipped: group.skipped, interrupted: group.interrupted, coverage: assessed.coverage,
      metrics, baseline, deltaVsBaseline: metrics ? Object.fromEntries(['accuracy', 'brier', 'logLoss'].map(name => [name, metrics[name] - baseline[name]])) : null,
      uncertainty: { method: assessed.uncertainty.method, status: assessed.uncertainty.status,
        brier: interval(assessed.uncertainty.brier), logLoss: interval(assessed.uncertainty.logLoss), pairedBrierDifference: interval(assessed.uncertainty.pairedBrierDifference) },
      reasons,
      evaluationSetHash: dataHash(group.evaluations.map(row => [row.source, row.fixtureId, row.kickoff, row.actual])),
      detailsHash: sha256(JSON.stringify(group)) };
  }).sort((a, b) => READINESS_LEAGUES.indexOf(a.league) - READINESS_LEAGUES.indexOf(b.league) || a.source.localeCompare(b.source) || a.horizonHours - b.horizonHours);
  const leagues = READINESS_LEAGUES.map(league => {
    const row = readiness.leagues.find(item => item.league === league);
    if (!row) fail();
    return { league, source: row.source ?? null, evaluated: row.settledFrozenSamples,
      minimumSampleGap: row.minimumSampleGap, registeredUnsettledMatches: row.registeredUnsettledMatches ?? null,
      legacyOrInvalidFreezeRecords: row.legacyOrInvalidFreezeRecords ?? null, releaseGate: 'BLOCKED' };
  });
  const prospectiveEvaluated = leagues.every(row => integer(row.evaluated)) ? leagues.reduce((n, row) => n + row.evaluated, 0) : null;
  const asset = { version: 1, kind: 'historical-evaluation-evidence', historicalOnly: true, releaseGate: 'BLOCKED', canRelease: false,
    generatedAt: manifest.generatedAt, exportedAt, binding: { reportId: manifest.reportId, codeVersion: manifest.codeVersion,
      manifestHash: manifest.manifestHash, inputsHash: manifest.inputsHash, modelHash: manifest.modelHash,
      reportSha256: sourceHashes.report || sha256(JSON.stringify(report)), documentSha256: sourceHashes.document || sha256(JSON.stringify(document)),
      backtestsSha256: document.backtestDetails.sha256, hashEncoding: 'source files: UTF-8 bytes; backtests: JSON.stringify/UTF-8; manifest: canonical JSON' },
    model: { id: model.id, version: model.version, calibrated: false },
    metricDefinitions: { accuracy: '历史最高概率方向命中比例；平票记为未命中，不是未来胜率',
      brier: '三分类平方误差之和，越低越好', logLoss: '自然对数损失，越低越好',
      baseline: '同场、同提前量、同训练池的平滑历史赛果频率', deltaConvention: 'model-minus-baseline',
      favorableDelta: { accuracy: 'positive', brier: 'negative', logLoss: 'negative' } },
    referenceHorizons, groups,
    prospective: { asOf: exportedAt, status: prospectiveEvaluated === null ? 'EVIDENCE_UNVERIFIED' : prospectiveEvaluated === 0 ? 'NO_SETTLED_PROSPECTIVE_SAMPLES' : 'UNVERIFIED_FOR_RELEASE',
      evaluated: prospectiveEvaluated, horizonHours: readiness.protocol.horizonHours, toleranceHours: readiness.protocol.toleranceHours,
      minimumPerLeague: 200, ledgerSnapshotHash: readiness.ledger.snapshotHash ?? null, leagues },
    improvement: { status: 'NO_COMPARABLE_MODEL_VERSIONS', series: [], note: '当前只有一个已绑定代码版本的历史快照；提前量差异不是模型升级轨迹。' },
    limitations: ['仅展示已归档历史回测；不批准当前赛事预测或今日优选。',
      '当前修订快照不能证明过去的数据可见性；本报告不是前瞻成绩。',
      '不同提前量复用同一批历史比赛，样本不可相加；只可比较各组内相同比赛的模型与基准。',
      '近似95%区间假设比赛独立，球队相关性可能使区间过窄；分箱或区间不能证明校准。',
      '五联赛各200场前瞻样本只是下限；校准、基准和训练可见性证据未完成，正式发布仍为BLOCKED。'] };
  if (Buffer.byteLength(JSON.stringify(asset, null, 2)) >= 100000) throw new Error('EVALUATION_EVIDENCE_TOO_LARGE');
  return asset;
}

export async function exportEvaluationEvidence({ directory, outputFile, nowISO = new Date().toISOString() }) {
  const root = resolve(directory), target = resolve(outputFile), location = relative(root, target);
  if (location !== '..' && !location.startsWith(`..${sep}`)) throw new Error('EVIDENCE_OUTPUT_MUST_NOT_OVERWRITE_SOURCE');
  const [reportText, documentText, manifestText] = await Promise.all(['latest.json', 'predictions.json', 'run-manifest.json'].map(name => readFile(resolve(root, name), 'utf8')));
  const report = JSON.parse(reportText), document = JSON.parse(documentText), manifest = JSON.parse(manifestText);
  if (!/^[a-f0-9]{64}$/.test(manifest.reportId || '')) fail();
  const inputs = JSON.parse(await readFile(resolve(root, 'replays', manifest.reportId, 'run-inputs.json'), 'utf8'));
  const readiness = await buildModelReadiness({ directory: resolve(root, 'forecast-ledger'), nowISO, model: report.forecasts.model });
  const asset = buildEvaluationEvidence({ report, document, manifest, inputs, readiness, exportedAt: nowISO,
    sourceHashes: { report: sha256(reportText), document: sha256(documentText) } });
  await writeFile(target, JSON.stringify(asset, null, 2) + '\n', { mode: 0o644 });
  return asset;
}

export async function runExportEvaluationCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--reports', '--output', '--now'].includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i])) fail();
      flags[args[i]] = args[i + 1];
    }
    if (!flags['--reports'] || !flags['--output']) fail();
    const asset = await exportEvaluationEvidence({ directory: flags['--reports'], outputFile: flags['--output'], nowISO: flags['--now'] });
    stdout(JSON.stringify({ kind: asset.kind, reportId: asset.binding.reportId, groups: asset.groups.length, releaseGate: 'BLOCKED' }) + '\n');
    return 0;
  } catch { stderr('EVALUATION_EVIDENCE_EXPORT_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runExportEvaluationCli(process.argv.slice(2));
