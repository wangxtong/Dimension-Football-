import { createHash } from 'node:crypto';

const labels = { home: '主胜', draw: '平局', away: '客胜' };
const reasons = {
  TEAM_ID_REQUIRED: '缺少可核对的球队 ID', HISTORY_UNAVAILABLE: '缺少同源同联赛完赛历史',
  LEAGUE_HISTORY_INSUFFICIENT: '联赛历史不足 40 场', HOME_HISTORY_INSUFFICIENT: '主队历史不足 6 场',
  AWAY_HISTORY_INSUFFICIENT: '客队历史不足 6 场', VENUE_HISTORY_INSUFFICIENT: '对应主客场样本不足 2 场',
  TEAM_HISTORY_STALE: '球队最近完赛记录超过 120 天', LEAGUE_GOALS_INSUFFICIENT: '联赛进球样本不足',
  NOT_PREMATCH: '已经开赛或非赛前状态', OUTSIDE_WINDOW: '超出预测日期窗口',
  FIXTURE_FRESHNESS_UNVERIFIED: '赛程时效无法核验', BUDGET_EXHAUSTED: '本轮预算已用尽', SIMULATION_ONLY: '模拟运行不发布真实预测',
  BACKTEST_INSUFFICIENT: '滚动回测不足 30 场或尚未完成', FORECAST_EXPIRED: '预测已超过 60 分钟有效期',
  NO_FRESH_COMPLETE_ASIAN_MARKET: '缺少有效的完整双方亚洲盘', SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING: '缺第二独立实时亚洲盘来源',
  TRUE_OPENING_RECORD_MISSING: '缺带来源、真实开盘时间和留档时间的初盘记录',
};
const percent = value => `${(value * 100).toFixed(1)}%`;
const markdown = value => String(value ?? '').replace(/[|\r\n]/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const why = row => (row.reasons || []).map(reason => reasons[reason] || reason).join('；');

// Per-match evaluation vectors remain in the complete collection report. The
// website needs aggregate metrics for each lead time, not copies of its history.
const aggregateEvaluation = ({ evaluations, exclusions, ...summary }) => summary;
function evaluationDetails(report, jsonPointer, value) {
  return { availability: 'collector-output',
    file: `collection-${report.completedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`,
    reportId: report.publication?.reportId || null, jsonPointer,
    sha256: createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'),
    hashEncoding: 'JSON.stringify/UTF-8' };
}

export function predictionDocument(report) {
  const backtests = report.forecasts?.backtests || [], prospective = report.prospectiveEvaluation;
  return { version: 1, kind: 'prematch-forecast-report', generatedAt: report.completedAt, simulated: report.simulated,
    model: report.forecasts?.model || null, summary: { fixtures: report.summary.total, forecasts: report.summary.forecasts || 0,
      unavailable: report.summary.forecastUnavailable ?? report.summary.total, strictCandidates: report.summary.candidates },
    history: report.forecasts?.history || null, backtests: backtests.map(aggregateEvaluation),
    backtestDetails: backtests.length ? evaluationDetails(report, '/forecasts/backtests', backtests) : null,
    coverage: report.coverage || [], diagnostics: report.diagnostics || [], replay: report.replay || null,
    predictionLedger: report.predictionLedger || null,
    prospectiveEvaluation: prospective ? { ...prospective, groups: (prospective.groups || []).map(aggregateEvaluation),
      details: evaluationDetails(report, '/prospectiveEvaluation', prospective) } : null,
    attribution: report.publicFixtureSources || [], publication: report.publication || { target: 'repository-report-files', externalDelivery: 'not_configured' },
    categories: { analysis: report.results.filter(r => r.forecast?.status === 'forecast').map(r => r.fixture.id),
      strictCandidates: report.results.filter(r => r.result.status === 'candidate' && !report.simulated).map(r => r.fixture.id),
      unassessable: report.results.filter(r => r.forecast?.status !== 'forecast').map(r => r.fixture.id) },
    categoryMeaning: 'analysis/unassessable partition the pool; strictCandidates is a separate independently gated market view',
    fixtures: report.results.map(row => ({ fixture: row.fixture,
      forecast: row.forecast || { status: 'unavailable', reasons: ['HISTORY_UNAVAILABLE'] },
      marketCandidate: { status: row.result.status, reasons: row.result.reasons, candidate: row.result.candidate || null,
        readiness: row.marketReadiness || null } })) };
}

const quality = f => f.completeness ? `基础数据检查 ${f.completeness.passed}/${f.completeness.total}；伤停、首发、赔率未纳入；全球覆盖未知` : '完整度未核验';
const strength = f => f.strength ? `主队进攻 ${f.strength.homeAttack.toFixed(2)} / 防守失球 ${f.strength.homeDefenceConceding.toFixed(2)}；客队进攻 ${f.strength.awayAttack.toFixed(2)} / 防守失球 ${f.strength.awayDefenceConceding.toFixed(2)}（联赛均值为 1；防守失球越低越好）` : '历史样本不足';
const validity = f => f.freshness ? `采集 ${f.freshness.fixtureFetchedAt || '未知'}；预测有效至 ${f.freshness.validUntil}；供应商赛程更新时间 ${f.freshness.fixtureSourceUpdatedAt || '未知'}` : '时效未核验';
const horizon = value => Number.isFinite(value) ? `${value.toFixed(2)} 小时` : '未记录';
const visibility = value => value === 'as-observed' ? '按已观测版本回放' : value === 'prospective-ledger' ? '赛前冻结预测核账' : '当前修订快照回顾';
const settlementScope = value => value?.scope === 'private-research-freezes'
  ? '这是私有研究冻结记录，不是已发布预测成绩；正式发布仍受独立门禁约束。'
  : '冻结与评分记录本身不能证明预测已公开发布；实际送达须另核验对应发布回执。';
const sampleQuality = f => f.sampleQuality ? `有效加权样本（主 / 客）${(f.sampleQuality.weighted?.home?.effectiveMatches || 0).toFixed(1)} / ${(f.sampleQuality.weighted?.away?.effectiveMatches || 0).toFixed(1)}；本季样本 ${f.sampleQuality.currentSeason ? `${f.sampleQuality.currentSeason.home} / ${f.sampleQuality.currentSeason.away}` : '未知'}；冷启动 ${f.sampleQuality.coldStart?.status || '未知'}` : '有效加权样本未记录';
const backtestGroups = rows => [...rows].sort((a, b) => `${a.source}:${a.league}`.localeCompare(`${b.source}:${b.league}`)
  || (a.horizonHours ?? 0) - (b.horizonHours ?? 0) || String(a.visibility).localeCompare(String(b.visibility)));

export function renderPredictionsMarkdown(report) {
  const doc = predictionDocument(report);
  const lines = [`# 赛前预测${doc.simulated ? '【模拟，非正式输出】' : ''}`, '',
    `生成时间：${doc.generatedAt}。已有预测 **${doc.summary.forecasts} 场**；暂不可预测 **${doc.summary.unavailable} 场**；严格盘口候选 **${doc.summary.strictCandidates} 场**。`, '',
    '胜平负概率来自历史比分统计基线，未做概率校准。缺少盘口不阻止基础预测；盘口候选仍单独通过原有严格证据门槛。', '',
    '| 比赛 | 开赛（北京时间） | 主胜 | 平局 | 客胜 | 倾向 | 预期进球（主 / 客） | 双方历史样本 |',
    '| --- | --- | ---: | ---: | ---: | --- | --- | --- |'];
  for (const { fixture, forecast: f } of doc.fixtures.filter(row => row.forecast.status === 'forecast')) {
    lines.push(`| ${markdown(fixture.home)} vs ${markdown(fixture.away)} | ${time(fixture.kickoff)} | ${percent(f.probabilities.home)} | ${percent(f.probabilities.draw)} | ${percent(f.probabilities.away)} | ${labels[f.selection] || '接近'} | ${f.expectedGoals.home.toFixed(2)} / ${f.expectedGoals.away.toFixed(2)} | ${f.sample.home} / ${f.sample.away} |`);
  }
  if (!doc.summary.forecasts) lines.push('| — | — | — | — | — | 本轮没有满足历史样本要求的预测 | — | — |');
  lines.push('', '## 预测依据、完整度与时效', '');
  for (const { fixture, forecast: f } of doc.fixtures.filter(r => r.forecast.status === 'forecast')) lines.push(
    `- **${markdown(fixture.home)} vs ${markdown(fixture.away)}**：${markdown(strength(f))}。${quality(f)}。${markdown(validity(f))}。提前量 ${horizon(f.horizonHours)}；${visibility(f.validation?.visibility)}；滚动回测 ${f.validation?.evaluated || 0} 场。${markdown(sampleQuality(f))}。`);
  lines.push('', '## 严格盘口候选', '', '此视图独立于普通预测；候选仍需人工复核。', '');
  const strict = doc.fixtures.filter(r => doc.categories.strictCandidates.includes(r.fixture.id));
  for (const { fixture, marketCandidate: { candidate: c } } of strict) lines.push(
    `- ${markdown(fixture.home)} vs ${markdown(fixture.away)}：${labels[c.selection]} ${c.handicap} @ ${c.decimalOdds}；独立来源 ${markdown(c.quoteGroups.join(' / '))}；真实初盘 ${c.opening.handicap} @ ${c.opening.decimalOdds}，开盘 ${c.opening.observedAt}，留档 ${c.opening.recordedAt}。`);
  if (!strict.length) lines.push('本轮无通过门槛的严格盘口候选。');
  lines.push('', '| 比赛 | 有效独立报价组 / 要求 | 真实初盘记录数 | 尚缺证据 |', '| --- | --- | --- | --- |');
  for (const { fixture, marketCandidate: m } of doc.fixtures) lines.push(`| ${markdown(fixture.home)} vs ${markdown(fixture.away)} | ${m.readiness?.quoteGroups.length || 0} / ${m.readiness?.requiredQuoteGroups || 2} | ${m.readiness?.verifiedOpeningCount || 0} | ${markdown(why({ reasons: m.readiness?.blockers || m.reasons })) || '检查完整筛选结果'} |`);
  lines.push('', '## 暂不可评估', '', '| 比赛 | 缺项或状态 |', '| --- | --- |');
  for (const { fixture, forecast } of doc.fixtures.filter(row => row.forecast.status !== 'forecast')) {
    lines.push(`| ${markdown(fixture.home)} vs ${markdown(fixture.away)} | ${markdown(why(forecast))} |`);
  }
  if (!doc.summary.unavailable) lines.push('| — | 本轮输入池均已生成基础预测 |');
  lines.push('', '## 按时间滚动回测', '', '每场预测只使用更早至少 4 小时的完赛记录。Brier / Log loss 越低越好，基准为当时历史赛果频率。', '',
    '| 联赛 / 来源 | 提前量 / 可见性 | 回测场数 | 模型 Brier | 基准 Brier | 模型 Log loss | 基准 Log loss | 历史方向命中率 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const b of backtestGroups(doc.backtests)) lines.push(`| ${markdown(b.league)} / ${markdown(b.source)} | ${horizon(b.horizonHours)} / ${visibility(b.visibility)} | ${b.evaluated}（跳过 ${b.skipped}）${b.interrupted ? '，未完成' : ''} | ${b.metrics?.brier?.toFixed(4) ?? '—'} | ${b.metrics?.baselineBrier?.toFixed(4) ?? '—'} | ${b.metrics?.logLoss?.toFixed(4) ?? '—'} | ${b.metrics?.baselineLogLoss?.toFixed(4) ?? '—'} | ${b.metrics ? percent(b.metrics.accuracy) : '—'} |`);
  if (!doc.backtests.length) lines.push('| — | — | 0 | — | — | — | — | — |');
  if (doc.coverage.length) {
    lines.push('', '## 联赛覆盖与历史来源', '', '| 联赛 / 来源 | 赛程状态 / 场数 | 历史状态 / 场数 | 来源诊断 |', '| --- | --- | --- | --- |');
    for (const row of doc.coverage) lines.push(`| ${markdown(row.league)} / ${markdown(row.source)} | ${markdown(row.fixtureStatus)} / ${row.fixtureCount} | ${markdown(row.historyStatus)} / ${row.historyCount} | ${markdown((row.diagnostics || []).map(d => d.code).join('；'))} |`);
  }
  if (doc.prospectiveEvaluation) {
    lines.push('', '## 赛前冻结预测核账', '', `更新时间：${doc.prospectiveEvaluation.generatedAt}；按来源、联赛和提前量分别统计。${settlementScope(doc.prospectiveEvaluation)}`, '', '| 来源 / 联赛 | 提前量 | 已评分 / 待结果 / 排除 | Brier |', '| --- | --- | --- | --- |');
    for (const group of doc.prospectiveEvaluation.groups || []) lines.push(`| ${markdown(group.source)} / ${markdown(group.league)} | ${horizon(group.horizonHours)} | ${group.coverage?.evaluated || 0} / ${group.coverage?.pending || 0} / ${group.coverage?.skipped || 0} | ${group.metrics?.brier?.toFixed(4) ?? '—'} |`);
  }
  lines.push('', '历史样本不足的比赛会跳过，指标仅针对可预测的比赛，不能代表全部赛程。回测使用当前取得的历史修订快照，不能还原当时数据可见性；最多 80 场，属于小样本回测，不能据此承诺未来命中率或投注收益。', '',
    '模型只使用同源球队 ID、主客场、历史全场进失球与时间衰减，未纳入伤停、阵容或赔率。JSON / HTML 同时提供比分分布参考、训练样本摘要和训练数据哈希。', '',
    '实际发布状态见同目录 publication.json；GitHub 最终回执见 publication-receipt 附件。文件生成、Summary 写入和报告附件上传分别记账，网站与 Telegram 的实际结果另行记入回执；Telegram 缺凭据时不发送。', '');
  for (const source of doc.attribution) lines.push(`- 数据归属：[${markdown(source.name)}](${source.url})；[${markdown(source.license)}](${source.licenseUrl})。`);
  return `${lines.join('\n')}\n`;
}

export function renderPredictionsHtml(report) {
  const doc = predictionDocument(report);
  const card = ({ fixture, forecast: f, marketCandidate }) => {
    const heading = `<div class="meta">${html(fixture.league)} · ${html(time(fixture.kickoff))} 北京时间</div><h2>${html(fixture.home)} <span>vs</span> ${html(fixture.away)}</h2>`;
    if (f.status !== 'forecast') return `<article class="card missing">${heading}<p class="tag">暂不可评估</p><p>${html(why(f))}</p><p>${html(quality(f))}</p><small>${html(validity(f))}</small></article>`;
    return `<article class="card">${heading}<p class="tag">基线预测 · ${html(labels[f.selection] || '接近')}</p>
      <div class="probabilities">${Object.entries(labels).map(([key, label]) => `<div><b>${percent(f.probabilities[key])}</b><span>${label}</span><meter min="0" max="1" value="${f.probabilities[key]}"></meter></div>`).join('')}</div>
      <p>预期进球：${f.expectedGoals.home.toFixed(2)} / ${f.expectedGoals.away.toFixed(2)} · 历史样本：${f.sample.home} / ${f.sample.away} 场</p>
      <p>比分参考：${f.topScores.map(score => `${score.home}:${score.away}（${percent(score.probability)}）`).join('、')}</p>
      <details><summary>依据、时效与数据完整度</summary><p>${html(strength(f))}</p><p>${html(quality(f))}</p><p>${html(validity(f))}</p>
      <p>提前量 ${html(horizon(f.horizonHours))}；${html(visibility(f.validation?.visibility))}。回测 ${f.validation?.evaluated || 0} 场；跳过 ${f.validation?.skipped || 0} 场。基础检查通过不等于数据全面或概率已校准。</p><p>${html(sampleQuality(f))}</p><small>训练截止 ${html(f.trainingCutoff)}</small></details></article>`;
  };
  const cards = doc.fixtures.filter(r => r.forecast.status === 'forecast').map(card).join('');
  const missing = doc.fixtures.filter(r => r.forecast.status !== 'forecast').map(card).join('');
  const strict = doc.fixtures.filter(r => doc.categories.strictCandidates.includes(r.fixture.id)).map(({ fixture, marketCandidate: { candidate: c } }) =>
    `<article class="card"><h2>${html(fixture.home)} vs ${html(fixture.away)}</h2><p>待人工复核：${html(labels[c.selection])} ${c.handicap} @ ${c.decimalOdds}</p>
    <p>独立来源：${html(c.quoteGroups.join(' / '))}</p><p>真实初盘 ${c.opening.handicap} @ ${c.opening.decimalOdds}<br>开盘 ${html(c.opening.observedAt)}<br>留档 ${html(c.opening.recordedAt)}</p></article>`).join('');
  const readiness = doc.fixtures.map(({ fixture, marketCandidate: m }) => `<tr><td>${html(fixture.home)} vs ${html(fixture.away)}</td><td>${m.readiness?.quoteGroups.length || 0} / ${m.readiness?.requiredQuoteGroups || 2}</td><td>${m.readiness?.verifiedOpeningCount || 0}</td><td>${html(why({ reasons: m.readiness?.blockers || m.reasons })) || '检查完整筛选结果'}</td></tr>`).join('');
  const backtests = backtestGroups(doc.backtests).map(b => `<tr><td>${html(b.league)} / ${html(b.source)}</td><td>${html(horizon(b.horizonHours))}<br>${html(visibility(b.visibility))}</td><td>${b.evaluated}（跳过 ${b.skipped}）${b.interrupted ? '，未完成' : ''}</td><td>${b.metrics?.brier?.toFixed(4) ?? '—'}</td><td>${b.metrics?.baselineBrier?.toFixed(4) ?? '—'}</td><td>${b.metrics?.logLoss?.toFixed(4) ?? '—'}</td><td>${b.metrics ? percent(b.metrics.accuracy) : '—'}</td></tr>`).join('');
  const coverage = doc.coverage.map(row => `<tr><td>${html(row.league)} / ${html(row.source)}</td><td>${html(row.fixtureStatus)} / ${row.fixtureCount}</td><td>${html(row.historyStatus)} / ${row.historyCount}</td><td>${html((row.diagnostics || []).map(d => d.code).join('；'))}</td></tr>`).join('');
  const prospective = (doc.prospectiveEvaluation?.groups || []).map(row => `<tr><td>${html(row.source)} / ${html(row.league)}</td><td>${html(horizon(row.horizonHours))}</td><td>${row.coverage?.evaluated || 0} / ${row.coverage?.pending || 0} / ${row.coverage?.skipped || 0}</td><td>${row.metrics?.brier?.toFixed(4) ?? '—'}</td></tr>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>维度足球 · 赛前预测</title>
<style>body{margin:0;background:#101826;color:#e7edf6;font:16px/1.6 system-ui,sans-serif}main{max-width:1150px;margin:auto;padding:36px 24px}h1{font-size:32px;margin:8px 0}h2{font-size:19px;margin:8px 0}h2 span,small,.meta{color:#aab8cb}.lead{max-width:850px}.stats{display:flex;gap:16px;flex-wrap:wrap;margin:28px 0}.stat{background:#1b283b;padding:18px 26px;border-radius:12px}.stat b{font-size:30px;color:#71ddbb;display:block}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,310px),1fr));gap:18px}.card{overflow-wrap:anywhere;padding:22px;background:#1b283b;border:1px solid #304157;border-radius:12px}.missing{background:#192332}.tag{color:#88dac2}.probabilities{display:flex;gap:15px;margin:18px 0}.probabilities div{flex:1;min-width:0}.probabilities b,.probabilities span{display:block}.probabilities b{font-size:25px}meter{width:100%;height:8px}p{margin:12px 0}table{width:100%;border-collapse:collapse;margin:16px 0}td,th{text-align:left;padding:10px;border-bottom:1px solid #344258}a{color:#91d5ff}.scroll{overflow:auto}.note{color:#b8c5d6;font-size:14px;margin-top:20px}footer{border-top:1px solid #344258;padding-top:20px;margin-top:28px}</style></head><body><main>
<div class="meta">维度足球 · ${html(doc.generatedAt)}${doc.simulated ? ' · 模拟运行' : ''}</div><h1>赛前预测与盘口候选</h1><p class="lead">历史比分模型生成胜平负概率与比分参考。盘口筛选独立运行，缺少赔率不会隐藏已有基础预测。当前模型为未经概率校准的统计基线。</p>
<div class="stats"><div class="stat"><b>${doc.summary.forecasts}</b>场已有预测</div><div class="stat"><b>${doc.summary.unavailable}</b>场暂不可预测</div><div class="stat"><b>${doc.summary.strictCandidates}</b>场严格盘口候选</div></div>
<nav><a href="#analysis">普通预测</a> · <a href="#strict">严格盘口候选</a> · <a href="#unassessable">暂不可评估</a> · <a href="publication.json">发布回执</a></nav>
<h2 id="analysis">普通赛前预测</h2><div class="grid">${cards || '<p>本轮无满足条件的普通预测。</p>'}</div>
<h2 id="strict">严格盘口候选</h2><div class="grid">${strict || '<p>本轮无通过门槛的严格盘口候选。</p>'}</div>
<details><summary>逐场盘口证据缺项</summary><div class="scroll"><table><thead><tr><th>比赛</th><th>独立来源 / 要求</th><th>真实初盘数</th><th>缺项</th></tr></thead><tbody>${readiness}</tbody></table></div></details>
<h2 id="unassessable">暂不可评估</h2><div class="grid">${missing || '<p>本轮输入池均有普通预测。</p>'}</div>
<h2>按时间滚动回测</h2><div class="scroll"><table><thead><tr><th>联赛 / 来源</th><th>提前量 / 可见性</th><th>场数</th><th>模型 Brier</th><th>基准 Brier</th><th>模型 Log loss</th><th>历史方向命中率</th></tr></thead><tbody>${backtests || '<tr><td colspan="7">没有足够历史开展回测。</td></tr>'}</tbody></table></div>
${coverage ? `<h2>联赛覆盖与历史来源</h2><div class="scroll"><table><thead><tr><th>联赛 / 来源</th><th>赛程状态 / 场数</th><th>历史状态 / 场数</th><th>来源诊断</th></tr></thead><tbody>${coverage}</tbody></table></div>` : ''}
${doc.prospectiveEvaluation ? `<h2>赛前冻结预测核账</h2><p>更新时间 ${html(doc.prospectiveEvaluation.generatedAt)}；尚无结果时保持待评分。${html(settlementScope(doc.prospectiveEvaluation))}</p><table><thead><tr><th>来源 / 联赛</th><th>提前量</th><th>已评分 / 待结果 / 排除</th><th>Brier</th></tr></thead><tbody>${prospective || '<tr><td colspan="4">尚无可评分的前瞻记录。</td></tr>'}</tbody></table>` : ''}
<p class="note">每场只使用更早至少 4 小时的完赛记录，最多回测 80 场；样本不足的比赛跳过，指标仅代表可预测子集。Brier 和 Log loss 越低越好；基准为此前赛果频率。历史修订数据不能重建当时数据可见性，回测不是前瞻验证，也不表示未来命中率或投注收益。模型未纳入伤停、阵容或盘口。</p>
<footer><p>预测到期后需重新采集。本页为报告快照，实际发布回执见 <a href="publication.json">publication.json</a>；GitHub 最终回执见 publication-receipt 附件。网站与 Telegram 的实际结果另行记入回执；Telegram 缺凭据时不发送。原始概率、训练摘要、哈希和缺项见同目录 predictions.json。</p>${doc.attribution.map(source => `<p>数据：<a href="${html(source.url)}">${html(source.name)}</a> · <a href="${html(source.licenseUrl)}">${html(source.license)}</a></p>`).join('')}</footer></main></body></html>`;
}
