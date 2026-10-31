import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { notifyHostedReport as productionNotifier } from '../hosted-notifications.mjs';
import { loadHostedProtocolModule } from './helpers/hosted-protocol.mjs';
const { createHostedNotifier, notifyHostedReport, hostedSummary, VERIFIED_TARGET_FINGERPRINT, VERIFIED_DASHBOARD_ORIGIN } = await loadHostedProtocolModule('../../hosted-notifications.mjs');
import { sampleBundle, sampleReport, NOW } from './fixtures.mjs';

const CHAT = '-1001234567890', TOKEN = '123456:synthetic_bot_token_for_offline_tests_0000';
const fingerprint = value => createHash('sha256').update(value).digest('hex').slice(0, 16);
class MockR2 {
  data = new Map(); sequence = 0; writes = [];
  async get(key) {
    const value = this.data.get(key); if (!value) return null;
    return { etag: value.etag, size: Buffer.byteLength(value.text), text: async () => value.text };
  }
  async put(key, text, options) {
    this.writes.push({ key, options });
    const old = this.data.get(key);
    if (options?.onlyIf?.etagDoesNotMatch === '*' && old || options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== old?.etag) return null;
    const etag = String(++this.sequence); this.data.set(key, { text, etag }); return { etag };
  }
}
function setup() {
  const bucket = new MockR2(), bundle = sampleBundle();
  bundle.freshness = { mode: 'hosted' }; bundle.health = { status: 'available' };
  const env = { BUCKET: bucket, TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT, DASHBOARD_ORIGIN: VERIFIED_DASHBOARD_ORIGIN };
  const state = { bundle, sends: [], receiptCalls: 0 };
  const notify = createHostedNotifier({ verifiedTargetFingerprint: fingerprint(CHAT) });
  const options = { reportId: bundle.reportId, now: NOW, loadBundle: async () => structuredClone(state.bundle),
    updateReceipt: async (_, receipt) => { state.receiptCalls++; state.bundle.receipt = structuredClone(receipt); return receipt; },
    fetchImpl: async (url, init) => { state.sends.push({ url, init }); return Response.json({ ok: true, result: { message_id: 42, chat: { id: Number(CHAT) } } }); } };
  return { env, state, options, notify, bucket };
}
const channel = receipt => receipt.channels.notifications;

test('direct production notifier remains BLOCKED before reads, claims or send requests',async()=>{
  const {env,options,bucket,state}=setup();
  env.RELEASE_GATE='GREEN';
  await assert.rejects(productionNotifier(env,{...options,releaseGate:()=>true}),/^Error: RELEASE_GATE_BLOCKED$/);
  assert.equal(bucket.data.size,0);assert.equal(state.sends.length,0);assert.equal(state.receiptCalls,0);
});

test('production notifier pins the existing destination and first send records API acceptance only', async () => {
  const config = JSON.parse(await readFile(new URL('../../config/delivery.json', import.meta.url), 'utf8'));
  assert.equal(VERIFIED_TARGET_FINGERPRINT, config.telegram.destinationFingerprint);
  const { env, state, options, notify, bucket } = setup();
  const receipt = await notify(env, options);
  assert.equal(receipt.reportId, options.reportId); assert.equal(channel(receipt).status, 'accepted');
  assert.equal(channel(receipt).messageId, 42); assert.equal(channel(receipt).destinationFingerprint, fingerprint(CHAT));
  assert.equal(channel(receipt).meaning, 'telegram-api-accepted-not-user-read');
  assert.equal(state.sends.length, 1);
  const sent = state.sends[0]; assert.equal(sent.url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(sent.init.redirect, 'manual');
  const body = JSON.parse(sent.init.body); assert.equal(body.chat_id, CHAT); assert.ok(body.text.length <= 3500);
  assert.ok(body.text.includes('未校准')); assert.ok(body.text.includes(VERIFIED_DASHBOARD_ORIGIN)); assert.equal(body.parse_mode, 'HTML');
  assert.equal(body.reply_markup.inline_keyboard.flat().length,5);assert.ok(body.text.includes('暂不放行'));
  assert.equal(bucket.writes.filter(row => row.options.onlyIf.etagDoesNotMatch === '*').length, 2);
  for (const value of bucket.data.values()) { assert.ok(!value.text.includes(TOKEN)); assert.ok(!value.text.includes(CHAT)); }
  assert.ok(!JSON.stringify(receipt).includes(TOKEN)); assert.ok(!JSON.stringify(receipt).includes(CHAT));
  const production = setup();
  assert.equal(channel(await notifyHostedReport(production.env, production.options)).code, 'TELEGRAM_DESTINATION_MISMATCH');
  assert.equal(production.state.sends.length, 0);
});

test('same report stays accepted across hours and another report is deduplicated within the UTC hour', async () => {
  const { env, state, options, notify } = setup();
  const accepted = await notify(env, options);
  assert.equal(channel(await notify(env, { ...options, now: NOW + 3600000 })).status, 'accepted');
  assert.deepEqual(state.bundle.receipt, accepted);
  const newer = sampleBundle(sampleReport('b', 1000)); newer.freshness = { mode: 'hosted' }; newer.health = { status: 'available' };
  state.bundle = newer;
  const skipped = await notify(env, { ...options, reportId: newer.reportId, now: NOW + 2000 });
  assert.equal(channel(skipped).status, 'skipped'); assert.equal(channel(skipped).code, 'HOSTED_HOURLY_DEDUPLICATED');
  assert.equal(state.sends.length, 1);
});

test('competing workers cannot send the same report twice', async () => {
  const { env, state, options, notify } = setup();
  const results = await Promise.all([notify(env, options), notify(env, options), notify(env, options)]);
  assert.equal(state.sends.length, 1); assert.ok(results.some(receipt => channel(receipt).status === 'accepted'));
});

test('timeouts, 5xx and unverifiable API responses remain unknown with no automatic retry', async () => {
  for (const fetchImpl of [async () => { throw Error(TOKEN); }, async () => Response.json({ ok: false, description: TOKEN }, { status: 500 }),
    async () => Response.json({ ok: true, result: { message_id: 42, chat: { id: -1009999999999 } } }), async () => new Response('invalid', { status: 200 })]) {
    const { env, state, options, notify } = setup(); let calls = 0;
    const args = { ...options, fetchImpl: async (...args) => { calls++; return fetchImpl(...args); } };
    const first = await notify(env, args); assert.equal(channel(first).status, 'unknown');
    assert.equal(channel(await notify(env, { ...args, now: NOW + 3600000 })).status, 'unknown');
    assert.equal(calls, 1); assert.ok(!JSON.stringify(state.bundle.receipt).includes(TOKEN));
  }
});

test('Workers-compatible Telegram fetch never follows redirects and leaves the outcome unknown without retry', async () => {
  const { env, options, notify } = setup();
  let calls = 0;
  const args = { ...options, fetchImpl: async (url, init) => {
    if (init.redirect === 'error') throw new TypeError('Invalid redirect value');
    assert.equal(init.redirect, 'manual'); assert.equal(new URL(url).origin, 'https://api.telegram.org');
    calls++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: Number(CHAT) } } }),
      { status: 302, headers: { location: 'https://untrusted.example/send' } });
  } };
  assert.equal(channel(await notify(env, args)).status, 'unknown');
  assert.equal(channel(await notify(env, { ...args, now: NOW + 3600000 })).status, 'unknown');
  assert.equal(calls, 1);
});

test('mismatched destinations, report expiry and expired forecasts never consume a send claim', async () => {
  for (const mutate of [
    setup => { setup.env.TELEGRAM_CHAT_ID = '-1009999999999'; },
    setup => { setup.options.now = NOW + 3600001; },
    setup => { for (const row of setup.state.bundle.report.fixtures) if (row.forecast.freshness) row.forecast.freshness.validUntil = new Date(NOW - 1).toISOString(); },
    setup => { setup.state.bundle.freshness.mode = 'bootstrap'; },
    setup => { setup.env.DASHBOARD_ORIGIN = 'https://old-bridge.example/'; },
  ]) {
    const context = setup(); mutate(context);
    const receipt = await context.notify(context.env, context.options);
    assert.ok(['failed', 'skipped'].includes(channel(receipt).status)); assert.equal(context.state.sends.length, 0); assert.equal(context.bucket.data.size, 0);
  }
  const wrong = setup(); wrong.options.reportId = 'b'.repeat(64);
  await assert.rejects(wrong.notify(wrong.env, wrong.options), /HOSTED_REPORT_NOT_CURRENT/);
});

test('accepted claim restores a failed receipt update without contacting Telegram again', async () => {
  const { env, state, options, notify } = setup();
  const first = await notify(env, { ...options, updateReceipt: async () => { throw Error('store unavailable'); } });
  assert.equal(channel(first).status, 'accepted'); assert.equal(first.channels.receiptSync.code, 'HOSTED_NOTIFICATION_RECEIPT_SYNC_FAILED');
  const recovered = await notify(env, options);
  assert.equal(channel(recovered).status, 'accepted'); assert.equal(channel(recovered).messageId, 42); assert.equal(state.sends.length, 1);
});

test('a lost storage acknowledgement recovers accepted state even after an unknown receipt was saved', async () => {
  const { env, state, options, notify, bucket } = setup();
  const put = bucket.put.bind(bucket); let lost = false;
  bucket.put = async (key, text, settings) => {
    const stored = await put(key, text, settings);
    if (!lost && key.startsWith('notifications/reports/') && JSON.parse(text).state === 'complete') { lost = true; throw Error('lost storage acknowledgement'); }
    return stored;
  };
  const first = await notify(env, options); assert.equal(channel(first).status, 'unknown');
  const recovered = await notify(env, options);
  assert.equal(channel(recovered).status, 'accepted'); assert.equal(state.sends.length, 1);
});

test('a prepared claim without a confirmed outcome is never reclaimed after a crash', async () => {
  const { env, state, options, notify, bucket } = setup();
  const put = bucket.put.bind(bucket); let lost = false;
  bucket.put = async (key, text, settings) => {
    const stored = await put(key, text, settings);
    if (!lost && key.startsWith('notifications/reports/')) { lost = true; throw Error('crash after preparing'); }
    return stored;
  };
  assert.equal(channel(await notify(env, options)).status, 'unknown');
  assert.equal(channel(await notify(env, { ...options, now: NOW + 3600000 })).status, 'unknown');
  assert.equal(state.sends.length, 0);
});

test('a missing group minus sign is restored only when it proves the pinned destination', async () => {
  const { env, state, options, notify } = setup(); env.TELEGRAM_CHAT_ID = CHAT.slice(1);
  assert.equal(channel(await notify(env, options)).status, 'accepted');
  assert.equal(JSON.parse(state.sends[0].init.body).chat_id, CHAT);
});

test('simulated reports are rejected before claims or Telegram requests', async () => {
  const { env, state, options, notify, bucket } = setup(); state.bundle.report.simulated = true;
  await assert.rejects(notify(env, options), /HOSTED_NOTIFICATION_BUNDLE_INVALID/);
  assert.equal(state.sends.length, 0); assert.equal(bucket.data.size, 0);
});

test('a current-pointer switch after the claim prevents sending an older report', async () => {
  const { env, state, options, notify } = setup(); let loads = 0;
  const receipt = await notify(env, { ...options, loadBundle: async () => ++loads === 1 ? structuredClone(state.bundle) : sampleBundle(sampleReport('b')) });
  assert.equal(channel(receipt).code, 'HOSTED_REPORT_CHANGED_BEFORE_SEND'); assert.equal(state.sends.length, 0);
});

test('missing data has an honest Chinese summary and never becomes a formal recommendation', async () => {
  const { env, state, options, notify } = setup();
  for (const row of state.bundle.report.fixtures) row.forecast = { status: 'unavailable', reasons: ['HISTORY_UNAVAILABLE'] };
  const receipt = await notify(env, options);
  assert.equal(channel(receipt).status, 'accepted');
  const text = JSON.parse(state.sends[0].init.body).text;
  assert.ok(text.includes('暂无可评估')); assert.ok(!text.includes('50.0%')); assert.ok(text.includes('不生成正式推荐'));
  const report = sampleReport(); report.fixtures[2].fixture.home = 'Bayern Munich';
  assert.ok(hostedSummary(report, VERIFIED_DASHBOARD_ORIGIN, NOW).includes('拜仁慕尼黑'));
});
