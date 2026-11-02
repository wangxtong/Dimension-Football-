import { validateBundle, validDate } from './report-schema.mjs';
import { validateMarketObservation, validateObservationAcquisition } from './market-observation-schema.mjs';
import { leagueName, teamName } from './locale-zh.mjs';
import { validateDailyResearch, researchPanelData } from './research-daily-store.mjs';

// Public identity only. Runtime credentials are never saved in the update ledger.
export const TELEGRAM_BOT_ID = 8858788137;
export const TELEGRAM_BOT_USERNAME = 'LYZKYPbot';
export const TELEGRAM_BOT_TARGET = 'c061d82bf8f5ff23';
export const TELEGRAM_BOT_ORIGIN = 'https://dimension-football-live-wangxtong.secretmelon37.chatgpt.site';
const SECTIONS = Object.freeze({ menu: '⚽ 维度足球', schedule: '⚽ 今日赛事', picks: '⭐ 优选门槛',
  backtest: '📚 历史回测', model: '📊 模型状态', settlement: '🧾 赛后核账', sources: '📡 来源诊断', status: '🔎 发布排查' });
const SOURCES = Object.freeze({ hkjc: '香港赛马会', macauslot: '澳门彩票', titan007: '球探参考源' });
const ASSET_HASHES = Object.freeze({
  '/evaluation-evidence.json': '7a391c44a75f1681bbe94184f672b4eb979b3c7adc935d92ecfdfab247f3d629',
  '/model-experiment-evidence.json': '38f66c9a604588dc0d96eb9db85b05be3dfce102ec3a493aefcdf407953f178c',
});
const PAGE_SIZE = 5, MAX_TEXT = 4096, MAX_BODY = 64000;
const STATUS_KEY = `telegram-bot/status/${TELEGRAM_BOT_ID}.json`;
const encoder = new TextEncoder(), verifiedContexts = new WeakSet();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const html = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Thirty-two code points bound even the worst six-byte HTML entity expansion.
// Truncate before escaping, so an entity or surrogate pair is never cut in half.
const label = value => {
  const points = Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' '));
  return html(points.slice(0, 32).join('') + (points.length > 32 ? '…' : ''));
};
const time = value => validDate(value) ? new Date(Date.parse(value) + 28800000).toISOString().slice(0, 16).replace('T', ' ') : '待核验';
const nowTime = now => time(new Date(now).toISOString());
const json = (value, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
function freeze(value) { if (object(value) || Array.isArray(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
async function constantSecret(a, b) {
  const [x, y] = await Promise.all([digest(a), digest(b)]); let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
async function boundedJSON(response, maximum = MAX_BODY) {
  if (Number(response.headers.get('content-length')) > maximum) throw Error('BODY_TOO_LARGE');
  const reader = response.body?.getReader(); if (!reader) throw Error('BODY_MISSING');
  let bytes = 0, text = ''; const decoder = new TextDecoder();
  try {
    for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength;
      if (bytes > maximum) throw Error('BODY_TOO_LARGE'); text += decoder.decode(item.value, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
function dailyStatus(value, now) {
  const d = value?.receipt, date = new Date(now + 28800000).toISOString().slice(0, 10);
  const codes = { accepted: ['DAILY_TELEGRAM_ACCEPTED'], failed: ['DAILY_TELEGRAM_REJECTED', 'DAILY_TELEGRAM_RATE_LIMITED'],
    unknown: ['DAILY_CLAIM_UNRESOLVED_NO_RETRY', 'DAILY_STORAGE_UNCERTAIN_NO_RETRY', 'DAILY_TELEGRAM_UNKNOWN_NO_RETRY', 'DAILY_OUTCOME_NOT_PERSISTED_NO_RETRY'],
    skipped: ['DAILY_NOT_DUE', 'DAILY_REPORT_CHANGED_BEFORE_SEND', 'DAILY_REPORT_EXPIRED_BEFORE_SEND', 'DAILY_DATE_CHANGED_BEFORE_SEND'],
    not_attempted: ['DAILY_NOT_ATTEMPTED'] };
  if (value?.version !== 1 || value.kind !== 'daily-observation-delivery' || typeof value.sentNow !== 'boolean'
    || !object(d) || d.version !== 1 || d.kind !== value.kind || d.date !== date || !validDate(d.checkedAt)
    || new Date(Date.parse(d.checkedAt) + 28800000).toISOString().slice(0, 10) !== d.date
    || Date.parse(d.checkedAt) > now + 60000 || d.destinationFingerprint !== TELEGRAM_BOT_TARGET
    || !Object.hasOwn(codes, d.status) || !codes[d.status].includes(d.code) || typeof d.sentNow !== 'boolean'
    || value.sentNow !== d.sentNow
    || d.status !== 'accepted' && (d.sentNow || value.sentNow || d.messageId !== undefined || d.payloadSha256 !== undefined)
    || d.status === 'not_attempted' && d.reportId !== null
    || d.status !== 'not_attempted' && !id(d.reportId)
    || !['DAILY_NOT_ATTEMPTED', 'DAILY_NOT_DUE'].includes(d.code) && !id(d.reportHash)
    || d.status === 'accepted' && (!integer(d.messageId) || d.messageId < 1 || !id(d.payloadSha256)
      || d.meaning !== 'telegram-api-accepted-not-user-read')) return null;
  return { status: d.status, date: d.date, reportId: d.reportId || null, reportHash: d.reportHash || null,
    messageId: d.status === 'accepted' ? d.messageId : null, checkedAt: d.checkedAt };
}
function observation(bundle, now) {
  validateBundle(bundle);
  const r = bundle.report, receipt = bundle.receipt, served = receipt?.channels?.externalWebsite;
  if (bundle.freshness?.mode !== 'hosted' || bundle.health?.status !== 'available' || !id(bundle.reportHash)
    || r.publicationKind !== 'observations' || r.forecastPublished !== false || r.releaseGate?.status !== 'BLOCKED'
    || r.publication?.publicationKind !== 'observations' || r.publication?.forecastPublished !== false
    || r.summary.forecasts !== 0 || r.summary.strictCandidates !== 0 || r.summary.unavailable !== r.fixtures.length
    || r.model !== null || r.backtests.length !== 0 || Date.parse(r.generatedAt) > now
    || served?.status !== 'published' || served.servedVerified !== true || served.reportId !== bundle.reportId
    || served.reportHash !== bundle.reportHash || served.mode !== 'hosted' || served.publicationKind !== 'observations'
    || served.forecastPublished !== false || !validDate(served.checkedAt) || Date.parse(served.checkedAt) > now) throw Error('BOT_OBSERVATION_REQUIRED');
  for (const row of r.fixtures) {
    if (!exact(row.forecast, ['status', 'reasons']) || row.forecast.status !== 'unavailable'
      || JSON.stringify(row.forecast.reasons) !== '["RELEASE_GATE_BLOCKED"]'
      || !exact(row.marketCandidate, ['status', 'reasons', 'candidate', 'readiness'])
      || row.marketCandidate.status !== 'source_insufficient' || row.marketCandidate.candidate !== null
      || JSON.stringify(row.marketCandidate.reasons) !== '["RELEASE_GATE_BLOCKED"]'
      || !exact(row.marketCandidate.readiness, ['quoteGroups', 'verifiedOpeningCount', 'blockers'])
      || row.marketCandidate.readiness.quoteGroups.length !== 0 || row.marketCandidate.readiness.verifiedOpeningCount !== 0
      || JSON.stringify(row.marketCandidate.readiness.blockers) !== '["RELEASE_GATE_BLOCKED"]') throw Error('BOT_OBSERVATION_REQUIRED');
  }
  let market = null, acquired = null;
  try { acquired = validateObservationAcquisition(r.acquisition); if (Date.parse(acquired.checkedAt) > now) acquired = null; } catch { /* explicitly unavailable */ }
  try { market = validateMarketObservation(r.marketObservation, { fixtureCount: r.fixtures.length, generatedAt: r.generatedAt, acquisition: r.acquisition }); } catch { /* optional aggregate may be absent */ }
  return { report: r, receipt, reportId: bundle.reportId, reportHash: bundle.reportHash, acquired, market };
}

/** The only path from repository assets and a hosted bundle into presentation data.
 * Asset hashes pin reviewed historical snapshots; revised assets need explicit review.
 * No caller-supplied probabilities or mutable experiment objects are rendered. */
export async function prepareTelegramBotContext({ bundle, assets = {}, daily, research, now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw Error('BOT_TIME_INVALID');
  // Research is optional and read-only. It is re-validated here so a caller
  // cannot hand the panel a partially checked object; any defect means "no data".
  let researchPanel = null;
  if (research !== undefined && research !== null) {
    try { await validateDailyResearch(research, { now }); researchPanel = researchPanelData(research); }
    catch { researchPanel = null; }
  }
  let live = null;
  try { live = observation(bundle, now); if (await digest(JSON.stringify(live.report)) !== live.reportHash) live = null; } catch { /* fail closed, show diagnostics */ }
  const historical = {};
  for (const [path, expected] of Object.entries(ASSET_HASHES)) {
    const raw = assets?.[path];
    if (typeof raw !== 'string' || raw.length > 300000 || await digest(raw) !== expected) continue;
    try { historical[path] = JSON.parse(raw); } catch { /* no fabricated defaults */ }
  }
  // Copy only this independent receipt's known scalar facts; never expose arbitrary API errors.
  let dailyReceipt = dailyStatus(daily, now);
  if (dailyReceipt && live && dailyReceipt.reportId === live.reportId && dailyReceipt.reportHash !== live.reportHash) dailyReceipt = null;
  const context = freeze(structuredClone({ live, evaluation: historical['/evaluation-evidence.json'] || null,
    experiment: historical['/model-experiment-evidence.json'] || null, research: researchPanel, daily: dailyReceipt, now }));
  verifiedContexts.add(context); return context;
}
function keyboard(section, page, pages) {
  const rows = [[{ text: '⚽ 今日赛事', callback_data: 'df1:schedule:0' }, { text: '⭐ 优选门槛', callback_data: 'df1:picks:0' }],
    [{ text: '📚 历史回测', callback_data: 'df1:backtest:0' }, { text: '📊 模型状态', callback_data: 'df1:model:0' }],
    [{ text: '🧾 赛后核账', callback_data: 'df1:settlement:0' }, { text: '📡 来源诊断', callback_data: 'df1:sources:0' }],
    [{ text: '🔎 发布排查', callback_data: 'df1:status:0' }]];
  const navigation = [];
  if (page > 0) navigation.push({ text: '⬅️ 上一页', callback_data: `df1:${section}:${page - 1}` });
  if (page + 1 < pages) navigation.push({ text: '下一页 ➡️', callback_data: `df1:${section}:${page + 1}` });
  if (navigation.length) rows.push(navigation);
  rows.push([{ text: '🔄 刷新本页', callback_data: `df1:${section}:${page}` }, { text: '🏠 主菜单', callback_data: 'df1:menu:0' }]);
  rows.push([{ text: '🌐 打开完整看板', url: TELEGRAM_BOT_ORIGIN }]);
  return { inline_keyboard: rows };
}
const OUTCOME = Object.freeze({ home: '主胜', draw: '平局', away: '客胜' });
const rate = value => Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '—';
const score = value => Number.isFinite(value) ? value.toFixed(4) : '—';
const beijingDate = now => new Date(now + 28800000).toISOString().slice(0, 10);
const noSample = row => row.scored === 0;
const sampleNote = row => row.sampleStatus === 'insufficient-prospective-sample' ? '（样本不足，仅描述性）' : '';
function researchHeadline(research, now) {
  return ['📄 研究日报：<code>' + research.reportId.slice(0, 12) + '</code>｜研究日 ' + research.beijingDay
    + '｜生成 ' + time(research.generatedAt),
  research.beijingDay === beijingDate(now) ? '🟡 研究参考：未校准，不是正式发布' : '🟠 历史研究日报（不是今天新预测）'];
}
function researchWindow(name, row) {
  const head = '<b>' + name + '</b>：冻结 ' + row.eligibleFrozen + '｜已核账 ' + row.scored
    + '｜待 FT ' + row.pending + '｜作废 ' + row.voided;
  return noSample(row) ? [head, '样本不足，暂无可报告指标。']
    : [head, '命中率 ' + rate(row.hitRate) + '｜Brier ' + score(row.brier) + '｜Log loss ' + score(row.logLoss) + sampleNote(row)];
}
const number = value => Number.isFinite(value) ? value.toFixed(4) : '待核验';
const percent = value => Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : '待核验';
function scheduleFresh(live, now) { return !!live?.acquired && now - Date.parse(live.acquired.checkedAt) <= 1200000; }
function marketFresh(live, now) { return !!live?.market && now < Date.parse(live.market.expiresAt); }

export function formatTelegramBotPanel({ context, section = 'menu', page = 0, now = context?.now } = {}) {
  if (!verifiedContexts.has(context) || !Object.hasOwn(SECTIONS, section) || !integer(page) || page > 999
    || !Number.isFinite(now) || now < context.now) throw Error('BOT_PANEL_INVALID');
  const { live, evaluation, experiment, research } = context, report = live?.report;
  const daily = context.daily?.date === new Date(now + 28800000).toISOString().slice(0, 10) ? context.daily : null;
  let pages = 1, current = 0, lines = [`<b>${SECTIONS[section]}</b>`, '━━━━━━━━━━━━━━'];
  if (section === 'menu') lines.push('选择下方按钮，在机器人内查看分类报告。', '',
    '⚽ 赛程与来源：真实采集观察', '📚 回测与模型：已归档研究证据', '🧾 核账与排查：明确缺项和交付状态', '',
    '🔒 正式预测与今日优选尚未开放。');
  if (section === 'schedule') {
    if (!live) lines.push('⚠️ 当前赛程尚未通过报告核验，请稍后刷新或查看发布排查。');
    else {
      const rows = report.fixtures.filter(row => ['SCHEDULED', 'TIMED'].includes(row.fixture.status)
        && Date.parse(row.fixture.kickoff) > now && Date.parse(row.fixture.kickoff) <= now + 86400000)
        .sort((a, b) => Date.parse(a.fixture.kickoff) - Date.parse(b.fixture.kickoff) || a.fixture.id.localeCompare(b.fixture.id));
      pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); current = Math.min(page, pages - 1);
      lines.push(`🗓 未来 24 小时：${rows.length} 场｜第 ${current + 1}/${pages} 页`,
        scheduleFresh(live, now) ? '🟢 赛程采集在有效期内' : '🟠 赛程已过期或取得时间待核验，以下仅供查阅', '');
      for (const row of rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) lines.push(
        `🏟 <b>${label(teamName(row.fixture.home))} vs ${label(teamName(row.fixture.away))}</b>`,
        `   ${label(leagueName(row.fixture.league))}｜${time(row.fixture.kickoff)}（北京时间）`, '');
      if (!rows.length) lines.push('本轮样本中暂无未来 24 小时赛事，不代表所有联赛没有比赛。');
      lines.push(`📥 赛程取得：${time(live.acquired?.checkedAt)}`);
    }
  }
  if (section === 'picks') {
    lines.push('🔒 正式优选：尚未开放', '不以每日数量目标代替质量门槛。', '');
    if (research) {
      lines.push(...researchHeadline(research, now),
        '🧊 赛前冻结研究预测：' + research.total + ' 场｜严格盘口正式推荐 0 场｜模型未校准', '');
      const rows = research.candidates;
      pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE)); current = Math.min(page, pages - 1);
      if (rows.length) {
        lines.push('🗓 第 ' + (current + 1) + '/' + pages + ' 页'
          + (research.truncated ? '（仅展示前 ' + research.shown + ' 场，共 ' + research.total + ' 场）' : ''), '');
        for (const row of rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) lines.push(
          '🏟 <b>' + label(teamName(row.home)) + ' vs ' + label(teamName(row.away)) + '</b>',
          '   ' + label(leagueName(row.league)) + '｜开球 ' + time(row.kickoff) + '（北京时间）',
          '   研究概率 主 ' + rate(row.probabilities.home) + ' / 平 ' + rate(row.probabilities.draw)
            + ' / 客 ' + rate(row.probabilities.away),
          '   研究方向：' + OUTCOME[row.selection] + '（研究参考）', '');
      } else lines.push('本轮研究日报没有合格赛前冻结预测；不补场。', '');
      lines.push('⚠️ 研究参考，非投注建议；未经校准，不构成正式预测发布。',
        '盘口证据充分也不自动取得模型发布资格。');
    } else {
      lines.push('① 模型前瞻与校准：尚未通过商业验收',
        live?.market ? '② 双源对齐：原观察 ' + live.market.alignedEligibleFixtureCount + ' 场' + (marketFresh(live, now) ? '' : '（已过期）') : '② 双源对齐：尚无可核验观察',
        live?.market ? '③ 真实初盘：原观察 ' + live.market.trueOpeningFixtureCount + ' 场' + (marketFresh(live, now) ? '' : '（已过期）') : '③ 真实初盘：证据待核验',
        '', '盘口证据充分也不自动取得模型发布资格。');
    }
  }
  if (section === 'backtest') {
    if (research) {
      const rows = research.prospective.byLeague30Days;
      pages = Math.max(1, Math.ceil(rows.length / 2)); current = Math.min(page, pages - 1);
      lines.push('🕒 研究前瞻账本（30 天窗口）', '赛前冻结 + 赛后实际 FT；与历史快照回放分开。',
        ...researchHeadline(research, now), '');
      for (const row of rows.slice(current * 2, (current + 1) * 2)) {
        lines.push('<b>' + label(leagueName(row.league)) + '</b>｜冻结 ' + row.eligibleFrozen
          + ' 场｜已评分 ' + row.scored + ' 场｜待 FT ' + row.pending + ' 场');
        lines.push(noSample(row) ? '样本不足，暂无可报告指标（30 天窗口）。'
          : '命中率 ' + rate(row.hitRate) + '｜Brier ' + score(row.brier) + '｜Log loss ' + score(row.logLoss) + sampleNote(row), '');
      }
      lines.push('30 天合计：冻结 ' + research.prospective.thirtyDays.eligibleFrozen + ' 场｜已评分 '
        + research.prospective.thirtyDays.scored + ' 场',
        '同场只计最早一次冻结；不同联赛方向不相加。Brier / Log loss 越低越好。',
        '第 ' + (current + 1) + '/' + pages + ' 页', '研究参考，非投注建议；0 评分不代表准确率。');
    } else if (!evaluation) {
      lines.push('⚠️ 历史回测资产尚未通过固定摘要校验，不显示估算指标。');
    } else {
      const groups = evaluation.groups.filter(g => g.purpose === 'reference-horizon' && g.horizonHours === 24);
      pages = Math.max(1, Math.ceil(groups.length / 2)); current = Math.min(page, pages - 1);
      lines.push('🕒 统一口径：赛前 24 小时', '历史快照回放，尚非独立前瞻成绩。', '');
      for (const g of groups.slice(current * 2, (current + 1) * 2)) {
        lines.push(`<b>${label(leagueName(g.league))}</b>｜评估 ${g.evaluated} 场 · 跳过 ${g.skipped} 场`);
        if (g.evaluated && g.metrics) lines.push(`方向命中 ${percent(g.metrics.accuracy)}｜基准 ${percent(g.baseline?.accuracy)}`,
          `Brier ${number(g.metrics.brier)}｜基准 ${number(g.baseline?.brier)}`,
          `Log loss ${number(g.metrics.logLoss)}｜基准 ${number(g.baseline?.logLoss)}`);
        else lines.push('样本不足，暂无可报告指标。');
        lines.push('');
      }
      lines.push('Brier / Log loss 越低越好；不同提前量不相加。', `📦 归档：${time(evaluation.generatedAt)}`, `第 ${current + 1}/${pages} 页`);
    }
  }
  if (section === 'model') {
    lines.push('🔒 尚未完成正式概率校准与充分前瞻验收。', '');
    if (!experiment) lines.push('⚠️ 模型实验资产未通过固定摘要校验。');
    else lines.push('🧠 该实验保留：主客场泊松基线 v2', '🧪 历史温度缩放实验：未采用', `输入 ${experiment.samples.input} 场｜留出评估 ${experiment.samples.holdout.evaluated} 场｜跳过 ${experiment.samples.holdout.skipped} 场`,
      `Brier：${number(experiment.holdout.baseline.brier)} → ${number(experiment.holdout.candidate.brier)}`,
      `Log loss：${number(experiment.holdout.baseline.logLoss)} → ${number(experiment.holdout.candidate.logLoss)}`,
      '上述两项未改善，不能宣称准确率提升。', '', '这是历史研究，不是今日赛事预测。', `📦 实验归档：${time(experiment.generatedAt)}`);
  }
  if (section === 'settlement') {
    if (research) {
      const p = research.prospective;
      lines.push('🧾 研究前瞻账本（商业发布 BLOCKED，非投注建议）', ...researchHeadline(research, now), '',
        '口径：赛前冻结记录 + 赛后实际 FT；每场只计一次；保留冻结 ' + p.retainedFrozen + ' 场', '');
      for (const [name, row] of [['当日（1 日）', p.oneDay], ['7 日', p.sevenDays], ['30 日', p.thirtyDays]])
        lines.push(...researchWindow(name, row), '');
      lines.push('<b>30 天分联赛</b>');
      for (const row of p.byLeague30Days) lines.push(label(leagueName(row.league)) + '：冻结 '
        + row.eligibleFrozen + ' 场｜已核账 ' + row.scored + ' 场｜待 FT ' + row.pending + ' 场');
      lines.push('', '研究账本不是商业生产成绩，也不代表公开推送；历史隔离核账/模拟不计入。',
        '下一步：持续持久保存赛前冻结记录，再绑定真实终场结果。');
    } else lines.push('🧾 生产前瞻账本：尚未接入本机器人', '待开赛、待赛果、已核账数量：暂不可核验。', '',
      '历史隔离核账测试不计作生产成绩，也不证明公开推送。',
      ...(evaluation ? ['📦 保留归档：' + time(evaluation.prospective.asOf), '该归档赛前 ' + evaluation.prospective.horizonHours + ' 小时窗口已评分 ' + evaluation.prospective.evaluated + ' 场；不是当前实时账本。'] : ['历史前瞻归档也暂未通过校验。']),
      '', '下一步：持久保存赛前冻结记录，再绑定真实终场结果。');
  }
  if (section === 'sources') {
    if (!live) lines.push('⚠️ 当前来源报告不可核验，不能推断接口已接通。');
    else {
      lines.push(`📥 赛程样本：${report.fixtures.length} 场`, `赛程取得：${time(live.acquired?.checkedAt)}`,
        scheduleFresh(live, now) ? '🟢 赛程时效有效' : '🟠 赛程时间未知或超过 20 分钟', '');
      if (!live.market) lines.push('⚠️ 盘口覆盖摘要缺失或未通过结构校验。');
      else {
        lines.push(marketFresh(live, now) ? '🟢 报价观察在有效期内' : '🟠 报价观察已过期；下列数值是原观察记录',
          `受检 ${live.market.fixtureCount} 场｜双源 ${live.market.dualSourceFixtureCount} 场`,
          `对齐 ${live.market.alignedEligibleFixtureCount} 场｜真实初盘 ${live.market.trueOpeningFixtureCount} 场`, '');
        for (const source of live.market.sources) lines.push(`• ${SOURCES[source.id]}：${source.pairedFixtureCount} 场完整配对`,
          `  原始源更新时间：${time(source.latestSourceUpdatedAt)}`);
        lines.push('', `观察时间：${time(live.market.checkedAt)}`, `失效时间：${time(live.market.expiresAt)}`);
      }
      lines.push('', '接口能访问不等于覆盖完整；当前不公开原始盘口。');
    }
  }
  if (section === 'status') {
    lines.push(live ? '✅ 网站报告：同报告摘要和回读证明已核验' : '⚠️ 网站报告：当前无法核验',
      live && scheduleFresh(live, now) ? '✅ 赛程时效：有效' : '⚠️ 赛程时效：过期或未知',
      live && marketFresh(live, now) ? '✅ 报价观察：有效' : '⚠️ 报价观察：过期或未知', '', '📨 每日赛事状态摘要');
    if (!daily) lines.push('回执未载入或未核验，不能认定已送达。');
    else {
      const names = { accepted: 'Telegram 平台已接收（不代表用户已读）', failed: '发送失败', unknown: '结果未知，不自动重发',
        not_configured: '发送配置不完整', skipped: '本次跳过', not_attempted: '尚未尝试' };
      lines.push(names[daily.status]);
      if (daily.messageId) lines.push(`消息编号：${daily.messageId}`);
      if (daily.reportId) lines.push(`日报报告：<code>${daily.reportId.slice(0, 12)}</code>${daily.reportId === live?.reportId ? '（与当前报告一致）' : '（独立历史版本）'}`);
      if (daily.checkedAt) lines.push(`回执时间：${time(daily.checkedAt)}`);
    }
    lines.push('', '🔒 正式预测日报：未开放', '自动任务可能延迟；状态摘要成功不等于生产预测交付完成。');
  }
  lines.push('', `🕒 查询：${nowTime(now)}（北京时间）`,
    live ? `🧾 报告：<code>${live.reportId.slice(0, 12)}</code>｜生成 ${time(report.generatedAt)}` : '🧾 当前报告：待核验',
    'ℹ️ 查询时间不会刷新原始数据时间。');
  const text = lines.join('\n');
  if (text.length > MAX_TEXT) throw Error('BOT_PANEL_TOO_LONG');
  return { text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: keyboard(section, current, pages) };
}

function decodeUpdate(update, now) {
  if (!object(update) || !integer(update.update_id)) return null;
  const query = update.callback_query;
  if (query !== undefined) {
    if (update.message !== undefined || !object(query) || typeof query.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(query.id)
      || !object(query.from) || !integer(query.from.id) || query.from.is_bot === true || !object(query.message)
      || query.message.from?.id !== TELEGRAM_BOT_ID || query.message.from?.is_bot !== true
      || !integer(query.message.message_id) || query.message.message_id < 1) return null;
    const parsed = /^df1:(menu|schedule|picks|backtest|model|settlement|sources|status):(0|[1-9]\d{0,2})$/.exec(query.data || '');
    if (!parsed) return null;
    return { updateId: update.update_id, chatId: query.message.chat?.id, messageId: query.message.message_id,
      queryId: query.id, section: parsed[1], page: Number(parsed[2]), action: 'callback', stale: false };
  }
  const message = update.message;
  if (!object(message) || message.from?.is_bot === true || !integer(message.message_id) || message.message_id < 1
    || typeof message.text !== 'string' || message.text.length > 80 || !integer(message.date)) return null;
  const command = /^\/(start|menu|help|status)(?:@LYZKYPbot)?\s*$/i.exec(message.text);
  if (!command) return null;
  const age = now - message.date * 1000;
  return { updateId: update.update_id, chatId: message.chat?.id, messageId: message.message_id, section: command[1].toLowerCase() === 'status' ? 'status' : 'menu',
    page: 0, action: 'command', stale: age < -60000 || age > 600000 };
}
async function telegramCall(token, method, body, fetchImpl, expected = {}) {
  const controller = new AbortController(); let timer;
  const uncertain = { status: 'unknown', code: 'TELEGRAM_OUTCOME_UNKNOWN_NO_RETRY' };
  try {
    return await Promise.race([(async () => {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await boundedJSON(response, 32000);
      if (response.ok && result.ok === true) {
        if (method === 'answerCallbackQuery' && result.result === true) return { status: 'accepted', code: 'TELEGRAM_ACCEPTED' };
        const value = result.result;
        if (object(value) && integer(value.message_id) && value.message_id > 0 && String(value.chat?.id) === String(expected.chatId)
          && value.from?.id === TELEGRAM_BOT_ID && value.from?.is_bot === true
          && (expected.messageId === undefined || value.message_id === expected.messageId)) return { status: 'accepted', code: 'TELEGRAM_ACCEPTED', messageId: value.message_id };
        return uncertain;
      }
      // No retry. "Not modified" is harmless only for editing this existing message.
      if (method === 'editMessageText' && response.status === 400 && result.ok === false
        && typeof result.description === 'string' && result.description.startsWith('Bad Request: message is not modified')) return { status: 'accepted', code: 'TELEGRAM_UNCHANGED', messageId: expected.messageId };
      return response.status >= 400 && response.status < 500 && result.ok === false
        ? { status: 'failed', code: response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_API_REJECTED' } : uncertain;
    })(), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(uncertain); }, 8000); })]);
  } catch { return uncertain; } finally { clearTimeout(timer); controller.abort(); }
}

const outcomeCodes = Object.freeze({ accepted: ['TELEGRAM_ACCEPTED', 'TELEGRAM_UNCHANGED'],
  failed: ['TELEGRAM_RATE_LIMITED', 'TELEGRAM_API_REJECTED'], unknown: ['TELEGRAM_OUTCOME_UNKNOWN_NO_RETRY', 'BOT_PROCESSING_UNCERTAIN_NO_RETRY'],
  skipped: ['BOT_OLD_MESSAGE_IGNORED'] });
function checkedOutcome(value) {
  return object(value) && Object.hasOwn(outcomeCodes, value.status) && outcomeCodes[value.status].includes(value.code)
    && (value.messageId === undefined || integer(value.messageId) && value.messageId > 0);
}
async function storedJSON(bucket, key, maximum = 12000) {
  const object = await bucket.get(key); if (!object) return null;
  if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > maximum || typeof object.etag !== 'string') throw Error('BOT_STATUS_INVALID');
  return { etag: object.etag, value: JSON.parse(await object.text()) };
}
function statusPointer(value, target) {
  if (!exact(value, ['version', 'botId', 'destinationFingerprint', 'updateId', 'processedAt']) || value.version !== 1
    || value.botId !== TELEGRAM_BOT_ID || value.destinationFingerprint !== target || !integer(value.updateId)
    || !validDate(value.processedAt)) throw Error('BOT_STATUS_INVALID');
  return value;
}
async function saveLastStatus(bucket, row) {
  const value = { version: 1, botId: TELEGRAM_BOT_ID, destinationFingerprint: row.destinationFingerprint,
    updateId: row.updateId, processedAt: row.completedAt };
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await storedJSON(bucket, STATUS_KEY);
    if (current) {
      const old = statusPointer(current.value, row.destinationFingerprint);
      if (Date.parse(old.processedAt) > Date.parse(value.processedAt)
        || old.processedAt === value.processedAt && old.updateId >= value.updateId) return;
    }
    const saved = await bucket.put(STATUS_KEY, JSON.stringify(value), {
      onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
    });
    if (saved && typeof saved.etag === 'string') return;
  }
  throw Error('BOT_STATUS_CONFLICT');
}
async function readBotStatus(env, { now = Date.now() } = {}, target = TELEGRAM_BOT_TARGET) {
  if (!Number.isFinite(now)) return { version: 1, kind: 'telegram-bot-status', status: 'unavailable', last: null, code: 'BOT_STATUS_UNVERIFIED' };
  const base = { version: 1, kind: 'telegram-bot-status', checkedAt: new Date(now).toISOString(),
    meaning: 'authenticated-webhook-processing-not-proof-of-human-click-or-formal-forecast-release' };
  try {
    const pointer = await storedJSON(env.BUCKET, STATUS_KEY);
    if (!pointer) return { ...base, status: 'not_processed', last: null };
    const p = statusPointer(pointer.value, target);
    const record = await storedJSON(env.BUCKET, `telegram-bot/updates/${TELEGRAM_BOT_ID}/${p.updateId}.json`), row = record?.value;
    if (!object(row) || row.version !== 1 || row.botId !== TELEGRAM_BOT_ID || row.destinationFingerprint !== target
      || row.state !== 'complete' || row.updateId !== p.updateId || row.completedAt !== p.processedAt || Date.parse(p.processedAt) > now + 60000
      || !Object.hasOwn(SECTIONS, row.section) || !['callback', 'command'].includes(row.action)
      || row.reportId !== null && !id(row.reportId) || !checkedOutcome(row.outcome)
      || row.action === 'callback' && !checkedOutcome(row.acknowledgement)
      || row.outcome.status === 'accepted' && (!integer(row.outcome.messageId) || row.outcome.messageId < 1)) throw Error('BOT_STATUS_INVALID');
    return { ...base, status: 'available', last: { processedAt: row.completedAt, action: row.action, section: row.section,
      reportId: row.reportId, status: row.outcome.status, code: row.outcome.code,
      ...(row.outcome.messageId ? { messageId: row.outcome.messageId } : {}),
      ...(row.action === 'callback' ? { acknowledgementStatus: row.acknowledgement.status } : {}) } };
  } catch { return { ...base, status: 'unavailable', last: null, code: 'BOT_STATUS_UNVERIFIED' }; }
}

/** Dedicated Telegram authentication, not browser cookies or Actions identity.
 * This only queries redacted observations/reviewed historical assets. It does not
 * authorize forecast publication, mutate report receipts or touch the other Bot. */
export function createTelegramBotHandler({ verifiedTargetFingerprint = TELEGRAM_BOT_TARGET } = {}) {
  if (typeof verifiedTargetFingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(verifiedTargetFingerprint)) throw Error('BOT_CONFIGURATION_INVALID');
  const handle = async function handle(request, env, { fetchImpl = fetch, now = Date.now(), loadBundle, wallClock = () => Date.now(),
  assets = {}, loadObservationReceipt, loadResearch } = {}) {
  const started = wallClock(), currentTime = () => now + Math.max(0, wallClock() - started);
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
  const secret = env.TELEGRAM_WEBHOOK_SECRET, token = env.TELEGRAM_BOT_TOKEN;
  if (!Number.isFinite(now) || typeof secret !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(secret)
    || typeof token !== 'string' || !/^8858788137:[A-Za-z0-9_-]{20,150}$/.test(token)
    || typeof env.BUCKET?.get !== 'function' || typeof env.BUCKET?.put !== 'function') return json({ ok: false, code: 'BOT_NOT_CONFIGURED' }, 503);
  const supplied = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (typeof supplied !== 'string' || supplied.length > 256 || !await constantSecret(supplied, secret)) return json({ ok: false, code: 'BOT_IDENTITY_REQUIRED' }, 401);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) return json({ ok: false, code: 'BOT_UPDATE_INVALID' }, 400);
  let update; try { update = await boundedJSON(request); } catch { return json({ ok: false, code: 'BOT_UPDATE_INVALID' }, 400); }
  const event = decodeUpdate(update, now);
  if (!event || !Number.isSafeInteger(event.chatId) || event.chatId === 0
    || (await digest(String(event.chatId))).slice(0, 16) !== verifiedTargetFingerprint) return json({ ok: true, status: 'ignored', code: 'BOT_UPDATE_IGNORED' });
  // Reserve once before any Telegram request. Prepared/unknown claims are never reclaimed.
  const key = `telegram-bot/updates/${TELEGRAM_BOT_ID}/${event.updateId}.json`;
  const row = { version: 1, updateId: event.updateId, botId: TELEGRAM_BOT_ID, destinationFingerprint: verifiedTargetFingerprint,
    section: event.section, page: event.page, action: event.action, state: 'prepared', createdAt: new Date(now).toISOString() };
  let claim;
  try {
    const previous = await env.BUCKET.get(key);
    if (previous) return json({ ok: true, status: 'duplicate', code: 'BOT_UPDATE_ALREADY_CLAIMED_NO_RETRY' });
    claim = await env.BUCKET.put(key, JSON.stringify(row), { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' } });
    if (!claim) return json({ ok: true, status: 'duplicate', code: 'BOT_UPDATE_ALREADY_CLAIMED_NO_RETRY' });
    if (typeof claim.etag !== 'string') throw Error('BAD_CLAIM');
  } catch { return json({ ok: true, status: 'unknown', code: 'BOT_CLAIM_UNCERTAIN_NO_RETRY' }); }
  let outcome = { status: 'skipped', code: 'BOT_OLD_MESSAGE_IGNORED' }, acknowledgement = null, reportId = null;
  if (!event.stale) {
    try {
      if (event.action === 'callback') {
        acknowledgement = await telegramCall(token, 'answerCallbackQuery',
          { callback_query_id: event.queryId, text: '正在读取已核验报告…', cache_time: 0 }, fetchImpl);
        outcome = acknowledgement;
      }
      if (event.action !== 'callback' || outcome.status === 'accepted') {
        let bundle = null, daily = null, research = null;
        try { if (typeof loadBundle === 'function') bundle = await loadBundle(env, { now: currentTime() }); } catch { /* clear unavailable panel */ }
        try { if (typeof loadObservationReceipt === 'function') daily = await loadObservationReceipt(env, { now: currentTime() }); } catch { /* independent unavailable receipt */ }
        try { if (typeof loadResearch === 'function') research = await loadResearch(env, { now: currentTime() }); } catch { /* optional research ledger */ }
        const context = await prepareTelegramBotContext({ bundle, assets, daily, research, now: currentTime() });
        reportId = context.live?.reportId || null;
        const presentation = formatTelegramBotPanel({ context, section: event.section, page: event.page, now: currentTime() });
        outcome = await telegramCall(token, event.action === 'callback' ? 'editMessageText' : 'sendMessage',
          { chat_id: event.chatId, ...(event.action === 'callback' ? { message_id: event.messageId } : {}), ...presentation }, fetchImpl,
          { chatId: event.chatId, ...(event.action === 'callback' ? { messageId: event.messageId } : {}) });
      }
    } catch { outcome = { status: 'unknown', code: 'BOT_PROCESSING_UNCERTAIN_NO_RETRY' }; }
  }
  const completed = { ...row, state: 'complete', reportId, acknowledgement, outcome,
    completedAt: new Date(currentTime()).toISOString() };
  try {
    const persisted = await env.BUCKET.put(key, JSON.stringify(completed),
      { onlyIf: { etagMatches: claim.etag }, httpMetadata: { contentType: 'application/json' } });
    if (!persisted || typeof persisted.etag !== 'string') throw Error('CLAIM_CONFLICT');
  } catch { return json({ ok: true, status: 'unknown', code: 'BOT_OUTCOME_NOT_PERSISTED_NO_RETRY' }); }
  let statusRecordVerified = true;
  try { await saveLastStatus(env.BUCKET, completed); } catch { statusRecordVerified = false; }
  return json({ ok: true, status: outcome.status, code: outcome.code, reportId,
    ...(outcome.messageId ? { messageId: outcome.messageId } : {}), statusRecordVerified, meaning: 'bot-panel-query-not-formal-forecast-publication' });
  };
  handle.readStatus = (env, options) => readBotStatus(env, options, verifiedTargetFingerprint);
  return handle;
}

// Production target cannot be overridden by env, callback data or request fields.
export const handleTelegramWebhook = createTelegramBotHandler();
export const readTelegramBotStatus = handleTelegramWebhook.readStatus;
