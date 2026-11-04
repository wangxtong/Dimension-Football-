import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollupProspectiveEvidence, scoreRow, runRollupCli, HORIZON_BUCKETS } from '../research-evidence-rollup.mjs';

const row = (probabilities, actual, extra = {}) => ({ provenance: 'prospective-ledger', league: 'BL1', source: 'openligadb',
  kickoff: '2024-03-02T14:30:00.000Z', modelHash: 'a'.repeat(64), horizonHours: 1.5, probabilities, actual, ...extra });
// 手算：0.38 / 0.38 / 0.56，均值 0.44，样本方差 0.0216/2 = 0.0108，SE = sqrt(0.0108/3) = 0.06。
const rows = [row({ home: 0.5, draw: 0.3, away: 0.2 }, 'home'),
  row({ home: 0.2, draw: 0.3, away: 0.5 }, 'away'),
  row({ home: 0.4, draw: 0.4, away: 0.2 }, 'draw')];

test('单场 Brier、对数损失与命中判定可手算复现', () => {
  const first = scoreRow({ probabilities: { home: 0.5, draw: 0.3, away: 0.2 }, actual: 'home' });
  assert.equal(Number(first.brier.toFixed(10)), 0.38);
  assert.equal(Number(first.logLoss.toFixed(6)), 0.693147);
  assert.equal(first.hit, true); assert.equal(first.selected, 'home');
  const draw = scoreRow({ probabilities: { home: 0.4, draw: 0.4, away: 0.2 }, actual: 'draw' });
  assert.equal(draw.hit, false);
});

test('汇总值、样本标准误与平局盲区与手算一致', () => {
  const result = rollupProspectiveEvidence({ evaluations: rows });
  assert.equal(result.overall.n, 3);
  assert.equal(Number(result.overall.brier.toFixed(6)), 0.44);
  assert.equal(Number(result.overall.brierSE.toFixed(6)), 0.06);
  assert.equal(Number(result.overall.accuracy.toFixed(6)), 0.666667);
  assert.equal(result.overall.predictedDrawCount, 0);
  assert.equal(result.overall.actualDrawCount, 1);
  assert.ok(result.blockers.includes('MODEL_NEVER_SELECTS_DRAW'));
  assert.deepEqual(result.horizonBuckets, HORIZON_BUCKETS);
});

test('多维拆分：赛季、提前量、模型、来源、联赛逐项存在', () => {
  const result = rollupProspectiveEvidence({ evaluations: [...rows, row({ home: 0.6, draw: 0.2, away: 0.2 }, 'draw',
    { kickoff: '2023-05-01T00:00:00.000Z', horizonHours: 30, source: 'football-data', modelHash: 'b'.repeat(64), league: 'PL' })] });
  assert.deepEqual(result.bySeason.map(item => item.key), ['2023', '2024']);
  assert.deepEqual(result.byHorizon.map(item => item.key).sort(), ['h24-48', 'h<2']);
  assert.equal(result.byModel.length, 2);
  assert.deepEqual(result.bySource.map(item => item.key), ['football-data', 'openligadb']);
  assert.deepEqual(result.byLeague.map(item => item.key), ['BL1', 'PL']);
  const pl = result.byLeague.find(item => item.key === 'PL');
  assert.equal(pl.n, 1); assert.equal(Number(pl.brier.toFixed(2)), 1.04);
});

test('非前瞻来源与非法概率被剔除或硬错，不静默计入', () => {
  const mixed = rollupProspectiveEvidence({ evaluations: [...rows, { ...rows[0], provenance: 'historical-backtest' }] });
  assert.equal(mixed.overall.n, 3);
  assert.equal(mixed.excluded, 1);
  assert.throws(() => scoreRow({ probabilities: { home: 0.5, draw: 0.3, away: 0.3 }, actual: 'home' }), /INVALID_EVALUATION_ROW/);
  assert.throws(() => scoreRow({ probabilities: { home: 0.5, draw: 0.5, away: 0 }, actual: 'unknown' }), /INVALID_EVALUATION_ROW/);
  assert.throws(() => rollupProspectiveEvidence({}), /INVALID_EVALUATION_LIST/);
});

test('空账本不伪造证据，命令行参数错误返回失败码', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rollup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let out = '', error = '';
  const io = { stdout: value => { out += value; }, stderr: value => { error += value; } };
  assert.equal(await runRollupCli(['--help'], io), 0);
  assert.match(out, /Usage: node collector\/research-evidence-rollup/);
  out = '';
  assert.equal(await runRollupCli(['--ledger', directory, '--now', '2026-11-04T07:00:00.000Z'], io), 2);
  assert.ok(JSON.parse(out.slice(out.indexOf('{'))).blockers.includes('NO_SCORED_PROSPECTIVE_ROWS'));
  out = '';
  assert.equal(await runRollupCli(['--ledger', directory, '--ledger', directory], io), 1);
  assert.equal(await runRollupCli([], io), 1);
  assert.equal(error, 'RESEARCH_EVIDENCE_ROLLUP_FAILED\n'.repeat(2));
});
