import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildResearchDeliveryReadiness, runResearchDeliveryCli, COIN_FLIP_THREE_WAY_BRIER } from '../research-delivery-readiness.mjs';

const nowISO = '2026-11-04T07:00:00.000Z';
// 实测参考值（OpenLigaDB 六赛季 / 480 场 walk-forward）：brier 0.6157, SE 0.0155, baseline 0.6565。
const measured = { n: 480, brier: 0.6157, brierSE: 0.0155, accuracy: 0.4958, baselineBrier: 0.6565, predictedDrawCount: 0,
  perSeason: [{ season: '2020', brier: 0.5886 }, { season: '2021', brier: 0.6327 }, { season: '2022', brier: 0.6391 },
    { season: '2023', brier: 0.5933 }, { season: '2024', brier: 0.6413 }] };
const build = (extra = {}) => buildResearchDeliveryReadiness({ backtest: { ...measured, ...extra }, nowISO });

test('实测回测证据足以支撑研究参考档，但永不授权商业发布', () => {
  const result = build();
  assert.equal(COIN_FLIP_THREE_WAY_BRIER, 2 / 3);
  assert.equal(result.canDeliver, true); assert.equal(result.deliveryClass, 'research-reference');
  assert.equal(result.canReleaseCommercially, false); assert.equal(result.releaseGate, 'BLOCKED');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.checks.brierInterval.pass, true);
  assert.ok(result.checks.brierInterval.upper < COIN_FLIP_THREE_WAY_BRIER);
  assert.equal(result.checks.seasonConsistency.pass, true);
  assert.equal(result.checks.baselineComparison.pairedSignificanceTested, false);
});

test('亏局盲区写作限制而不是达标条件', () => {
  const result = build();
  assert.ok(result.limitations.some(text => text.includes('never predicts a draw')));
  assert.equal(result.canDeliver, true);
});

test('样本不足、无区间、某季不达标分别阻断交付', () => {
  const small = build({ n: 80 });
  assert.equal(small.canDeliver, false); assert.ok(small.blockers.includes('SAMPLE_FLOOR_NOT_MET'));
  const noSE = build({ brierSE: undefined });
  assert.equal(noSE.canDeliver, false); assert.ok(noSE.blockers.includes('UNCERTAINTY_NOT_QUANTIFIED'));
  assert.equal(noSE.checks.brierInterval.status, 'NOT_QUANTIFIED');
  const badSeason = build({ perSeason: [{ season: '2024', brier: 0.70 }] });
  assert.equal(badSeason.canDeliver, false); assert.ok(badSeason.blockers.includes('SEASON_INCONSISTENT'));
  assert.deepEqual(badSeason.checks.seasonConsistency.failingSeasons, ['2024']);
  const noSeason = build({ perSeason: undefined });
  assert.ok(noSeason.blockers.includes('SEASON_BREAKDOWN_MISSING'));
  const worseThanBaseline = build({ brier: 0.68, brierSE: 0.0155, baselineBrier: 0.6555 });
  assert.ok(worseThanBaseline.blockers.includes('NOT_BETTER_THAN_BASELINE'));
  assert.ok(worseThanBaseline.blockers.includes('BRIER_INTERVAL_NOT_BELOW_COIN_FLIP'));
});

test('非法输入与缺字段是硬错，不返回看起来能够交付的报告', () => {
  assert.throws(() => buildResearchDeliveryReadiness({ backtest: null }), /INVALID_RESEARCH_READINESS_OPTIONS/);
  assert.throws(() => buildResearchDeliveryReadiness({ backtest: { n: 480 }, nowISO }), /INVALID_BACKTEST_EVIDENCE/);
  assert.throws(() => buildResearchDeliveryReadiness({ backtest: measured, minimumSamples: 5 }), /INVALID_RESEARCH_READINESS_OPTIONS/);
  assert.throws(() => buildResearchDeliveryReadiness({ backtest: { ...measured, accuracy: 2 }, nowISO }), /INVALID_BACKTEST_EVIDENCE/);
});

test('CLI 输出可机器读取，参数重复或缺失都是失败码', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'research-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'backtest.json');
  await writeFile(path, JSON.stringify(measured));
  let out = '', error = '';
  const io = { stdout: value => { out += value; }, stderr: value => { error += value; } };
  assert.equal(runResearchDeliveryCli(['--backtest', path, '--now', nowISO], io), 0);
  assert.equal(JSON.parse(out).canDeliver, true); assert.equal(error, '');
  out = ''; await writeFile(path, JSON.stringify({ ...measured, n: 10 }));
  assert.equal(runResearchDeliveryCli(['--backtest', path, '--now', nowISO], io), 2);
  assert.equal(JSON.parse(out).canDeliver, false);
  out = '';
  assert.equal(runResearchDeliveryCli(['--backtest', path, '--backtest', path], io), 1);
  assert.equal(runResearchDeliveryCli([], io), 1);
  assert.equal(error, 'RESEARCH_DELIVERY_READINESS_FAILED\n'.repeat(2));
});
