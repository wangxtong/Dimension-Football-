import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, atomicJson } from './storage.mjs';

// 研究日报 Telegram 推送：所有者 2026-11-02 授权的个人研究用途通道。
// 与 publish-research-daily.mjs（Web）对称：普通 1X2 研究参考才允许发送；
// 严格盘口候选恒为 0；商业发布门禁保持 BLOCKED，本通道不构成正式发布授权。
const HASH = /^[a-f0-9]{64}$/;
const TELEGRAM_MAX_CHARS = 3900;

function validDailyResearch(report) {
  return report?.kind === 'research-daily-1x2' && report?.mode === 'research-reference'
    && report?.commercialReleaseGate === 'BLOCKED' && report?.externalTelegramSent !== true
    && report?.strictMarkets?.releasedCandidates === 0 && HASH.test(report.reportId || '')
    && typeof report.disclaimer === 'string' && report.disclaimer.length > 0
    && /^\d{4}-\d{2}-\d{2}$/.test(report.beijingDay || '')
    && Number.isFinite(Date.parse(report.generatedAt || ''))
    && report.forecasts && Number.isSafeInteger(report.forecasts.total);
}

function telegramText(report, markdown) {
  const head = '维度足球｜每日 1X2 研究参考\n'
    + '北京日：' + report.beijingDay + '；有效冻结 ' + report.forecasts.total + ' 场；严格盘口对外候选 0 场\n'
    + report.disclaimer + '\n';
  const body = markdown.replace(/^# /, '').split('\n').filter(line => !line.startsWith('| ---')).join('\n');
  const full = head + body;
  return full.length <= TELEGRAM_MAX_CHARS ? full : head + full.slice(head.length, TELEGRAM_MAX_CHARS) + '\n…（完整内容见网站报告）';
}

export async function publishResearchTelegram({ root, env = process.env, fetchImpl = fetch, clock = () => new Date().toISOString() }) {
  if (!root) throw Error('RESEARCH_ROOT_REQUIRED');
  const directory = resolve(root, 'reports/research-daily');
  const report = await readJson(join(directory, 'latest.json'), 750_000);
  if (!validDailyResearch(report)) throw Error('RESEARCH_REPORT_INVALID');
  const token = env.TELEGRAM_BOT_TOKEN; const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { reportId: report.reportId, beijingDay: report.beijingDay,
    status: 'not_configured', code: 'TELEGRAM_CREDENTIALS_REQUIRED' };
  if (!/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(token) || !/^-?\d{5,20}$/.test(String(chatId))) throw Error('TELEGRAM_CONFIGURATION_INVALID');
  const receiptPath = join(directory, 'telegram-receipt.json');
  let prior = null;
  try { prior = await readJson(receiptPath, 16000); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (prior?.beijingDay === report.beijingDay && prior?.codeSha === report.codeSha && prior?.status === 'accepted')
    return { reportId: report.reportId, beijingDay: report.beijingDay, status: 'skipped', code: 'ALREADY_SENT_TODAY' };
  const markdown = await readFile(join(directory, 'latest.md'), 'utf8');
  let result;
  try {
    const response = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: telegramText(report, markdown), link_preview_options: { is_disabled: true } }) });
    if (!response.ok) { await response.body?.cancel(); result = { status: 'failed', code: 'TELEGRAM_API_REJECTED', httpStatus: response.status }; }
    else {
      const data = await response.json();
      if (data.ok !== true || !Number.isSafeInteger(data.result?.message_id) || String(data.result?.chat?.id) !== String(chatId))
        result = { status: 'unknown', code: 'TELEGRAM_RECEIPT_UNVERIFIED' };
      else result = { status: 'accepted', messageId: data.result.message_id };
    }
  } catch { result = { status: 'unknown', code: 'DELIVERY_RESULT_UNKNOWN_NO_AUTOMATIC_RETRY' }; }
  await mkdir(directory, { recursive: true });
  await atomicJson(receiptPath, { version: 1, beijingDay: report.beijingDay, codeSha: report.codeSha,
    reportId: report.reportId, sentAt: clock(), ...result });
  return { reportId: report.reportId, beijingDay: report.beijingDay, ...result,
    meaning: result.status === 'accepted' ? 'telegram-api-accepted-not-a-user-read-receipt' : undefined };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root') {
    console.error('用法：node collector/publish-research-telegram.mjs --root <研究工作区>');
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(await publishResearchTelegram({ root: args[1] }))); }
    catch (error) {
      const code = /^(?:RESEARCH|TELEGRAM)_[A-Z0-9_]+$/.test(error?.message || '') ? error.message : 'RESEARCH_DELIVERY_FAILED';
      console.error(code); process.exitCode = 1;
    }
  }
}
