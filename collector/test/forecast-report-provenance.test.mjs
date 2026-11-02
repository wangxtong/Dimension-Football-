import test from 'node:test';
import assert from 'node:assert/strict';
import { predictionDocument, renderPredictionsHtml, renderPredictionsMarkdown } from '../forecast-report.mjs';

for (const scope of ['private-research-freezes', undefined]) test(`frozen evaluation display does not claim publication for ${scope || 'unspecified'} scope`, () => {
  const report = { completedAt: '2026-11-02T00:00:00.000Z', simulated: false,
    summary: { total: 0, candidates: 0 }, results: [], publication: { reportId: 'a'.repeat(64) },
    prospectiveEvaluation: { version: 1, generatedAt: '2026-11-02T00:00:00.000Z', ...(scope ? { scope, forecastPublished: false } : {}),
      groups: [{ source: 'openligadb', league: 'BL1', provenance: 'prospective-ledger', horizonHours: 24,
        coverage: { evaluated: 1, pending: 2, skipped: 0 }, metrics: { brier: .25 } }] } };
  const before = structuredClone(report), doc = predictionDocument(report);
  for (const text of [renderPredictionsHtml(report), renderPredictionsMarkdown(report)]) {
    assert.match(text, /赛前冻结预测核账/); assert.doesNotMatch(text, /已发布预测前瞻/);
    assert.match(text, scope ? /私有研究冻结记录，不是已发布预测成绩/ : /不能证明预测已公开发布/);
    assert.match(text, /0\.2500/);
  }
  assert.deepEqual(report, before); assert.deepEqual(predictionDocument(report), doc);
  assert.equal(doc.prospectiveEvaluation.scope, scope);
});
