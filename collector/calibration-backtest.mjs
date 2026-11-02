// 校准与命中率诊断（只读，不写账本、不改模型）。
// 用外部历史数据做 walk-forward 回测，给出「模型在不同联赛的真实方向命中率与 Brier」，
// 用于对照当期少量前瞻结果（例如 4 场 0%），避免被误读成模型失效。
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { walkForwardBacktest } from './forecast.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

export function summarize(byLeague) {
  const rows = Object.entries(byLeague).map(([league, r]) => ({
    league, evaluated: r.evaluated, skipped: r.skipped,
    accuracy: r.metrics?.accuracy ?? null,
    brier: r.metrics?.brier ?? null,
    logLoss: r.metrics?.logLoss ?? null,
    baselineBrier: r.metrics?.baselineBrier ?? null,
  })).filter(r => r.accuracy !== null);
  const valid = rows.filter(r => Number.isFinite(r.accuracy));
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  return { version: 1, rows,
    meanAccuracy: mean(valid.map(r => r.accuracy)),
    meanBrier: mean(valid.map(r => r.brier).filter(Number.isFinite)),
    meanBaselineBrier: mean(valid.map(r => r.baselineBrier).filter(Number.isFinite)),
    totalEvaluated: valid.reduce((a, r) => a + (r.evaluated || 0), 0) };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const hist = resolve(arg('history', '/tmp/hf_hist.json'));
  const out = resolve(arg('out', 'reports/calibration-backtest.json'));
  const nowISO = arg('now', '2026-11-03T00:00:00Z');
  let matches;
  try { matches = JSON.parse(await readFile(hist, 'utf8')); }
  catch { console.log(JSON.stringify({ status: 'blocked', code: 'HISTORY_UNAVAILABLE' })); process.exitCode = 1; }
  if (matches) {
    const byLeague = {};
    for (const r of matches) (byLeague[r.league] ||= []).push(r);
    const results = {};
    for (const [lg, ms] of Object.entries(byLeague)) {
      ms.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
      results[lg] = walkForwardBacktest(ms, { source: 'hf-soccer-dataset', league: lg, nowISO, horizonHours: 1 });
    }
    const summary = { ...summarize(results), generatedAt: new Date().toISOString(), source: 'hf-soccer-dataset', season: '2024-2025', horizonHours: 1 };
    await writeFile(out, JSON.stringify(summary, null, 2) + '\n');
    console.log(JSON.stringify({ status: 'ok', out, meanAccuracy: summary.meanAccuracy, meanBrier: summary.meanBrier, totalEvaluated: summary.totalEvaluated, rows: summary.rows }));
  }
}
