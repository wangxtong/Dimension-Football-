#!/usr/bin/env node
// OpenLigaDB 历史回测（默认德甲 BL1）。只读：不写账本、不改模型、不发网络写请求。
// 用法：node collector/backtest-openligadb.mjs --from 2019 --to 2024 --league BL1 --out reports/openligadb-backtest.json
// 输出：逐窗口 + 合并后的命中率/Brier/基线对比，用于区分「模型失效」与「样本不足」。
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { walkForwardBacktest } from './forecast.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const LEAGUES = { BL1: 'bl1', BL2: 'bl2' };
const league = arg('league', 'BL1');
const from = Number(arg('from', '2019'));
const to = Number(arg('to', '2024'));
const out = resolve(arg('out', 'reports/openligadb-backtest.json'));
const SOURCE = 'hf-soccer-dataset';
const K = ['home', 'draw', 'away'];

if (!LEAGUES[league] || !Number.isInteger(from) || !Number.isInteger(to) || from > to) {
  console.error(JSON.stringify({ status: 'failed', code: 'INVALID_ARGS' }));
  process.exit(2);
}

function toHistory(rows) {
  const matches = []; let rejected = 0;
  for (const m of rows) {
    const results = m.matchResults || [];
    const fin = results.find(r => r.resultTypeID === 2) || results[results.length - 1];
    if (!m.matchIsFinished || !fin || !m.team1 || !m.team2 || m.team1.teamId === m.team2.teamId) { rejected++; continue; }
    const h = fin.pointsTeam1, a = fin.pointsTeam2;
    if (![h, a].every(v => Number.isInteger(v) && v >= 0 && v <= 20)) { rejected++; continue; }
    matches.push({
      id: 'ol-' + m.matchID, source: SOURCE, sourceFixtureId: 'ol-' + m.matchID,
      league, season: String(m.leagueSeason), kickoff: m.matchDateTimeUTC,
      home: m.team1.teamName, away: m.team2.teamName,
      homeTeamId: 'ol-' + m.team1.teamId, awayTeamId: 'ol-' + m.team2.teamId,
      homeGoals: h, awayGoals: a, status: 'FINISHED', period: 'full-time'
    });
  }
  matches.sort((x, y) => Date.parse(x.kickoff) - Date.parse(y.kickoff));
  return { matches, rejected };
}

const raw = []; let rejected = 0;
for (let y = from; y <= to; y++) {
  const response = await fetch(`https://api.openligadb.de/getmatchdata/${LEAGUES[league]}/${y}`);
  if (!response.ok) { console.error(JSON.stringify({ status: 'failed', code: 'SOURCE_HTTP_' + response.status, season: y })); process.exit(1); }
  const converted = toHistory(await response.json());
  raw.push(...converted.matches); rejected += converted.rejected;
}
const seenId = new Set(); const matches = raw.filter(m => !seenId.has(m.id) && seenId.add(m.id));
const windows = [];
for (let y = from + 1; y <= to + 1; y++) windows.push(`${y}-06-30T00:00:00Z`);
windows.push(`${to + 2}-06-30T00:00:00Z`);

const merged = new Map(); const perWindow = [];
for (const nowISO of windows) {
  const r = walkForwardBacktest(matches, { source: SOURCE, league, nowISO, horizonHours: 1 });
  for (const e of r.evaluations) if (!merged.has(e.fixtureId)) merged.set(e.fixtureId, e);
  perWindow.push({ nowISO, status: r.status, evaluated: r.evaluated, skipped: r.skipped });
}
const bs = (p, actual) => K.reduce((s, k) => s + ((p[k] ?? 0) - (k === actual ? 1 : 0)) ** 2, 0);
const argmax = p => K.reduce((b, k) => (p[k] > p[b] ? k : b), 'home');
const ev = [...merged.values()];
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const brier = ev.map(e => bs(e.probabilities, e.actual));
const baseline = ev.map(e => bs(e.baseline, e.actual));
const n = ev.length, mB = mean(brier);
const sd = n > 1 ? Math.sqrt(brier.reduce((s, x) => s + (x - mB) ** 2, 0) / (n - 1)) : null;
const se = n > 1 ? sd / Math.sqrt(n) : null;
const seasonRows = {};
for (const e of ev) (seasonRows[e.season || 'unknown'] ||= []).push(e);
const report = {
  version: 1, generatedAt: new Date().toISOString(), league, source: SOURCE, origin: 'openligadb',
  range: { from, to }, matchesLoaded: matches.length, rejectedRows: rejected, windows: perWindow,
  merged: {
    evaluated: n,
    accuracy: mean(ev.map(e => (argmax(e.probabilities) === e.actual ? 1 : 0))),
    baselineAccuracy: mean(ev.map(e => (argmax(e.baseline) === e.actual ? 1 : 0))),
    brier: mB, brierSE: se, brier95: se === null ? null : [mB - 1.96 * se, mB + 1.96 * se],
    baselineBrier: mean(baseline), predictedDrawCount: ev.filter(e => argmax(e.probabilities) === 'draw').length,
    threeWayCoinFlipBrier: 2 / 3
  },
  bySeason: Object.entries(seasonRows).sort().map(([season, list]) => ({
    season, evaluated: list.length,
    accuracy: mean(list.map(e => (argmax(e.probabilities) === e.actual ? 1 : 0))),
    brier: mean(list.map(e => bs(e.probabilities, e.actual))),
    baselineBrier: mean(list.map(e => bs(e.baseline, e.actual)))
  })),
  limitations: [
    '回溯回放（retrospective），不能替代只接受赛前冻结的前瞻样本门槛。',
    'FORECAST_MODEL.backtestLimit 限制单窗口候选场次，本工具用多窗口叠加扩样。',
    '德甲之外需对应联赛的历史源，本工具不伪造跨源合并。'
  ]
};
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: 'ok', out, evaluated: n, accuracy: report.merged.accuracy, brier: report.merged.brier, baselineBrier: report.merged.baselineBrier }));
