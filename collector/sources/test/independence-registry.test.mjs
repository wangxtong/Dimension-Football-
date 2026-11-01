import test from 'node:test';
import assert from 'node:assert/strict';
import { QUOTE_ORIGINS, quoteChannelSource, resolveQuoteOrigin } from '../independence-registry.mjs';

test('three Titan bookmaker labels and alternate hosts retain one publishing origin', () => {
  const rows = [['M88', 17, 'live.titan007.com'], ['12Bet', 24, 'livestatic.titan007.com'], ['SBOBET', 31, 'new-mirror.invalid']]
    .map(([bookmaker, companyId, hostname]) => ({ sourceId: 'titan007', provider: 'titan007-public-market', bookmaker,
      companyId, evidenceUrl: `https://${hostname}/`, independenceGroup: bookmaker, group: bookmaker }));
  assert.deepEqual([...new Set(rows.map(row => resolveQuoteOrigin(row)?.group))], ['titan007']);
});

test('Macau producer identity is explicit and cannot be forged by provider, bookmaker or company labels', () => {
  const row = { sourceId: 'macauslot', provider: 'macauslot-official', bookmaker: 'Macau SLOT' };
  assert.equal(resolveQuoteOrigin(row).group, 'macauslot-official');
  for (const patch of [{ sourceId: 'oddstorm' }, { sourceId: 'new-domain' }, { sourceId: '__proto__' },
    { provider: 'titan007-public-market' }, { source: 'hkjc-first-party' }, { bookmaker: 'HKJC' }, { companyId: 17 }, { provider: 'unknown' }]) {
    assert.equal(resolveQuoteOrigin({ ...row, ...patch }), null);
  }
  assert.equal(quoteChannelSource('macauslot-official'), 'macauslot');
  assert.equal(quoteChannelSource('titan007-public-market'), 'titan007');
  assert.equal(quoteChannelSource('hkjc-first-party'), 'hkjc');
  assert.equal(quoteChannelSource('https://www.macauslot.com'), null);
});

test('archive identity can be checked without URLs and a resolved identity does not validate prices or authorization', () => {
  const origin = resolveQuoteOrigin({ sourceId: 'hkjc', bookmaker: 'HKJC', observedAt: 'invalid', decimalOdds: null });
  assert.equal(origin, QUOTE_ORIGINS.hkjc);
  for (const key of ['verified', 'authorized', 'opening', 'live', 'commercialLicence']) assert.equal(Object.hasOwn(origin, key), false);
  assert.equal(resolveQuoteOrigin({ sourceId: 'titan007', bookmaker: 'M88', companyId: 24 }), null);
});

test('registry evidence keeps historical documentation limits and cannot be mutated by callers', () => {
  const origin = QUOTE_ORIGINS.macauslot;
  assert.equal(origin.evidence[0].documentDate, '2019-07-23');
  assert.match(origin.evidence[0].limitation, /not a current data licence/);
  assert.throws(() => { origin.group = 'extra-vote'; }, TypeError);
  assert.throws(() => origin.hosts.push('arbitrary.invalid'), TypeError);
  assert.throws(() => { origin.evidence[0].claim = 'authorized'; }, TypeError);
});
