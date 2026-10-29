import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPublicEvidence, sourceCapabilities} from '../index.mjs';

const nowISO = '2026-10-27T08:30:00.000Z';
const fixture = {id: 'fd-1', league: 'SA', home: 'US Sassuolo Calcio', away: 'SS Lazio',
  kickoff: '2026-10-27T17:30:00.000Z', status: 'TIMED', source: 'football-data.org'};
function feedFetch(calls) {
  const schedule = Array(69).fill('');
  Object.assign(schedule, {0: '310001', 2: '意甲', 5: '萨索洛', 8: '拉齐奥', 11: '01:30', 13: '0', 36: '10-28', 43: '2026'});
  const market = Array(52).fill('');
  Object.assign(market, {0: '310001', 1: '1788000', 2: '-0.25', 3: '0.87', 4: '0.95', 13: '1', 14: '0'});
  return async (url, options) => {
    calls.push({url, options});
    const path = new URL(url).pathname;
    const headers = {Date: 'Tue, 27 Oct 2026 08:30:00 GMT', 'Last-Modified': 'Tue, 27 Oct 2026 08:29:55 GMT'};
    if (path.endsWith('.js')) return new Response(`A[1]=${JSON.stringify(schedule.join('^'))}.split('^');`, {headers});
    if (path.endsWith('.xml')) return new Response(`<c><match><m>${market.join(',')}</m></match><isMaintain>0</isMaintain></c>`, {headers});
    return new Response('not available', {status: 403});
  };
}

test('normalization keeps two prices per bookmaker and one shared provider independence group', async () => {
  const calls = [];
  const result = await collectPublicEvidence({fixtures: [fixture], nowISO, fetchImpl: feedFetch(calls)});
  assert.equal(result.quotes.length, 6);
  assert.deepEqual([...new Set(result.quotes.map(q => q.bookmaker))], ['M88', '12Bet', 'SBOBET']);
  assert.deepEqual([...new Set(result.quotes.map(q => q.independenceGroup))], ['titan007']);
  for (const quote of result.quotes) {
    assert.equal(quote.sourceId, 'titan007');
    assert.equal(quote.fixtureId, fixture.id);
    assert.equal(quote.fixtureSnapshot.home, fixture.home);
    assert.equal(quote.market, 'asian-handicap');
    assert.equal(quote.period, 'full-time');
    assert.equal(quote.verified, true);
    assert.equal(quote.verificationMethod, 'automatic');
    assert.equal(quote.inPlay, false);
    assert.equal(quote.closed, false);
    assert.ok(quote.evidenceUrl.startsWith('https://live.titan007.com/'));
  }
  const schedule = calls.find(call => call.url.includes('bfdata_ut.js'));
  assert.equal(schedule.options.headers.Referer, 'https://live.titan007.com/index2in1.aspx?id=17');
  assert.equal(calls.some(call => new URL(call.url).pathname.includes('goal3.xml')), false);
  for (const id of ['forebet', 'footymetrics', 'tactix', 'golsinyali', 'fotmob']) {
    const diagnostic = result.diagnostics.find(d => d.id === id);
    assert.equal(diagnostic.status, 'restricted');
    assert.equal(diagnostic.fetchedAt, null);
    assert.ok(diagnostic.capability);
    assert.equal(calls.some(call => new URL(call.url).hostname === new URL(diagnostic.url).hostname), false);
  }
  assert.equal(result.signals.length, 0);
  assert.ok(sourceCapabilities.statarea.includes('1X2'));
});

test('oversized or invalid fixture request fails before fetching and is never silently truncated', async () => {
  const fetchImpl = () => { throw new Error('must not fetch'); };
  await assert.rejects(() => collectPublicEvidence({fixtures: Array(3001).fill(fixture), nowISO, fetchImpl}), /maximum 3000/);
  await assert.rejects(() => collectPublicEvidence({fixtures: null, nowISO, fetchImpl}), /maximum 3000/);
  await assert.rejects(() => collectPublicEvidence({fixtures: [], nowISO: 'invalid', fetchImpl}), /maximum 3000/);
});
