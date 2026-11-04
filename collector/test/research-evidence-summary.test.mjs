import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderEvidenceSummary, runSummaryCli } from '../research-evidence-summary.mjs';

const NL = String.fromCharCode(10);
const bucket = (key, n, brier, se, accuracy) => ({ key, n, brier, brierSE: se, accuracy, logLoss: 1.1, predictedDrawCount: 0, actualDrawCount: 0 });
const rollup = () => ({
  version: 1, kind: 'research-evidence-rollup', seasonDefinition: 'kickoff-utc-year',
  overall: { n: 4, brier: 0.8265, brierSE: 0.1111, accuracy: 0.25, logLoss: 1.3214, predictedDrawCount: 0, actualDrawCount: 1 },
  bySeason: [bucket('2026', 4, 0.8265, 0.1111, 0.25)],
  byHorizon: [bucket('h6-24', 4, 0.8265, 0.1111, 0.25)],
  byModel: [bucket('abcdef12', 4, 0.8265, 0.1111, 0.25)],
  bySource: [bucket('football-data', 4, 0.8265, 0.1111, 0.25)],
  byLeague: [bucket('EPL', 2, 0.9, 0.2, 0), bucket('La Liga', 1, 0.7, null, 1), bucket('Serie A', 1, 0.6, 0.1, 1)],
  excluded: 2, blockers: ['MODEL_NEVER_SELECTS_DRAW'],
  ledger: { assessmentStatus: 'single-cohort', cohorts: [['m', 1, 'h', 's', 'EPL']], coverage: { eligible: 6, evaluated: 4, skipped: 1, pending: 1, rate: 4 / 6 } },
});

test('渲染总体指标、账本口径与阻断项，数字直接来自汇总不重算', () => {
  const md = renderEvidenceSummary(rollup(), { source: 'reports/forecast-ledger' });
  assert.ok(md.startsWith('# 研究证据汇总'));
  assert.ok(md.includes('- 样本：4 场（排除 2 条不合口径记录）'));
  assert.ok(md.includes('- Brier：0.8265（样本标准误 0.1111）'));
  assert.ok(md.includes('- 命中率：25.0%'));
  assert.ok(md.includes('cohort 数 1'));
  assert.ok(md.includes('eligible 6；已评分 4；待 FT 1；跳过 1；评分率 66.7%'));
  assert.ok(!md.includes('不可直接与回测成绩比较'));
  assert.ok(md.includes('阻断项：MODEL_NEVER_SELECTS_DRAW'));
  assert.ok(md.includes('reports/forecast-ledger'));
  assert.ok(md.includes('不授权商业发布'));
  assert.ok(!md.includes(String.fromCharCode(92) + 'n'));
});

test('不可计算的指标渲染为 n/a 而不是 NaN', () => {
  const md = renderEvidenceSummary(rollup());
  assert.ok(md.includes('| La Liga | 1 | 0.7000 | n/a | 100.0% | 0 | 0 |'));
  assert.ok(!md.includes('NaN'));
});

test('超过上限的分桶被省略并标注数量，完整数字指向 json', () => {
  const md = renderEvidenceSummary(rollup(), { maxRowsPerDimension: 2 });
  assert.ok(md.includes('| EPL | 2 |'));
  assert.ok(md.includes('另有 1 个分桶按样本量省略'));
  assert.ok(md.includes('evidence-rollup.json'));
  assert.ok(!md.includes('| Serie A |'));
});

test('空分桶写无样本，账本口径缺失时用 n/a', () => {
  const empty = { ...rollup(), byLeague: [], ledger: undefined, blockers: [], overall: { n: 0 } };
  const md = renderEvidenceSummary(empty);
  assert.ok(md.includes('无样本。'));
  assert.ok(md.includes('cohort 数 n/a'));
  assert.ok(md.includes('阻断项：无'));
  assert.ok(md.includes('- Brier：n/a（样本标准误 n/a）'));
});

test('多 cohort 时给出扣留指标警示', () => {
  const base = rollup();
  const mixed = { ...base, ledger: { ...base.ledger, assessmentStatus: 'blocked-mixed-cohorts', metricsWithheldByMixedCohorts: true }, blockers: [...base.blockers, 'MIXED_MODEL_COHORTS'] };
  const md = renderEvidenceSummary(mixed);
  assert.ok(md.includes('不可直接与回测成绩比较'));
  assert.ok(md.includes('blocked-mixed-cohorts'));
  assert.ok(md.includes('MIXED_MODEL_COHORTS'));
});

test('非法输入抛 INVALID_ROLLUP_INPUT', () => {
  assert.throws(() => renderEvidenceSummary(null), /INVALID_ROLLUP_INPUT/);
  assert.throws(() => renderEvidenceSummary({ kind: 'other' }), /INVALID_ROLLUP_INPUT/);
});

test('CLI 写入文件并返回 0；缺参数返回 1', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'evidence-summary-'));
  const input = join(dir, 'in.json');
  const out = join(dir, 'nested', 'out.md');
  await writeFile(input, JSON.stringify(rollup()));
  const printed = [];
  const code = await runSummaryCli(['--input', input, '--out', out], { stdout: v => printed.push(v), stderr: () => {} });
  assert.equal(code, 0);
  assert.ok(printed.join('').includes('SUMMARY_WRITTEN'));
  assert.ok((await readFile(out, 'utf8')).includes('- 样本：4 场'));
  assert.equal(await runSummaryCli(['--input', input], { stdout: () => {}, stderr: () => {} }), 1);
  assert.equal(await runSummaryCli(['--bogus', 'x'], { stdout: () => {}, stderr: () => {} }), 1);
});
