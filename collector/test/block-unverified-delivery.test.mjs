import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCollection } from '../pipeline.mjs';
import { blockUnverifiedPublication } from '../block-unverified-delivery.mjs';

test('unverified live report stays internal; both external receipts explicitly skipped', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'internal-only-'));
  t.after(() => rm(dir, { recursive:true, force:true }));
  await runCollection({
    fixtures: [], simulated:false, outDir:dir, statePath:join(dir,'state.json'),
    collectEvidence:async()=>({ quotes:[], signals:[], diagnostics:[] }),
  });
  const result = await blockUnverifiedPublication(dir, () => '2026-10-31T08:00:00.000Z');
  for (const channel of ['externalWebsite','notifications']) {
    assert.equal(result[channel].status,'skipped');
    assert.equal(result[channel].code,'BACKTEST_ALL_GREEN_ONLY_NOT_VERIFIED');
  }
  const receipt = JSON.parse(await readFile(join(dir,'publication.json'), 'utf8'));
  assert.equal(receipt.channels.externalWebsite.status,'skipped');
  assert.equal(receipt.channels.notifications.status,'skipped');
  assert.notEqual(receipt.channels.files.status, 'failed');
});

test('hourly workflow cannot publish website or Telegram while backtest is insufficient', async () => {
  const path = new URL('../../.github/workflows/public-sources.yml', import.meta.url);
  const source = await readFile(path,'utf8');
  assert.match(source,/contents: read/);
  assert.match(source,/node collector\/block-unverified-delivery\.mjs reports\/public/);
  assert.doesNotMatch(source,/node collector\/publish\.mjs (?:website|telegram|website-receipt)/);
  assert.doesNotMatch(source,/secrets\.TELEGRAM_BOT_TOKEN|secrets\.TELEGRAM_CHAT_ID|GITHUB_TOKEN:\s*\$\{\{\s*github\.token/);
});
