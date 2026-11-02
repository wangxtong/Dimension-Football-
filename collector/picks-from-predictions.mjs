// 从 predictions.json 直接生成「每日预测清单」，供日报与 Telegram 使用。
// 关键修复：validUntil 只有生成+1h，日报原逻辑会因此把所有已冻结预测隐藏成「冻结 0 场」；
// 这里改为按「未开赛 + 有概率」展示，并显式标注 freshness 状态，不再静默隐藏。
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };

export function extractPicks(predictions, { nowISO, horizonHours = 72, limit = 20 } = {}) {
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) return { picks: [], error: 'INVALID_NOW' };
  const picks = [];
  for (const row of predictions?.fixtures || []) {
    const f = row.fixture || {}, fc = row.forecast || {};
    const p = fc.probabilities;
    if (!f.id || !p || ![p.home, p.draw, p.away].every(v => Number.isFinite(v))) continue;
    const kickoff = Date.parse(f.kickoff);
    if (!Number.isFinite(kickoff) || kickoff <= now) continue;
    if (kickoff > now + horizonHours * 3600_000) continue;
    const ranked = Object.entries({ home: p.home, draw: p.draw, away: p.away }).sort((a, b) => b[1] - a[1]);
    picks.push({ fixtureId: f.id, league: f.league, home: f.home, away: f.away, kickoff: f.kickoff,
      probabilities: { home: p.home, draw: p.draw, away: p.away },
      selection: ranked[0][0], confidence: Math.round(ranked[0][1] * 1000) / 10,
      generatedAt: fc.generatedAt || null,
      freshnessValidUntil: fc.freshness?.validUntil || null,
      expired: Boolean(fc.freshness?.validUntil && Date.parse(fc.freshness.validUntil) <= now) });
  }
  picks.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
  return { picks: picks.slice(0, limit), total: picks.length };
}

const LABEL = Object.freeze({ home: '主胜', draw: '平局', away: '客胜' });

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const root = resolve(arg('root', '/tmp/ci5')), nowISO = arg('now', new Date().toISOString()), limit = Number(arg('limit', '20')) || 20;
  let predictions;
  try { predictions = JSON.parse(await readFile(resolve(root, 'reports/predictions.json'), 'utf8')); }
  catch { console.log(JSON.stringify({ status: 'blocked', code: 'PREDICTIONS_UNAVAILABLE' })); process.exitCode = 1; }
  if (predictions) {
    const out = extractPicks(predictions, { nowISO, limit });
    console.log(JSON.stringify({ status: 'ok', nowISO, ...out, lines: out.picks.map(p =>
      `${p.league} ${p.home} vs ${p.away}  ${p.kickoff.slice(5, 16)}Z  ${LABEL[p.selection]} ${p.confidence}%`) }));
  }
}
