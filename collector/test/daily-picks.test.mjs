import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDailyPicks, pickSide, settleHandicap, settleHhad, settleDailyPicks } from '../daily-picks.mjs';

const kickoff = '2026-11-03T16:00:00.000Z';
const now = '2026-11-03T08:00:00.000Z';
const match = (over = {}) => ({ matchId: 111, league: 'PL', home: '主队', away: '客队', kickoff,
  handicap: { pool: 'hhad', source: 'sporttery-jc', goalLine: -1, home: 2.07, draw: 3.4, away: 2.76,
    updatedAt: '2026-11-03T07:00:00.000Z' }, ...over });
const forecast = (over = {}) => ({ matchId: 111, generatedAt: '2026-11-03T07:50:00.000Z',
  probabilities: { home: .65, draw: .20, away: .15 }, ...over });
const result = (over = {}) => ({ matchId: 111, status: 'FT', homeGoals: 2, awayGoals: 1,
  resultObservedAt: '2026-11-03T18:30:00.000Z', kickoff, home: '主队', away: '客队', ...over });

test('体彩三项让球平是一种全赢选择，绝不是亚盘走盘', () => {
  assert.deepEqual(settleHhad({ homeGoals: 2, awayGoals: 1, goalLine: -1, selection: 'draw', decimalOdds: 3.4 }),
    { selection: 'draw', winningSelection: 'draw', margin: 0, outcome: '全赢', decimalOdds: 3.4, profitUnits: 2.4 });
  assert.equal(settleHhad({ homeGoals: 2, awayGoals: 1, goalLine: -1, selection: 'home', decimalOdds: 2.07 }).outcome, '全输');
  assert.equal(settleHandicap({ homeGoals: 2, awayGoals: 1, goalLine: -1 }), null);
});

test('所选客队赢时必须记客队命中，不能以主队净胜判断', () => {
  const x = settleHhad({ homeGoals: 0, awayGoals: 2, goalLine: -1, selection: 'away', decimalOdds: 1.81 });
  assert.equal(x.outcome, '全赢'); assert.equal(x.winningSelection, 'away');
  assert.equal(x.profitUnits, .81);
});

test('体彩 hhad 不接受亚洲四分之一球和非正常比分', () => {
  assert.equal(settleHhad({ homeGoals: 2, awayGoals: 1, goalLine: -.25, selection: 'home', decimalOdds: 1.9 }), null);
  assert.equal(settleHhad({ homeGoals: -1, awayGoals: 2, goalLine: -1, selection: 'home', decimalOdds: 1.9 }), null);
  assert.equal(settleHhad({ homeGoals: 1, awayGoals: 2, goalLine: -1, selection: 'void', decimalOdds: 1.9 }), null);
});

test('赛前冻结且有完整三项报价才生成研究清单', () => {
  const good = buildDailyPicks({matches:[match()],forecasts:[forecast()],nowISO:now});
  assert.equal(good.total, 1); assert.equal(good.selected, 1);
  assert.equal(good.picks[0].pick.method,'UNCALIBRATED_1X2_PROXY_NOT_HHAD_PROBABILITY');
  assert.equal(good.picks[0].pick.decimalOdds, 2.07);
  const late = buildDailyPicks({matches:[match()],forecasts:[forecast({generatedAt:'2026-11-03T18:00:00.000Z'})],nowISO:now});
  assert.equal(late.picks[0].pick,null);
  const malformed = buildDailyPicks({matches:[match({handicap:{pool:'hhad',goalLine:-1,home:1.5,draw:3.4}})],nowISO:now});
  assert.equal(malformed.total,0);
  assert.equal(buildDailyPicks({matches:[match({handicap:{...match().handicap,pool:'asian-handicap'}})],nowISO:now}).total,0);
});

test('赔率绝不沿用更早模型时间倒填，当前观察时刻才是选盘时间', () => {
  const { picks } = buildDailyPicks({ matches: [match()], forecasts: [forecast()], nowISO: now });
  assert.equal(picks[0].modelGeneratedAt, '2026-11-03T07:50:00.000Z');
  assert.equal(picks[0].quoteObservedAt, now);
  assert.equal(picks[0].predictionFrozenAt, now);
  assert.notEqual(picks[0].predictionFrozenAt, picks[0].modelGeneratedAt);
  const futureMarket = match({ handicap: { ...match().handicap, updatedAt: '2026-11-03T08:00:01.000Z' } });
  const noFutureQuote = buildDailyPicks({ matches: [futureMarket], forecasts: [forecast()], nowISO: now });
  assert.equal(noFutureQuote.total, 1);
  assert.equal(noFutureQuote.selected, 0);
  assert.equal(noFutureQuote.picks[0].pick, null);
  const noQuoteClock = buildDailyPicks({ matches: [match({handicap: {...match().handicap, updatedAt: null}})],
    forecasts: [forecast()], nowISO: now });
  assert.equal(noQuoteClock.selected, 0);
});

test('篡改盘口报价时钟或伪造旧冻结时间的记录必须拒绝结算', () => {
  const { picks } = buildDailyPicks({ matches: [match()], forecasts: [forecast()], nowISO: now });
  const good = settleDailyPicks({ picks, results: [result({homeGoals:3,awayGoals:1})] });
  assert.equal(good.wins, 1);
  const backdatedSelection = structuredClone(picks);
  backdatedSelection[0].predictionFrozenAt = '2026-11-03T07:30:00.000Z';
  const early = settleDailyPicks({picks:backdatedSelection,results:[result({homeGoals:3,awayGoals:1})]});
  assert.equal(early.total, 0);
  assert.equal(early.coverage.invalid, 1);
  const futureSourceTime = structuredClone(picks);
  futureSourceTime[0].handicap.updatedAt = '2026-11-03T08:00:01.000Z';
  const rejected = settleDailyPicks({picks:futureSourceTime,results:[result({homeGoals:3,awayGoals:1})]});
  assert.equal(rejected.total, 0);
  assert.equal(rejected.coverage.invalid, 1);
});

test('匹配真实赛果才统计；纯候选与未完赛不算失败或成功', () => {
  const {picks}=buildDailyPicks({matches:[match()],forecasts:[forecast()],nowISO:now});
  const won=settleDailyPicks({picks,results:[result({homeGoals:3,awayGoals:1})]});
  assert.equal(won.wins,1); assert.equal(won.hitRate,100); assert.equal(won.pushes,0);
  assert.equal(won.profitUnits,1.07);
  const lost=settleDailyPicks({picks,results:[result()]});
  assert.equal(lost.wins,0); assert.equal(lost.losses,1);
  const live=settleDailyPicks({picks,results:[result({status:'LIVE'})]});
  assert.equal(live.total,0); assert.equal(live.coverage.invalid,1);
  const none=settleDailyPicks({picks,results:[]});
  assert.equal(none.hitRate,null); assert.equal(none.coverage.pending,1);
});

test('未预测比赛、身份冲突和赛后冻结都不能混入分母', () => {
  const unselected=buildDailyPicks({matches:[match()],forecasts:[],nowISO:now}).picks;
  assert.equal(settleDailyPicks({picks:unselected,results:[result()]}).total,0);
  const selected=buildDailyPicks({matches:[match()],forecasts:[forecast()],nowISO:now}).picks;
  assert.equal(settleDailyPicks({picks:selected,results:[result(),result()]}).total,0);
  assert.equal(settleDailyPicks({picks:selected,results:[result({home:'其他'})]}).total,0);
  assert.equal(settleDailyPicks({picks:selected,results:[result({resultObservedAt:'2026-11-03T15:00:00.000Z'})]}).total,0);
});

test('对手数据、客胜方向和反转方向均可计分，胜率不会按主队自动给出', () => {
  const picks = buildDailyPicks({matches:[match(),match({matchId:222})],
    forecasts:[forecast(),forecast({matchId:222,probabilities:{home:.10,draw:.1,away:.8}})],nowISO:now}).picks;
  assert.equal(picks.length,2);
  assert.equal(picks[1].pick.side,'away');
  const outcomes=settleDailyPicks({picks,results:[result({homeGoals:3,awayGoals:1}),
    result({matchId:222,homeGoals:0,awayGoals:2})]});
  assert.equal(outcomes.wins,2);
  assert.equal(outcomes.profitUnits,1.07+1.76);
  assert.equal(outcomes.hitRate,100);
});

test('1X2启发式只作为研究信号，永不宣称可校准的体彩概率', () => {
  const p=pickSide({probabilities:{home:.5,draw:.3,away:.2},goalLine:-1});
  assert.equal(p.researchOnly,true);
  assert.notEqual(p.method,'calibrated-hhad');
});

test('不完整/隐式转换概率绝不能生成真实选项', () => {
  for (const bad of [
    {home: null, draw: .2, away: .8},
    {home: '', draw: .2, away: .8},
    {home: .5, draw: undefined, away: .5},
    {home: .1, draw: .1, away: .1},
    {home: 1.1, draw: 0, away: 0},
  ]) {
    assert.equal(pickSide({probabilities:bad,goalLine:-1}),null);
    const x=buildDailyPicks({matches:[match()],forecasts:[forecast({probabilities:bad})],nowISO:now});
    assert.equal(x.selected,0);
  }
});

test('完整FT必须含双方身份、同一开球时间和至少90分钟赛果观察', () => {
  const {picks}=buildDailyPicks({matches:[match()],forecasts:[forecast()],nowISO:now});
  const invalidResults=[
    result({home:undefined}),result({away:undefined}),result({home:''}),
    result({kickoff:undefined}),result({kickoff:'2026-11-03T17:00:00.000Z'}),
    result({resultObservedAt:'2026-11-03T16:30:00.000Z'}),
  ];
  for (const r of invalidResults) {
    const s=settleDailyPicks({picks,results:[r]});
    assert.equal(s.total,0);assert.equal(s.coverage.invalid,1);
  }
  assert.equal(settleDailyPicks({picks,results:[result({homeGoals:3,awayGoals:1})]}).wins,1);
});

test('冻结选项价格与市场原价不一致时拒绝ROI统计', () => {
  const {picks}=buildDailyPicks({matches:[match()],forecasts:[forecast()],nowISO:now});
  const drift=structuredClone(picks);
  drift[0].pick.decimalOdds=3.99;
  const s=settleDailyPicks({picks:drift,results:[result({homeGoals:3,awayGoals:1})]});
  assert.equal(s.total,0);assert.equal(s.coverage.invalid,1);
});
