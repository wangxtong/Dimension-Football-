import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTelegramBotHandler, prepareTelegramBotContext, formatTelegramBotPanel,
  TELEGRAM_BOT_ID, TELEGRAM_BOT_ORIGIN } from '../telegram-bot.mjs';
import { readDailyResearch } from '../research-daily-store.mjs';
import { MemoryBucket } from './hosted-fixtures.mjs';

const NOW = Date.parse('2026-11-02T01:20:00Z'), CHAT = -1001234567890;
const sha = text => createHash('sha256').update(text).digest('hex');
const hex = (length, char) => char.repeat(length);
const stats = row => ({ days: row.days, fromDay: row.fromDay, toDay: row.toDay,
  eligibleFrozen: row.eligibleFrozen, scored: row.scored, pending: row.pending, voided: row.voided,
  hitRate: row.hitRate, brier: row.brier, logLoss: row.logLoss,
  sampleStatus: row.sampleStatus || 'insufficient-prospective-sample' });
const candidate = (index, overrides = {}) => {
  const league = ['PL', 'PD', 'SA', 'BL1', 'FL1'][index % 5];
  return { predictionId: sha('prediction-' + index), fixtureId: 'fixture-' + index,
    source: 'openligadb', league, home: '主队' + index, away: '客队' + index,
    kickoff: '2026-11-02T12:' + String(index % 6).padStart(2, '0') + ':00Z',
    recordedAt: '2026-11-02T01:10:00Z', sourceReportId: hex(64, 'b'),
    modelId: 'poisson-v2', modelVersion: 2, modelHash: sha('model-' + index), trainingHash: sha('training-' + index),
    probabilities: { home: 0.45, draw: 0.28, away: 0.27 }, selection: 'home', calibrated: false, ...overrides };
};
const league30 = (league, eligibleFrozen, scored, pending, voided, hitRate, brier, logLoss) => ({
  league, ...stats({ days: 30, fromDay: '2026-10-04', toDay: '2026-11-02', eligibleFrozen, scored, pending, voided,
    hitRate, brier, logLoss }) });
function report({ candidates = Array.from({ length: 7 }, (_, index) => candidate(index)), retainedFrozen = 40 } = {}) {
  const base = { version: 1, kind: 'research-daily-1x2', mode: 'research-reference',
    disclaimer: '研究参考，非投注建议。不是正式推荐，不保证命中率。',
    generatedAt: '2026-11-02T01:15:00Z', beijingDay: '2026-11-02', codeSha: hex(40, 'a'),
    sourceReportId: hex(64, 'b'), sourceReportSha256: hex(64, 'c'), state: 'frozen-research-forecasts',
    forecasts: { total: candidates.length, candidates, skipped: 0, isPublishedRecommendation: false },
    prospective: { provenance: 'immutable-prematch-ledger-plus-observed-full-time',
      uniqueFixtureRule: 'earliest-valid-frozen-prediction-per-source-fixture', retainedFrozen,
      oneDay: stats({ days: 1, fromDay: '2026-11-02', toDay: '2026-11-02', eligibleFrozen: 2, scored: 0,
        pending: 2, voided: 0, hitRate: null, brier: null, logLoss: null }),
      sevenDays: stats({ days: 7, fromDay: '2026-10-27', toDay: '2026-11-02', eligibleFrozen: 12, scored: 3,
        pending: 8, voided: 1, hitRate: 0.6667, brier: 0.5123, logLoss: 0.8765 }),
      thirtyDays: stats({ days: 30, fromDay: '2026-10-04', toDay: '2026-11-02', eligibleFrozen: 40, scored: 12,
        pending: 26, voided: 2, hitRate: 0.5833, brier: 0.6, logLoss: 0.95 }),
      byLeague30Days: [league30('PL', 10, 4, 5, 1, 0.5, 0.61, 0.92), league30('PD', 8, 3, 4, 1, 0.6667, 0.55, 0.8),
        league30('SA', 7, 2, 4, 1, 0.5, 0.62, 0.9), league30('BL1', 9, 2, 6, 1, 0.5, 0.66, 1.0),
        league30('FL1', 6, 1, 4, 1, 1, 0.41, 0.7)] },
    strictMarkets: { separation: 'independent-dual-source-and-provider-opening', sourceScreenedCandidates: null,
      releasedCandidates: 0, reviewed: false },
    commercialReleaseGate: 'BLOCKED', researchGate: 'INDEPENDENT_OF_COMMERCIAL', externalTelegramSent: false,
    limitations: ['研究模型未经正式校准，当前输出不代表投注建议或正式预测发布。'] };
  return { ...base, reportId: sha(JSON.stringify(base)) };
}

test('synced research ledger replaces settlement, backtest and picks placeholders', async () => {
  const research = report();
  const context = await prepareTelegramBotContext({ research, now: NOW });
  assert.ok(context.research);
  assert.equal(context.research.total, 7);
  const picks = formatTelegramBotPanel({ context, section: 'picks' });
  assert.match(picks.text, /赛前冻结研究预测：7 场｜严格盘口正式推荐 0 场/);
  assert.match(picks.text, /研究参考，非投注建议/);
  assert.ok(picks.text.includes(research.reportId.slice(0, 12)));
  assert.match(picks.text, /第 1\/2 页/);
  assert.match(picks.text, /研究概率 主 45\.00% \/ 平 28\.00% \/ 客 27\.00%/);
  assert.match(picks.text, /研究方向：主胜/);
  assert.doesNotMatch(picks.text, /尚未接入/);
  const settlement = formatTelegramBotPanel({ context, section: 'settlement' });
  assert.match(settlement.text, /研究前瞻账本（商业发布 BLOCKED，非投注建议）/);
  assert.match(settlement.text, /保留冻结 40 场/);
  assert.match(settlement.text, /已核账 3/);
  assert.match(settlement.text, /命中率 66\.67%｜Brier 0\.5123｜Log loss 0\.8765/);
  assert.match(settlement.text, /30 天分联赛/);
  assert.match(settlement.text, /英超：冻结 10 场｜已核账 4 场/);
  assert.doesNotMatch(settlement.text, /尚未接入/);
  const backtest = formatTelegramBotPanel({ context, section: 'backtest' });
  assert.match(backtest.text, /研究前瞻账本（30 天窗口）/);
  assert.match(backtest.text, /冻结 40 场｜已评分 12 场/);
  assert.match(backtest.text, /命中率 50\.00%｜Brier 0\.6100/);
  assert.match(backtest.text, /样本不足，仅描述性/);
  assert.match(backtest.text, /第 1\/3 页/);
  assert.doesNotMatch(backtest.text, /尚未通过固定摘要校验/);
  const picks2 = formatTelegramBotPanel({ context, section: 'picks', page: 1 });
  assert.match(picks2.text, /第 2\/2 页/);
  assert.match(picks2.text, /主队5/); assert.match(picks2.text, /主队6/);
  const backtest3 = formatTelegramBotPanel({ context, section: 'backtest', page: 2 });
  assert.match(backtest3.text, /法甲/); assert.match(backtest3.text, /第 3\/3 页/);
});

test('oversized candidate pools stay bounded and say how many are shown', async () => {
  const research = report({ candidates: Array.from({ length: 200 }, (_, index) => candidate(index)) });
  const context = await prepareTelegramBotContext({ research, now: NOW });
  assert.equal(context.research.shown, 120);
  assert.equal(context.research.truncated, true);
  const first = formatTelegramBotPanel({ context, section: 'picks', page: 0 });
  assert.match(first.text, /仅展示前 120 场，共 200 场/);
  assert.match(first.text, /第 1\/24 页/);
  const last = formatTelegramBotPanel({ context, section: 'picks', page: 999 });
  assert.match(last.text, /第 24\/24 页/);
  assert.ok(last.text.length <= 4096);
});

test('tampered or incomplete research reports never reach the panel', async () => {
  const mutations = [
    value => { value.reportId = hex(64, 'f'); },
    value => { value.commercialReleaseGate = 'RELEASED'; },
    value => { value.externalTelegramSent = true; },
    value => { value.disclaimer = '研究参考。'; },
    value => { value.strictMarkets.releasedCandidates = 1; },
    value => { value.forecasts.candidates[0].probabilities = { home: 0.5, draw: 0.3, away: 0.3 }; },
    value => { value.forecasts.total = 6; },
    value => { value.forecasts.candidates[0].home = 'x'.repeat(201); },
    value => { value.forecasts.candidates[0].recordedAt = '2026-11-02T02:00:00Z'; },
    value => { value.prospective.sevenDays.hitRate = null; },
    value => { value.prospective.byLeague30Days = value.prospective.byLeague30Days.slice(0, 4); },
    value => { value.prospective.retainedFrozen = 39; value.prospective.thirtyDays = { ...value.prospective.thirtyDays, eligibleFrozen: 41 }; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(report()); mutate(value);
    const context = await prepareTelegramBotContext({ research: value, now: NOW });
    assert.equal(context.research, null);
    assert.match(formatTelegramBotPanel({ context, section: 'settlement' }).text, /尚未接入本机器人/);
  }
});

test('real store readback feeds the same panel and malformed storage is ignored', async () => {
  const research = report(), bucket = new MemoryBucket();
  assert.equal(await readDailyResearch({ BUCKET: bucket }), null);
  await bucket.put('research-daily/current.json', JSON.stringify({ version: 1, reportId: research.reportId,
    generatedAt: research.generatedAt, beijingDay: research.beijingDay }));
  await bucket.put('research-daily/reports/' + research.reportId + '.json', JSON.stringify(research));
  const loaded = await readDailyResearch({ BUCKET: bucket });
  assert.equal(loaded.reportId, research.reportId);
  const context = await prepareTelegramBotContext({ research: loaded, now: NOW });
  assert.ok(context.research);
  assert.match(formatTelegramBotPanel({ context, section: 'backtest' }).text, /冻结 40 场/);
  const stored = JSON.parse(bucket.rows.get('research-daily/reports/' + research.reportId + '.json').text);
  stored.prospective.sevenDays.scored = 99;
  await bucket.put('research-daily/reports/' + research.reportId + '.json', JSON.stringify(stored));
  await assert.rejects(readDailyResearch({ BUCKET: bucket }), { code: 'RESEARCH_STORAGE_INVALID' });
});

const handler = createTelegramBotHandler({ verifiedTargetFingerprint: sha(String(CHAT)).slice(0, 16) });
const env = () => ({ TELEGRAM_WEBHOOK_SECRET: 's'.repeat(32),
  TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_ID + ':synthetic_offline_token_not_a_real_credential', BUCKET: new MemoryBucket() });
const callback = (updateId = 1, data = 'df1:settlement:0') => ({ update_id: updateId,
  callback_query: { id: 'query-' + updateId, from: { id: 123, is_bot: false }, data,
    message: { message_id: 41, date: Math.floor(NOW / 1000) - 3600, chat: { id: CHAT, type: 'supergroup' },
      from: { id: TELEGRAM_BOT_ID, is_bot: true } } } });
const request = body => new Request(TELEGRAM_BOT_ORIGIN + '/telegram/webhook', { method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 's'.repeat(32) }, body: JSON.stringify(body) });
function transport() {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const method = new URL(url).pathname.split('/').at(-1), body = JSON.parse(init.body);
    calls.push({ method, body });
    return Response.json({ ok: true, result: method === 'answerCallbackQuery' ? true
      : { message_id: body.message_id || 9, chat: { id: body.chat_id }, from: { id: TELEGRAM_BOT_ID, is_bot: true } } });
  } };
}

test('webhook loads the research ledger only through the injected reader and fails closed', async () => {
  const e = env(), t = transport();
  let reads = 0, seen = null;
  const loaded = await handler(request(callback(201)), e, { now: NOW, assets: {}, fetchImpl: t.fetchImpl,
    loadResearch: async (envArg) => { reads++; seen = envArg; return report(); } });
  assert.equal((await loaded.json()).status, 'accepted');
  assert.equal(reads, 1); assert.equal(seen, e);
  assert.match(t.calls[1].body.text, /研究前瞻账本/);
  assert.doesNotMatch(t.calls[1].body.text, /尚未接入/);
  const broken = transport();
  const failed = await handler(request(callback(202)), e, { now: NOW, assets: {}, fetchImpl: broken.fetchImpl,
    loadResearch: async () => { throw Error('private storage failure'); } });
  assert.equal((await failed.json()).status, 'accepted');
  assert.match(broken.calls[1].body.text, /尚未接入本机器人/);
  assert.doesNotMatch(broken.calls[1].body.text, /private storage failure/);
  const absent = transport();
  await handler(request(callback(203)), e, { now: NOW, assets: {}, fetchImpl: absent.fetchImpl });
  assert.match(absent.calls[1].body.text, /尚未接入本机器人/);
});
