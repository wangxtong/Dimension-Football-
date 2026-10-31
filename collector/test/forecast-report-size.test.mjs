import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildForecasts, BACKTEST_HORIZONS } from '../forecast.mjs';
import { predictionDocument } from '../forecast-report.mjs';

const NOW = '2026-10-31T04:00:00.000Z';
const at = hours => new Date(Date.parse(NOW) + hours * 3600000).toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
function history() {
  const rows = [];
  for (let round = 0; round < 12; round++) for (let home = 1; home <= 4; home++) for (let away = 1; away <= 4; away++) {
    if (home === away) continue;
    rows.push({ id: `history-${rows.length}`, source: 'openligadb', league: 'BL1', season: '2026',
      home: `Club ${home}`, away: `Club ${away}`, homeTeamId: String(home), awayTeamId: String(away),
      kickoff: at((-150 + rows.length) * 24), homeGoals: (round + home) % 4, awayGoals: (round + away) % 3,
      status: 'FINISHED', period: 'full-time' });
  }
  return rows;
}
function modelReport(count) {
  // Distinct publication lead times exercise count + four reference backtests,
  // rather than accidentally hiding repeated detail behind the model's cache.
  const fixtures = Array.from({ length: count }, (_, index) => ({ id: `next-${index}`, source: 'openligadb', league: 'BL1',
    season: '2026', home: 'Club 1', away: 'Club 2', homeTeamId: '1', awayTeamId: '2',
    kickoff: at(24.125 + index * .5), status: 'SCHEDULED', updatedAt: NOW }));
  const forecasts = buildForecasts({ fixtures, history: history(), nowISO: NOW });
  return { completedAt: NOW, simulated: false, forecasts,
    publication: { reportId: 'a'.repeat(64), externalDelivery: 'see-receipt' },
    summary: { total: count, forecasts: forecasts.summary.forecasts, forecastUnavailable: forecasts.summary.unavailable, candidates: 0 },
    results: fixtures.map((fixture, index) => ({ fixture, forecast: forecasts.rows[index], result: { status: 'source_insufficient', reasons: [] } })) };
}

for (const count of [50, 100]) test(`${count} actual model forecasts publish bounded aggregate backtests without changing predictions`, t => {
  const report = modelReport(count), originalBacktests = JSON.stringify(report.forecasts.backtests);
  assert.equal(report.forecasts.summary.forecasts, count);
  assert.equal(report.forecasts.backtests.length, count + BACKTEST_HORIZONS.length);
  assert.ok(report.forecasts.backtests.every(row => row.evaluations.length > 0));
  const doc = predictionDocument(report);
  assert.equal(doc.backtests.length, report.forecasts.backtests.length);
  for (let index = 0; index < doc.backtests.length; index++) {
    const { evaluations, exclusions, ...expected } = report.forecasts.backtests[index];
    assert.deepEqual(doc.backtests[index], expected);
    assert.ok(!Object.hasOwn(doc.backtests[index], 'evaluations'));
    assert.ok(!Object.hasOwn(doc.backtests[index], 'exclusions'));
  }
  for (let index = 0; index < count; index++) {
    assert.deepEqual(doc.fixtures[index].fixture, report.results[index].fixture);
    assert.deepEqual(doc.fixtures[index].forecast, report.results[index].forecast);
  }
  assert.equal(JSON.stringify(report.forecasts.backtests), originalBacktests, 'full report keeps every detailed evaluation and exclusion');
  assert.deepEqual(doc.backtestDetails, { availability: 'collector-output', file: 'collection-20261031T040000Z.json',
    reportId: report.publication.reportId, jsonPointer: '/forecasts/backtests', sha256: hash(report.forecasts.backtests),
    hashEncoding: 'JSON.stringify/UTF-8' });
  const compactBytes = Buffer.byteLength(JSON.stringify(doc));
  const prettyBytes = Buffer.byteLength(JSON.stringify(doc, null, 2));
  const previousBytes = Buffer.byteLength(JSON.stringify({ ...doc, backtests: report.forecasts.backtests }));
  t.diagnostic(`${count} fixtures / ${doc.backtests.length} backtests: prior ${previousBytes} bytes; aggregate ${compactBytes} bytes; pretty JSON ${prettyBytes} bytes`);
  assert.ok(previousBytes > 4 * 1024 * 1024, 'the fixture reproduces the former 4 MiB delivery failure');
  assert.ok(compactBytes < previousBytes / 3, 'remove repeated per-match vectors, not model metrics');
  assert.ok(prettyBytes < 4 * 1024 * 1024, 'even the on-disk pretty prediction document fits the unchanged feed limit');
  // This is a supported sample-size check, not a promise that every 3000-match
  // pool fits. The report store must still reject an oversized complete bundle.
});

test('prospective ledger groups expose summaries and verifiable local detail references', () => {
  const group = { source: 'openligadb', league: 'BL1', provenance: 'prospective-ledger', horizonHours: 24, toleranceHours: 1,
    filters: { source: 'openligadb', league: 'BL1' }, evaluations: [{ predictionId: 'prediction', actual: 'home' }],
    exclusions: [{ fixtureId: 'unavailable', reason: 'FORECAST_UNAVAILABLE' }],
    metrics: { brier: .5, logLoss: .7, accuracy: 1 }, coverage: { eligible: 3, evaluated: 1, skipped: 1, pending: 1 },
    reliability: { home: [{ count: 1, status: 'insufficient-bin-sample' }] }, uncertainty: { status: 'insufficient-sample' } };
  const report = { completedAt: NOW, simulated: false, summary: { total: 0, candidates: 0 }, results: [],
    publication: { reportId: 'b'.repeat(64) },
    prospectiveEvaluation: { version: 1, generatedAt: NOW, groups: [group], summary: { recordedScores: 1 } } };
  const original = structuredClone(report), doc = predictionDocument(report);
  const { evaluations, exclusions, ...summary } = group;
  assert.deepEqual(doc.prospectiveEvaluation.groups, [summary]);
  assert.deepEqual(report, original);
  assert.equal(doc.prospectiveEvaluation.details.jsonPointer, '/prospectiveEvaluation');
  assert.equal(doc.prospectiveEvaluation.details.sha256, hash(report.prospectiveEvaluation));
  assert.equal(doc.prospectiveEvaluation.details.reportId, report.publication.reportId);
  assert.equal(doc.backtestDetails, null);
  report.prospectiveEvaluation.groups[0].evaluations[0].actual = 'away';
  assert.notEqual(predictionDocument(report).prospectiveEvaluation.details.sha256, doc.prospectiveEvaluation.details.sha256);
});
