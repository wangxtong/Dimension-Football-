import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

/** 三分类均匀盲猜的 Brier 值：3 * (1/3) * (1-1/3)^2 = 2/3。 */
export const COIN_FLIP_THREE_WAY_BRIER = 2 / 3;
/** 研究参考档的最小样本下限。低于此值时区间过宽，无法判定优劣。 */
export const MINIMUM_RESEARCH_SAMPLES = 300;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const rate = value => finite(value) && value >= 0 && value <= 1;

/**
 * 研究参考档交付判定：只回答“历史回测证据是否足以支撑研究参考级交付”。
 * 与 RELEASE_GATE（商业交付）完全独立，永不返回可商业发布的结果。
 */
export function buildResearchDeliveryReadiness({ backtest, nowISO = new Date().toISOString(),
  minimumSamples = MINIMUM_RESEARCH_SAMPLES, coinFlipBrier = COIN_FLIP_THREE_WAY_BRIER } = {}) {
  if (!backtest || typeof backtest !== 'object' || Array.isArray(backtest)
    || !Number.isSafeInteger(minimumSamples) || minimumSamples < 30
    || !finite(coinFlipBrier) || coinFlipBrier <= 0 || coinFlipBrier >= 1
    || !Number.isFinite(Date.parse(nowISO))) throw new Error('INVALID_RESEARCH_READINESS_OPTIONS');
  const n = backtest.n;
  if (!Number.isSafeInteger(n) || n < 0 || !rate(backtest.brier)) throw new Error('INVALID_BACKTEST_EVIDENCE');
  if (backtest.accuracy !== undefined && !rate(backtest.accuracy)) throw new Error('INVALID_BACKTEST_EVIDENCE');
  if (backtest.baselineBrier !== undefined && !rate(backtest.baselineBrier)) throw new Error('INVALID_BACKTEST_EVIDENCE');
  if (backtest.brierSE !== undefined && (!finite(backtest.brierSE) || backtest.brierSE <= 0)) throw new Error('INVALID_BACKTEST_EVIDENCE');
  if (backtest.predictedDrawCount !== undefined && (!Number.isSafeInteger(backtest.predictedDrawCount) || backtest.predictedDrawCount < 0)) throw new Error('INVALID_BACKTEST_EVIDENCE');
  const brierSE = backtest.brierSE, accuracy = backtest.accuracy, baselineBrier = backtest.baselineBrier;
  const perSeason = Array.isArray(backtest.perSeason) ? backtest.perSeason : null;
  const blockers = [], limitations = [];

  // 1) 样本下限
  const sampleFloorPass = n >= minimumSamples;
  if (!sampleFloorPass) blockers.push('SAMPLE_FLOOR_NOT_MET');

  // 2) 区间上界低于盲猜：只有点估计不算数
  let interval = { status: 'NOT_QUANTIFIED', pass: false, method: 'normal-approximation-95' };
  if (finite(brierSE) && brierSE > 0) {
    const upper = backtest.brier + 1.96 * brierSE, lower = backtest.brier - 1.96 * brierSE;
    interval = { status: 'QUANTIFIED', method: 'normal-approximation-95', point: backtest.brier,
      standardError: brierSE, lower, upper, coinFlipBrier, pass: upper < coinFlipBrier };
    if (!interval.pass) blockers.push('BRIER_INTERVAL_NOT_BELOW_COIN_FLIP');
  } else blockers.push('UNCERTAINTY_NOT_QUANTIFIED');

  // 3) 逐赛季一致性：防单季偶然拉低总体
  let season = { status: 'NOT_PROVIDED', pass: false };
  if (perSeason && perSeason.length) {
    const rows = perSeason.filter(row => row && finite(row.brier));
    const failing = rows.filter(row => !(row.brier < coinFlipBrier)).map(row => row.season);
    season = { status: 'PROVIDED', seasons: rows.length, pass: rows.length === perSeason.length && failing.length === 0,
      failingSeasons: failing, requiresEverySeasonBelowCoinFlip: true };
    if (!season.pass) blockers.push('SEASON_INCONSISTENT');
  } else blockers.push('SEASON_BREAKDOWN_MISSING');

  // 4) 相对同窗基线：只记录点估计方向，不做显著性断言
  let baseline = { status: 'NOT_PROVIDED', pass: false };
  if (finite(baselineBrier)) {
    baseline = { status: 'PROVIDED', point: baselineBrier, delta: baselineBrier - backtest.brier,
      pass: baselineBrier - backtest.brier > 0, pairedSignificanceTested: false };
    if (!baseline.pass) blockers.push('NOT_BETTER_THAN_BASELINE');
    limitations.push('Baseline advantage is a point estimate only; no paired significance test was computed.');
  } else blockers.push('BASELINE_NOT_PROVIDED');

  if (backtest.predictedDrawCount === 0) limitations.push('Model never predicts a draw; draw hit rate is 0 by construction, not evidence of draw skill.');
  limitations.push('Historical revision snapshots are retrospective; they cannot impersonate prospective evidence.');
  limitations.push('This class never authorizes commercial release, accuracy promises or profit claims; RELEASE_GATE stays BLOCKED.');

  return { version: 1, kind: 'research-delivery-readiness', generatedAt: nowISO,
    deliveryClass: 'research-reference', canDeliver: blockers.length === 0,
    scope: '托管看板仅作研究参考展示，禁止对外承诺命中率或收益。',
    canReleaseCommercially: false, releaseGate: 'BLOCKED',
    checks: { sampleFloor: { pass: sampleFloorPass, minimum: minimumSamples, actual: n },
      brierInterval: interval, seasonConsistency: season, baselineComparison: baseline },
    metrics: { n, brier: backtest.brier, accuracy: finite(accuracy) ? accuracy : null,
      baselineBrier: finite(baselineBrier) ? baselineBrier : null, coinFlipBrier },
    blockers, limitations };
}

export function runResearchDeliveryCli(args, { stdout = v => process.stdout.write(v), stderr = v => process.stderr.write(v) } = {}) {
  try {
    const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--backtest', '--now', '--minimum-samples'].includes(args[i]) || !args[i + 1] || Object.hasOwn(options, args[i])) throw new Error('INVALID_RESEARCH_READINESS_ARGUMENT');
      options[args[i]] = args[i + 1];
    }
    if (!options['--backtest']) throw new Error('INVALID_RESEARCH_READINESS_ARGUMENT');
    const backtest = JSON.parse(readFileSync(options['--backtest'], 'utf8'));
    const result = buildResearchDeliveryReadiness({ backtest, ...(options['--now'] ? { nowISO: options['--now'] } : {}),
      ...(options['--minimum-samples'] ? { minimumSamples: Number(options['--minimum-samples']) } : {}) });
    stdout(JSON.stringify(result, null, 2) + '\n');
    return result.canDeliver ? 0 : 2;
  } catch { stderr('RESEARCH_DELIVERY_READINESS_FAILED\n'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runResearchDeliveryCli(process.argv.slice(2));
