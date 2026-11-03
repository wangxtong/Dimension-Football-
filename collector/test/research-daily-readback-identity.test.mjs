import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDailyResearch } from '../publish-research-daily.mjs';

function sample() {
  const payload = { version: 1, kind: 'research-daily-1x2', mode: 'research-reference',
    generatedAt: '2026-11-03T12:00:00.000Z', beijingDay: '2026-11-03',
    codeSha: 'a'.repeat(40), sourceReportId: null,
    forecasts: { total: 1, candidates: [{ fixtureId: 'F-1', probabilities: { home: .5, draw: .3, away: .2 } }] },
    strictMarkets: { releasedCandidates: 0 }, commercialReleaseGate: 'BLOCKED',
    externalTelegramSent: false };
  return { ...payload, reportId: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
async function setup(t, report, readback) {
  const root = await mkdtemp(join(tmpdir(), 'research-readback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'reports/research-daily'), { recursive: true });
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  const calls = [];
  const client = { request: async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (options.method === 'POST') {
      assert.deepEqual(options.body, report);
      return { status: 'research-available', reportId: report.reportId, commercialReleaseGate: 'BLOCKED' };
    }
    return readback;
  } };
  return { root, client, calls };
}
test('matching authenticated POST/GET payload and SHA are accepted without actual network', async t => {
  const report = sample(), { root, client, calls } = await setup(t, report, structuredClone(report));
  const got = await publishDailyResearch({ root, client });
  assert.equal(got.status, 'research-authenticated-web-verified');
  assert.equal(got.reportId, report.reportId);
  assert.deepEqual(calls.map(x => x.method), ['POST', 'GET']);
});
test('same reportId/codeSha/day/sourceReportId but mutated probabilities cannot count as Web delivery', async t => {
  const report = sample(), reloaded = structuredClone(report);
  reloaded.forecasts.candidates[0].probabilities.home = .95;
  const { root, client } = await setup(t, report, reloaded);
  await assert.rejects(publishDailyResearch({ root, client }), /RESEARCH_READBACK_MISMATCH/);
});
test('missing forecast rows with same identifier cannot count as Web delivery', async t => {
  const report = sample(), reloaded = structuredClone(report);
  reloaded.forecasts.candidates = [];
  const { root, client } = await setup(t, report, reloaded);
  await assert.rejects(publishDailyResearch({ root, client }), /RESEARCH_READBACK_MISMATCH/);
});
test('reportId-looking hex is not proof of local research payload integrity', async t => {
  const report = sample();
  report.forecasts.candidates[0].probabilities.home = .6; // stale ID deliberately retained
  const { root, client, calls } = await setup(t, report, report);
  await assert.rejects(publishDailyResearch({ root, client }), /RESEARCH_REPORT_INVALID/);
  assert.equal(calls.length, 0);
});
