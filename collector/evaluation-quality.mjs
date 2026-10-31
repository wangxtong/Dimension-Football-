import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUTCOMES, scoreProbabilities, validProbabilities } from './forecast-evaluation.mjs';
import { canonicalTimestamp, validDataToken } from './data/identity.mjs';
import { buildEvaluationEvidence } from './export-evaluation.mjs';
import { buildModelReadiness } from './model-readiness.mjs';

// Fixed before reading the evaluation data. No search over bins, seeds, blocks,
// horizons or model parameters is performed, and no calibrator is fitted here.
export const QUALITY_PROTOCOL = Object.freeze({ version: 1, bins: 5, minimumBinCount: 20,
  bootstrapReplicates: 2000, confidenceLevel: .95, block: 'UTC-calendar-week-starting-Monday',
  minimumBlocksForInterval: 8, cautionBelowBlocks: 20, seed: 1447120468 });
const hash = text => createHash('sha256').update(text).digest('hex');
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const cohortKey = row => JSON.stringify([row.source, row.league, row.horizonHours, row.visibility]);
const eventKey = row => JSON.stringify([row.source, row.fixtureId]);
const fail = code => { throw new Error(code); };

function probabilities(row, field) {
  if (!validProbabilities(row?.[field]) || !OUTCOMES.includes(row.actual)) fail('INVALID_QUALITY_PROBABILITIES');
  return row[field];
}

/** Classwise equal-width ECE; it is a descriptive, bin-dependent statistic. */
export function calibrationDiagnostics(rows, field = 'probabilities') {
  if (!Array.isArray(rows) || !['probabilities', 'baseline'].includes(field)) fail('INVALID_CALIBRATION_DIAGNOSTICS');
  for (const row of rows) probabilities(row, field);
  const classes = Object.fromEntries(OUTCOMES.map(outcome => {
    const totals = Array.from({ length: QUALITY_PROTOCOL.bins }, () => ({ count: 0, probability: 0, actual: 0 }));
    for (const row of rows) {
      const p = row[field][outcome], bin = totals[Math.min(QUALITY_PROTOCOL.bins - 1, Math.floor(p * QUALITY_PROTOCOL.bins))];
      bin.count++; bin.probability += p; bin.actual += Number(row.actual === outcome);
    }
    const bins = totals.map((bin, index) => ({ lower: index / QUALITY_PROTOCOL.bins, upper: (index + 1) / QUALITY_PROTOCOL.bins,
      count: bin.count, meanProbability: bin.count ? bin.probability / bin.count : null,
      observedFrequency: bin.count ? bin.actual / bin.count : null,
      gap: bin.count ? (bin.probability - bin.actual) / bin.count : null,
      status: bin.count >= QUALITY_PROTOCOL.minimumBinCount ? 'descriptive' : 'insufficient-bin-sample' }));
    return [outcome, { ece: rows.length ? totals.reduce((sum, bin) => sum + Math.abs(bin.probability - bin.actual), 0) / rows.length : null,
      occupiedBins: bins.filter(bin => bin.count).length, adequatelyPopulatedBins: bins.filter(bin => bin.count >= QUALITY_PROTOCOL.minimumBinCount).length, bins }];
  }));
  return { status: rows.length ? 'descriptive-only-not-calibration-certification' : 'no-samples', count: rows.length,
    macroECE: rows.length ? mean(OUTCOMES.map(outcome => classes[outcome].ece)) : null, classes };
}

function utcWeek(iso) {
  if (!canonicalTimestamp(iso)) fail('INVALID_QUALITY_KICKOFF');
  const date = new Date(iso);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability, lower = Math.floor(position), fraction = position - lower;
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]);
}
function bootstrapInterval(estimate, samples) {
  if (!samples.length) return { estimate, lower: null, upper: null };
  const sorted = samples.toSorted((a, b) => a - b);
  return { estimate, lower: quantile(sorted, .025), upper: quantile(sorted, .975) };
}

function pairedBlockBootstrap(rows, key) {
  const blocks = new Map();
  for (const row of rows) {
    const week = utcWeek(row.kickoff);
    if (!blocks.has(week)) blocks.set(week, []);
    const model = scoreProbabilities(row.probabilities, row.actual), baseline = scoreProbabilities(row.baseline, row.actual);
    blocks.get(week).push({ row, brier: model.brier - baseline.brier, logLoss: model.logLoss - baseline.logLoss });
  }
  const ordered = [...blocks.entries()].sort(([a], [b]) => a.localeCompare(b)), members = ordered.map(([, values]) => values);
  const all = members.flat(), brier = [], logLoss = [], ece = [];
  const seed = (parseInt(hash(key).slice(0, 8), 16) ^ QUALITY_PROTOCOL.seed) >>> 0, random = randomGenerator(seed);
  if (members.length >= QUALITY_PROTOCOL.minimumBlocksForInterval) {
    for (let iteration = 0; iteration < QUALITY_PROTOCOL.bootstrapReplicates; iteration++) {
      const sampled = [];
      for (let block = 0; block < members.length; block++) sampled.push(...members[Math.floor(random() * members.length)]);
      // A whole week's games and both models' scores move together. The mean
      // uses all games in the sampled weeks, including variable week sizes.
      brier.push(mean(sampled.map(row => row.brier)));
      logLoss.push(mean(sampled.map(row => row.logLoss)));
      ece.push(calibrationDiagnostics(sampled.map(row => row.row)).macroECE);
    }
  }
  return { method: 'paired-UTC-week-cluster-percentile-bootstrap', seed, confidenceLevel: QUALITY_PROTOCOL.confidenceLevel,
    replicates: brier.length, blocks: members.length, observations: rows.length,
    blockSizes: ordered.map(([weekStart, values]) => ({ weekStart, count: values.length })),
    status: !rows.length ? 'no-samples' : members.length < QUALITY_PROTOCOL.minimumBlocksForInterval ? 'insufficient-temporal-blocks'
      : members.length < QUALITY_PROTOCOL.cautionBelowBlocks ? 'few-temporal-blocks' : 'approximate-descriptive-intervals',
    pairedBrierDifference: bootstrapInterval(all.length ? mean(all.map(row => row.brier)) : null, brier),
    pairedLogLossDifference: bootstrapInterval(all.length ? mean(all.map(row => row.logLoss)) : null, logLoss),
    macroECE: bootstrapInterval(calibrationDiagnostics(rows).macroECE, ece) };
}

/** One archived model per invocation. Repeated matches across horizons are counted explicitly, never pooled. */
export function evaluateQualityGroups(groups) {
  if (!Array.isArray(groups) || groups.length > 100 || new Set(groups.map(cohortKey)).size !== groups.length) fail('INVALID_QUALITY_COHORTS');
  const unique = new Map(), membership = [], assessed = [];
  for (const group of groups) {
    if (!validDataToken(group.source) || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(group.league)
      || group.visibility !== 'snapshot' || !Number.isFinite(group.horizonHours) || group.horizonHours < 0 || group.horizonHours > 336
      || !Array.isArray(group.evaluations) || group.evaluations.length > 10000) fail('INVALID_QUALITY_COHORT');
    const rows = group.evaluations.toSorted((a, b) => String(a.fixtureId).localeCompare(String(b.fixtureId))), keys = new Set();
    for (const row of rows) {
      if (!validDataToken(row.fixtureId) || row.source !== group.source || row.league !== group.league || row.horizonHours !== group.horizonHours
        || row.provenance !== 'revised-snapshot-retrospective' || !canonicalTimestamp(row.generatedAt) || !canonicalTimestamp(row.kickoff)
        || Math.abs(Date.parse(row.kickoff) - Date.parse(row.generatedAt) - group.horizonHours * 3600000) > 1) fail('INVALID_QUALITY_ROW');
      probabilities(row, 'probabilities'); probabilities(row, 'baseline');
      const key = eventKey(row);
      if (keys.has(key)) fail('DUPLICATE_WITHIN_QUALITY_COHORT');
      keys.add(key);
      const fingerprint = JSON.stringify([row.league, row.kickoff, row.actual]);
      if (unique.has(key) && unique.get(key) !== fingerprint) fail('INCONSISTENT_CROSS_HORIZON_OUTCOME');
      unique.set(key, fingerprint);
    }
    membership.push({ group, keys });
    const model = calibrationDiagnostics(rows), baseline = calibrationDiagnostics(rows, 'baseline');
    const seasons = new Map();
    for (const row of rows) {
      const season = typeof row.season === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,79}$/.test(row.season) ? row.season : null;
      seasons.set(season, (seasons.get(season) || 0) + 1);
    }
    const dates = rows.map(row => row.kickoff).sort();
    assessed.push({ source: group.source, league: group.league, horizonHours: group.horizonHours, visibility: 'snapshot',
      evaluated: rows.length, sampleStructure: { from: dates[0] || null, to: dates.at(-1) || null,
        seasons: [...seasons].sort(([a], [b]) => String(a).localeCompare(String(b))).map(([season, count]) => ({ season, count })) },
      calibration: { model, baseline, macroECEDifference: rows.length ? model.macroECE - baseline.macroECE : null,
        calibrated: false, note: 'ECE depends on fixed bin boundaries and finite sample noise; a small ECE does not certify calibration.' },
      uncertainty: pairedBlockBootstrap(rows, cohortKey(group)), releaseGate: 'BLOCKED' });
  }
  const overlap = [];
  for (let a = 0; a < membership.length; a++) for (let b = a + 1; b < membership.length; b++) {
    const left = membership[a], right = membership[b];
    if (left.group.source !== right.group.source || left.group.league !== right.group.league || !left.keys.size || !right.keys.size) continue;
    const shared = [...left.keys].filter(key => right.keys.has(key)).length;
    overlap.push({ source: left.group.source, league: left.group.league, horizonHours: [left.group.horizonHours, right.group.horizonHours],
      counts: [left.keys.size, right.keys.size], shared, union: left.keys.size + right.keys.size - shared,
      identicalEvaluationSet: shared === left.keys.size && shared === right.keys.size });
  }
  const appearances = assessed.reduce((sum, group) => sum + group.evaluated, 0);
  return { groups: assessed, dependence: { appearancesAcrossHorizons: appearances, uniqueSourceFixtures: unique.size,
    repeatedAppearances: appearances - unique.size, pooledMetrics: null, overlap,
    note: 'Source-scoped match identity; repeated horizons are not extra trials. Different sources are not assumed to be independent matches.' } };
}

export async function readEvaluationQuality({ directory, nowISO = new Date().toISOString() }) {
  const root = resolve(directory);
  const [reportText, documentText, manifestText] = await Promise.all(['latest.json', 'predictions.json', 'run-manifest.json'].map(name => readFile(resolve(root, name), 'utf8')));
  const report = JSON.parse(reportText), document = JSON.parse(documentText), manifest = JSON.parse(manifestText);
  if (!/^[a-f0-9]{64}$/.test(manifest.reportId || '')) fail('INVALID_QUALITY_REPORT_ID');
  const inputs = JSON.parse(await readFile(resolve(root, 'replays', manifest.reportId, 'run-inputs.json'), 'utf8'));
  const readiness = await buildModelReadiness({ directory: resolve(root, 'forecast-ledger'), nowISO, model: report.forecasts.model });
  // Reuse the existing provenance/outcome/aggregate consistency validator, without its writer.
  const evidence = buildEvaluationEvidence({ report, document, manifest, inputs, readiness, exportedAt: nowISO,
    sourceHashes: { report: hash(reportText), document: hash(documentText) } });
  return { version: 1, kind: 'historical-evaluation-quality', generatedAt: nowISO, historicalGeneratedAt: evidence.generatedAt,
    historicalOnly: true, releaseGate: 'BLOCKED', canRelease: false, calibrated: false, binding: evidence.binding, model: evidence.model,
    protocol: QUALITY_PROTOCOL, ...evaluateQualityGroups(report.forecasts.backtests), prospective: evidence.prospective,
    limitations: ['No calibrator is fitted and no model or horizon is selected using these diagnostics.',
      'These are revised-snapshot retrospective outcomes, not prospective performance or a future win-rate estimate.',
      'Weeks are sampled as independent blocks. Team dependence across weeks, season changes and data revisions are not fully modeled.',
      'Cluster intervals are not guaranteed to be wider or more conservative than per-match intervals.',
      'Fewer than eight observed weeks suppresses intervals; eight to nineteen weeks remains a fragile descriptive estimate, not a release criterion.',
      'ECE and its percentile interval are bin-dependent and biased in finite samples; reliability bins with fewer than twenty matches are sparse.',
      'Intervals are pointwise, not adjusted for comparing multiple horizons; selecting the best horizon after seeing them is invalid evidence.',
      'Training input visibility, independent prospective evaluation, frozen baseline and production calibration remain required before release.'] };
}

export async function runEvaluationQualityCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--reports', '--now'].includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i])) fail('INVALID_QUALITY_ARGUMENTS');
      flags[args[i]] = args[i + 1];
    }
    if (!flags['--reports']) fail('INVALID_QUALITY_ARGUMENTS');
    stdout(JSON.stringify(await readEvaluationQuality({ directory: flags['--reports'], nowISO: flags['--now'] }), null, 2) + '\n');
    return 0;
  } catch { stderr('EVALUATION_QUALITY_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runEvaluationQualityCli(process.argv.slice(2));
