import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withSourceCooldown } from '../cooldown.mjs';

const NOW = '2026-10-31T10:00:00.000Z';
test('Retry-After serializes concurrent callers and survives a new acquisition round', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-cooldown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'cooldown.json'); let calls = 0;
  const limited = async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '7200' } }); };
  await withSourceCooldown({ statePath, clock: () => NOW }, async cooldown => {
    const outcomes = await Promise.allSettled([1, 2, 3].map(() => cooldown.fetch('hkjc', limited, 'https://example.invalid')));
    assert.deepEqual(outcomes.map(r => r.reason.code), ['rate_limited', 'source_cooldown', 'source_cooldown']);
  });
  await withSourceCooldown({ statePath, clock: () => NOW }, async cooldown => {
    await assert.rejects(cooldown.fetch('hkjc', limited, 'https://example.invalid'), { code: 'source_cooldown', retryAfterMs: 7200000 });
    assert.equal((await cooldown.fetch('openligadb', async () => new Response('ok'), 'https://example.invalid')).status, 200);
  });
  assert.equal(calls, 1);
  await withSourceCooldown({ statePath, clock: () => '2026-10-31T12:00:00.000Z' }, async cooldown => {
    assert.equal((await cooldown.fetch('hkjc', async () => { calls++; return new Response('ok'); }, 'https://example.invalid')).status, 200);
  });
  assert.equal(calls, 2);
});

test('memory-only rounds honor 503 date Retry-After and corrupt persistent state fails closed', async t => {
  let calls = 0;
  await withSourceCooldown({ clock: () => NOW }, async cooldown => {
    const unavailable = async () => { calls++; return new Response('', { status: 503, headers: { 'retry-after': 'Sat, 31 Oct 2026 11:00:00 GMT' } }); };
    await assert.rejects(cooldown.fetch('source', unavailable, 'https://example.invalid'), { code: 'http_unavailable', retryAfterMs: 3600000 });
    await assert.rejects(cooldown.fetch('source', unavailable, 'https://example.invalid'), { code: 'source_cooldown' });
  });
  assert.equal(calls, 1);
  const directory = await mkdtemp(join(tmpdir(), 'source-cooldown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'bad.json'); await writeFile(statePath, '{');
  await assert.rejects(withSourceCooldown({ statePath }, () => assert.fail('must not run')), { message: 'SOURCE_COOLDOWN_UNREADABLE' });
});

test('cancelled or expired rounds never perform a request', async () => {
  for (const options of [{ signal: AbortSignal.abort() }, { remaining: () => 0 }]) {
    await withSourceCooldown(options, cooldown => assert.rejects(cooldown.fetch('source', () => assert.fail('no network'), 'https://example.invalid'),
      { code: options.signal ? 'cancelled' : 'budget_exhausted' }));
  }
});

test('an abort releases the round lock even when the underlying transport ignores cancellation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'source-cooldown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statePath = join(directory, 'state.json'), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20);
  try {
    await assert.rejects(withSourceCooldown({ statePath, signal: controller.signal }, cooldown =>
      cooldown.fetch('source', () => new Promise(() => {}), 'https://example.invalid')), { code: 'cancelled' });
    await withSourceCooldown({ statePath }, async () => {});
  } finally { clearTimeout(timer); }
});
