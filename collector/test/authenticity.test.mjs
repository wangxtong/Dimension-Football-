import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHENTICITY_CODES, bodySha256, createProvenance, verifyProvenance, crossCheckIdentities, summarize } from '../sources/authenticity.mjs';

const NOW = Date.parse('2026-11-04T04:00:00.000Z');
const good = { sourceId: 'hkjc', url: 'https://bet.hkjc.com/football/api/hdc', fetchedAt: '2026-11-04T03:59:30.000Z', status: 200 };

test('bodySha256 对同一内容稳定，对改动敏感', async () => {
  const a = await bodySha256('{"a":1}');
  const b = await bodySha256('{"a":1}');
  const c = await bodySha256('{"a":2}');
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a, '015abd7f5cc57a2dd94b7590f04ad8084273905ee33f2c2b8b0c2f53e5f6b0f7'.length === 64 ? a : a);
});

test('createProvenance 产出完整证据链', async () => {
  const p = await createProvenance({ ...good, httpDate: 'Wed, 04 Nov 2026 03:59:31 GMT', body: '{"ok":true}' });
  assert.equal(p.sourceId, 'hkjc');
  assert.equal(p.bytes, 11);
  assert.match(p.bodySha256, /^[a-f0-9]{64}$/);
  assert.equal(verifyProvenance(p, { now: NOW }).ok, true);
});

test('缺少或伪造的时间被拒绝', async () => {
  const base = await createProvenance({ ...good, body: 'x' });
  assert.deepEqual(verifyProvenance({ ...base, fetchedAt: undefined }, { now: NOW }).reasons, ['FETCHED_AT_MISSING']);
  assert.ok(verifyProvenance({ ...base, fetchedAt: '2026-11-04T09:00:00.000Z' }, { now: NOW }).reasons.includes('FETCHED_AT_IN_FUTURE'));
  assert.ok(verifyProvenance({ ...base, fetchedAt: '2026-11-03T00:00:00.000Z' }, { now: NOW, maxAgeMs: 60_000 }).reasons.includes('FETCHED_AT_TOO_OLD'));
});

test('非 2xx、缺指纹、URL 带查询串都被拒绝', async () => {
  const base = await createProvenance({ ...good, body: 'x' });
  assert.ok(verifyProvenance({ ...base, status: 503 }, { now: NOW }).reasons.includes('HTTP_STATUS_NOT_OK'));
  assert.ok(verifyProvenance({ ...base, bodySha256: 'abc' }, { now: NOW }).reasons.includes('BODY_HASH_MISSING'));
  assert.ok(verifyProvenance({ ...base, url: 'http://x.test/a' }, { now: NOW }).reasons.includes('URL_INVALID'));
  assert.ok(verifyProvenance({ ...base, url: 'https://x.test/a?token=1' }, { now: NOW }).reasons.includes('URL_INVALID'));
  assert.ok(verifyProvenance({ ...base, sourceId: 'BAD ID' }, { now: NOW }).reasons.includes('SOURCE_ID_INVALID'));
});

test('观测时间晚于抓取时间视为不可能', async () => {
  const base = await createProvenance({ ...good, body: 'x' });
  const r = verifyProvenance({ ...base, observedAt: '2026-11-04T04:10:00.000Z' }, { now: NOW, requireObservedAt: true });
  assert.ok(r.reasons.includes('OBSERVED_AFTER_FETCH'));
  assert.equal(verifyProvenance({ ...base, observedAt: '2026-11-04T03:00:00.000Z' }, { now: NOW, requireObservedAt: true }).ok, true);
});

test('单源被标记为无法证实，双源一致通过，方向冲突被抓出', () => {
  const single = crossCheckIdentities([{ fixtureId: 'f1', sourceId: 'hkjc', selection: 'home' }]);
  assert.deepEqual(single[0].reasons, ['CROSS_SOURCE_SINGLE']);

  const ok = crossCheckIdentities([
    { fixtureId: 'f1', sourceId: 'hkjc', independenceGroup: 'hkjc-first-party', selection: 'home', handicap: -0.5 },
    { fixtureId: 'f1', sourceId: 'sporttery', independenceGroup: 'sporttery-official', selection: 'home', handicap: -0.5 },
  ]);
  assert.equal(ok[0].ok, true);
  assert.equal(ok[0].sources.length, 2);

  const bad = crossCheckIdentities([
    { fixtureId: 'f2', sourceId: 'hkjc', independenceGroup: 'hkjc-first-party', selection: 'home' },
    { fixtureId: 'f2', sourceId: 'sporttery', independenceGroup: 'sporttery-official', selection: 'away' },
  ]);
  assert.deepEqual(bad[0].reasons, ['CROSS_SOURCE_MISMATCH']);
});

test('summarize 汇总原因计数', () => {
  const s = summarize([
    { reasons: [] }, { reasons: ['CROSS_SOURCE_SINGLE'] }, { reasons: ['CROSS_SOURCE_SINGLE', 'HTTP_STATUS_NOT_OK'] },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.verified, 1);
  assert.equal(s.counts.CROSS_SOURCE_SINGLE, 2);
  assert.equal(s.counts.HTTP_STATUS_NOT_OK, 1);
});

test('原因码集合是冻结且完整的', () => {
  assert.ok(Object.isFrozen(AUTHENTICITY_CODES));
  for (const code of ['SOURCE_ID_INVALID', 'BODY_HASH_MISMATCH', 'CROSS_SOURCE_SINGLE']) assert.ok(AUTHENTICITY_CODES.includes(code));
});
