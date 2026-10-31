import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { atomicJson, acquireLock, readJson } from './storage.mjs';
import { beginPublication, finishGeneration } from './publication.mjs';
import { predictionDocument, renderPredictionsMarkdown, renderPredictionsHtml } from './forecast-report.mjs';
import { createReplayBundle, prepareReplayInputs } from './data/run-manifest.mjs';
import { dataHash } from './data/identity.mjs';
import { appendReportPredictions } from './prediction-ledger.mjs';
import { PUBLIC_FIXTURE_SOURCES } from './sources/public-fixtures.mjs';

const statuses = { pending: '待续查', candidate: '候选，待人工复核', simulated_candidate: '模拟候选', avoid: '回避', source_insufficient: '来源不足' };
async function immutableReplayFile(path, value) {
  try {
    const previous = await readJson(path);
    if (dataHash(previous) !== dataHash(value)) throw new Error('IMMUTABLE_REPLAY_CONFLICT');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicJson(path, value);
  }
}
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
  robots_denied: '站点 robots 规则不允许采集', robots_unavailable: '站点 robots 规则暂无法确认',
  access_challenge: '站点返回访问验证页面', crawler_cooldown: '来源正在冷却', redirect_blocked: '来源发生重定向，待复核',
  crawler_budget_exhausted: '爬虫请求或时间预算已用完', crawler_cancelled: '爬虫已取消',
  crawler_timeout: '爬虫请求超时', crawler_network_unavailable: '爬虫网络请求失败',
  crawler_response_too_large: '爬虫响应大小超限', cache_validation_failed: '缓存复验未通过',
  crawl_delay_exceeds_budget: '站点要求的访问间隔超过本次等待预算',
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
    + `📊 赛前预测 ${s.forecasts || 0} 场；暂不可预测 ${s.forecastUnavailable ?? s.total} 场。[查看逐场概率](predictions.md) · [打开预测页面](predictions.html)。  \n`
    + `🎯 严格盘口候选 ${s.candidates} 场${report.simulated ? `；模拟候选 ${s.simulatedCandidates} 场` : ''}；盘口回避 ${s.avoid} 场；盘口来源不足 ${s.sourceInsufficient} 场。\n\n`
    + `🛡️ ${report.poolComplete ? '覆盖统计针对本轮实际取得的输入池。' : '赛程来源不完整，站点或全球赛事总覆盖率未知。'} 报价在报告生成时重新核验，候选不等于可直接执行的推荐。\n\n`
    + (report.limitations.map(item => `- ${item}`).join('\n')) + '\n'
    + (report.publicFixtureSources?.length ? '\n公开赛程归属（社区 / 免费档，覆盖不完整）：\n\n'
      + report.publicFixtureSources.map(source => `- [${source.name}](${source.url})；[${source.license}](${source.licenseUrl})。`).join('\n') + '\n' : '');
}
export function renderMessage(report) {
  const lines = [renderBrief(report), renderPredictionsMarkdown(report), '# 📨逐场盘口筛选', '', '| 比赛 | 开赛时间（北京时间） | 状态 | 原因 | 盘口采集诊断 |', '| --- | --- | --- | --- | --- |'];
  for (const row of report.results) lines.push(`| ${cell(row.fixture.home)} vs ${cell(row.fixture.away)} | ${beijingTime(row.fixture.kickoff)} | ${statuses[row.result.status] || '未知'} | ${row.result.reasons.map(code => reasons[code] || cell(code)).join('；')} | ${marketDetail(row.marketDiagnostics)} |`);
  lines.push('', '## 🔗来源诊断', '', '| 来源 | 状态 | 诊断码 | 解析盘口数 / 匹配数 | 赛程快照覆盖（北京时间） |', '| --- | --- | --- | --- | --- |');
  for (const source of report.diagnostics) lines.push(`| ${cell(source.id)}${source.league ? ` / ${cell(source.league)}` : ''} | ${cell(source.status)} | ${cell(source.code)}${source.httpStatus ? ` (HTTP ${source.httpStatus})` : ''} | ${source.parsedCount ?? '未知'} / ${source.matchedCount ?? 0} | ${source.scheduleCoverageFrom && source.scheduleCoverageTo ? `${beijingTime(source.scheduleCoverageFrom)} → ${beijingTime(source.scheduleCoverageTo)}` : '未提供'} |`);
  if (report.sourceManagement) {
    const m = report.sourceManagement;
    lines.push('', '## 信息源自动维护', '',
      `本轮赛程源：${cell(m.selectedSource || '不可用')}；模式：${cell(m.mode)}；备用切换：${m.fallbackUsed ? '是' : '否'}。`, '',
      '| 本轮尝试 | 状态 | 原因 | 完整联赛数 | 下次允许探测（北京时间） |', '| --- | --- | --- | --- | --- |');
    for (const attempt of m.attempts) lines.push(`| ${cell(attempt.id)} | ${cell(attempt.status)} | ${cell(attempt.code)} | ${attempt.healthyLeagues ?? '未请求'} | ${attempt.nextProbeAt ? beijingTime(attempt.nextProbeAt) : '下轮可查'} |`);
    lines.push('', '冷却到期后由下一轮采集复查；健康历史不是当前数据可用证明。', '',
      '| 公开证据源 | 本轮状态 | 能力 | 自动备用 |', '| --- | --- | --- | --- |');
    for (const source of m.publicSources || []) lines.push(`| ${cell(source.id)} | ${cell(source.status)} | ${cell(source.capability)} | 尚无已验证的同类备用源 |`);
  }
  if (report.crawler) {
    lines.push('', '## 网页爬虫采集', '',
      `本轮网络请求 ${report.crawler.networkRequests}/${report.crawler.maxRequests} 次（含 robots 与重试）；缓存命中与 HTTP 成功不等于有效预测。`, '',
      `HTML 页面引擎：${cell(report.crawler.runtime?.engine || 'http')}；浏览器子请求：${report.crawler.runtime?.browserRequests || 0}；环境说明：${cell(report.crawler.runtime?.reason || '已探测')}。`, '',
      '| 来源 | 请求结果 | 缓存 | HTTP |', '| --- | --- | --- | --- |');
    for (const event of report.crawler.events) lines.push(`| ${cell(event.sourceId)} | ${cell(marketReasons[event.code] || event.code)} | ${cell(event.cache || '未使用')} | ${event.httpStatus ?? '未取得'} |`);
    for (const issue of report.crawler.parserIssues || []) lines.push(`- ${cell(issue.sourceId)}：${cell(issue.code)}，当前格式或页面日期未通过核验。`);
  }
  if (report.providers) {
    lines.push('', '## 商业数据来源', '',
      '模型概率与市场隐含概率分别展示。报价参考尚未通过上游独立性和初盘时间核验，不增加正式候选票。', '',
      '| 来源 | 本轮状态 | 请求数 | 下次探测 |', '| --- | --- | --- | --- |');
    for (const row of report.providers.attempts) lines.push(`| ${cell(row.id)} | ${cell(row.status)} | ${row.requests} | ${row.nextProbeAt ? beijingTime(row.nextProbeAt) : '—'} |`);
    lines.push('', '| 比赛 | 来源 / 公司 | 市场 | 概率或报价 | 时效 |', '| --- | --- | --- | --- | --- |');
    const fixtures = new Map(report.results.map(row => [row.fixture.id, row.fixture]));
    for (const row of report.providers.observations) {
      const fixture = fixtures.get(row.fixtureId);
      const values = row.kind === 'model-probability'
        ? Object.entries(row.probabilities).map(([key, value]) => `${key} ${(value * 100).toFixed(2)}%`).join(' / ')
        : row.outcomes.map(value => `${value.selection}${value.line !== undefined ? ` ${value.line}` : ''} @ ${value.decimalOdds}`).join(' / ');
      lines.push(`| ${cell(fixture ? `${fixture.home} vs ${fixture.away}` : row.fixtureId)} | ${cell(row.provider)}${row.bookmaker ? ` / ${cell(row.bookmaker)}` : ''} | ${cell(row.market)} | ${cell(values)} | ${row.currentAtPublication ? '发布时有效' : '已过期'}；${row.sourceUpdatedAt ? beijingTime(row.sourceUpdatedAt) : '模型生成时间未提供；每日赛前模型'} |`);
    }
    if (!report.providers.observations.length) lines.push('| — | — | — | 本轮没有取得可匹配的新数据；查看配置及来源诊断 | — |');
    lines.push('', 'iSports 当前仅匹配 UTC 当日未开赛比赛；每轮报告保留采集快照，不能据此宣称拥有完整逐笔赔率历史。');
  }
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

export async function writeReports(report, directory, { history = [], codeVersion = null, clock = () => new Date().toISOString(),
  appendPredictions = appendReportPredictions } = {}) {
  await mkdir(directory, { recursive: true });
  const release = await acquireLock(resolve(directory, 'publication.json'));
  let receipt;
  try {
  const inputs = prepareReplayInputs({ fixtures: report.results.map(row => row.fixture), history, policy: report.policy, model: report.forecasts.model });
  report.inputHash = dataHash(inputs);
  receipt = await beginPublication(report, directory);
  const replay = createReplayBundle({ reportId: receipt.reportId, ...inputs, generatedAt: report.completedAt, cutoff: report.startedAt,
    codeVersion, simulated: report.simulated });
  report.replay = { manifest: 'run-manifest.json', inputs: 'run-inputs.json', archive: `replays/${receipt.reportId}`,
    inputHash: replay.manifest.inputsHash, status: replay.manifest.replayStatus };
  await immutableReplayFile(resolve(directory, 'replays', receipt.reportId, 'run-inputs.json'), replay.inputs);
  await immutableReplayFile(resolve(directory, 'replays', receipt.reportId, 'run-manifest.json'), replay.manifest);
  await atomicJson(resolve(directory, 'run-manifest.json'), replay.manifest);
  await atomicJson(resolve(directory, 'run-inputs.json'), replay.inputs);
  const publicFixtures = inputs.fixtures.filter(row => row.source === 'openligadb'), publicHistory = inputs.history.filter(row => row.source === 'openligadb');
  await atomicJson(resolve(directory, 'openligadb-fixtures.json'), { reportId: receipt.reportId, attribution: PUBLIC_FIXTURE_SOURCES[0],
    checkedAt: report.startedAt, usedInReport: !!(publicFixtures.length || publicHistory.length), fixtures: publicFixtures, history: publicHistory });
  // The immutable ledger is written after the report ID is fixed and before any
  // external publication can observe files marked ready.
  report.predictionLedger = await appendPredictions({ directory: resolve(directory, 'forecast-ledger'), report: predictionDocument(report), nowISO: clock() });
  const name = `collection-${report.completedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`;
  const brief = renderBrief(report), message = renderMessage(report);
  const jsonPath = resolve(directory, `${name}.json`);
  await atomicJson(jsonPath, report);
  await writeFile(resolve(directory, `${name}-brief.md`), brief, 'utf8');
  await writeFile(resolve(directory, `${name}-message.md`), message, 'utf8');
  await atomicJson(resolve(directory, 'latest.json'), report);
  await writeFile(resolve(directory, 'latest-brief.md'), brief, 'utf8');
  await writeFile(resolve(directory, 'latest-message.md'), message, 'utf8');
  await atomicJson(resolve(directory, 'predictions.json'), predictionDocument(report));
  await writeFile(resolve(directory, 'predictions.md'), renderPredictionsMarkdown(report), 'utf8');
  await writeFile(resolve(directory, 'predictions.html'), renderPredictionsHtml(report), 'utf8');
  await finishGeneration(directory, receipt, [`${name}.json`, `${name}-brief.md`, `${name}-message.md`,
    'latest.json', 'latest-brief.md', 'latest-message.md', 'predictions.json', 'predictions.md', 'predictions.html',
    'run-manifest.json', 'run-inputs.json', 'openligadb-fixtures.json']);
  return { jsonPath, briefPath: resolve(directory, 'latest-brief.md'), messagePath: resolve(directory, 'latest-message.md'),
    predictionsPath: resolve(directory, 'predictions.json'), predictionsHtmlPath: resolve(directory, 'predictions.html'),
    publicationPath: resolve(directory, 'publication.json'), runManifestPath: resolve(directory, 'run-manifest.json'), runInputsPath: resolve(directory, 'run-inputs.json') };
  } catch (error) {
    if (receipt) await finishGeneration(directory, receipt, [], true);
    throw error;
  } finally { await release(); }
}
