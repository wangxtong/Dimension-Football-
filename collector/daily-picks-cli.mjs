// 研究专用：将体彩三项让球胜平负与赛前冻结的自有模型匹配。
// 不是二项亚洲盘，不进入正式推荐；不明身份、比赛时间不一致或无冻结时间时不出方向。
// 用法：node collector/daily-picks-cli.mjs --root /path [--limit 10] [--now ISO]
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fetchSportteryMatches } from './sources/sporttery.mjs';
import { buildDailyPicks } from './daily-picks.mjs';
import { teamName } from './sources/team-names.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = resolve(arg('root', '/tmp/ci5'));
const limit = Number(arg('limit', '10'));
const nowISO = arg('now', new Date().toISOString());
const cn = name => { try { return teamName(name) || name; } catch { return name; } };
const matchupKey = (home, away, kickoff) => [home, away, kickoff].join('|');

async function main() {
  let predictions;
  try { predictions = JSON.parse(await readFile(resolve(root, 'reports/predictions.json'), 'utf8')); }
  catch { console.log(JSON.stringify({ status:'blocked', code:'PREDICTIONS_UNAVAILABLE' })); process.exitCode=1; return; }
  const jc = await fetchSportteryMatches();
  if (jc.error) { console.log(JSON.stringify({ status:'blocked', code:'SPORTTERY_' + jc.error })); process.exitCode=1; return; }

  // 不能只用中文队名进行赛事绑定：同队在其他日期有比赛，跨日误配会造出虚假预测。
  const modelByMatch = new Map(), ambiguous = new Set();
  for (const row of predictions.fixtures || []) {
    const fixture = row?.fixture, forecast = row?.forecast;
    if (!fixture || forecast?.status !== 'forecast' || !forecast.probabilities) continue;
    const key = matchupKey(cn(fixture.home), cn(fixture.away), fixture.kickoff);
    const generatedAt = forecast.generatedAt || row.generatedAt || predictions.generatedAt;
    if (!Number.isFinite(Date.parse(generatedAt))) continue;
    if (modelByMatch.has(key)) { ambiguous.add(key); modelByMatch.delete(key); continue; }
    if (!ambiguous.has(key)) modelByMatch.set(key, { probabilities: forecast.probabilities, generatedAt, fixtureId: fixture.id });
  }
  const matches = jc.matches;
  const forecasts = [];
  for (const match of matches) {
    const key = matchupKey(match.home, match.away, match.kickoff);
    if (ambiguous.has(key)) continue;
    const model = modelByMatch.get(key);
    if (!model) continue;
    forecasts.push({ ...model, matchId: match.matchId, fixtureKey: 'jc-' + match.matchId });
  }
  const picks = buildDailyPicks({ matches, forecasts, nowISO, limit });
  const matched = picks.picks.filter(p => p.probabilities).length;
  console.log(JSON.stringify({
    status:'ok', nowISO, source:'sporttery-jc + own-model', pool:'hhad',
    disclaimer:'研究参考；三项让球胜平负不是亚洲让球二项盘，1X2倾向不是校准的hhad概率',
    jcTotal:jc.matches.length, jcUpdatedAt:jc.updatedAt || null,
    modelFixtures:(predictions.fixtures || []).length,
    picksTotal:picks.total, matched, selected:picks.selected || 0,
    researchOnly:true, commercialReleaseGate:'BLOCKED',
    picks:picks.picks.map(p=>({matchId:p.matchId,league:p.league,home:p.home,away:p.away,kickoff:p.kickoff,
      pool:p.handicap.pool, goalLine:p.handicap.goalLine, odds:{home:p.handicap.home,draw:p.handicap.draw,away:p.handicap.away},
      updatedAt:p.handicap.updatedAt, rank:[p.homeRank?.rank ?? null,p.awayRank?.rank ?? null],
      probabilities:p.probabilities || null, predictionFrozenAt:p.predictionFrozenAt, pick:p.pick})) }));
}
await main();
