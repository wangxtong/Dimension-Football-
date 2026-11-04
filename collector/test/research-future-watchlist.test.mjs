import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendPrediction, readPredictionLedger } from '../prediction-ledger.mjs';
import { buildDailyResearchReport, renderDailyResearchMarkdown } from '../research-daily-report.mjs';
import { validateDailyResearch } from '../../website/research-daily-store.mjs';

const NOW = '2026-11-04T02:10:00.000Z';
const KICKOFF = '2026-11-07T14:30:00.000Z';
const SHA = 'a'.repeat(40), REPORT = 'b'.repeat(64);
const fixture = { id: 'oldb-example-early', source: 'openligadb', league: 'BL1',
  home: '多特蒙德', away: '奥格斯堡', homeTeamId: 'team-12', awayTeamId: 'team-34',
  kickoff: KICKOFF, season: '2026', observedAt: NOW };
const model = { id: 'venue-poisson-v2', version: 2, calibrated: false };
const forecast = { fixtureId: fixture.id, status: 'forecast', generatedAt: NOW, trainingCutoff: NOW,
  trainingHash: 'c'.repeat(64), probabilities: { home: .6, draw: .25, away: .15 },
  freshness: { validUntil: '2026-11-04T03:10:00.000Z' } };
const document = { version: 1, kind: 'prematch-forecast-report', generatedAt: NOW, simulated: false,
  publication: { reportId: REPORT }, summary: { fixtures: 1, forecasts: 1, strictCandidates: 0 },
  fixtures: [{ fixture, forecast }] };
async function prepared(t) {
  const root = await mkdtemp(join(tmpdir(), 'df-early-research-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'ledger');
  await appendPrediction({directory:path, fixture, forecast, model, reportId:REPORT, nowISO:NOW});
  return readPredictionLedger({directory:path});
}

test('a genuine >36h future forecast is visible only as preliminary watchlist, not a qualified pick', async t => {
  const ledger = await prepared(t);
  const report = buildDailyResearchReport({ document, ledger,
    nowISO:'2026-11-04T02:11:00.000Z', codeSha:SHA });
  assert.equal(report.forecasts.total, 0);
  assert.equal(report.forecasts.candidates.length, 0);
  assert.equal(report.strictMarkets.releasedCandidates,0);
  assert.equal(report.commercialReleaseGate,'BLOCKED');
  assert.equal(report.externalTelegramSent,false);
  assert.equal(report.prospective.retainedFrozen,1);
  assert.equal(report.prospective.frozenLooseList[0].home,'多特蒙德');
  assert.equal(report.prospective.frozenLooseList[0].away,'奥格斯堡');
  const md=renderDailyResearchMarkdown(report);
  assert.match(md,/今日有效冻结 0 场/);
  assert.match(md,/未来7天的远期模型观察/);
  assert.match(md,/多特蒙德 vs 奥格斯堡/);
  assert.match(md,/非当期36小时合格冻结、非实时盘口、非投注建议/);
  await validateDailyResearch(report,{now:Date.parse(report.generatedAt),fresh:true});
});

test('contradictory fixture IDs isolate watchlist names instead of inventing matched fixtures',async t=>{
  const ledger=await prepared(t);
  const conflict=structuredClone(document);
  conflict.fixtures[0].fixture.homeTeamId='unrelated-id';
  const report=buildDailyResearchReport({document:conflict,ledger,nowISO:'2026-11-04T02:11:00.000Z',codeSha:SHA});
  assert.equal(report.prospective.retainedFrozen,1,'immutable ledger remains');
  assert.equal(report.prospective.frozenLooseList[0].home,undefined);
  assert.doesNotMatch(renderDailyResearchMarkdown(report),/多特蒙德 vs 奥格斯堡/);
  assert.equal(report.forecasts.total,0);
  assert.equal(report.strictMarkets.releasedCandidates,0);
});

test('a source report from a previous Beijing day never acquires invented watchlist names',async t=>{
  const ledger=await prepared(t);
  const report=buildDailyResearchReport({document,ledger,nowISO:'2026-11-05T02:11:00.000Z',codeSha:SHA});
  assert.equal(report.state,'no-today-source-report');
  assert.equal(report.prospective.frozenLooseList[0].home,undefined);
  assert.doesNotMatch(renderDailyResearchMarkdown(report),/多特蒙德 vs 奥格斯堡/);
});
