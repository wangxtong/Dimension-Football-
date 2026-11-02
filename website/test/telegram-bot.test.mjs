import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createTelegramBotHandler, handleTelegramWebhook, prepareTelegramBotContext, formatTelegramBotPanel,
  TELEGRAM_BOT_ID, TELEGRAM_BOT_TARGET, TELEGRAM_BOT_ORIGIN } from '../telegram-bot.mjs';
import { MemoryBucket } from './hosted-fixtures.mjs';

const NOW = Date.parse('2026-11-02T01:19:58.925Z'), CHAT = -1001234567890;
const hash = text => createHash('sha256').update(text).digest('hex');
const SECRET = 'synthetic-webhook-secret-for-offline-tests-only';
const TOKEN = `${TELEGRAM_BOT_ID}:synthetic_offline_token_not_a_real_credential`;
const retained = JSON.parse(await readFile(new URL('./fixtures/telegram-bot-production-readback.json', import.meta.url), 'utf8'));
const realBundle = () => structuredClone(retained.bundle);
const assets = Object.fromEntries(await Promise.all(['evaluation-evidence.json', 'model-experiment-evidence.json']
  .map(async name => ['/' + name, await readFile(new URL('../' + name, import.meta.url), 'utf8')])));
const handler = createTelegramBotHandler({ verifiedTargetFingerprint: hash(String(CHAT)).slice(0, 16) });
const env = () => ({ TELEGRAM_WEBHOOK_SECRET: SECRET, TELEGRAM_BOT_TOKEN: TOKEN, BUCKET: new MemoryBucket() });
const command = (updateId = 1, overrides = {}) => ({ update_id: updateId,
  message: { message_id: 11, date: Math.floor(NOW / 1000), chat: { id: CHAT, type: 'supergroup' },
    from: { id: 123, is_bot: false }, text: '/menu@LYZKYPbot', ...overrides } });
const callback = (updateId = 2, data = 'df1:schedule:0', overrides = {}) => ({ update_id: updateId,
  callback_query: { id: 'query-' + updateId, from: { id: 123, is_bot: false }, data,
    message: { message_id: 41, date: Math.floor(NOW / 1000) - 86400, chat: { id: CHAT, type: 'supergroup' },
      from: { id: TELEGRAM_BOT_ID, is_bot: true } }, ...overrides } });
const request = (body = command(), headers = {}) => new Request(TELEGRAM_BOT_ORIGIN + '/telegram/webhook', {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': SECRET, ...headers }, body: JSON.stringify(body),
});
function transport(replace) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const method = new URL(url).pathname.split('/').at(-1), body = JSON.parse(init.body);
    assert.equal(new URL(url).origin, 'https://api.telegram.org'); assert.equal(init.redirect, 'manual');
    calls.push({ method, body });
    if (replace) { const replaced = await replace(method, body); if (replaced) return replaced; }
    return Response.json({ ok: true, result: method === 'answerCallbackQuery' ? true : {
      message_id: body.message_id || 90, chat: { id: body.chat_id }, from: { id: TELEGRAM_BOT_ID, is_bot: true },
    } });
  } };
}
const options = transport => ({ ...transport, now: NOW, assets, loadBundle: async () => realBundle() });
const record = (e, updateId) => e.BUCKET.json(`telegram-bot/updates/${TELEGRAM_BOT_ID}/${updateId}.json`);

test('retained production schema renders real source counts at acquisition and explicitly expires at wall clock', async () => {
  const r = realBundle(); assert.equal(hash(JSON.stringify(r.report)), r.reportHash);
  assert.equal(r.report.fixtures.length, 13);
  const historical = await prepareTelegramBotContext({ bundle: r, assets, now: NOW });
  const current = formatTelegramBotPanel({ context: historical, section: 'sources' });
  assert.match(current.text, /澳门彩票：4 场完整配对/); assert.match(current.text, /双源 2 场/);
  assert.match(current.text, /🟢 报价观察在有效期内/);
  const expired = await prepareTelegramBotContext({ bundle: r, assets, now: Date.parse('2026-11-02T02:00:00Z') });
  const panel = formatTelegramBotPanel({ context: expired, section: 'sources' });
  assert.match(panel.text, /报价观察已过期/); assert.match(panel.text, /2026-11-02 09:17/);
  assert.match(panel.text, /2026-11-02 09:21/); assert.match(panel.text, /超过 20 分钟/);
  assert.equal(r.report.marketObservation.checkedAt, retained.bundle.report.marketObservation.checkedAt);
});

test('seven native classifications show distinct content and all buttons use bounded callback protocol', async () => {
  const context = await prepareTelegramBotContext({ bundle: realBundle(), assets, now: NOW });
  for (const section of ['schedule', 'picks', 'backtest', 'model', 'settlement', 'sources', 'status']) {
    const panel = formatTelegramBotPanel({ context, section });
    assert.ok(panel.text.length <= 4096); assert.equal(panel.parse_mode, 'HTML');
    assert.ok(panel.reply_markup.inline_keyboard.flat().some(b => b.callback_data === `df1:${section}:0`));
    for (const button of panel.reply_markup.inline_keyboard.flat()) {
      if (button.callback_data) assert.match(button.callback_data, /^df1:(menu|schedule|picks|backtest|model|settlement|sources|status):\d{1,3}$/);
      else assert.equal(button.url, TELEGRAM_BOT_ORIGIN);
    }
  }
  const backtest = formatTelegramBotPanel({ context, section: 'backtest', page: 1 });
  assert.match(backtest.text, /评估 63 场/); assert.match(backtest.text, /49\.21%/); assert.match(backtest.text, /0\.5900/);
  assert.match(formatTelegramBotPanel({ context, section: 'model' }).text, /输入 982 场｜留出评估 182 场/);
  assert.match(formatTelegramBotPanel({ context, section: 'model' }).text, /未采用/);
  assert.match(formatTelegramBotPanel({ context, section: 'settlement' }).text, /生产前瞻账本：尚未接入/);
  assert.doesNotMatch(formatTelegramBotPanel({ context, section: 'settlement' }).text, /已核账 2 场/);
  assert.match(formatTelegramBotPanel({ context, section: 'status' }).text, /回执未载入或未核验/);
});

test('modified or missing evidence assets never become fabricated performance', async () => {
  const changed = { ...assets, '/evaluation-evidence.json': assets['/evaluation-evidence.json'].replace('0.49206349206349204', '0.99') };
  const context = await prepareTelegramBotContext({ bundle: realBundle(), assets: changed, now: NOW });
  assert.match(formatTelegramBotPanel({ context, section: 'backtest' }).text, /尚未通过固定摘要校验/);
  const empty = await prepareTelegramBotContext({ now: NOW });
  assert.match(formatTelegramBotPanel({ context: empty, section: 'model' }).text, /未通过固定摘要校验/);
  assert.throws(() => formatTelegramBotPanel({ context: { ...context }, section: 'model' }), /BOT_PANEL_INVALID/);
  assert.throws(() => { context.experiment.samples.input = 1; }, TypeError);
});

test('HTML payloads, emoji and large fixture pools stay escaped and bounded with real pagination', async () => {
  const b = realBundle(), row = structuredClone(b.report.fixtures[0]);
  b.report.fixtures = Array.from({ length: 100 }, (_, i) => {
    const value = structuredClone(row); value.fixture.id = 'fixture-' + i;
    value.fixture.home = '<a href="https://evil.example">' + '🐈'.repeat(80); value.fixture.away = '&"'.repeat(90);
    return value;
  });
  Object.assign(b.report.summary, { fixtures: 100, unavailable: 100 }); b.reportHash = hash(JSON.stringify(b.report));
  b.receipt.channels.externalWebsite.reportHash = b.reportHash;
  const context = await prepareTelegramBotContext({ bundle: b, assets, now: NOW });
  const first = formatTelegramBotPanel({ context, section: 'schedule', page: 0 });
  const last = formatTelegramBotPanel({ context, section: 'schedule', page: 999 });
  assert.match(first.text, /未来 24 小时：100 场/); assert.match(first.text, /&lt;a href=/);
  assert.doesNotMatch(first.text, /<a href="https:\/\/evil/);
  assert.ok(first.text.length <= 4096); assert.ok(last.text.length <= 4096);
  assert.match(last.text, /第 20\/20 页/);
  assert.throws(() => formatTelegramBotPanel({ context, section: 'schedule', page: 1000 }), /BOT_PANEL_INVALID/);
});

test('formal, simulated, mismatched hashes and injected probability fields cannot enter Bot panels', async () => {
  for (const mutate of [b => { b.report.publicationKind = 'forecasts'; }, b => { b.report.simulated = true; },
    b => { b.report.fixtures[0].forecast.probabilities = { home: .99, draw: 0, away: .01 }; },
    b => { b.report.summary.forecasts = 1; }, b => { b.reportHash = 'f'.repeat(64); },
    b => { b.receipt.channels.externalWebsite.servedVerified = false; },
    b => { b.receipt.channels.externalWebsite.reportHash = 'f'.repeat(64); },
    b => { b.receipt.channels.externalWebsite.mode = 'bootstrap'; },
    b => { b.receipt.channels.externalWebsite.publicationKind = 'forecast'; },
    b => { b.receipt.channels.externalWebsite.forecastPublished = true; },
    b => { b.report.publication.forecastPublished = true; }]) {
    const b = realBundle(); mutate(b);
    const context = await prepareTelegramBotContext({ bundle: b, assets, now: NOW });
    assert.equal(context.live, null);
    assert.match(formatTelegramBotPanel({ context, section: 'schedule' }).text, /尚未通过报告核验/);
    assert.doesNotMatch(formatTelegramBotPanel({ context, section: 'picks' }).text, /99%/);
  }
});

test('worst-case HTML entity expansion cannot break five-fixture pages or drop matches', async () => {
  const b = realBundle(), row = structuredClone(b.report.fixtures[0]);
  b.report.fixtures = Array.from({ length: 11 }, (_, index) => {
    const value = structuredClone(row); value.fixture.id = 'entity-' + index;
    value.fixture.home = '"'.repeat(64); value.fixture.away = '"'.repeat(64); value.fixture.league = '"'.repeat(64); return value;
  });
  Object.assign(b.report.summary, { fixtures: 11, unavailable: 11 });
  b.reportHash = hash(JSON.stringify(b.report)); b.receipt.channels.externalWebsite.reportHash = b.reportHash;
  const context = await prepareTelegramBotContext({ bundle: b, assets, now: NOW });
  assert.ok(context.live); let displayed = 0;
  for (let page = 0; page < 3; page++) {
    const text = formatTelegramBotPanel({ context, section: 'schedule', page }).text;
    assert.ok(text.length <= 4096); assert.ok(!text.includes('&quo…')); displayed += text.split(' vs ').length - 1;
  }
  assert.equal(displayed, 11);
});

test('secret, content type, size and runtime identity are checked before report reads or Telegram', async () => {
  const e = env(), t = transport(); let reads = 0;
  const o = { ...options(t), loadBundle: async () => { reads++; return realBundle(); } };
  for (const req of [request(command(), { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }),
    request(command(), { 'content-type': 'text/plain' }), request({ padding: 'x'.repeat(65000) })]) {
    const response = await handler(req, e, o); assert.ok(response.status >= 400);
    const text = await response.text(); assert.ok(!text.includes(SECRET) && !text.includes(TOKEN));
  }
  assert.equal((await handler(request(), { ...e, TELEGRAM_BOT_TOKEN: '9999999999:wrong_token' }, o)).status, 503);
  assert.equal(reads, 0); assert.equal(t.calls.length, 0); assert.equal(e.BUCKET.rows.size, 0);
});

test('production target cannot be overridden with env or request and private messages read nothing', async () => {
  const e = { ...env(), TELEGRAM_CHAT_ID: String(CHAT), destinationFingerprint: hash(String(CHAT)).slice(0, 16) }, t = transport();
  let reads = 0; const o = { ...options(t), loadBundle: async () => { reads++; return realBundle(); } };
  assert.equal((await handleTelegramWebhook(request(), e, o)).status, 200);
  const another = command(33, { chat: { id: 123, type: 'private' } });
  assert.equal((await (await handler(request(another), e, o)).json()).status, 'ignored');
  assert.equal(reads, 0); assert.equal(t.calls.length, 0); assert.equal(e.BUCKET.rows.size, 0);
});

test('authorized start/menu/help/status commands send one panel with real button callbacks', async () => {
  const e = env(), t = transport();
  for (const [i, commandText] of ['/start', '/menu@LYZKYPbot', '/help', '/status'].entries()) {
    const result = await (await handler(request(command(i, { text: commandText })), e, options(t))).json();
    assert.equal(result.status, 'accepted'); assert.equal(result.messageId, 90);
  }
  assert.equal(t.calls.length, 4); assert.ok(t.calls.every(c => c.method === 'sendMessage'));
  assert.match(t.calls.at(-1).body.text, /发布排查/);
  for (const text of ['/start@WDZQYCbot', '/unknown', '/start arbitrary argument'])
    assert.equal((await (await handler(request(command(100, { text })), e, options(t))).json()).status, 'ignored');
  const saved = JSON.stringify([...e.BUCKET.rows.values()]); assert.ok(!saved.includes(TOKEN) && !saved.includes(SECRET));
  assert.ok(!saved.includes(String(CHAT))); assert.ok(!saved.includes('/menu'));
});

test('old pending commands are acknowledged without replies or data reads', async () => {
  const e = env(), t = transport(); let reads = 0;
  const old = command(111, { date: Math.floor(NOW / 1000) - 601 });
  const result = await (await handler(request(old), e, { ...options(t), loadBundle: async () => { reads++; return realBundle(); } })).json();
  assert.equal(result.status, 'skipped'); assert.equal(result.code, 'BOT_OLD_MESSAGE_IGNORED');
  assert.equal(reads, 0); assert.equal(t.calls.length, 0); assert.equal(record(e, 111).state, 'complete');
});

test('native callback acknowledges then edits the original message; an old message may receive a new click', async () => {
  const e = env(), t = transport();
  const result = await (await handler(request(callback()), e, options(t))).json();
  assert.equal(result.status, 'accepted'); assert.equal(result.messageId, 41);
  assert.deepEqual(t.calls.map(c => c.method), ['answerCallbackQuery', 'editMessageText']);
  assert.equal(t.calls[1].body.message_id, 41); assert.equal(t.calls[1].body.chat_id, CHAT);
  assert.equal(record(e, 2).acknowledgement.status, 'accepted'); assert.equal(record(e, 2).outcome.status, 'accepted');
  assert.match(t.calls[1].body.text, /今日赛事/);
});

test('callback whitelist, sender bot identity and target chat reject spoofed or arbitrary requests', async () => {
  const e = env(), t = transport();
  const wrongSender = callback(); wrongSender.callback_query.message.from.id = 42;
  const wrongChat = callback(); wrongChat.callback_query.message.chat.id = 88;
  for (const value of [wrongSender, wrongChat, callback(2, 'df1:schedule:-1'), callback(2, 'df1:schedule:1000'),
    callback(2, 'df1:send:https://evil.example'), callback(2, 'df1:sources:0', { inline_message_id: 'x', message: undefined })]) {
    assert.equal((await (await handler(request(value), e, options(t))).json()).status, 'ignored');
  }
  assert.equal(t.calls.length, 0); assert.equal(e.BUCKET.rows.size, 0);
});

test('concurrent retries share an atomic update claim and send at most one response', async () => {
  const e = env(), t = transport();
  const results = await Promise.all(Array.from({ length: 8 }, () => handler(request(command(50)), e, options(t)).then(r => r.json())));
  assert.equal(results.filter(r => r.status === 'accepted').length, 1);
  assert.equal(results.filter(r => r.status === 'duplicate').length, 7); assert.equal(t.calls.length, 1);
});

test('uncertain network or unresolved claims never resend and do not leak provider errors', async () => {
  const e = env(), t = transport(() => { throw Error('secret ' + TOKEN); });
  const first = await (await handler(request(command(60)), e, options(t))).json();
  assert.equal(first.status, 'unknown'); assert.ok(!JSON.stringify(first).includes(TOKEN));
  const repeated = await (await handler(request(command(60)), e, options(t))).json();
  assert.equal(repeated.status, 'duplicate'); assert.equal(t.calls.length, 1);
  e.BUCKET.rows.set(`telegram-bot/updates/${TELEGRAM_BOT_ID}/61.json`, { etag: 'old', text: '{bad' });
  assert.equal((await (await handler(request(command(61)), e, options(t))).json()).status, 'duplicate');
  assert.equal(t.calls.length, 1);
});

test('acknowledgement failure prevents editing; successful acknowledgement alone is not panel delivery', async () => {
  const e = env(), rejected = transport(method => method === 'answerCallbackQuery' ? Response.json({ ok: false }, { status: 429 }) : undefined);
  assert.equal((await (await handler(request(callback(70)), e, options(rejected))).json()).status, 'failed');
  assert.deepEqual(rejected.calls.map(c => c.method), ['answerCallbackQuery']);
  const uncertain = transport(method => method === 'editMessageText' ? Response.json({ ok: true, result: { message_id: 41, chat: { id: 123 } } }) : undefined);
  assert.equal((await (await handler(request(callback(71)), e, options(uncertain))).json()).status, 'unknown');
  assert.equal(record(e, 71).acknowledgement.status, 'accepted'); assert.equal(record(e, 71).outcome.status, 'unknown');
});

test('message-not-modified is idempotent success and receipt persistence failure stays unknown', async () => {
  const e = env(), t = transport(method => method === 'editMessageText' ? Response.json({ ok: false, description: 'Bad Request: message is not modified: old content' }, { status: 400 }) : undefined);
  assert.equal((await (await handler(request(callback(80)), e, options(t))).json()).code, 'TELEGRAM_UNCHANGED');
  const broken = env(), normal = transport(); broken.BUCKET.beforePut = async (key, text, opts) => { if (opts.onlyIf.etagMatches) throw Error(TOKEN); };
  const result = await (await handler(request(command(81)), broken, options(normal))).json();
  assert.equal(result.status, 'unknown'); assert.equal(record(broken, 81).state, 'prepared');
  await handler(request(command(81)), broken, options(normal)); assert.equal(normal.calls.length, 1);
});

test('data load failures produce explicit unavailable panels without replacing receipts or formal gates', async () => {
  const e = env(), t = transport();
  const response = await handler(request(callback(90, 'df1:sources:0')), e,
    { ...options(t), loadBundle: async () => { throw Error('private raw failure'); } });
  assert.equal((await response.json()).status, 'accepted'); assert.match(t.calls[1].body.text, /当前来源报告不可核验/);
  assert.doesNotMatch(t.calls[1].body.text, /private raw failure/);
  assert.ok([...e.BUCKET.rows.keys()].every(k => k.startsWith('telegram-bot/')));
});

test('daily receipt is separate from current report and unverified receipt fields are never rendered', async () => {
  const daily = { version: 1, kind: 'daily-observation-delivery', sentNow: false, receipt: {
    version: 1, kind: 'daily-observation-delivery', date: '2026-11-02', sentNow: false,
    destinationFingerprint: TELEGRAM_BOT_TARGET, status: 'accepted', code: 'DAILY_TELEGRAM_ACCEPTED', reportId: 'e'.repeat(64),
    reportHash: 'b'.repeat(64), payloadSha256: 'c'.repeat(64), messageId: 118, meaning: 'telegram-api-accepted-not-user-read',
    checkedAt: new Date(NOW).toISOString(), error: TOKEN } };
  const context = await prepareTelegramBotContext({ bundle: realBundle(), assets, daily, now: NOW });
  const panel = formatTelegramBotPanel({ context, section: 'status' });
  assert.match(panel.text, /消息编号：118/); assert.match(panel.text, /独立历史版本/); assert.match(panel.text, /不代表用户已读/);
  assert.doesNotMatch(panel.text, /synthetic_offline_token/);
  for (const mutate of [d => { d.receipt.code = 'DAILY_NOT_DUE'; }, d => { d.receipt.date = '2026-11-01'; },
    d => { d.receipt.kind = 'forecast-delivery'; }, d => { d.receipt.reportHash = 'bad'; }, d => { d.receipt.messageId = null; },
    d => { d.receipt.reportId = realBundle().reportId; }, d => { d.receipt.checkedAt = '2026-11-01T01:19:58Z'; },
    d => { d.receipt.meaning = 'user-read'; }, d => { d.sentNow = true; }]) {
    const value = structuredClone(daily); mutate(value);
    const invalid = await prepareTelegramBotContext({ bundle: realBundle(), assets, daily: value, now: NOW });
    assert.equal(invalid.daily, null); assert.match(formatTelegramBotPanel({ context: invalid, section: 'status' }).text, /未载入或未核验/);
  }
});

test('callback acknowledgement or report loading crossing real expiry cannot send a green freshness panel', async () => {
  const start = Date.parse('2026-11-02T01:21:05Z');
  for (const delayAt of ['acknowledgement', 'load']) {
    let wall = 50000; const e = env(), t = transport(method => { if (delayAt === 'acknowledgement' && method === 'answerCallbackQuery') wall += 2000; });
    const output = await handler(request(callback(104, 'df1:sources:0')), e, { ...options(t), now: start, wallClock: () => wall,
      loadBundle: async ({}, params) => { assert.ok(params.now >= start); if (delayAt === 'load') wall += 2000; return realBundle(); } });
    assert.equal((await output.json()).status, 'accepted');
    assert.match(t.calls[1].body.text, /报价观察已过期/); assert.doesNotMatch(t.calls[1].body.text, /🟢 报价观察在有效期内/);
    assert.match(t.calls[1].body.text, /失效时间：2026-11-02 09:21/);
    assert.equal(record(e, 104).completedAt, '2026-11-02T01:21:07.000Z');
  }
});

test('read-only Bot status follows completed claim and contains no user identity or message body', async () => {
  const e = env(), t = transport();
  assert.equal((await handler.readStatus(e, { now: NOW })).status, 'not_processed');
  await handler(request(callback(102, 'df1:backtest:1')), e, options(t));
  const status = await handler.readStatus(e, { now: NOW + 1000 });
  assert.equal(status.status, 'available'); assert.equal(status.last.action, 'callback'); assert.equal(status.last.section, 'backtest');
  assert.equal(status.last.status, 'accepted'); assert.equal(status.last.messageId, 41); assert.equal(status.last.acknowledgementStatus, 'accepted');
  assert.equal(status.last.reportId, realBundle().reportId);
  const serialized = JSON.stringify(status);
  for (const forbidden of [TOKEN, SECRET, String(CHAT), 'query-102', 'callback_query', 'from', '/menu']) assert.ok(!serialized.includes(forbidden));
  const key = `telegram-bot/updates/${TELEGRAM_BOT_ID}/102.json`, row = record(e, 102);
  row.outcome.code = 'BOT_OLD_MESSAGE_IGNORED'; e.BUCKET.rows.set(key, { text: JSON.stringify(row), etag: 'corrupt' });
  assert.equal((await handler.readStatus(e, { now: NOW + 1000 })).status, 'unavailable');
});

test('status-pointer storage failure cannot retry an already accepted Bot response', async () => {
  const e = env(), t = transport();
  e.BUCKET.beforePut = async key => { if (key.includes('/status/')) throw Error(TOKEN); };
  const result = await (await handler(request(command(103)), e, options(t))).json();
  assert.equal(result.status, 'accepted'); assert.equal(result.statusRecordVerified, false);
  assert.equal(record(e, 103).outcome.status, 'accepted');
  await handler(request(command(103)), e, options(t)); assert.equal(t.calls.length, 1);
});
