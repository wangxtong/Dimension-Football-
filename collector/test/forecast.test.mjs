import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildForecasts, prepareForecastHistory, poissonProbabilities, walkForwardBacktest, FORECAST_MODEL } from '../forecast.mjs';
import { runCollection } from '../pipeline.mjs';
import { runCli } from '../run.mjs';
import { renderPredictionsHtml } from '../forecast-report.mjs';

const NOW = '2026-10-31T04:00:00.000Z', DAY = 86400000;
const at = (days, hours = 0) => new Date(Date.parse(NOW) + days * DAY + hours * 3600000).toISOString();
const fixture = () => ({ id: 'test-next', source: 'openligadb', league: 'BL1', home: 'Home Club', away: 'Away Club',
  homeTeamId: '1', awayTeamId: '2', kickoff: at(1), status: 'SCHEDULED', updatedAt: NOW });
function history() {
  const rows = [];
  for (let round = 0; round < 12; round++) for (let home = 1; home <= 4; home++) for (let away = 1; away <= 4; away++) {
    if (home === away) continue;
    rows.push({ id: `history-${rows.length}`, source: 'openligadb', league: 'BL1', home: `Club ${home}`, away: `Club ${away}`,
      homeTeamId: String(home), awayTeamId: String(away), kickoff: at(-150 + rows.length), homeGoals: (round + home) % 4,
      awayGoals: (round + away) % 3, status: 'FINISHED', period: 'full-time' });
  }
  return rows;
}
const predict = (past = history(), match = fixture(), extra = {}) => buildForecasts({ fixtures: [match], history: past, nowISO: NOW, ...extra });
async function workspace(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'football-forecast-'));
  t.after(() => rm(cwd, { recursive: true, force: true })); return cwd;
}

test('Poisson probabilities are normalized, symmetric and respond to stronger home scoring', () => {
  const symmetric = poissonProbabilities(1.5, 1.5), stronger = poissonProbabilities(2.5, 1.5);
  assert.ok(Math.abs(Object.values(symmetric.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(symmetric.probabilities.home - symmetric.probabilities.away) < 1e-12);
  assert.ok(stronger.probabilities.home > symmetric.probabilities.home);
  assert.ok(stronger.probabilities.away < symmetric.probabilities.away);
  assert.ok(symmetric.topScores.every(row => row.probability > 0 && row.probability < 1));
  for (const invalid of [0, 5, NaN, Infinity]) assert.throws(() => poissonProbabilities(invalid, 1));
});

test('real-shaped history creates a traceable baseline forecast without any odds', () => {
  const report = predict(), p = report.rows[0];
  assert.equal(p.status, 'forecast'); assert.equal(report.summary.forecasts, 1);
  assert.equal(report.model.calibrated, false); assert.equal(p.confidence, 'uncalibrated-baseline');
  assert.equal(p.sample.league, 144); assert.equal(p.trainingCutoff, NOW);
  assert.match(p.trainingHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(p.probabilities).every(value => value > 0 && value < 1));
  assert.ok(!Object.hasOwn(p, 'asianWinProbability'));
  assert.equal(p.completeness.passed, p.completeness.total);
  assert.equal(p.completeness.globalCoverage, 'unknown');
  assert.ok(p.strength.homeAttack > 0);
  assert.ok(p.validation.evaluated >= 30);
  assert.equal(Date.parse(p.freshness.validUntil) - Date.parse(NOW), 3600000);
});

test('sufficient current samples but insufficient retrospective validation are not displayed as forecasts', () => {
  const result = predict(history().slice(-55)).rows[0];
  assert.equal(result.status, 'unavailable');
  assert.ok(result.reasons.includes('BACKTEST_INSUFFICIENT'));
  assert.ok(!Object.hasOwn(result, 'probabilities'));
});

test('ordinary forecasts expire after one hour even before kickoff', async t => {
  const cwd = await workspace(t); let now = NOW;
  const result = await runCollection({ fixtures: [fixture()], history: history(), statePath: join(cwd, 'state.json'), outDir: cwd,
    clock: () => now, collectEvidence: async () => { now = at(0, 1); return { quotes: [], signals: [], diagnostics: [] }; } });
  assert.equal(result.report.summary.forecasts, 0);
  assert.deepEqual(result.report.results[0].forecast.reasons, ['FORECAST_EXPIRED']);
});

test('future results, same-fixture results and recently started games never affect a prediction', () => {
  const base = predict().rows[0], seed = history()[0];
  const injected = [
    { ...seed, id: 'future', kickoff: at(2), homeGoals: 20, awayGoals: 0 },
    { ...seed, id: fixture().id, kickoff: at(-1), homeGoals: 20, awayGoals: 0 },
    { ...seed, id: 'too-recent', kickoff: at(0, -1), homeGoals: 20, awayGoals: 0 },
  ];
  const checked = predict([...history(), ...injected]).rows[0];
  assert.deepEqual(checked.probabilities, base.probabilities);
  assert.equal(checked.trainingHash, base.trainingHash);
});

test('source and numeric team identity take precedence over matching team names', () => {
  const past = history();
  assert.equal(predict(past.map(row => ({ ...row, source: 'other-provider' }))).rows[0].status, 'unavailable');
  assert.equal(predict(past.map(row => ({ ...row, league: 'PL' }))).rows[0].status, 'unavailable');
  const wrong = predict(past, { ...fixture(), homeTeamId: '999' }).rows[0];
  assert.equal(wrong.status, 'unavailable'); assert.ok(wrong.reasons.includes('HOME_HISTORY_INSUFFICIENT'));
  assert.deepEqual(predict(past, { ...fixture(), home: 'Club renamed' }).rows[0].probabilities, predict().rows[0].probabilities);
  assert.ok(predict(past, { ...fixture(), homeTeamId: undefined }).rows[0].reasons.includes('TEAM_ID_REQUIRED'));
});

test('small or stale samples do not produce fallback probabilities', () => {
  for (const past of [[], history().slice(-5), history().map(row => ({ ...row, kickoff: at(-300) }))]) {
    const result = predict(past).rows[0];
    assert.equal(result.status, 'unavailable'); assert.ok(!Object.hasOwn(result, 'probabilities'));
  }
  assert.equal(predict(history(), { ...fixture(), status: 'POSTPONED' }).rows[0].status, 'unavailable');
  assert.equal(predict(history(), { ...fixture(), kickoff: NOW }).rows[0].status, 'unavailable');
  assert.equal(predict(history(), fixture(), { simulated: true }).summary.forecasts, 0);
});

test('history normalization rejects wrong periods and malformed scores, detects conflicts and strips raw fields', () => {
  const seed = history()[0], secret = 'raw-private-header';
  const clean = prepareForecastHistory([{ ...seed, authorization: secret }, seed,
    { ...seed, id: 'negative', homeGoals: -1 }, { ...seed, id: 'half', period: 'half-time' }, { ...seed, id: 'bad-date', kickoff: '2026-02-30T00:00:00Z' }]);
  assert.equal(clean.matches.length, 1); assert.equal(clean.duplicates, 1); assert.equal(clean.rejected, 3);
  assert.ok(!JSON.stringify(clean).includes(secret));
  assert.throws(() => prepareForecastHistory([seed, { ...seed, homeGoals: seed.homeGoals + 1 }]), { message: 'CONFLICTING_HISTORY_ID' });
  assert.throws(() => prepareForecastHistory({}), { message: 'INVALID_HISTORY_FILE' });
});

test('rolling validation is bounded and cannot use games after the evaluation timestamp', () => {
  const past = prepareForecastHistory(history()).matches;
  const args = { source: 'openligadb', league: 'BL1', nowISO: NOW };
  const result = walkForwardBacktest(past, args);
  assert.equal(result.evaluated, FORECAST_MODEL.backtestLimit);
  assert.equal(result.method, 'chronological-walk-forward');
  assert.ok(result.metrics.brier >= 0 && result.metrics.brier <= 2);
  assert.ok(result.metrics.logLoss > 0 && result.metrics.baselineLogLoss > 0);
  const future = { ...past.at(-1), id: 'future', kickoff: at(1), homeGoals: 20 };
  assert.deepEqual(walkForwardBacktest([...past, future], args), result);
  const interrupted = walkForwardBacktest(past, { ...args, remaining: () => 0 });
  assert.equal(interrupted.interrupted, true); assert.equal(interrupted.metrics, null);
});

test('backtest lead times exclude information acquired between the forecast and kickoff', () => {
  const past = history(), target = past.at(-1), options = { source: 'openligadb', league: 'BL1', nowISO: NOW };
  const between = { ...target, id: 'between-generation-and-kickoff', kickoff: new Date(Date.parse(target.kickoff) - 12 * 3600000).toISOString(), homeGoals: 20 };
  const evaluation = (rows, horizonHours) => walkForwardBacktest(prepareForecastHistory(rows).matches, { ...options, horizonHours }).evaluations.find(row => row.fixtureId === target.id);
  assert.deepEqual(evaluation(past, 24).probabilities, evaluation([...past, between], 24).probabilities);
  assert.notDeepEqual(evaluation(past, 1).probabilities, evaluation([...past, between], 1).probabilities);
  const report = predict(past, { ...fixture(), kickoff: at(0, 13.5) });
  assert.equal(report.rows[0].validation.horizonHours, 13.5);
  assert.deepEqual([1, 24, 72, 168].filter(hours => report.backtests.some(row => row.horizonHours === hours)), [1, 24, 72, 168]);
});

test('history metadata preserves observed-time provenance and isolates same matches under different IDs', () => {
  const seed = history()[0], withMetadata = { ...seed, season: 2026, observedAt: NOW, resultObservedAt: NOW,
    fetchedAt: NOW, sourceUpdatedAt: null, authorization: 'must-not-retain' };
  const normalized = prepareForecastHistory([withMetadata]).matches[0];
  assert.equal(normalized.season, '2026'); assert.equal(normalized.resultObservedAt, NOW);
  assert.match(normalized.revisionId, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(normalized).includes('must-not-retain'));
  assert.equal(prepareForecastHistory([{ ...withMetadata, observedAt: 'bad-date' }]).rejected, 1);
  const conflict = prepareForecastHistory([seed, { ...seed, id: 'another-provider-id-for-same-match' }]);
  assert.equal(conflict.matches.length, 0); assert.equal(conflict.logicalConflicts, 2);
  const observedNow = history().map(row => ({ ...row, observedAt: NOW }));
  const options = { source: 'openligadb', league: 'BL1', nowISO: NOW, horizonHours: 24 };
  assert.equal(walkForwardBacktest(observedNow, { ...options, visibility: 'as-observed' }).evaluated, 0);
  assert.ok(walkForwardBacktest(observedNow, { ...options, visibility: 'snapshot' }).evaluated > 0);
});

test('effective and seasonal samples disclose a cold start without inventing roster effects', () => {
  const rows = history().map((row, i) => ({ ...row, season: i < 140 ? '2025' : '2026' }));
  const { sample, sampleQuality } = predict(rows, { ...fixture(), season: '2026' }).rows[0];
  assert.equal(sampleQuality.currentSeason.league, 4);
  assert.equal(sampleQuality.coldStart.status, 'limited-current-season');
  assert.ok(sampleQuality.weighted.home.effectiveMatches <= sample.home);
  assert.ok(sampleQuality.weighted.home.weightedMatches < sample.home);
});

test('reversing all home/away venues reverses the predicted rates and outcomes', () => {
  const before = predict().rows[0];
  const reverse = row => ({ ...row, home: row.away, away: row.home, homeTeamId: row.awayTeamId, awayTeamId: row.homeTeamId,
    homeGoals: row.awayGoals, awayGoals: row.homeGoals });
  const after = predict(history().map(reverse), reverse(fixture())).rows[0];
  assert.ok(Math.abs(before.probabilities.home - after.probabilities.away) < 1e-12);
  assert.ok(Math.abs(before.expectedGoals.home - after.expectedGoals.away) < 1e-12);
});

test('odds collection failure still writes usable forecast files without creating strict candidates', async t => {
  const cwd = await workspace(t);
  const result = await runCollection({ fixtures: [fixture()], history: history(), statePath: join(cwd, 'state.json'), outDir: cwd,
    clock: () => NOW, collectEvidence: async () => { throw new Error('unavailable odds'); } });
  assert.equal(result.report.status, 'failed'); assert.equal(result.report.summary.forecasts, 1);
  assert.equal(result.report.summary.candidates, 0);
  const published = JSON.parse(await readFile(result.files.predictionsPath, 'utf8'));
  assert.equal(published.summary.forecasts, 1); assert.equal(published.publication.externalDelivery, 'see-receipt');
  assert.ok((await readFile(result.files.predictionsHtmlPath, 'utf8')).includes('Home Club'));
  assert.ok((await readFile(result.files.briefPath, 'utf8')).includes('赛前预测 1 场'));
});

test('a game that starts during collection has its forecast withdrawn before publication', async t => {
  const cwd = await workspace(t); let now = NOW;
  const result = await runCollection({ fixtures: [fixture()], history: history(), statePath: join(cwd, 'state.json'), outDir: cwd,
    clock: () => now, collectEvidence: async () => { now = at(1); return { quotes: [], signals: [], diagnostics: [] }; } });
  assert.equal(result.report.summary.forecasts, 0);
  assert.deepEqual(result.report.results[0].forecast.reasons, ['NOT_PREMATCH']);
  assert.ok(!JSON.stringify(result.report.results[0].forecast).includes('probabilities'));
});

test('history changes refresh probabilities even when unchanged market evidence is reused', async t => {
  let now = NOW;
  const cwd = await workspace(t), args = { fixtures: [fixture()], statePath: join(cwd, 'state.json'), outDir: cwd,
    clock: () => now, collectEvidence: async () => ({ quotes: [], signals: [], diagnostics: [] }) };
  const before = await runCollection({ ...args, history: history() });
  now = new Date(Date.parse(NOW) + 1).toISOString();
  const after = await runCollection({ ...args, history: history().map(row => row.homeTeamId === '1' ? { ...row, homeGoals: row.homeGoals + 2 } : row) });
  assert.equal(after.report.summary.reused, 1);
  assert.notDeepEqual(after.report.results[0].forecast.probabilities, before.report.results[0].forecast.probabilities);
});

test('CLI supports a separate history file and safely renders hostile team labels', async t => {
  const cwd = await workspace(t), match = { ...fixture(), home: '<script>alert(1)</script>' };
  await writeFile(join(cwd, 'fixtures.json'), JSON.stringify([match]));
  await writeFile(join(cwd, 'history.json'), JSON.stringify({ history: history() }));
  const result = await runCli(['--input', 'fixtures.json', '--history', 'history.json'], { cwd, env: {}, clock: () => NOW,
    stdout: () => {}, fetchImpl: async () => new Response('User-agent: *\nDisallow: /') });
  assert.equal(result.report.summary.forecasts, 1);
  const html = renderPredictionsHtml(result.report);
  assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>alert'));
  await writeFile(join(cwd, 'bad-history.json'), '{}');
  await assert.rejects(runCli(['--input', 'fixtures.json', '--history', 'bad-history.json'], { cwd, env: {}, stdout: () => {} }), { message: 'INVALID_HISTORY_FILE' });
});
