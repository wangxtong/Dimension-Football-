import test from 'node:test';
import assert from 'node:assert/strict';
import { teamName } from '../team-names.mjs';

// Observed API names and exact aliases already used by the Statarea adapter.
// Each row must agree with the existing canonical spelling as well as its label.
const canonicalPairs = [
  ['Paris Saint Germain', 'Paris Saint-Germain FC', '巴黎圣日耳曼'],
  ['Paris Saint-Germain', 'Paris Saint-Germain FC', '巴黎圣日耳曼'],
  ['FSV Mainz 05', '1. FSV Mainz 05', '美因茨'],
  ['Bayer Leverkusen', 'Bayer 04 Leverkusen', '勒沃库森'],
  ['Werder Bremen', 'SV Werder Bremen', '云达不莱梅'],
  ['Union Berlin', '1. FC Union Berlin', '柏林联合'],
  ['1899 Hoffenheim', 'TSG 1899 Hoffenheim', '霍芬海姆'],
  ['Borussia Monchengladbach', 'Borussia Mönchengladbach', '门兴格拉德巴赫'],
  ['Tottenham Hotspur', 'Tottenham Hotspur FC', '热刺'],
  ['Newcastle Utd', 'Newcastle United FC', '纽卡斯尔联'],
  ['Brighton and Hove Albion', 'Brighton & Hove Albion FC', '布莱顿'],
  ['West Ham United', 'West Ham United FC', '西汉姆联'],
  ['Wolverhampton', 'Wolverhampton Wanderers FC', '狼队'],
  ['Wolverhampton Wanderers', 'Wolverhampton Wanderers FC', '狼队'],
  ['Leeds United', 'Leeds United FC', '利兹联'],
  ['Real Betis', 'Real Betis Balompié', '皇家贝蒂斯'],
  ['Celta Vigo', 'RC Celta de Vigo', '塞尔塔'],
  ['Rayo Vallecano', 'Rayo Vallecano de Madrid', '巴列卡诺'],
  ['Elche', 'Elche CF', '埃尔切'],
  ['Inter Milan', 'FC Internazionale Milano', '国际米兰'],
  ['Inter Milano', 'FC Internazionale Milano', '国际米兰'],
  ['Unione Venezia', 'Venezia FC', '威尼斯'],
];

test('shared team names match verified API and signal aliases to canonical teams', () => {
  for (const [alias, canonical, expected] of canonicalPairs) {
    assert.equal(teamName(alias), expected, alias);
    assert.equal(teamName(alias), teamName(canonical), `${alias} / ${canonical}`);
  }
});

test('shared registry includes exact remaining aliases already verified by the signal reader', () => {
  for (const [alias, expected] of [
    ['VfL Bochum', '波鸿'], ['AC Monza', '蒙扎'], ['Monza', '蒙扎'], ['Frosinone', '弗罗西诺内'],
  ]) assert.equal(teamName(alias), expected, alias);
});

test('unknown teams remain distinct instead of using fuzzy or substring matching', () => {
  for (const name of ['SV Elversberg', 'SC Paderborn 07', 'Paris Saint Germain II', 'Inter Miami', 'Bayer Unknown']) {
    assert.equal(teamName(name), name);
  }
  assert.notEqual(teamName('Paris FC'), teamName('Paris Saint Germain'));
  assert.notEqual(teamName('Bayer Leverkusen'), teamName('Bayern Munich'));
  assert.notEqual(teamName('Manchester United'), teamName('Manchester City'));
  assert.equal(teamName(null), '未知球队');
});
