const REPO = 'wangxtong/Dimension-Football-', BASE = '/api/';
const leagues = { PL: '英超', PD: '西甲', SA: '意甲', BL1: '德甲', FL1: '法甲' }, choices = { home: '主胜', draw: '平局', away: '客胜' };
const reasons = { HISTORY_UNAVAILABLE: '缺同源联赛历史', HOME_HISTORY_INSUFFICIENT: '主队历史不足', AWAY_HISTORY_INSUFFICIENT: '客队历史不足',
  LEAGUE_HISTORY_INSUFFICIENT: '联赛样本不足', VENUE_HISTORY_INSUFFICIENT: '主客场样本不足', TEAM_ID_REQUIRED: '球队身份待核对',
  BACKTEST_INSUFFICIENT: '回测样本不足或未完成', TEAM_HISTORY_STALE: '球队历史过旧', FORECAST_EXPIRED: '预测已过期',
  NOT_PREMATCH: '比赛已开始或状态已改变', NO_FRESH_COMPLETE_ASIAN_MARKET: '无有效完整亚洲盘',
  SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING: '缺第二独立报价', TRUE_OPENING_RECORD_MISSING: '缺真实初盘记录' };
const $ = id => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
const time = date => Number.isFinite(Date.parse(date)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(date)) : '未知';
const percent = n => `${(n * 100).toFixed(1)}%`;
let report = null, receipt = null, view = 'analysis', failedRefresh = false;
const current = row => row.forecast.status === 'forecast' && Date.parse(row.forecast.freshness?.validUntil) > Date.now() && Date.parse(row.fixture.kickoff) > Date.now();
function grouped() {
  if (!report) return { analysis: [], strict: [], missing: [] };
  return { analysis: report.fixtures.filter(current), missing: report.fixtures.filter(r => !current(r)),
    strict: report.fixtures.filter(r => !report.simulated && r.marketCandidate.status === 'candidate' && Date.parse(r.fixture.kickoff) > Date.now()
      && r.marketCandidate.candidate?.quotes?.length && r.marketCandidate.candidate.quotes.every(q => Date.parse(q.validUntil) > Date.now())) };
}
function card(row) {
  const { fixture: f, forecast: p, marketCandidate: m } = row, root = el('article', null, 'card');
  const meta = el('div', null, 'meta'); meta.append(el('span', leagues[f.league] || f.league, 'league-tag'), el('span', `${time(f.kickoff)} 北京时间`));
  const teams = el('div', null, 'teams'); teams.append(el('div', f.home), el('span', 'VS'), el('div', f.away)); root.append(meta, teams);
  if (view === 'strict') {
    const c = m.candidate; root.append(el('div', '严格候选 · 待人工复核', 'pill'), el('p', `${choices[c.selection]} ${c.handicap} @ ${c.decimalOdds}`),
      el('p', `独立来源：${c.quoteGroups.join(' / ')}`, 'facts'), el('p', `初盘 ${c.opening.handicap} @ ${c.opening.decimalOdds} · ${time(c.opening.observedAt)}`, 'facts'));
    return root;
  }
  if (!current(row)) {
    const why = p.status === 'forecast' ? ['预测已过期，等待下一轮采集'] : (p.reasons || []).map(r => reasons[r] || r);
    root.append(el('div', '暂不可评估', 'pill expired'), el('p', why.join('；')), el('p', `盘口独立来源 ${m.readiness?.quoteGroups.length || 0} / 2；真实初盘 ${m.readiness?.verifiedOpeningCount || 0} 条`, 'facts'));
    return root;
  }
  root.append(el('div', `基线倾向 · ${choices[p.selection] || '接近'}`, 'pill'));
  const probs = el('div', null, 'probabilities');
  for (const key of Object.keys(choices)) { const n = el('div'); const bar = el('div', null, 'bar'), fill = el('i'); fill.style.width = `${p.probabilities[key] * 100}%`; bar.append(fill); n.append(el('strong', percent(p.probabilities[key])), el('small', choices[key]), bar); probs.append(n); }
  root.append(probs, el('p', `预期进球 ${p.expectedGoals.home.toFixed(2)} / ${p.expectedGoals.away.toFixed(2)} · 样本 ${p.sample.home} / ${p.sample.away} 场`, 'facts'),
    el('p', `比分参考 ${p.topScores.map(s => `${s.home}:${s.away} (${percent(s.probability)})`).join('、')}`, 'note'));
  const details = el('details'); details.append(el('summary', '查看依据与数据完整度'));
  for (const line of [`有效至 ${time(p.freshness.validUntil)}（北京时间）`, `基础检查 ${p.completeness.passed}/${p.completeness.total}；全球覆盖未知`,
    `主队进攻强度 ${p.strength.homeAttack.toFixed(2)} / 客队 ${p.strength.awayAttack.toFixed(2)}（联赛均值 1）`,
    `同源回测 ${p.validation.evaluated} 场；跳过 ${p.validation.skipped} 场`,
    `盘口有效独立来源 ${m.readiness?.quoteGroups.length || 0} / 2；真实初盘 ${m.readiness?.verifiedOpeningCount || 0} 条`,
    ...(m.readiness?.blockers || []).map(r => reasons[r] || r)]) details.append(el('div', line, 'detail-row'));
  root.append(details); return root;
}
function render() {
  if (!report) return;
  const groups = grouped(); $('count-analysis').textContent = groups.analysis.length; $('count-strict').textContent = groups.strict.length; $('count-missing').textContent = groups.missing.length;
  const expired = report.fixtures.filter(r => r.forecast.status === 'forecast' && !current(r)).length;
  const message = failedRefresh ? '本次刷新失败，当前显示上次成功读取的报告。' : expired ? `${expired} 场预测已过期或开赛，已移入暂不可评估。` : '';
  $('warning').hidden = !message; $('warning').textContent = message;
  const rows = groups[view].filter(r => $('league').value === 'all' || r.fixture.league === $('league').value);
  $('cards').replaceChildren(...rows.map(card));
  if (!rows.length) $('cards').append(el('p', '本轮没有符合此分类与联赛的比赛。', 'empty'));
  $('pool-note').textContent = `本轮输入 ${report.summary.fixtures} 场 · 当前视图 ${rows.length} 场 · 生成于 ${time(report.generatedAt)}（北京时间）`;
  $('validation').replaceChildren();
  for (const b of report.backtests.filter(b => b.metrics)) { $('validation').append(el('p', `${leagues[b.league] || b.league} · ${b.evaluated} 场回测 / ${b.skipped} 场跳过`),
    el('p', `Brier ${b.metrics.brier.toFixed(4)}，基准 ${b.metrics.baselineBrier.toFixed(4)}；Log loss ${b.metrics.logLoss.toFixed(4)}`, 'note')); }
  if (!$('validation').childNodes.length) $('validation').append(el('p', '当前无足够回测数据。', 'muted'));
  $('delivery').replaceChildren();
  const statuses = { published: '已完成', accepted: '平台已接收', failed: '失败', not_configured: '待配置', not_attempted: '未执行', skipped: '已跳过', unknown: '发送结果待核对' };
  const labels = { files: '报告生成', githubArtifact: '报告附件', externalWebsite: '网站数据', notifications: 'Telegram 通知' };
  if (receipt?.reportId === report.publication.reportId) for (const [key, label] of Object.entries(labels)) {
    const n = el('div', null, 'receipt'); n.append(el('span', label), el('span', statuses[receipt.channels[key]?.status] || '状态待同步')); $('delivery').append(n);
  } else $('delivery').append(el('p', '最新发布回执正在同步。', 'muted'));
  $('updated').textContent = `报告 ID ${report.publication.reportId.slice(0,12)} · 更新时间 ${time(report.generatedAt)}`;
  const artifactUrl = receipt?.channels.githubArtifact?.url;
  if (typeof artifactUrl === 'string' && artifactUrl.startsWith(`https://github.com/${REPO}/actions/runs/`)) $('run-link').href = artifactUrl;
  $('attribution').replaceChildren();
  for (const a of report.attribution) { const n = el('a', `${a.name} · ${a.license}`); if (/^https:\/\//.test(a.url)) { n.href = a.url; n.target = '_blank'; n.rel = 'noreferrer'; $('attribution').append(n); } }
  const data = el('a', 'OpenLigaDB 原始数据与许可 ↗'); data.href = BASE+'openligadb-fixtures.json'; data.target = '_blank'; data.rel = 'noreferrer'; $('attribution').append(data);
}
async function load() {
  $('refresh').disabled = true; $('sync-status').textContent = '正在检查最新报告…';
  try {
    const response = await fetch(BASE+`predictions.json?round=${Math.floor(Date.now()/60000)}`, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (response.status === 401) { location.assign('/login'); return; }
    if (!response.ok) throw Error('feed');
    const data = await response.json();
    if (data.kind !== 'prematch-forecast-report' || data.simulated || !Array.isArray(data.fixtures) || data.fixtures.length > 3000 || !/^[a-f0-9]{64}$/.test(data.publication?.reportId)) throw Error('schema');
    report = data; failedRefresh = false;
    try { const r = await fetch(BASE+`publication.json?round=${Math.floor(Date.now()/60000)}`, { signal: AbortSignal.timeout(8000), cache:'no-store' }); receipt = r.ok ? await r.json() : null; } catch { receipt = null; }
    $('sync-status').textContent = `已检查 · ${time(new Date().toISOString())} 北京时间`; render();
  } catch { failedRefresh = true; $('sync-status').textContent = '暂时无法读取最新报告'; if (report) render(); else $('cards').replaceChildren(el('p', '最新报告尚未就绪。可以稍后刷新，或查看采集任务状态。', 'empty')); }
  finally { $('refresh').disabled = false; }
}
$('refresh').addEventListener('click', load); $('league').addEventListener('change', render);
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { view = button.dataset.view; document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-selected',String(b === button))); render(); }));
setInterval(load, 300000); setInterval(render, 30000); load();
