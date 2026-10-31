import { leagueName, reasonText, teamName } from './locale-zh.mjs';
import { validateReceipt, validateReport } from './report-schema.mjs';

export const TELEGRAM_SITE_ORIGIN = 'https://dimension-football-live-wangxtong.secretmelon37.chatgpt.site';
export const TELEGRAM_TEXT_LIMIT = 4096; // Telegram entity offsets and limits use UTF-16 code units.
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const label = value => {
  const points = Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' '));
  return escapeHTML(points.slice(0, 72).join('') + (points.length > 72 ? '…' : ''));
};
export function beijingTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '时间待核验';
  return new Date(ms + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + '（北京时间）';
}
const upcoming = (row, now) => ['SCHEDULED','TIMED'].includes(row.fixture.status) && Date.parse(row.fixture.kickoff) > now;
const available = (row, now) => upcoming(row, now) && row.forecast.status === 'forecast' && Date.parse(row.forecast.freshness?.validUntil) > now;
const missingReason = (row, now) => !upcoming(row,now) ? 'NOT_PREMATCH'
  : row.forecast.status === 'forecast' ? 'FORECAST_EXPIRED' : row.forecast.reasons[0];
function reasons(rows, getCodes) {
  const counts = new Map();
  for (const row of rows) for (const code of new Set(getCodes(row))) counts.set(code, (counts.get(code) || 0) + 1);
  return [...counts].sort((a,b) => b[1]-a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0,3)
    .map(([code,count]) => `  · ${label(reasonText(code))}：${count} 场`);
}
function origin(value) {
  const url = new URL(value);
  if (url.origin !== TELEGRAM_SITE_ORIGIN || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw Error('TELEGRAM_PRESENTATION_ORIGIN_INVALID');
  return url.origin;
}
function message(blocks, footer) {
  const lines=[],more='其余数据缺项请打开原网站查看。';
  for (const block of blocks) {
    if ([...lines,block,footer].join('\n').length > TELEGRAM_TEXT_LIMIT-more.length-1) {
      lines.push(more);break;
    }
    lines.push(block);
  }
  const text=[...lines,footer].join('\n');
  if (text.length > TELEGRAM_TEXT_LIMIT) throw Error('TELEGRAM_PRESENTATION_TOO_LONG');
  return text;
}

/** Display only. This module neither authorizes a release nor sends a message.
 * The current release is BLOCKED even if input files claim GREEN. Future release
 * enablement requires a separate review of the production authority and copy. */
export function formatTelegramPublication({report,receipt,siteURL=TELEGRAM_SITE_ORIGIN,now=Date.now()}={}) {
  validateReport(report);
  if (receipt !== undefined && receipt !== null) validateReceipt(receipt,report);
  if (!Number.isFinite(now)) throw Error('TELEGRAM_PRESENTATION_TIME_INVALID');
  const site=origin(siteURL),current=report.fixtures.filter(row=>available(row,now));
  const unavailable=report.fixtures.filter(row=>!available(row,now));
  const strict=report.fixtures.filter(row=>upcoming(row,now)&&row.marketCandidate.status==='candidate'
    && row.marketCandidate.candidate.quotes.every(quote=>Date.parse(quote.validUntil)>now));
  const missingMarkets=report.fixtures.filter(row=>row.marketCandidate.status!=='candidate');
  const leagueCounts=new Map();
  for(const row of report.fixtures)leagueCounts.set(row.fixture.league,(leagueCounts.get(row.fixture.league)||0)+1);
  const coverage=[...leagueCounts].slice(0,5).map(([league,count])=>`${label(leagueName(league))} ${count} 场`).join(' · ')
    +(leagueCounts.size>5?` · 另 ${leagueCounts.size-5} 个联赛`:'');
  const web=receipt?.channels.externalWebsite;
  const served=web?.status==='published'&&web.servedVerified===true&&web.reportId===report.publication.reportId;
  const blocks=[
    '⚽ <b>维度足球 · 数据状态摘要</b>',
    '🔒 <b>发布门禁：暂不放行</b>',
    '正式推荐未发布；以下仅说明数据准备情况。',
    `🕒 ${beijingTime(report.generatedAt)}`,
    '',
    `📥 <b>赛程覆盖</b>｜${report.fixtures.length} 场 · ${leagueCounts.size} 个联赛`,
    coverage || '本轮暂无可用赛程。',
    '',
    `📊 <b>普通分析</b>｜可评估 ${current.length} 场 · 暂不可评估 ${unavailable.length} 场`,
    current.length?'未校准统计基线尚未获准发布，不展示概率或投注方向。':'暂无可评估的普通预测，等待有效数据。',
    `🎯 <b>严格条件</b>｜${strict.length} 场满足报告内条件，均未获准发布`,
    '',
    `🧩 <b>数据缺项</b>｜普通分析 ${unavailable.length} 场待补`,
    ...reasons(unavailable,row=>[missingReason(row,now)]),
    ...unavailable.slice(0,3).map(row=>`  · ${label(teamName(row.fixture.home))} 对阵 ${label(teamName(row.fixture.away))}\n    ${label(reasonText(missingReason(row,now)))}`),
    `盘口证据待补 ${missingMarkets.length} 场（原因可重复计数）`,
    ...reasons(missingMarkets,row=>row.marketCandidate.reasons?.length?row.marketCandidate.reasons:row.marketCandidate.readiness?.blockers||[]),
    '',
    `📡 <b>网站交付</b>｜${served?'该报告已完成同报告回读核验':'该报告尚未完成同报告回读核验'}`,
    `🧾 报告 <code>${report.publication.reportId.slice(0,12)}</code>`,
  ];
  const footer=`\n⚠️ 本摘要不生成正式推荐。\n<a href="${site}/?view=status#status">打开原网站 · 查看发布状态</a>`;
  return {text:message(blocks,footer),parse_mode:'HTML',link_preview_options:{is_disabled:true},
    reply_markup:{inline_keyboard:[
      [{text:'🗓 实时联赛赛程',url:site+'/?view=schedule#schedule'}],
      [{text:'📊 普通胜平负',url:site+'/?view=analysis#analysis'},{text:'🎯 严格候选',url:site+'/?view=strict#strict'}],
      [{text:'🧩 数据缺失',url:site+'/?view=missing#missing'},{text:'🛡 发布状态',url:site+'/?view=status#status'}],
    ]}};
}
