import test from 'node:test';
import assert from 'node:assert/strict';
import { validDate, validateReport, validateReceipt, validateBundle, MAX_REPORT_BACKTESTS } from '../report-schema.mjs';
import { createSnapshotLoader, createEvaluationLoader, validateEvaluationEvidence } from '../app.mjs';
import { readFile } from 'node:fs/promises';
import { sampleReport, sampleReceipt, sampleBundle, NOW } from './fixtures.mjs';

test('report schema accepts production-shaped categories and optional extensions', () => {
  const report = sampleReport(); report.horizons = { prematch: true }; report.fixtures[0].forecast.assessment = { status: 'pending' };
  assert.equal(validateReport(report), report);
  assert.equal(validateReceipt(sampleReceipt(report), report).reportId, report.publication.reportId);
  const bundle = sampleBundle(report); bundle.health = { status: 'healthy' };
  assert.equal(validateBundle(bundle), bundle);
});

test('the full fixture pool can describe actual and reference horizons beyond 100 backtests', () => {
  const report = sampleReport(), seed = report.backtests[0];
  report.backtests = Array.from({ length: MAX_REPORT_BACKTESTS }, (_, i) => ({ ...seed, horizonHours: i / 100 }));
  assert.equal(validateReport(report), report);
  report.backtests.push(seed); assert.throws(() => validateReport(report), /REPORT_SCHEMA_INVALID/);
});

test('nested report corruption and invalid numeric/date domains fail before rendering', () => {
  const changes = [
    r => { r.version = 2; }, r => { r.simulated = true; }, r => { r.fixtures[0] = {}; },
    r => { r.fixtures[0].forecast.probabilities.home = 1.1; },
    r => { r.fixtures[0].forecast.probabilities.home = .4; },
    r => { r.fixtures[0].forecast.expectedGoals.home = '1'; },
    r => { r.fixtures[0].forecast.sample.home = -1; }, r => { r.fixtures[0].forecast.topScores = null; },
    r => { r.fixtures[0].forecast.strength.homeAttack = Infinity; },
    r => { r.fixtures[0].forecast.validation.evaluated = .5; },
    r => { r.fixtures[0].forecast.freshness.validUntil = '2026-02-30T12:00:00Z'; },
    r => { r.fixtures[0].fixture.kickoff = 'tomorrow'; }, r => { r.fixtures[1].fixture.id = 'analysis'; },
    r => { r.fixtures[1].marketCandidate.candidate.quotes[0].validUntil = 'invalid'; },
    r => { r.fixtures[1].marketCandidate.candidate.opening.fixtureId = 'other'; },
    r => { r.fixtures[1].marketCandidate.candidate.quoteGroups = ['same', 'same']; },
    r => { r.fixtures[2].forecast.reasons = {}; }, r => { r.backtests[0].metrics.logLoss = NaN; },
    r => { r.attribution[0].url = 'javascript:alert(1)'; }, r => { r.summary.fixtures = 4; },
  ];
  for (const change of changes) { const r = sampleReport(); change(r); assert.throws(() => validateReport(r), /REPORT_SCHEMA_INVALID/); }
  for (const value of [null, {}, '2026-11-31T12:00:00Z', '2026-10-31T24:00:00Z']) assert.equal(validDate(value), false);
  assert.equal(validDate('2026-10-31T20:00:00+08:00'), true);
});

test('bundle and receipt identities, dates and channel shapes must agree', () => {
  for (const change of [
    b => { b.reportId = 'b'.repeat(64); }, b => { b.receipt.reportId = 'b'.repeat(64); },
    b => { b.receipt.generatedAt = '2026-10-30T12:00:00Z'; }, b => { b.receipt.channels = {}; },
    b => { b.receipt.channels.files.status = 'invented'; }, b => { delete b.receipt; },
  ]) { const bundle = sampleBundle(); change(bundle); assert.throws(() => validateBundle(bundle)); }
  const bundle = sampleBundle(); bundle.receipt = null; assert.equal(validateBundle(bundle).receipt, null);
});

test('one in-flight refresh is shared and delayed/stale reports cannot roll back the snapshot', async () => {
  let release, calls = 0;
  const loader = createSnapshotLoader({ now: () => NOW + 60000, fetchImpl: async () => {
    calls++; return new Promise(resolve => { release = bundle => resolve(Response.json(bundle)); });
  } });
  const first = loader.load(), duplicate = loader.load(); assert.equal(first, duplicate); assert.equal(calls, 1);
  release(sampleBundle(sampleReport('b', 30000))); assert.equal((await first).reportId, 'b'.repeat(64));
  const old = loader.load(); release(sampleBundle(sampleReport('a'))); await assert.rejects(old, /REPORT_TIME_INVALID/);
  const good = loader.load(); release(sampleBundle(sampleReport('c', 40000))); assert.equal((await good).reportId, 'c'.repeat(64));
});

test('failed refresh does not advance the successful snapshot or block recovery', async () => {
  let next = sampleBundle();
  const loader = createSnapshotLoader({ now: () => NOW + 60000, fetchImpl: async () => Response.json(next) });
  await loader.load(); next = sampleBundle(sampleReport('b', 50000)); next.report.fixtures[0] = {};
  await assert.rejects(loader.load(), /REPORT_SCHEMA_INVALID/);
  next = sampleBundle(sampleReport('c', 30000)); assert.equal((await loader.load()).reportId, 'c'.repeat(64));
});

test('legacy fallback is explicit, drops mismatched receipts and never hides bundle failures', async () => {
  const paths = [], report = sampleReport(), wrong = sampleReceipt(sampleReport('b'));
  const loader = createSnapshotLoader({ now: () => NOW, fetchImpl: async url => {
    const path = url.split('?')[0]; paths.push(path);
    if (path === '/api/report') return new Response(null, { status: 404 });
    return Response.json(path.endsWith('predictions.json') ? report : wrong);
  } });
  assert.equal((await loader.load()).receipt, null);
  assert.deepEqual(paths, ['/api/report', '/api/predictions.json', '/api/publication.json']);
  for (const status of [401, 502]) {
    let count = 0;
    const broken = createSnapshotLoader({ fetchImpl: async () => { count++; return new Response(null, { status }); } });
    await assert.rejects(broken.load(), new RegExp(status === 401 ? 'AUTH_REQUIRED' : 'REPORT_UNAVAILABLE')); assert.equal(count, 1);
  }
});

test('an expired session on the receipt request also requires login', async () => {
  const loader = createSnapshotLoader({ now: () => NOW, fetchImpl: async url => url.includes('/report?')
    ? new Response(null, { status: 404 }) : url.includes('predictions') ? Response.json(sampleReport()) : new Response(null, { status: 401 }) });
  await assert.rejects(loader.load(), /AUTH_REQUIRED/);
});

test('historical evidence validates bound real metrics and never accepts invented deltas or promotion', async () => {
  const evidence = JSON.parse(await readFile(new URL('../evaluation-evidence.json', import.meta.url), 'utf8'));
  assert.equal(validateEvaluationEvidence(evidence), evidence);
  const selected = evidence.groups.find(row => row.league === 'BL1' && row.horizonHours === 24);
  assert.ok(selected.evaluated > 0);
  assert.ok(Math.abs(selected.deltaVsBaseline.brier - (selected.metrics.brier - selected.baseline.brier)) < 1e-10);
  for (const change of [v => { v.releaseGate = 'GREEN'; }, v => { v.historicalOnly = false; },
    v => { v.binding.inputsHash = 'missing'; }, v => { v.groups.find(row => row.metrics).deltaVsBaseline.brier = 99; },
    v => { v.groups.find(row => row.metrics).metrics.accuracy = 1.1; }, v => { v.groups = Array(101).fill(v.groups[0]); }]) {
    const copy = structuredClone(evidence); change(copy); assert.throws(() => validateEvaluationEvidence(copy), /HISTORICAL_EVIDENCE_INVALID/);
  }
});

test('historical evidence loads independently with same-origin auth and shares in-flight work', async () => {
  const evidence = JSON.parse(await readFile(new URL('../evaluation-evidence.json', import.meta.url), 'utf8'));
  let release, calls = 0;
  const loader = createEvaluationLoader({ fetchImpl: async (url, options) => {
    assert.equal(url, '/evaluation-evidence.json'); assert.equal(options.credentials, 'same-origin');
    calls++; return new Promise(resolve => { release = resolve; });
  } });
  const first = loader.load(); assert.equal(loader.load(), first); assert.equal(calls, 1);
  release(Response.json(evidence)); assert.equal((await first).groups.length, evidence.groups.length);
  const failed = loader.load(); release(new Response(null, { status: 503 })); await assert.rejects(failed, /HISTORICAL_EVIDENCE_UNAVAILABLE/);
  const next = loader.load(); release(Response.json(evidence)); assert.equal((await next).releaseGate, 'BLOCKED');
});
