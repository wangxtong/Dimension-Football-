import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { FORECAST_MODEL, BACKTEST_HORIZONS } from './forecast.mjs';
import { digest, isoMillis } from './policy.mjs';
import { createResultVersion, frozenPredictionIssues, readPredictionLedger, scorePredictionRecord } from './prediction-ledger.mjs';

const counts = () => ({ awaitingKickoff: 0, awaitingResult: 0, postponed: 0, settled: 0, void: 0, ambiguous: 0, invalidFreeze: 0, invalidResult: 0 });
const statusKey = { 'awaiting-kickoff': 'awaitingKickoff', 'awaiting-result': 'awaitingResult',
  'pending-postponed': 'postponed', scored: 'settled', 'void-result': 'void',
  'void-identity-or-schedule-changed': 'void', 'ambiguous-result': 'ambiguous', 'invalid-freeze': 'invalidFreeze', 'invalid-result': 'invalidResult' };

/** Read-only progress. This never widens evaluation windows, writes scores or proves publication. */
export async function buildSettlementReadiness({ directory, nowISO = new Date().toISOString(), model = FORECAST_MODEL } = {}) {
  const now = isoMillis(nowISO);
  if (typeof directory !== 'string' || !directory || !Number.isFinite(now) || !model || typeof model.id !== 'string'
    || !Number.isSafeInteger(model.version)) throw new Error('INVALID_SETTLEMENT_READINESS_OPTIONS');
  const ledger = await readPredictionLedger({ directory }), modelHash = digest(model), groups = new Map(), rows = [];
  let selectedPredictionRecords = 0, otherModelRecords = 0;
  for (const event of ledger.events) {
    const observed = event.predictions.filter(row => isoMillis(row.recordedAt) <= now);
    const predictions = observed.filter(row => row.model?.id === model.id && row.model?.version === model.version && row.modelHash === modelHash);
    otherModelRecords += observed.length - predictions.length;
    if (!predictions.length) continue;
    selectedPredictionRecords += predictions.length;
    const valid = predictions.filter(row => frozenPredictionIssues(row).length === 0)
      .sort((a, b) => isoMillis(b.recordedAt) - isoMillis(a.recordedAt) || a.predictionId.localeCompare(b.predictionId));
    const chosen = valid[0] || predictions[0], windows = BACKTEST_HORIZONS.filter(horizon => valid.some(row => {
      const lead = (isoMillis(row.kickoff) - isoMillis(row.recordedAt)) / 3600000;
      return lead >= horizon && lead <= horizon + 1;
    }));
    const resultVersions = event.results.filter(result => Number.isFinite(isoMillis(result.resultObservedAt))
      && Number.isFinite(isoMillis(result.recordedAt)) && isoMillis(result.resultObservedAt) <= now && isoMillis(result.recordedAt) <= now)
      .sort((a, b) => isoMillis(b.resultObservedAt) - isoMillis(a.resultObservedAt) || a.resultVersionId.localeCompare(b.resultVersionId));
    let status = 'invalid-freeze', resultVersionId = null;
    if (valid.length) {
      if (!resultVersions.length) status = isoMillis(chosen.kickoff) > now ? 'awaiting-kickoff' : 'awaiting-result';
      else if (resultVersions[1] && isoMillis(resultVersions[1].resultObservedAt) === isoMillis(resultVersions[0].resultObservedAt)) status = 'ambiguous-result';
      else {
        resultVersionId = resultVersions[0].resultVersionId;
        const result = resultVersions[0];
        try {
          const rebuilt = createResultVersion({ ...result, id: result.fixtureId });
          if (rebuilt.contentHash !== result.contentHash || rebuilt.resultVersionId !== result.resultVersionId
            || isoMillis(result.recordedAt) < isoMillis(result.resultObservedAt)) throw new Error('INVALID_STORED_RESULT');
          status = scorePredictionRecord(chosen, result).status;
        } catch { status = 'invalid-result'; }
      }
    }
    const key = JSON.stringify([chosen.source, chosen.league]);
    if (!groups.has(key)) groups.set(key, { source: chosen.source, league: chosen.league, fixtures: 0, ...counts(),
      outsideReferenceWindows: 0, referenceWindows: BACKTEST_HORIZONS.map(horizonHours => ({ horizonHours, toleranceHours: 1, fixtures: 0 })) });
    const group = groups.get(key); group.fixtures++; group[statusKey[status]]++;
    if (valid.length && !windows.length) group.outsideReferenceWindows++;
    for (const row of group.referenceWindows) if (windows.includes(row.horizonHours)) row.fixtures++;
    rows.push({ source: chosen.source, fixtureId: chosen.fixtureId, league: chosen.league,
      predictionId: chosen.predictionId, recordedAt: chosen.recordedAt, kickoff: chosen.kickoff,
      horizonHours: (isoMillis(chosen.kickoff) - isoMillis(chosen.recordedAt)) / 3600000,
      status, resultVersionId, fixedReferenceWindows: windows, storedPredictions: predictions.length,
      invalidFreezeRecords: predictions.length - valid.length });
  }
  rows.sort((a, b) => a.kickoff.localeCompare(b.kickoff) || a.fixtureId.localeCompare(b.fixtureId));
  const ordered = [...groups.values()].sort((a, b) => `${a.source}:${a.league}`.localeCompare(`${b.source}:${b.league}`));
  const summary = { fixtures: rows.length, ...counts(), outsideReferenceWindows: 0 };
  for (const group of ordered) for (const key of [...Object.keys(counts()), 'outsideReferenceWindows']) summary[key] += group[key];
  return { version: 1, kind: 'settlement-readiness', generatedAt: nowISO, releaseGate: 'BLOCKED', canRelease: false,
    scope: 'retained-freezes-not-publication-proof', publicationVerified: false,
    model: { id: model.id, version: model.version, configurationHash: modelHash },
    ledger: { exists: ledger.exists, snapshotHash: digest(ledger), selectedPredictionRecords, otherModelRecords },
    protocol: { countUnit: 'one-source-fixture-for-selected-model-configuration', latestValidFreezeForStatus: true,
      referenceHorizons: [...BACKTEST_HORIZONS], toleranceHours: 1, evaluationWindowsChanged: false,
      scoreBasis: 'recomputed-from-retained-prediction-and-result', scorePersistenceVerified: false },
    summary, groups: ordered, fixtures: rows,
    limitations: ['A past kickoff does not prove a finished match; awaiting-result includes matches still in play or delayed.',
      'Settled means the retained result can score the freeze; this reader does not inspect persisted score files.',
      'Settled retained forecasts are not proof of public publication or independent model validation.',
      'Outside-window settlements do not enter the fixed 1/24/72/168-hour cohorts; no performance metric is pooled here.',
      'Local hashes verify retained file consistency, not external publication times or source-result truth.'] };
}

export async function runSettlementReadinessCli(args, { stdout = value => process.stdout.write(value), stderr = value => process.stderr.write(value) } = {}) {
  try {
    const flags = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--ledger', '--now'].includes(args[i]) || !args[i + 1] || Object.hasOwn(flags, args[i])) throw new Error('INVALID_ARGUMENTS');
      flags[args[i]] = args[i + 1];
    }
    const result = await buildSettlementReadiness({ directory: flags['--ledger'], nowISO: flags['--now'] });
    stdout(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch { stderr('SETTLEMENT_READINESS_FAILED\n'); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runSettlementReadinessCli(process.argv.slice(2));
