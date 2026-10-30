import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson } from './storage.mjs';

const statuses = { pending: '待续查', candidate: '候选，待人工复核', simulated_candidate: '模拟候选', avoid: '回避', source_insufficient: '来源不足' };
const reasons = {
  NOT_PREMATCH: '非未开赛赛事', OUTSIDE_WINDOW: '超出本轮日期窗口', FIXTURE_FRESHNESS_UNVERIFIED: '赛程时效未核验',
  NO_FRESH_COMPLETE_ASIAN_MARKET: '无有效的完整双方亚洲盘', PRICE_OR_HANDICAP_OUTSIDE_POLICY: '价格或让受球超出规则',
  SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING: '缺第二独立实时亚洲盘来源', FORECAST_CONFLICT: '预测存在反向意见',
  INDEPENDENT_FORECAST_MISSING: '缺独立预测辅助', OPENING_TRAJECTORY_MISSING_OR_CHANGED: '缺初盘轨迹或盘口/价格变化超限',
  EVIDENCE_GATE_PASSED_REQUIRES_REVIEW: '证据门槛通过，仍须人工复核', BUDGET_EXHAUSTED: '处理预算已用完，下轮续查',
};
const marketReasons = {
  fixture_ineligible: '不在该源的采集范围', fixture_identity_unmatched: '赛程身份未匹配（球队、联赛或时间）',
  fixture_identity_ambiguous: '赛程匹配不唯一', not_prematch: '该源赛事不是未开赛状态',
  market_not_published: '已匹配比赛，源中暂无盘口', market_ambiguous: '同场盘口记录不唯一',
  invalid_market_fields: '盘口字段不合法', incomplete_market: '缺完整双方盘口或价格', quote_expired: '配对报价时效未通过', quote_validation_failed: '配对报价最终核验未通过',
  matched: '完整双方盘口已匹配', stale_snapshot: '源快照时间缺失、过期或超前', invalid_schedule: '赛程快照格式无法核验',
  invalid_snapshot: '盘口快照格式无法核验', access_denied: '源返回403', authorization_required: '源要求授权',
  rate_limited: '源限流', http_unavailable: '源HTTP请求失败', empty_snapshot: '源快照为空', snapshot_too_large: '源快照超限',
  timeout: '请求超时', network_unavailable: '网络未接通', maintenance: '源维护中',
};
function marketDetail(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const code = row.code || row.note, companies = groups.get(code) || [];
    companies.push(row.bookmaker); groups.set(code, companies);
  }
  return [...groups].map(([code, companies]) => `${[...new Set(companies)].map(cell).join('/')}：${marketReasons[code] || cell(code)}`).join('；') || '本轮未留存逐场诊断';
}
const cell = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/[|<>]/g, ' ').replace(/([\\`*_\[\]])/g, '\\$1');
export function beijingTime(value) {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}
export function renderBrief(report) {
  const s = report.summary;
  return `# ⚡维度足球采集精简版${report.simulated ? '【模拟数据，仅用于验证】' : ''}\n\n`
    + `📅 赛程拉取日期：${beijingTime(report.startedAt).slice(0, 10)}（北京时间）  \n`
    + `🔄 本轮：${beijingTime(report.startedAt)} → ${beijingTime(report.completedAt)}  \n`
    + `📋 输入池 ${s.total} 场，基础筛选 ${s.basicScreened} 场，深入核验 ${s.processed} 场，复用 ${s.reused} 场，待续查 ${s.pending} 场。  \n`
    + `🎯 生产候选 ${s.candidates} 场${report.simulated ? `；模拟候选 ${s.simulatedCandidates} 场` : ''}；回避 ${s.avoid} 场；来源不足 ${s.sourceInsufficient} 场。\n\n`
    + `🛡️ ${report.poolComplete ? '覆盖统计针对本轮实际取得的输入池。' : '赛程来源不完整，站点或全球赛事总覆盖率未知。'} 报价在报告生成时重新核验，候选不等于可直接执行的推荐。\n\n`
    + (report.limitations.map(item => `- ${item}`).join('\n')) + '\n';
}
export function renderMessage(report) {
  const lines = [renderBrief(report), '# 📨逐场消息版', '', '| 比赛 | 开赛时间（北京时间） | 状态 | 原因 | 盘口采集诊断 |', '| --- | --- | --- | --- | --- |'];
  for (const row of report.results) lines.push(`| ${cell(row.fixture.home)} vs ${cell(row.fixture.away)} | ${beijingTime(row.fixture.kickoff)} | ${statuses[row.result.status] || '未知'} | ${row.result.reasons.map(code => reasons[code] || cell(code)).join('；')} | ${marketDetail(row.marketDiagnostics)} |`);
  lines.push('', '## 🔗来源诊断', '', '| 来源 | 状态 | 诊断码 | 解析盘口数 / 匹配数 | 赛程快照覆盖（北京时间） |', '| --- | --- | --- | --- | --- |');
  for (const source of report.diagnostics) lines.push(`| ${cell(source.id)}${source.league ? ` / ${cell(source.league)}` : ''} | ${cell(source.status)} | ${cell(source.code)}${source.httpStatus ? ` (HTTP ${source.httpStatus})` : ''} | ${source.parsedCount ?? '未知'} / ${source.matchedCount ?? 0} | ${source.scheduleCoverageFrom && source.scheduleCoverageTo ? `${beijingTime(source.scheduleCoverageFrom)} → ${beijingTime(source.scheduleCoverageTo)}` : '未提供'} |`);
  lines.push('', '## 🎯候选证据', '');
  const candidates = report.results.filter(row => ['candidate', 'simulated_candidate'].includes(row.result.status));
  if (!candidates.length) lines.push('本轮没有通过完整证据门槛的候选。');
  for (const row of candidates) {
    const c = row.result.candidate;
    lines.push(`### ${cell(row.fixture.home)} vs ${cell(row.fixture.away)}${report.simulated ? '（模拟）' : ''}`, '',
      `🎯 ${c.selection === 'home' ? '主队' : '客队'} ${c.handicap > 0 ? '+' : ''}${c.handicap}，十进制赔率 ${c.decimalOdds}。需人工复核。`,
      `📈 初盘 ${c.opening.handicap} @ ${c.opening.decimalOdds}；独立报价组 ${c.quoteGroups.length} 个。`,
      '⚖️ 大小球：未取得足够证据；🔢 比分：未生成；亚洲盘赢盘概率：未知。', '');
    for (const quote of c.quotes) lines.push(`- ${cell(quote.sourceId)} / ${cell(quote.bookmaker)}：${quote.decimalOdds}；来源更新时间 ${beijingTime(quote.sourceUpdatedAt)}；[原始证据](${quote.evidenceUrl.replace(/[()]/g, c => encodeURIComponent(c))})`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function writeReports(report, directory) {
  await mkdir(directory, { recursive: true });
  const name = `collection-${report.completedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const brief = renderBrief(report), message = renderMessage(report);
  const jsonPath = resolve(directory, `${name}.json`);
  await atomicJson(jsonPath, report);
  await writeFile(resolve(directory, `${name}-brief.md`), brief, 'utf8');
  await writeFile(resolve(directory, `${name}-message.md`), message, 'utf8');
  await atomicJson(resolve(directory, 'latest.json'), report);
  await writeFile(resolve(directory, 'latest-brief.md'), brief, 'utf8');
  await writeFile(resolve(directory, 'latest-message.md'), message, 'utf8');
  return { jsonPath, briefPath: resolve(directory, 'latest-brief.md'), messagePath: resolve(directory, 'latest-message.md') };
}
