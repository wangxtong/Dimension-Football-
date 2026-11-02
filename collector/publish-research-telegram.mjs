import { mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, atomicJson } from './storage.mjs';
import { teamName } from './sources/team-names.mjs';

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

const LEAGUE_CN = { PL: '英超', PD: '西甲', SA: '意甲', BL1: '德甲', FL1: '法甲' };
const OUTCOME_CN = { home: '主胜', draw: '平', away: '客胜' };
function pctValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? (value * 100).toFixed(1) + '%' : '—';
}
function beijingShort(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 8 * 3600_000);
  const pad = n => String(n).padStart(2, '0');
  return pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}
function weatherLine(row) {
  const w = row.weather;
  if (!w || w.status !== 'ok') return null;
  const parts = [];
  if (typeof w.temperatureC === 'number' && Number.isFinite(w.temperatureC)) parts.push(w.temperatureC.toFixed(0) + '°C');
  if (typeof w.windKmh === 'number' && Number.isFinite(w.windKmh)) parts.push('风' + w.windKmh.toFixed(0) + 'km/h');
  if (typeof w.precipitationProbabilityPct === 'number' && Number.isFinite(w.precipitationProbabilityPct))
    parts.push('雨' + w.precipitationProbabilityPct.toFixed(0) + '%');
  if (typeof w.precipitationMm === 'number' && w.precipitationMm > 0) parts.push(w.precipitationMm.toFixed(1) + 'mm');
  if (!parts.length) return null;
  const city = row.venue && typeof row.venue.city === 'string' ? '（' + row.venue.city + '）' : '';
  return '天气 ' + parts.join(' ') + city;
}
// Telegram 不渲染 Markdown 表格：改成一赛一段的纯文本，避免出现 "| --- |" 竖线噪声。
function forecastBlock(row) {
  const lines = [];
  const p = row.probabilities || {};
  lines.push('【' + (LEAGUE_CN[row.league] || row.league) + '】' + teamName(row.home) + ' vs ' + teamName(row.away));
  lines.push('开球 ' + beijingShort(row.kickoff) + '（北京）｜最高倾向 ' + (OUTCOME_CN[row.selection] || row.selection)
    + ' ' + pctValue(p[row.selection]));
  lines.push('主胜 ' + pctValue(p.home) + '｜平 ' + pctValue(p.draw) + '｜客胜 ' + pctValue(p.away));
  const eg = row.expectedGoals;
  if (eg && Number.isFinite(eg.home) && Number.isFinite(eg.away)) {
    const total = eg.home + eg.away;
    lines.push('预期进球 ' + eg.home.toFixed(2) + ' / ' + eg.away.toFixed(2) + '｜'
      + (total >= 2.5 ? '大2.5' : '小2.5') + '(' + total.toFixed(2) + ')');
  }
  const scores = Array.isArray(row.topScores) && row.topScores.length
    ? row.topScores.map(s => s.home + ':' + s.away).join(' / ') : '';
  if (scores) lines.push('比分参考 ' + scores);
  const weather = weatherLine(row);
  if (weather) lines.push(weather);
  return lines;
}
function statsLine(row) {
  if (!row) return '—';
  const scored = row.scored ? (row.hitRate * 100).toFixed(1) + '%' : '无已评分样本';
  return '冻结 ' + row.eligibleFrozen + '｜评分 ' + row.scored + '｜待FT ' + row.pending + '｜命中率 ' + scored;
}
export function telegramText(report) {
  const lines = ['维度足球｜每日 1X2 研究参考',
    '北京日 ' + report.beijingDay + '｜研究冻结 ' + report.forecasts.total + ' 场｜严格盘口对外候选 0 场',
    report.disclaimer, ''];
  const candidates = report.forecasts.candidates || [];
  if (candidates.length) {
    for (const row of candidates) { lines.push(...forecastBlock(row), ''); }
  } else {
    lines.push('本轮没有符合赛前冻结条件的研究预测，不补场。', '');
  }
  lines.push('—— 真实前瞻 FT 核账（每场只计一次）',
    '1日 ' + statsLine(report.prospective?.oneDay),
    '7日 ' + statsLine(report.prospective?.sevenDays),
    '30日 ' + statsLine(report.prospective?.thirtyDays), '',
    '说明：历史回测、模拟数据、赛后补造预测均不得计入真实前瞻；样本不足30场不作优劣结论。',
    '报告 ' + String(report.reportId).slice(0, 16) + '…（完整版见网站）');
  const full = lines.join('\n');
  return full.length <= TELEGRAM_MAX_CHARS ? full : full.slice(0, TELEGRAM_MAX_CHARS - 20) + '\n…（完整内容见网站报告）';
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
  await readFile(join(directory, 'latest.md'), 'utf8');
  let result;
  try {
    const response = await fetchImpl('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: telegramText(report), link_preview_options: { is_disabled: true } }) });
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
