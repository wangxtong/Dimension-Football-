import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishResearchTelegram } from '../publish-research-telegram.mjs';

const NOW = '2026-11-02T02:10:00.000Z';
function dailyReport(overrides = {}) {
  const report = { version: 1, kind: 'research-daily-1x2', mode: 'research-reference',
    disclaimer: '研究参考，非投注建议；概率未经正式校准，不代表有投注价值或保证命中率。',
    generatedAt: NOW, beijingDay: '2026-11-02', codeSha: 'a'.repeat(40), sourceReportId: null,
    state: 'research-reference', forecasts: { total: 5, candidates: [] },
    prospective: { oneDay: { days: 1, eligibleFrozen: 0, scored: 0, pending: 0, voided: 0, hitRate: null, brier: null, logLoss: null },
      sevenDays: { days: 7, eligibleFrozen: 0, scored: 0, pending: 0, voided: 0, hitRate: null, brier: null, logLoss: null },
      thirtyDays: { days: 30, eligibleFrozen: 0, scored: 0, pending: 0, voided: 0, hitRate: null, brier: null, logLoss: null } },
    strictMarkets: { releasedCandidates: 0, reviewed: false },
    commercialReleaseGate: 'BLOCKED', researchGate: 'INDEPENDENT_OF_COMMERCIAL', externalTelegramSent: false,
    limitations: [] };
  const merged = { ...report, ...overrides };
  return { report: { ...merged, reportId: createHash('sha256').update(JSON.stringify(merged)).digest('hex') } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'research-tg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'reports/research-daily'), { recursive: true });
  return root;
}
const TOKEN = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const CHAT = '-1004312560482';
function telegramOk(payload) {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 42, chat: { id: payload.chat_id } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

const MARKDOWN = ['# 维度足球｜每日1X2研究参考', '', '**研究参考，非投注建议。**', '',
  '| 赛事 | 开球(UTC) | 主胜 | 平 | 客胜 |', '| A vs B | 2026-11-03T00:00:00.000Z | 40.0% | 30.0% | 30.0% |'].join(String.fromCharCode(10));

test('research telegram sends the simplified-Chinese study digest exactly once and records a receipt', async t => {
  const root = await fixture(t);
  const { report } = dailyReport();
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  await writeFile(join(root, 'reports/research-daily/latest.md'), MARKDOWN);
  const calls = [];
  const first = await publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) });
      assert.ok(url.startsWith('https://api.telegram.org/bot')); return telegramOk(JSON.parse(init.body)); } });
  assert.equal(first.status, 'accepted'); assert.equal(first.messageId, 42); assert.equal(first.channel, 'rich');
  // 首选 sendRichMessage：rich_message.html 才是能渲染表格的富文本通道。
  assert.ok(calls[0].url.endsWith('/sendRichMessage'), 'first attempt must be sendRichMessage');
  assert.ok(String(calls[0].body.rich_message.html).includes('<table'), 'rich html must use real tables');
  assert.ok(String(calls[0].body.rich_message.html).includes('研究参考，非投注建议'));
  const second = await publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async () => { throw Error('never'); } });
  assert.equal(second.status, 'skipped'); assert.equal(second.code, 'ALREADY_SENT_TODAY');
  const receipt = JSON.parse(await readFile(join(root, 'reports/research-daily/telegram-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.reportId, report.reportId);
});

test('falls back to plain sendMessage when sendRichMessage is rejected', async t => {
  const root = await fixture(t);
  const { report } = dailyReport();
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  await writeFile(join(root, 'reports/research-daily/latest.md'), MARKDOWN);
  const methods = [];
  const out = await publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async (url, init) => {
      const method = String(url).split('/').pop();
      methods.push(method);
      const body = JSON.parse(init.body);
      if (method === 'sendRichMessage') return { ok: false, status: 400, body: { cancel: async () => {} } };
      return telegramOk(body);
    } });
  assert.deepEqual(methods, ['sendRichMessage', 'sendMessage']);
  assert.equal(out.status, 'accepted'); assert.equal(out.channel, 'plain');
  assert.ok(String(out.messageId).length > 0);
});

test('research telegram refuses any report that released market candidates', async t => {
  const root = await fixture(t);
  const { report } = dailyReport({ strictMarkets: { releasedCandidates: 1 } });
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  await assert.rejects(publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async () => telegramOk({}) }), /RESEARCH_REPORT_INVALID/);
});

test('research telegram refuses a commercial gate other than BLOCKED or a missing disclaimer', async t => {
  const root = await fixture(t);
  const a = dailyReport({ commercialReleaseGate: 'GREEN' });
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(a.report));
  await assert.rejects(publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async () => telegramOk({}) }), /RESEARCH_REPORT_INVALID/);
  const b = dailyReport({ disclaimer: '' });
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(b.report));
  await assert.rejects(publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async () => telegramOk({}) }), /RESEARCH_REPORT_INVALID/);
});

test('missing credentials report not_configured without any network call', async t => {
  const root = await fixture(t);
  const { report } = dailyReport();
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  await writeFile(join(root, 'reports/research-daily/latest.md'), MARKDOWN);
  const out = await publishResearchTelegram({ root, env: {}, fetchImpl: async () => { throw Error('never'); } });
  assert.equal(out.status, 'not_configured'); assert.equal(out.code, 'TELEGRAM_CREDENTIALS_REQUIRED');
});

test('an API rejection persists a failed receipt and is never auto-retried', async t => {
  const root = await fixture(t);
  const { report } = dailyReport();
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  await writeFile(join(root, 'reports/research-daily/latest.md'), MARKDOWN);
  const out = await publishResearchTelegram({ root, env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async () => new Response('{"ok":false,"description":"Forbidden"}', { status: 403, headers: { 'content-type': 'application/json' } }) });
  assert.equal(out.status, 'failed'); assert.equal(out.code, 'TELEGRAM_API_REJECTED');
  const receipt = JSON.parse(await readFile(join(root, 'reports/research-daily/telegram-receipt.json'), 'utf8'));
  assert.equal(receipt.status, 'failed');
});
