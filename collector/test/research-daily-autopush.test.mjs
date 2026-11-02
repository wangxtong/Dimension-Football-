import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishResearchTelegram } from '../publish-research-telegram.mjs';
import { buildDailyResearchReport, renderDailyResearchMarkdown } from '../research-daily-report.mjs';
import { allowedStatePath } from '../hosted.mjs';

// 本文件锁定两件事：
// 1) 研究日报和 Telegram 回执只存在 runner 临时目录，不在 /internal/state 允许列表里，
//    所以“新 runner 每次都是空 receipt”是真实行为；同一北京日若被触发两次，仅靠回执
//    无法跨 runner 去重（workflow 用 Actions 缓存里的当日送达标记补上这一层）。
// 2) 36h 窗口内 0 场不会让日报生成失败，TG 会收到明确的“0 场”文案；这正是 2026-11-02
//    线上运行（report f50dfc58…）的真实状态。

const NOW = '2026-11-02T02:10:00.000Z';
const TOKEN = '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const CHAT = '-1004312560482';

function zeroReport(overrides = {}) {
  const row = { days: 1, eligibleFrozen: 0, scored: 0, pending: 0, voided: 0, hitRate: null, brier: null, logLoss: null };
  const report = {
    version: 1, kind: 'research-daily-1x2', mode: 'research-reference',
    disclaimer: '研究参考，非投注建议；概率未经正式校准，不代表有投注价值或保证命中率。',
    generatedAt: NOW, beijingDay: '2026-11-02', codeSha: 'a'.repeat(40), sourceReportId: null,
    state: 'zero-qualified-forecasts', forecasts: { total: 0, candidates: [], skipped: 0, isPublishedRecommendation: false },
    prospective: { provenance: 'immutable-prematch-ledger-plus-observed-full-time', uniqueFixtureRule: 'earliest-valid-frozen-prediction-per-source-fixture',
      oneDay: { ...row }, sevenDays: { ...row, days: 7 }, thirtyDays: { ...row, days: 30 }, byLeague30Days: [], retainedFrozen: 0 },
    strictMarkets: { releasedCandidates: 0, reviewed: false },
    commercialReleaseGate: 'BLOCKED', researchGate: 'INDEPENDENT_OF_COMMERCIAL', externalTelegramSent: false,
  };
  const merged = { ...report, ...overrides };
  return { ...merged, reportId: createHash('sha256').update(JSON.stringify(merged)).digest('hex') };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'research-autopush-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'reports/research-daily'), { recursive: true });
  return root;
}

async function writeReport(root, report) {
  await writeFile(join(root, 'reports/research-daily/latest.json'), JSON.stringify(report));
  await writeFile(join(root, 'reports/research-daily/latest.md'), renderDailyResearchMarkdown(report));
}

function telegramOk(messageId) {
  return payload => new Response(JSON.stringify({ ok: true, result: { message_id: messageId, chat: { id: payload.chat_id } } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
}

test('研究日报与 Telegram 回执不在持久 state 允许列表：新 runner 的 receipt 必然是空的', () => {
  assert.equal(allowedStatePath('reports/research-daily/latest.json'), false);
  assert.equal(allowedStatePath('reports/research-daily/latest.md'), false);
  assert.equal(allowedStatePath('reports/research-daily/telegram-receipt.json'), false);
  // 对照组：喂给日报的来源文档和由 hosted.mjs 维护的调度状态确实会持久化。
  assert.equal(allowedStatePath('reports/predictions.json'), true);
  assert.equal(allowedStatePath('state/hosted-research-scheduler.json'), true);
});

test('同一 root 的第二次调用会去重，但换一个空 root（等价于新 runner）会再次发送', async t => {
  const report = zeroReport();
  const firstRoot = await fixture(t);
  const secondRoot = await fixture(t);
  await writeReport(firstRoot, report);
  await writeReport(secondRoot, report);

  const first = await publishResearchTelegram({ root: firstRoot,
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async (url, init) => telegramOk(101)(JSON.parse(init.body)) });
  assert.equal(first.status, 'accepted');
  assert.equal(first.messageId, 101);

  const repeated = await publishResearchTelegram({ root: firstRoot,
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async () => { throw new Error('same runner must not resend'); } });
  assert.equal(repeated.status, 'skipped');
  assert.equal(repeated.code, 'ALREADY_SENT_TODAY');

  // 新 runner 从空的 RUNNER_TEMP 开始：没有 receipt，所以同一报告会再次 accepted。
  // 跨 runner 的当日幂等必须由 workflow 的 research-telegram-<beijingDay> 缓存标记保证。
  const freshRunner = await publishResearchTelegram({ root: secondRoot,
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async (url, init) => telegramOk(102)(JSON.parse(init.body)) });
  assert.equal(freshRunner.status, 'accepted');
  assert.equal(freshRunner.messageId, 102);
  assert.equal(freshRunner.reportId, report.reportId);
});

test('36 小时窗口内 0 场：日报仍生成，TG 文案明确说明 0 场而不是报错', async t => {
  const nowISO = NOW;
  const document = {
    simulated: false, kind: 'prematch-forecast-report',
    publication: { reportId: 'b'.repeat(64) },
    generatedAt: nowISO,
    fixtures: [{
      fixture: { id: 'f1', source: 'openligadb', league: 'BL1', home: 'Alpha', away: 'Beta', kickoff: '2026-11-04T19:30:00.000Z' },
      forecast: { status: 'forecast', generatedAt: nowISO, probabilities: { home: 0.5, draw: 0.3, away: 0.2 } },
    }],
  };
  const report = buildDailyResearchReport({ document, ledger: { exists: true, events: [] }, nowISO, codeSha: 'a'.repeat(40) });
  assert.equal(report.state, 'zero-qualified-forecasts');
  assert.equal(report.forecasts.total, 0);
  assert.equal(report.forecasts.candidates.length, 0);
  assert.equal(report.forecasts.skipped, 1, '窗口外的场次应计入 skipped 而不是报错');
  assert.match(report.reportId, /^[a-f0-9]{64}$/);
  assert.match(renderDailyResearchMarkdown(report), /无合格赛前研究预测，不补场/);

  const root = await fixture(t);
  await writeReport(root, report);
  let sent = null;
  const result = await publishResearchTelegram({ root,
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: CHAT },
    fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return telegramOk(201)(sent.body); } });
  assert.equal(result.status, 'accepted', '0 场不得让推送失败');
  assert.equal(result.messageId, 201);
  assert.ok(sent.url.endsWith('/sendRichMessage'));
  const html = String(sent.body.rich_message.html);
  assert.match(html, /冻结 0 场/);
  assert.match(html, /本轮没有符合赛前冻结条件的研究预测，不补场/);
  assert.equal(JSON.parse(await readFile(join(root, 'reports/research-daily/telegram-receipt.json'), 'utf8')).status, 'accepted');
});
