import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FORECAST_MODEL } from '../forecast.mjs';
import { digest } from '../policy.mjs';
import { appendPrediction, appendResultAndScore, evaluatePredictionLedger } from '../prediction-ledger.mjs';
import { buildSettlementReadiness, runSettlementReadinessCli } from '../settlement-readiness.mjs';

const NOW = '2026-10-31T12:00:00.000Z', finished = '2026-11-01T14:00:00.000Z';
const fixture = { id: 'event-1', source: 'openligadb', league: 'BL1', homeTeamId: '1', awayTeamId: '2', kickoff: '2026-11-01T12:00:00.000Z', season: '2026' };
const forecast = { fixtureId: fixture.id, status: 'forecast', generatedAt: NOW, trainingCutoff: NOW, trainingHash: 'a'.repeat(64),
  probabilities: { home: .6, draw: .2, away: .2 }, freshness: { validUntil: '2026-10-31T13:00:00.000Z' } };
const input = { fixture, forecast, model: FORECAST_MODEL, reportId: 'b'.repeat(64), nowISO: NOW };
const result = { ...fixture, status: 'FINISHED', period: 'full-time', homeGoals: 2, awayGoals: 0, resultObservedAt: finished };
async function workspace(t) { const directory = await mkdtemp(join(tmpdir(), 'settlement-readiness-')); t.after(() => rm(directory, { recursive: true, force: true })); return directory; }
async function snapshot(directory) {
  return Object.fromEntries(await Promise.all((await readdir(directory, { recursive: true })).filter(x => x.endsWith('.json')).sort().map(async name => [name, await readFile(join(directory, name), 'utf8')])));
}

test('read-only lifecycle distinguishes future, missing result and actual result without claiming publication', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  const future = await buildSettlementReadiness({ directory, nowISO: NOW });
  assert.equal(future.summary.awaitingKickoff, 1); assert.equal(future.summary.awaitingResult, 0);
  assert.deepEqual(future.fixtures[0].fixedReferenceWindows, [24]);
  const noResult = await buildSettlementReadiness({ directory, nowISO: finished });
  assert.equal(noResult.summary.awaitingResult, 1); assert.equal(noResult.summary.settled, 0);
  await appendResultAndScore({ directory, result, nowISO: finished });
  const before = await snapshot(directory), scored = await buildSettlementReadiness({ directory, nowISO: finished });
  assert.equal(scored.summary.settled, 1); assert.equal(scored.summary.awaitingResult, 0);
  assert.equal(scored.canRelease, false); assert.equal(scored.releaseGate, 'BLOCKED'); assert.equal(scored.publicationVerified, false);
  assert.equal(scored.scope, 'retained-freezes-not-publication-proof');
  assert.equal(Object.hasOwn(scored, 'metrics'), false); assert.deepEqual(await snapshot(directory), before);
});

test('outside-window settlements never broaden standard evaluation cohorts or count multiple freezes twice', async t => {
  const directory = await workspace(t), kickoff = '2026-10-31T19:00:00.000Z', observedAt = '2026-10-31T22:00:00.000Z';
  await appendPrediction({ directory, ...input, fixture: { ...fixture, kickoff } });
  const later = '2026-10-31T12:30:00.000Z';
  await appendPrediction({ directory, ...input, fixture: { ...fixture, kickoff }, nowISO: later,
    forecast: { ...forecast, generatedAt: later } });
  await appendResultAndScore({ directory, result: { ...result, kickoff, resultObservedAt: observedAt }, nowISO: observedAt });
  const progress = await buildSettlementReadiness({ directory, nowISO: observedAt });
  assert.equal(progress.summary.fixtures, 1); assert.equal(progress.summary.settled, 1);
  assert.equal(progress.summary.outsideReferenceWindows, 1); assert.equal(progress.ledger.selectedPredictionRecords, 2);
  assert.equal(progress.fixtures[0].recordedAt, later); assert.equal(progress.fixtures[0].horizonHours, 6.5);
  assert.deepEqual(progress.protocol.referenceHorizons, [1, 24, 72, 168]);
  assert.ok(progress.groups[0].referenceWindows.every(row => row.fixtures === 0));
  for (const horizonHours of progress.protocol.referenceHorizons) {
    assert.equal((await evaluatePredictionLedger({ directory, nowISO: observedAt, horizonHours, toleranceHours: 1 })).coverage.evaluated, 0);
  }
});

test('latest cancellations, postponements, schedule changes and simultaneous revisions are distinguished', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  for (const [status, expected, observedAt] of [['POSTPONED', 'postponed', finished], ['CANCELLED', 'void', '2026-11-01T15:00:00.000Z']]) {
    await appendResultAndScore({ directory, result: { ...result, status, resultObservedAt: observedAt }, nowISO: observedAt });
    assert.equal((await buildSettlementReadiness({ directory, nowISO: observedAt })).summary[expected], 1);
  }
  const observedAt = '2026-11-02T15:00:00.000Z';
  await appendResultAndScore({ directory, result: { ...result, kickoff: '2026-11-02T12:00:00.000Z', resultObservedAt: observedAt }, nowISO: observedAt });
  assert.equal((await buildSettlementReadiness({ directory, nowISO: observedAt })).fixtures[0].status, 'void-identity-or-schedule-changed');
  await appendResultAndScore({ directory, result: { ...result, resultObservedAt: observedAt }, nowISO: observedAt });
  assert.equal((await buildSettlementReadiness({ directory, nowISO: observedAt })).summary.ambiguous, 1);
});

test('recorded time prevents result leakage and model configurations are kept separate', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  const later = '2026-11-01T16:00:00.000Z';
  await appendResultAndScore({ directory, result, nowISO: later });
  assert.equal((await buildSettlementReadiness({ directory, nowISO: finished })).summary.awaitingResult, 1);
  assert.equal((await buildSettlementReadiness({ directory, nowISO: later })).summary.settled, 1);
  const excluded = await buildSettlementReadiness({ directory, nowISO: later, model: { ...FORECAST_MODEL, experiment: 'other' } });
  assert.equal(excluded.summary.fixtures, 0); assert.equal(excluded.ledger.otherModelRecords, 1);
});

test('invalid result contents with recomputed envelope digest cannot appear settled', async t => {
  const directory = await workspace(t); await appendPrediction({ directory, ...input });
  await appendResultAndScore({ directory, result, nowISO: finished });
  const name = (await readdir(directory, { recursive: true })).find(x => x.includes('/results/') && x.endsWith('.json'));
  const path = join(directory, name), envelope = JSON.parse(await readFile(path, 'utf8'));
  envelope.record.status = 'UNCONFIRMED'; envelope.sha256 = digest(envelope.record); await writeFile(path, JSON.stringify(envelope));
  const progress = await buildSettlementReadiness({ directory, nowISO: finished });
  assert.equal(progress.summary.invalidResult, 1); assert.equal(progress.summary.settled, 0);
});

test('CLI handles empty ledger and redacts invalid argument failures', async t => {
  const directory = await workspace(t); let out = '', err = '';
  const io = { stdout: value => { out += value; }, stderr: value => { err += value; } };
  assert.equal(await runSettlementReadinessCli(['--ledger', directory, '--now', NOW], io), 0);
  assert.equal(JSON.parse(out).summary.fixtures, 0);
  assert.equal(await runSettlementReadinessCli(['--ledger', '/secret/value', '--now', 'bad-value'], io), 1);
  assert.equal(err, 'SETTLEMENT_READINESS_FAILED\n');
  assert.equal(await runSettlementReadinessCli(['--ledger', directory, '--ledger', directory], io), 1);
});
