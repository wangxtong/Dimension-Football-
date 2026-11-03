import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FORECAST_MODEL } from './forecast.mjs';
import { digest, isoMillis } from './policy.mjs';
import { evaluatePredictionLedger, frozenPredictionIssues, readPredictionLedger } from './prediction-ledger.mjs';

export const READINESS_LEAGUES = Object.freeze(['PL', 'PD', 'SA', 'BL1', 'FL1', 'CL', 'BSA']);
export const MINIMUM_PROSPECTIVE_PER_LEAGUE = 200;
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const matchesModel = (row, model) => row.model?.id === model.id && row.model?.version === model.version;
const eventKey = row => `${row.source}:${row.fixtureId}`;

/** Read-only diagnostics. A sample floor or model.calibrated flag never authorizes release. */
export async function buildModelReadiness({ directory, nowISO = new Date().toISOString(), model = FORECAST_MODEL,
  horizonHours = 1, toleranceHours = 1, sourceByLeague = {} } = {}) {
  if (typeof directory !== 'string' || !directory || !Number.isFinite(isoMillis(nowISO)) || !token(model?.id)
    || !Number.isSafeInteger(model.version) || typeof model.calibrated !== 'boolean'
    || !Number.isFinite(horizonHours) || horizonHours < 0 || horizonHours > 336
    || !Number.isFinite(toleranceHours) || toleranceHours < 0 || toleranceHours > 24
    || !sourceByLeague || typeof sourceByLeague !== 'object' || Array.isArray(sourceByLeague)
    || Object.entries(sourceByLeague).some(([key, value]) => !READINESS_LEAGUES.includes(key) || !token(value))) throw new Error('INVALID_MODEL_READINESS_OPTIONS');
  const modelHash = digest(model), now = isoMillis(nowISO);
  const base = { version: 1, kind: 'model-readiness', generatedAt: nowISO, releaseGate: 'BLOCKED', canRelease: false,
    model: { id: model.id, version: model.version, configurationHash: modelHash, calibrated: model.calibrated },
    protocol: { horizonHours, toleranceHours, horizonBasis: 'recordedAt', minimumPerLeague: MINIMUM_PROSPECTIVE_PER_LEAGUE,
      sampleFloorIsSufficient: false, countUnit: 'one-prediction-per-source-fixture-in-fixed-lead-window',
      sourcePooling: 'forbidden-without-reviewed-cross-source-identity', historicalBacktestsCountAsProspective: false },
    calibration: { status: model.calibrated ? 'UNVERIFIED' : 'NOT_CALIBRATED', evidenceVerified: false },
    baseline: { status: 'MISSING_FROZEN_BASELINE_COMPARISON', evidenceVerified: false },
    inputVisibility: { status: 'UNVERIFIED', note: 'A training hash and cutoff alone do not prove that every training input was visible at prediction time.' },
    limitations: ['Local content hashes detect inconsistent files; they are not signed proof of an external publication time.',
      'Only stored, settled, unexpired-at-registration predictions enter the selected cohort; backtest aggregates and training matches are never counted.',
      'Calibration and frozen-baseline validation are not implemented as release evidence. This report cannot promote a model.'] };
  let ledger;
  try { ledger = await readPredictionLedger({ directory }); }
  catch {
    return { ...base, ledger: { directory: resolve(directory), status: 'UNREADABLE_OR_INVALID' },
      blockers: ['LEDGER_INTEGRITY_UNVERIFIED', ...(model.calibrated ? [] : ['MODEL_NOT_CALIBRATED'])],
      leagues: READINESS_LEAGUES.map(league => ({ league, settledFrozenSamples: null, minimumSampleGap: null, sampleFloorSatisfied: false, releaseGate: 'BLOCKED' })) };
  }
  const predictions = ledger.events.flatMap(event => event.predictions).filter(row => matchesModel(row, model) && isoMillis(row.recordedAt) <= now);
  const opportunities = ledger.events.flatMap(event => event.opportunities).filter(row => matchesModel(row, model) && isoMillis(row.recordedAt) <= now);
  const eventsByPrediction = new Map(ledger.events.flatMap(event => event.predictions.map(row => [row.predictionId, event])));
  const leagues = [];
  for (const league of READINESS_LEAGUES) {
    const stored = predictions.filter(row => row.league === league), attempts = opportunities.filter(row => row.league === league);
    const sources = [...new Set([...stored, ...attempts].map(row => row.source))].sort();
    const source = sourceByLeague[league] || (sources.length === 1 ? sources[0] : null);
    const chosen = source ? stored.filter(row => row.source === source) : [];
    const assessment = source ? await evaluatePredictionLedger({ directory, ledger, nowISO, horizonHours, toleranceHours,
      modelId: model.id, modelVersion: model.version, modelHash, source, league }) : null;
    const count = assessment?.assessmentStatus === 'single-cohort' ? assessment.evaluations.length : 0;
    const registered = chosen.filter(row => Number.isFinite(isoMillis(row.generatedAt)) && isoMillis(row.generatedAt) <= isoMillis(row.recordedAt)
      && isoMillis(row.recordedAt) < isoMillis(row.kickoff));
    const pending = registered.filter(row => {
      const event = eventsByPrediction.get(row.predictionId);
      return !event?.results.some(result => isoMillis(result.resultObservedAt) <= now && isoMillis(result.recordedAt) <= now);
    });
    const reasons = ['CALIBRATION_EVIDENCE_UNVERIFIED', 'FROZEN_BASELINE_COMPARISON_MISSING', 'TRAINING_INPUT_VISIBILITY_UNVERIFIED'];
    if (count < MINIMUM_PROSPECTIVE_PER_LEAGUE) reasons.push('PROSPECTIVE_SAMPLE_FLOOR_NOT_MET');
    if (!source) reasons.push(sources.length ? 'SOURCE_COHORT_AMBIGUOUS' : 'NO_PROSPECTIVE_SOURCE');
    if (!model.calibrated) reasons.push('MODEL_NOT_CALIBRATED');
    leagues.push({ league, source, availableSources: sources, releaseGate: 'BLOCKED', blockers: reasons,
      storedPredictionRecords: stored.length, registeredPrematchMatches: new Set(registered.map(eventKey)).size,
      storedOpportunityRecords: attempts.length,
      registeredUnsettledMatches: new Set(pending.map(eventKey)).size,
      legacyOrInvalidFreezeRecords: chosen.filter(row => frozenPredictionIssues(row).length).length,
      freezeMetadataIssues: [...new Set(chosen.flatMap(frozenPredictionIssues))],
      frozenConfigurationMatches: chosen.filter(row => row.modelHash === modelHash).length,
      settledFrozenSamples: count, minimumSampleGap: Math.max(0, MINIMUM_PROSPECTIVE_PER_LEAGUE - count),
      sampleFloorSatisfied: count >= MINIMUM_PROSPECTIVE_PER_LEAGUE, releaseQualifiedSamples: 0,
      coverage: assessment?.coverage || null, metrics: assessment?.metrics || null,
      reliability: assessment?.reliability || null, uncertainty: assessment?.uncertainty || null,
      exclusionReasons: [...new Set((assessment?.exclusions || []).flatMap(row => [row.reason, ...(row.reasons || [])]))] });
  }
  return { ...base, ledger: { directory: resolve(directory), status: ledger.exists ? 'READ' : 'MISSING',
    snapshotHash: digest(ledger), eventCount: ledger.events.length, selectedModelPredictionRecords: predictions.length,
    selectedModelOpportunityRecords: opportunities.length }, leagues,
    blockers: [...new Set([...(!ledger.exists ? ['LEDGER_MISSING'] : []), ...leagues.flatMap(row => row.blockers)])] };
}

export async function runModelReadinessCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--ledger', '--now', '--horizon-hours', '--tolerance-hours'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error('INVALID_MODEL_READINESS_ARGUMENT');
      options[args[i]] = args[i + 1];
    }
    const result = await buildModelReadiness({ directory: options['--ledger'], nowISO: options['--now'],
      ...(options['--horizon-hours'] ? { horizonHours: Number(options['--horizon-hours']) } : {}),
      ...(options['--tolerance-hours'] ? { toleranceHours: Number(options['--tolerance-hours']) } : {}) });
    stdout(JSON.stringify(result, null, 2) + '\n');
    return 2; // A readable report with BLOCKED is an intentional gate result, not a CLI failure.
  } catch { stderr('MODEL_READINESS_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runModelReadinessCli(process.argv.slice(2));
