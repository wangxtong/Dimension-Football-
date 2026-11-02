import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPrediction, appendResultAndScore, readPredictionLedger } from '../prediction-ledger.mjs';
import { buildDailyResearchReport, renderDailyResearchMarkdown, produceDailyResearchReport } from '../research-daily-report.mjs';
import { requireGreenForecastDelivery } from '../publication-release-gate.mjs';
import { readJson } from '../storage.mjs';

const NOW = '2026-11-02T02:10:00.000Z', KICKOFF = '2026-11-03T00:00:00.000Z';
const NOW_PLUS = '2026-11-02T02:11:00.000Z';
const FT = '2026-11-03T03:00:00.000Z', SHA = 'a'.repeat(40), REPORT = 'b'.repeat(64);
const fixture = { id: 'match-27', source: 'openligadb', league: 'BL1', home: '主队', away: '客队',
  homeTeamId: 't1', awayTeamId: 't2', kickoff: KICKOFF, season: '2026', observedAt: NOW };
const model = { id: 'venue-poisson-v2', version: 2, calibrated: false };
const forecast = { fixtureId: fixture.id, status: 'forecast', generatedAt: NOW, trainingCutoff: NOW,
  trainingHash: 'c'.repeat(64), probabilities: { home: .6, draw: .2, away: .2 },
  freshness: { validUntil: '2026-11-02T03:10:00.000Z' } };
const doc = { version: 1, kind: 'prematch-forecast-report', generatedAt: NOW, simulated: false,
  publication: { reportId: REPORT }, summary: { fixtures: 1, forecasts: 1, strictCandidates: 0 },
  fixtures: [{ fixture, forecast }] };
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'dimension-research-daily-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function frozen(directory) {
  await appendPrediction({ directory, fixture, forecast, model, reportId: REPORT, nowISO: NOW });
  return readPredictionLedger({ directory });
}

test('separate research report exposes real frozen 1X2 with clear non-betting label and no commercial release', async t => {
  const root = await workspace(t), ledger = await frozen(join(root, 'forecast-ledger'));
  const report = buildDailyResearchReport({ document: doc, ledger, nowISO: NOW_PLUS, codeSha: SHA });
  assert.equal(report.beijingDay, '2026-11-02');
  assert.equal(report.forecasts.total, 1);
  assert.equal(report.forecasts.candidates[0].predictionId.length, 64);
  assert.equal(report.prospective.thirtyDays.scored, 0);
  assert.equal(report.strictMarkets.releasedCandidates, 0);
  assert.equal(report.commercialReleaseGate, 'BLOCKED');
  assert.equal(report.externalTelegramSent, false);
  assert.match(report.disclaimer, /非投注建议/);
  assert.match(renderDailyResearchMarkdown(report), /研究参考，非投注建议/);
  await assert.rejects(requireGreenForecastDelivery(root), /RELEASE_GATE_BLOCKED/);
});

test('true FT later scores exactly once, preserves original freeze and reports day/7/30 hit rate', async t => {
  const root = await workspace(t), directory = join(root, 'forecast-ledger');
  await frozen(directory);
  const result = { ...fixture, status: 'FINISHED', period: 'full-time', homeGoals: 2, awayGoals: 0,
    resultObservedAt: FT };
  const scored = await appendResultAndScore({ directory, result, nowISO: FT });
  assert.equal(scored.scores.length, 1);
  await appendResultAndScore({ directory, result: { ...result, resultObservedAt: '2026-11-03T03:10:00.000Z' },
    nowISO: '2026-11-03T03:10:00.000Z' });
  const report = buildDailyResearchReport({ document: doc, ledger: await readPredictionLedger({ directory }),
    nowISO: '2026-11-03T04:00:00.000Z', codeSha: SHA });
  assert.equal(report.forecasts.total, 0, 'Yesterday report is not relabeled as today');
  for (const window of [report.prospective.oneDay, report.prospective.sevenDays, report.prospective.thirtyDays]) {
    assert.equal(window.eligibleFrozen, 1);
    assert.equal(window.scored, 1);
    assert.equal(window.pending, 0);
    assert.equal(window.hitRate, 1);
    assert.ok(window.brier > 0 && window.brier < 2);
    assert.equal(window.sampleStatus, 'insufficient-prospective-sample');
  }
});

test('unsettled and future-observed results cannot be counted as wins', async t => {
  const root = await workspace(t), directory = join(root, 'forecast-ledger');
  const ledger = await frozen(directory);
  let r = buildDailyResearchReport({ document: null, ledger, nowISO: '2026-11-03T01:00:00.000Z', codeSha: SHA });
  assert.equal(r.prospective.oneDay.pending, 1);
  assert.equal(r.prospective.oneDay.scored, 0);
  const mutated = structuredClone(ledger);
  mutated.events[0].results.push({ ...fixture, kind:'result', resultVersionId:'d'.repeat(64),
    contentHash:'e'.repeat(64), resultObservedAt: '2026-11-03T03:00:00.000Z', recordedAt:'2026-11-03T03:00:00.000Z',
    status:'FINISHED', period:'full-time', homeGoals:2, awayGoals:0 });
  r = buildDailyResearchReport({ document: null, ledger: mutated,
    nowISO:'2026-11-03T01:00:00.000Z',codeSha:SHA });
  assert.equal(r.prospective.oneDay.scored, 0);
});

test('do not display simulated, stale-day, unknown-source, or unpersisted guesses', async t => {
  const root = await workspace(t);
  const ledger = await frozen(join(root,'forecast-ledger'));
  const stale = buildDailyResearchReport({ document: doc, ledger,
    nowISO: '2026-11-03T01:00:00.000Z', codeSha: SHA });
  assert.equal(stale.state, 'no-today-source-report');
  assert.equal(stale.forecasts.total, 0);
  const forged = { ...doc, publication: { reportId: 'f'.repeat(64) } };
  const missing = buildDailyResearchReport({ document: forged, ledger, nowISO: NOW_PLUS, codeSha: SHA });
  assert.equal(missing.forecasts.total, 0);
  assert.throws(() => buildDailyResearchReport({ document: { ...doc, simulated: true },
    ledger, nowISO: NOW_PLUS, codeSha: SHA }), /RESEARCH_SOURCE_REPORT_INVALID/);
  assert.throws(() => buildDailyResearchReport({ document: doc, ledger, nowISO: NOW_PLUS,
    codeSha: 'not-sha' }), /RESEARCH_INPUT_INVALID/);
  const unknownSource = structuredClone(ledger);
  unknownSource.events[0].predictions[0].source = 'unreviewed-source';
  assert.equal(buildDailyResearchReport({ document: doc, ledger: unknownSource,
    nowISO: NOW_PLUS, codeSha: SHA }).forecasts.total, 0);
});

test('real persisted ledger is re-read independently and emits immutable-identified daily artifact', async t => {
  const root = await workspace(t), directory = join(root,'reports/forecast-ledger');
  await frozen(directory);
  const { atomicJson } = await import('../storage.mjs');
  await atomicJson(join(root,'reports/predictions.json'),doc);
  const report = await produceDailyResearchReport({ root, nowISO: NOW_PLUS, codeSha: SHA });
  const reopened = await readJson(join(root,'reports/research-daily/latest.json'));
  assert.equal(reopened.reportId, report.reportId);
  assert.equal(reopened.forecasts.total, 1);
  assert.equal(reopened.researchGate, 'INDEPENDENT_OF_COMMERCIAL');
});

test('four-to-six-day archived genuine freezes count as prospective samples but not todays 36h selection', async t => {
  const root=await workspace(t),directory=join(root,'forecast-ledger');
  const future={...fixture,kickoff:'2026-11-08T14:30:00.000Z'};
  await appendPrediction({directory,fixture:future,forecast,model,reportId:REPORT,nowISO:NOW});
  const ledger=await readPredictionLedger({directory});
  const study=buildDailyResearchReport({document:{...doc,fixtures:[{fixture:future,forecast}]},
    ledger,nowISO:NOW_PLUS,codeSha:SHA});
  assert.equal(study.state,'zero-qualified-forecasts');
  assert.equal(study.forecasts.total,0);
  assert.equal(study.forecasts.skipped,1);
  assert.equal(study.prospective.retainedFrozen,1);
  assert.equal(study.prospective.oneDay.scored,0);
  assert.equal(study.prospective.sevenDays.scored,0);
});
