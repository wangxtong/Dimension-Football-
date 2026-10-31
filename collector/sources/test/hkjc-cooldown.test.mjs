import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchHkjcEvidence } from '../hkjc.mjs';

test('HKJC persists Retry-After and reports the cooldown without issuing a second request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hkjc-cooldown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nowISO = '2026-10-31T05:30:00.000Z'; let calls = 0;
  const options = { nowISO, clock: () => nowISO, cooldownStatePath: join(directory, 'hkjc.json'),
    fixtures: [{ id: 'f1', league: 'BL1', home: 'Leverkusen', away: 'Stuttgart', kickoff: '2026-10-31T14:30:00.000Z', status: 'SCHEDULED' }],
    fetchImpl: async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '7200' } }); } };
  const first = await fetchHkjcEvidence(options), next = await fetchHkjcEvidence(options);
  assert.equal(calls, 1); assert.equal(first.diagnostics[0].code, 'rate_limited');
  assert.equal(next.diagnostics[0].code, 'source_cooldown'); assert.equal(next.diagnostics[0].retryAfterMs, 7200000);
  assert.equal(next.diagnostics[0].nextProbeAt, '2026-10-31T07:30:00.000Z');
  assert.deepEqual(next.quotes, []);
  const rejected = await fetchHkjcEvidence({ ...options, cooldownStatePath: undefined, fetchImpl: async () => {
    throw Object.assign(new Error('synthetic-secret'), { httpStatus: 'synthetic-secret', retryAfterMs: 'synthetic-secret', nextProbeAt: 'synthetic-secret' });
  } });
  assert.ok(!JSON.stringify(rejected).includes('synthetic-secret'));
});
