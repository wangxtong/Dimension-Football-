import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchSportteryMatches, handicapQuotes, toHandicap } from '../sources/sporttery.mjs';

const wrap = (subMatchList, totalCount = subMatchList.length) => ({
  success: true, value: { matchInfoList: [{ businessDate: '2026-11-02', subMatchList }],
    totalCount, lastUpdateTime: '2026-11-02 21:49:56' },
});
const row = (over = {}) => ({ matchId: 2042441, matchNum: 1004, matchNumStr: '周一004',
  leagueAbbName: '意甲', leagueId: 5, homeTeamAbbName: '亚特兰大', awayTeamAbbName: '帕尔马',
  homeRank: '[意甲13]', awayRank: '[意甲18]', matchDate: '2026-11-03', matchTime: '03:45:00',
  matchStatus: 'Selling', sellStatus: '1',
  hhad: { h: '2.07', d: '3.40', a: '2.76', goalLine: '-1', goalLineValue: '-1.00',
    updateDate: '2026-11-02', updateTime: '17:09:34' }, ...over });
const respond = body => async () => ({ ok: true, json: async () => body });

test('merges matchDate and matchTime into a Beijing kickoff', async () => {
  const p = await fetchSportteryMatches({ fetchImpl: respond(wrap([row()])) });
  assert.equal(p.error, undefined);
  assert.equal(p.matches.length, 1);
  assert.equal(p.matches[0].kickoff, '2026-11-02T19:45:00.000Z');
  assert.equal(p.matches[0].league, '意甲');
  assert.deepEqual(p.matches[0].homeRank, { league: '意甲', rank: 13 });
  assert.equal(p.updatedAt, '2026-11-02T13:49:56.000Z');
});

test('handicap keeps goal line and seconds-level update time', async () => {
  const p = await fetchSportteryMatches({ fetchImpl: respond(wrap([row()])) });
  const q = handicapQuotes(p);
  assert.equal(q.length, 1);
  const quote = q[0];
  assert.equal(quote.source, 'sporttery-jc');
  assert.equal(quote.goalLine, -1);
  assert.equal(quote.home, 2.07);
  assert.equal(quote.draw, 3.4);
  assert.equal(quote.away, 2.76);
  assert.equal(quote.updatedAt, '2026-11-02T09:09:34.000Z');
  assert.equal(quote.fixtureKey, 'jc-2042441');
});

test('rejects rows without a usable handicap or identity', async () => {
  const p = await fetchSportteryMatches({ fetchImpl: respond(wrap([
    row({ matchId: null }),
    row({ hhad: {} }),
    row({ homeTeamAbbName: 'X', awayTeamAbbName: 'X' }),
    row({ matchDate: 'not-a-date' }),
    row({ hhad: { h: '0', d: '3', a: '3', goalLine: '-1' } }),
    row({ matchId: 2 }),
  ])) });
  // hhad 为空的行仍保留（赛程信息有用），但不产出盘口报价。
  assert.equal(p.matches.length, 3);
  assert.equal(p.matches.filter(m => m.handicap).length, 1);
  assert.equal(handicapQuotes(p).length, 1);
});

test('degrades on transport, HTTP and payload failures', async () => {
  const a = await fetchSportteryMatches({ fetchImpl: async () => { throw new Error('x'); } });
  assert.equal(a.error, 'FETCH_UNCONFIRMED');
  const b = await fetchSportteryMatches({ fetchImpl: async () => ({ ok: false, status: 403, body: { cancel: async () => {} } }) });
  assert.equal(b.error, 'HTTP_403');
  const c = await fetchSportteryMatches({ fetchImpl: respond({ success: false }) });
  assert.equal(c.error, 'INVALID_PAYLOAD');
  assert.equal(toHandicap(null), null);
});