import test from 'node:test';
import assert from 'node:assert/strict';
import { demoInput } from '../demo.mjs';
import { evaluateFixture, quoteSourceGroup, validQuote } from '../policy.mjs';

const nowISO = '2026-10-29T08:00:00.000Z';
function evidence() {
  const input = demoInput(nowISO), fixture = input.fixtures[0];
  const quotes = input.evidence.quotes.map(q => {
    if (q.sourceId !== 'oddstorm') { const row = { ...q }; delete row.opening; return row; }
    const row = { ...q, sourceId: 'macauslot', provider: 'macauslot-official', bookmaker: 'Macau SLOT',
      evidenceUrl: 'https://www.macauslot.com/content/page/soccer/odds/all.html?sport=1&lang=cn' };
    delete row.opening; delete row.companyId;
    return row;
  });
  return { fixture, input: { ...input.evidence, quotes }, quote: quotes.find(q => q.sourceId === 'macauslot') };
}
test('official Macau and Titan are separate production channels but missing opening still blocks a candidate', () => {
  const { fixture, input, quote } = evidence();
  assert.equal(quoteSourceGroup(quote), 'macauslot-official');
  assert.equal(validQuote(quote, fixture, Date.parse(nowISO)), true);
  const result = evaluateFixture(fixture, input, nowISO);
  assert.equal(result.status, 'source_insufficient');
  assert.ok(result.reasons.includes('OPENING_TRAJECTORY_MISSING_OR_CHANGED'));
  assert.ok(!result.reasons.includes('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING'));
});
test('Macau identity cannot be renamed to manufacture another independent channel', () => {
  const { quote } = evidence();
  for (const changed of [
    { ...quote, sourceId: 'oddstorm' }, { ...quote, bookmaker: 'HKJC' },
    { ...quote, provider: 'titan007-public-market' }, { ...quote, source: 'hkjc-first-party' },
  ]) assert.equal(quoteSourceGroup(changed), null);
  assert.equal(quoteSourceGroup({ ...quote, independenceGroup: 'invented-channel' }), 'macauslot-official');
});
test('Macau uses genuine feed modification freshness with no publisher-time shortcut or fabricated opening', () => {
  const { fixture, quote } = evidence();
  const stale = new Date(Date.parse(nowISO) - 300001).toISOString();
  assert.equal(validQuote({ ...quote, sourceUpdatedAt: stale, sourceAsOf: nowISO, freshnessBasis: 'publisher-live-snapshot' }, fixture, Date.parse(nowISO)), false);
  assert.equal(validQuote({ ...quote, sourceUpdatedAt: new Date(Date.parse(nowISO) + 1).toISOString() }, fixture, Date.parse(nowISO)), false);
  assert.equal(validQuote({ ...quote, evidenceUrl: 'https://unregistered.example/odds' }, fixture, Date.parse(nowISO)), false);
});
