import { readFile, mkdir, open, link, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { FORECAST_MODEL, prepareForecastHistory, walkForwardBacktest } from './forecast.mjs';
import { OUTCOMES, validProbabilities, scoreProbabilities, summarizeEvaluations } from './forecast-evaluation.mjs';
import { evaluateQualityGroups } from './evaluation-quality.mjs';
import { dataHash, canonicalTimestamp, validDataToken } from './data/identity.mjs';

const HOUR = 3600000;
export const EXPERIMENT_RULES = Object.freeze({ version: 1, candidate: 'poisson-temperature-v1', horizonHours: 24,
  warmupFraction: .4, calibrationEndFraction: .8, minimumCalibration: 100, minimumHoldout: 30,
  inverseTemperatureMinimum: .5, inverseTemperatureMaximum: 2, optimizerIterations: 60,
  objective: 'calibration-multiclass-log-loss', baselineUpdate: 'fixed-parameters-prequential-past-results-only',
  holdoutDisclosure: 'previously-inspected-history-not-independent-confirmation' });
const CODE_DEPENDENCIES = Object.freeze(['model-experiment.mjs', 'forecast.mjs', 'forecast-evaluation.mjs', 'evaluation-quality.mjs',
  'policy.mjs', 'data/identity.mjs', 'data/history-cache.mjs']);
const hash = value => createHash('sha256').update(value).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const time = value => Date.parse(value);
const eventKey = row => `${row.source}:${row.fixtureId || row.id}`;
const fail = code => { throw new Error(code); };
const knownAt = row => {
  const known = [row.observedAt, row.resultObservedAt].map(time).filter(Number.isFinite);
  return known.length ? Math.max(...known) : time(row.fetchedAt);
};

/** A real probability transformation. Positive alpha preserves all argmax rankings and ties. */
export function temperatureScale(probabilities, inverseTemperature) {
  if (!validProbabilities(probabilities) || !Number.isFinite(inverseTemperature)
    || inverseTemperature < EXPERIMENT_RULES.inverseTemperatureMinimum || inverseTemperature > EXPERIMENT_RULES.inverseTemperatureMaximum) fail('INVALID_TEMPERATURE_INPUT');
  if (inverseTemperature === 1) return { ...probabilities };
  const logits = OUTCOMES.map(key => Math.log(probabilities[key]) * inverseTemperature), maximum = Math.max(...logits);
  const weights = logits.map(value => Math.exp(value - maximum)), total = weights.reduce((a, b) => a + b, 0);
  return Object.fromEntries(OUTCOMES.map((key, index) => [key, weights[index] / total]));
}

/** One bounded convex fit, using calibration labels only. No holdout argument exists. */
export function fitTemperature(rows, { fitCutoff }) {
  if (!Array.isArray(rows) || !canonicalTimestamp(fitCutoff)) fail('INVALID_TEMPERATURE_FIT');
  const seen = new Set();
  for (const row of rows) {
    if (!validDataToken(row.fixtureId) || !validDataToken(row.source) || !validProbabilities(row.probabilities)
      || OUTCOMES.some(key => row.probabilities[key] <= 0) || !OUTCOMES.includes(row.actual)
      || !canonicalTimestamp(row.generatedAt) || !canonicalTimestamp(row.kickoff) || !canonicalTimestamp(row.labelAvailableAt)
      || time(row.generatedAt) >= time(row.kickoff) || time(row.labelAvailableAt) <= time(row.kickoff)
      || time(row.labelAvailableAt) >= time(fitCutoff)) fail('NONPAST_CALIBRATION_LABEL');
    if (seen.has(eventKey(row))) fail('DUPLICATE_CALIBRATION_FIXTURE');
    seen.add(eventKey(row));
  }
  if (rows.length < EXPERIMENT_RULES.minimumCalibration) return { status: 'insufficient-calibration', calibrated: false,
    count: rows.length, required: EXPERIMENT_RULES.minimumCalibration, inverseTemperature: null, temperature: null };
  const derivative = alpha => rows.reduce((sum, row) => {
    const q = temperatureScale(row.probabilities, alpha);
    return sum + OUTCOMES.reduce((n, key) => n + q[key] * Math.log(row.probabilities[key]), 0) - Math.log(row.probabilities[row.actual]);
  }, 0) / rows.length;
  let lower = EXPERIMENT_RULES.inverseTemperatureMinimum, upper = EXPERIMENT_RULES.inverseTemperatureMaximum, alpha;
  if (Math.abs(derivative(1)) <= 1e-12) alpha = 1;
  else if (derivative(lower) >= 0) alpha = lower;
  else if (derivative(upper) <= 0) alpha = upper;
  else {
    for (let i = 0; i < EXPERIMENT_RULES.optimizerIterations; i++) {
      const midpoint = (lower + upper) / 2;
      if (derivative(midpoint) > 0) upper = midpoint; else lower = midpoint;
    }
    alpha = (lower + upper) / 2;
  }
  const averageLoss = candidate => rows.reduce((sum, row) => sum + scoreProbabilities(
    candidate ? temperatureScale(row.probabilities, alpha) : row.probabilities, row.actual).logLoss, 0) / rows.length;
  return { status: 'fitted-internal-research-only', calibrated: false, count: rows.length, fitCutoff,
    inverseTemperature: alpha, temperature: 1 / alpha,
    boundarySolution: alpha === EXPERIMENT_RULES.inverseTemperatureMinimum || alpha === EXPERIMENT_RULES.inverseTemperatureMaximum,
    calibrationLogLoss: { poisson: averageLoss(false), candidate: averageLoss(true) },
    calibrationRowsHash: dataHash(rows), note: 'Fit-set loss is an optimization diagnostic, not validation evidence. Direction accuracy cannot improve through temperature scaling.' };
}

function selectedHistory(history, { source, league, asOf }) {
  if (!validDataToken(source) || !['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(league) || !canonicalTimestamp(asOf)) fail('INVALID_EXPERIMENT_SCOPE');
  const clean = prepareForecastHistory(history);
  if (clean.rejected || clean.logicalConflicts) fail('EXPERIMENT_HISTORY_REQUIRES_CLEAN_INPUT');
  const scope = clean.matches.filter(row => row.source === source && row.league === league);
  const matches = scope.filter(row => time(row.kickoff) + FORECAST_MODEL.resultLagHours * HOUR <= time(asOf)
    && (!Number.isFinite(knownAt(row)) || knownAt(row) <= time(asOf)));
  return { matches, excludedAfterAsOf: scope.length - matches.length, duplicatesRemoved: clean.duplicates };
}
function splitHistory(matches) {
  if (matches.length < 5) fail('INSUFFICIENT_EXPERIMENT_HISTORY');
  // Entire simultaneous kickoff batches remain together. Boundaries depend on
  // timestamps only, never scores or the set of forecasts that happen to pass.
  const calibrationStart = matches[Math.floor(matches.length * EXPERIMENT_RULES.warmupFraction)].kickoff;
  const holdoutStart = matches[Math.floor(matches.length * EXPERIMENT_RULES.calibrationEndFraction)].kickoff;
  const phase = row => time(row.kickoff) < time(calibrationStart) ? 'warmup' : time(row.kickoff) < time(holdoutStart) ? 'calibration' : 'holdout';
  const segments = Object.fromEntries(['warmup', 'calibration', 'holdout'].map(name => {
    const rows = matches.filter(row => phase(row) === name);
    return [name, { count: rows.length, from: rows[0]?.kickoff || null, to: rows.at(-1)?.kickoff || null,
      fixtureIdsHash: dataHash(rows.map(row => row.id)) }];
  }));
  return { calibrationStart, holdoutStart, fitCutoff: new Date(time(holdoutStart) - EXPERIMENT_RULES.horizonHours * HOUR).toISOString(), segments, phase };
}

export function prepareModelExperiment({ history, source, league, asOf, createdAt, rawInputSha256, experimentCodeHash }) {
  if (!canonicalTimestamp(createdAt) || time(createdAt) < time(asOf) || !isHash(rawInputSha256) || !isHash(experimentCodeHash)) fail('INVALID_EXPERIMENT_BINDING');
  const selected = selectedHistory(history, { source, league, asOf }), split = splitHistory(selected.matches);
  const body = { version: 1, kind: 'model-experiment-protocol', createdAt, source, league, asOf,
    rules: EXPERIMENT_RULES, experimentCodeHash, codeDependencies: CODE_DEPENDENCIES,
    codeHashEncoding: 'canonical JSON SHA-256 of dependency filename to file-byte-SHA-256 mapping', rawInputSha256, normalizedHistoryHash: dataHash(selected.matches),
    baseline: { id: FORECAST_MODEL.id, version: FORECAST_MODEL.version, configurationHash: dataHash(FORECAST_MODEL) },
    history: { accepted: selected.matches.length, excludedAfterAsOf: selected.excludedAfterAsOf, duplicatesRemoved: selected.duplicatesRemoved,
      unknownObservationTime: selected.matches.filter(row => !Number.isFinite(knownAt(row))).length },
    split: { calibrationStart: split.calibrationStart, holdoutStart: split.holdoutStart, fitCutoff: split.fitCutoff, segments: split.segments },
    candidateCount: 1, primaryComparison: 'holdout-candidate-minus-poisson-log-loss',
    evidenceStatus: 'internally-fixed-exploratory-protocol-not-external-preregistration', releaseGate: 'BLOCKED' };
  return { ...body, protocolHash: dataHash(body) };
}

function rollingPredictions(matches, scope, visibility) {
  const rows = new Map(), exclusions = new Map(), limit = FORECAST_MODEL.backtestLimit;
  for (let end = Math.min(limit, matches.length); ; end = Math.min(matches.length, end + limit)) {
    // Prefixes cover the entire selected history despite the production helper's
    // last-80 diagnostic cap. Future games never enter an earlier training pool.
    const result = walkForwardBacktest(matches.slice(0, end), { source: scope.source, league: scope.league,
      nowISO: scope.asOf, horizonHours: EXPERIMENT_RULES.horizonHours, visibility });
    for (const row of result.evaluations) {
      if (rows.has(row.fixtureId) && dataHash(rows.get(row.fixtureId)) !== dataHash(row)) fail('INCONSISTENT_PREQUENTIAL_REPLAY');
      if (time(row.newestTrainingKickoff) + FORECAST_MODEL.resultLagHours * HOUR > time(row.generatedAt)) fail('FUTURE_TRAINING_RESULT');
      rows.set(row.fixtureId, row);
    }
    for (const row of result.exclusions) exclusions.set(row.fixtureId, row.reasons);
    if (end === matches.length) break;
  }
  return { rows, exclusions };
}

function runVisibility(matches, protocol, visibility) {
  const split = splitHistory(matches), replay = rollingPredictions(matches, protocol, visibility);
  const calibrationFixtures = matches.filter(row => split.phase(row) === 'calibration');
  const heldoutFixtures = matches.filter(row => split.phase(row) === 'holdout');
  const calibration = [], calibrationExcluded = [];
  for (const fixture of calibrationFixtures) {
    const row = replay.rows.get(fixture.id), available = visibility === 'snapshot'
      ? time(fixture.kickoff) + FORECAST_MODEL.resultLagHours * HOUR : knownAt(fixture);
    if (!row) calibrationExcluded.push({ fixtureId: fixture.id, reasons: replay.exclusions.get(fixture.id) || ['BASELINE_UNAVAILABLE'] });
    else if (!Number.isFinite(available) || available >= time(split.fitCutoff)) calibrationExcluded.push({ fixtureId: fixture.id, reasons: ['LABEL_NOT_AVAILABLE_BEFORE_FIT_CUTOFF'] });
    else calibration.push({ ...row, labelAvailableAt: new Date(available).toISOString() });
  }
  const fitted = fitTemperature(calibration, { fitCutoff: split.fitCutoff }), canTransform = fitted.inverseTemperature !== null;
  const paired = [], heldout = [], excluded = [];
  for (const fixture of heldoutFixtures) {
    const row = replay.rows.get(fixture.id);
    if (!row) { excluded.push({ fixtureId: fixture.id, reasons: replay.exclusions.get(fixture.id) || ['BASELINE_UNAVAILABLE'] }); continue; }
    const candidate = canTransform ? temperatureScale(row.probabilities, fitted.inverseTemperature) : null;
    if (candidate) paired.push({ ...row, probabilities: candidate, baseline: row.probabilities });
    heldout.push({ fixtureId: row.fixtureId, kickoff: row.kickoff, generatedAt: row.generatedAt, trainingHash: row.trainingHash,
      newestTrainingKickoff: row.newestTrainingKickoff, actual: row.actual, baselineProbabilities: row.probabilities,
      frequencyProbabilities: row.baseline, candidateProbabilities: candidate,
      scores: { poisson: scoreProbabilities(row.probabilities, row.actual), frequency: scoreProbabilities(row.baseline, row.actual),
        candidate: candidate ? scoreProbabilities(candidate, row.actual) : null } });
  }
  const original = heldoutFixtures.map(fixture => replay.rows.get(fixture.id)).filter(Boolean);
  const coverage = { eligible: heldoutFixtures.length, skipped: excluded.length, pending: 0 };
  const baselineAssessment = summarizeEvaluations(original, coverage);
  const candidateAssessment = canTransform ? summarizeEvaluations(paired, coverage) : null;
  const quality = visibility === 'snapshot' && canTransform ? evaluateQualityGroups([{ source: protocol.source, league: protocol.league,
    horizonHours: EXPERIMENT_RULES.horizonHours, visibility, evaluations: paired }]).groups[0] : null;
  return { visibility, evidence: visibility === 'snapshot' ? 'revised-snapshot-retrospective' : 'observed-history-replay-not-published-prospective',
    status: !canTransform ? 'insufficient-calibration' : heldout.length < EXPERIMENT_RULES.minimumHoldout ? 'insufficient-holdout' : 'completed-exploratory-only',
    calibrated: false, releaseGate: 'BLOCKED', calibration: { eligible: calibrationFixtures.length, evaluated: calibration.length,
      skipped: calibrationExcluded.length, labelAvailability: visibility === 'snapshot' ? 'assumed-kickoff-plus-four-hours-not-observed-proof' : 'recorded-observation-time',
      fitted, exclusions: calibrationExcluded }, holdout: { coverage: baselineAssessment.coverage, baseline: baselineAssessment,
      candidate: candidateAssessment, candidateMinusPoisson: candidateAssessment?.metrics && baselineAssessment.metrics
        ? Object.fromEntries(['logLoss', 'brier', 'accuracy'].map(key => [key, candidateAssessment.metrics[key] - baselineAssessment.metrics[key]])) : null,
      quality, evaluations: heldout, exclusions: excluded } };
}

export function runModelExperiment({ history, protocol, rawInputSha256, experimentCodeHash, executedAt }) {
  if (!protocol || !canonicalTimestamp(executedAt) || time(executedAt) < time(protocol.createdAt)) fail('INVALID_EXPERIMENT_EXECUTION');
  const expected = prepareModelExperiment({ history, source: protocol.source, league: protocol.league, asOf: protocol.asOf,
    createdAt: protocol.createdAt, rawInputSha256, experimentCodeHash });
  if (dataHash(expected) !== dataHash(protocol)) fail('EXPERIMENT_PROTOCOL_OR_INPUT_MISMATCH');
  const { matches } = selectedHistory(history, protocol);
  return { version: 1, kind: 'model-experiment-result', executedAt, protocolHash: protocol.protocolHash,
    bindings: { rawInputSha256, normalizedHistoryHash: protocol.normalizedHistoryHash, experimentCodeHash, baseline: protocol.baseline },
    candidate: EXPERIMENT_RULES.candidate, releaseGate: 'BLOCKED', canRelease: false, calibrated: false, independentEvidence: false,
    split: protocol.split, snapshot: runVisibility(matches, protocol, 'snapshot'), asObserved: runVisibility(matches, protocol, 'as-observed'),
    limitations: ['The candidate and time split were fixed for this run, but this history was inspected earlier; this is not untouched independent confirmation.',
      'The fixed Poisson parameters are recomputed prequentially from earlier eligible results, including earlier holdout games; this is not a static training-only model.',
      'Snapshot label availability assumes kickoff plus four hours. The as-observed comparison separately requires genuine observation timestamps.',
      'Temperature scaling preserves direction rankings and cannot improve argmax accuracy; its objective is probability scoring.',
      'One candidate and one horizon only. No holdout-driven refit, alternate split search, automatic promotion or current match recommendation is performed.',
      'Exploratory metrics, ECE and bootstrap intervals do not establish production calibration, a future win rate or betting value.'] };
}

async function writeOnce(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  try { await link(temporary, path); } catch (error) { if (error.code === 'EEXIST') fail('IMMUTABLE_EXPERIMENT_ALREADY_EXISTS'); throw error; }
  finally { await unlink(temporary).catch(() => {}); }
}

/** Two separate local steps: freeze protocol first, then fit and score once. No network or production writes. */
export async function runModelExperimentCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const mode = args[0], flags = {};
    if (!['prepare', 'run'].includes(mode)) fail('INVALID_EXPERIMENT_MODE');
    for (let i = 1; i < args.length; i += 2) {
      if (!['--history', '--source', '--league', '--as-of', '--protocol', '--output'].includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i])) fail('INVALID_EXPERIMENT_ARGUMENTS');
      flags[args[i]] = args[i + 1];
    }
    if (!flags['--history'] || !flags['--protocol']) fail('EXPERIMENT_INPUT_REQUIRED');
    const protocolPath = resolve(flags['--protocol']), inputPath = resolve(flags['--history']);
    const [raw, dependencies] = await Promise.all([readFile(inputPath, 'utf8'),
      Promise.all(CODE_DEPENDENCIES.map(async name => [name, hash(await readFile(new URL(name, import.meta.url)))]))]);
    const parsed = JSON.parse(raw), history = Array.isArray(parsed) ? parsed : parsed.history;
    const rawInputSha256 = hash(raw), experimentCodeHash = dataHash(Object.fromEntries(dependencies)), now = new Date().toISOString();
    if (protocolPath === inputPath) fail('EXPERIMENT_OUTPUT_OVERLAPS_INPUT');
    if (mode === 'prepare') {
      if (flags['--output']) fail('INVALID_EXPERIMENT_ARGUMENTS');
      const protocol = prepareModelExperiment({ history, source: flags['--source'], league: flags['--league'], asOf: flags['--as-of'],
        createdAt: now, rawInputSha256, experimentCodeHash });
      await writeOnce(protocolPath, protocol);
      stdout(JSON.stringify({ protocolHash: protocol.protocolHash, split: protocol.split, releaseGate: 'BLOCKED' }) + '\n');
    } else {
      if (!flags['--output'] || ['--source', '--league', '--as-of'].some(key => flags[key])) fail('INVALID_EXPERIMENT_ARGUMENTS');
      const output = resolve(flags['--output']);
      if ([inputPath, protocolPath].includes(output)) fail('EXPERIMENT_OUTPUT_OVERLAPS_INPUT');
      const protocol = JSON.parse(await readFile(protocolPath, 'utf8'));
      const result = runModelExperiment({ history, protocol, rawInputSha256, experimentCodeHash, executedAt: now });
      await writeOnce(output, result);
      stdout(JSON.stringify({ protocolHash: protocol.protocolHash, snapshotStatus: result.snapshot.status,
        asObservedStatus: result.asObserved.status, releaseGate: 'BLOCKED' }) + '\n');
    }
    return 0;
  } catch { stderr('MODEL_EXPERIMENT_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runModelExperimentCli(process.argv.slice(2));
