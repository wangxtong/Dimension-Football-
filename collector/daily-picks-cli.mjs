// 每日盘口清单 CLI：把体彩让球盘与本项目模型 1X2 概率合成一张可回测的每日推荐表。
// 用法：node collector/daily-picks-cli.mjs --root /path [--limit 10] [--out FILE]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchSportteryMatches } from './sources/sporttery.mjs';
import { buildDailyPicks, settleDailyPicks } from './daily-picks.mjs';
import { teamName } from './sources/team-names.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const root = resolve(arg('root', '/tmp/ci5'));
const limit = Number(arg('limit', '10')) || 10;
const nowISO = arg('now', new Date().toISOString());

const cn = name => { try { return teamName(name) || name; } catch { return name; } };

async function main() {
  let predictions = null;
  try { predictions = JSON.parse(await readFile(resolve(root, 'reports/predictions.json'), 'utf8')); }
  catch { console.log(JSON.stringify({ status: 'blocked', code: 'PREDICTIONS_UNAVAILABLE' })); process.exitCode = 1; return; }

  const jc = await fetchSportteryMatches();
  if (jc.error) { console.log(JSON.stringify({ status: 'blocked', code: 'SPORTTERY_' + jc.error })); process.exitCode = 1; return; }

  // 把模型预测按「中文主队|中文客队」建索引，用于和体彩的场次对齐
  const modelByTeams = new Map();
  for (const row of predictions.fixtures || []) {
    const f = row.fixture || {}, fc = row.forecast || null;
    if (!fc) continue;
    const key = cn(f.home) + '|' + cn(f.away);
    modelByTeams.set(key, { probabilities: fc.probabilities || fc, fixtureId: f.id, kickoff: f.kickoff });
  }

  const matches = jc.matches.map(m => {
    const hit = modelByTeams.get(m.home + '|' + m.away) || null;
    return { ...m, fixtureKey: hit ? hit.fixtureId : null, ...(hit ? { forecast: hit } : {}) };
  });
  const picks = buildDailyPicks({ matches, forecasts: matches.map(m => m.forecast ? { ...m.forecast, matchId: m.matchId, fixtureKey: m.fixtureId } : null).filter(Boolean), nowISO, limit });

  const matched = picks.picks.filter(p => p.probabilities).length;
  const out = {
    status: 'ok', nowISO, source: 'sporttery-jc + own-model',
    jcTotal: jc.matches.length, jcUpdatedAt: jc.updatedAt || null,
    modelFixtures: (predictions.fixtures || []).length,
    picksTotal: picks.total, matched, picks: picks.picks.map(p => ({
      league: p.league, home: p.home, away: p.away, kickoff: p.kickoff,
      handicap: p.handicap.goalLine, odds: { home: p.handicap.home, draw: p.handicap.draw, away: p.handicap.away },
      rank: [p.homeRank?.rank ?? null, p.awayRank?.rank ?? null],
      probabilities: p.probabilities || null, pick: p.pick,
    })),
  };
  console.log(JSON.stringify(out));
}

await main();
