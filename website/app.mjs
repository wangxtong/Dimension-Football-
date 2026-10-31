import { validateReport, validateReceipt, validateBundle } from './report-schema.mjs';
const REPO = 'wangxtong/Dimension-Football-', BASE = '/api/';
const WORKFLOW_URL = `https://github.com/${REPO}/actions/workflows/public-sources.yml`;
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
const safeLabel = (value, fallback = '未记录') => typeof value === 'string' && value.trim() && value.length <= 160 && !/[\u0000-\u001f]/u.test(value) ? value : fallback;
const validHorizon = value => Number.isFinite(value) && value >= 0 && value <= 336;
const horizonLabel = value => validHorizon(value) ? `提前 ${Number(value.toFixed(2))} 小时` : '提前量未记录';
const visibilityLabel = value => value === 'as-observed' ? '按已观察历史回放' : value === 'snapshot' ? '修订快照回顾' : '验证口径未记录';
const effectiveLabel = value => Number.isFinite(value) && value >= 0 && value <= 1e9 ? value.toFixed(1) : '未知';
export function createSnapshotLoader({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  let inFlight = null, latest = null;
  async function request(path, legacyProbe = false) {
    const r = await fetchImpl(BASE + path + `?round=${Math.floor(now() / 60000)}`, { signal: AbortSignal.timeout(12000), cache: 'no-store' });
    if (r.status === 401) throw Error('AUTH_REQUIRED');
    if (legacyProbe && [404, 405].includes(r.status)) return null;
    if (!r.ok) throw Error('REPORT_UNAVAILABLE');
    return { data: await r.json() };
  }
  return { load() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const bundle = await request('report', true);
      let next;
      if (bundle) next = validateBundle(bundle.data);
      else {
        const report = validateReport((await request('predictions.json')).data);
        let receipt = null;
        try { receipt = validateReceipt((await request('publication.json')).data, report); }
        catch (error) { if (error.message === 'AUTH_REQUIRED') throw error; }
        next = { reportId: report.publication.reportId, report, receipt };
      }
      if (Date.parse(next.report.generatedAt) > now() + 300000
        || (latest && Date.parse(next.report.generatedAt) < Date.parse(latest.report.generatedAt))) throw Error('REPORT_TIME_INVALID');
      latest = next;
      return next;
    })().finally(() => { inFlight = null; });
    return inFlight;
  } };
}
let report = null, receipt = null, view = 'analysis', failedRefresh = false, freshness = null, health = null;
const current = row => row.forecast.status === 'forecast' && Date.parse(row.forecast.freshness?.validUntil) > Date.now() && Date.parse(row.fixture.kickoff) > Date.now();
const cardCache = new Map(), expanded = new Map();
function grouped() {
  if (!report) return { analysis: [], strict: [], missing: [] };
  return { analysis: report.fixtures.filter(current), missing: report.fixtures.filter(r => !current(r)),
    strict: report.fixtures.filter(r => !report.simulated && r.marketCandidate.status === 'candidate' && Date.parse(r.fixture.kickoff) > Date.now()
      && r.marketCandidate.candidate?.quotes?.length && r.marketCandidate.candidate.quotes.every(q => Date.parse(q.validUntil) > Date.now())) };
}
function card(row) {
  const { fixture: f, forecast: p, marketCandidate: m } = row, root = el('article', null, 'card');
  root.dataset.fixtureId = f.id;
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
  const details = el('details'); details.open = expanded.get(f.id) || false;
  details.addEventListener('toggle', () => { expanded.set(f.id, details.open); });
  details.append(el('summary', '查看依据与数据完整度'));
  for (const line of [`有效至 ${time(p.freshness.validUntil)}（北京时间）`, `基础检查 ${p.completeness.passed}/${p.completeness.total}；全球覆盖未知`,
    `主队进攻强度 ${p.strength.homeAttack.toFixed(2)} / 客队 ${p.strength.awayAttack.toFixed(2)}（联赛均值 1）`,
    `实际预测${horizonLabel(validHorizon(p.horizonHours) ? p.horizonHours : p.validation.horizonHours)}；${visibilityLabel(p.validation.visibility)}`,
    `有效加权样本（主 / 客）${effectiveLabel(p.sampleQuality?.weighted?.home?.effectiveMatches)} / ${effectiveLabel(p.sampleQuality?.weighted?.away?.effectiveMatches)}`,
    `同源回测 ${p.validation.evaluated} 场；跳过 ${p.validation.skipped} 场`,
    `盘口有效独立来源 ${m.readiness?.quoteGroups.length || 0} / 2；真实初盘 ${m.readiness?.verifiedOpeningCount || 0} 条`,
    ...(m.readiness?.blockers || []).map(r => reasons[r] || r)]) details.append(el('div', line, 'detail-row'));
  root.append(details); return root;
}
function renderCards(rows) {
  const container = $('cards'), focused = document.activeElement;
  const focusedId = container.contains(focused) ? focused.closest('[data-fixture-id]')?.dataset.fixtureId : null;
  const wanted = rows.map(row => {
    const key = `${view}:${row.fixture.id}`, signature = JSON.stringify([current(row), row]);
    const cached = cardCache.get(key);
    if (cached?.signature === signature) return cached.node;
    const node = card(row); cardCache.set(key, { signature, node, fixtureId: row.fixture.id }); return node;
  });
  if (!wanted.length) wanted.push(el('p', '本轮没有符合此分类与联赛的比赛。', 'empty'));
  const keep = new Set(wanted);
  for (const node of [...container.children]) if (!keep.has(node)) node.remove();
  wanted.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
  if (focusedId && document.activeElement !== focused) {
    const replacement = wanted.find(node => node.dataset.fixtureId === focusedId)?.querySelector('summary');
    (replacement || container).focus({ preventScroll: true });
  }
  const ids = new Set(report.fixtures.map(row => row.fixture.id));
  for (const [key, value] of cardCache) if (!ids.has(value.fixtureId)) cardCache.delete(key);
  for (const key of expanded.keys()) if (!ids.has(key)) expanded.delete(key);
}
function renderCoverage() {
  const container = $('coverage'), count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1e9;
  const statuses = { sample: '样本覆盖', partial: '部分可用', available: '可用', unavailable: '不可用',
    'not-requested': '未请求', 'not-supported': '不支持' };
  const rows = Array.isArray(report.coverage) ? report.coverage.slice(0, 100).filter(row => row && typeof row === 'object'
    && safeLabel(row.source, null) && safeLabel(row.league, null) && count(row.fixtureCount) && count(row.historyCount)) : [];
  container.replaceChildren();
  for (const row of rows) {
    const status = value => typeof value === 'string' && Object.hasOwn(statuses, value) ? statuses[value] : '状态未记录';
    const entry = el('div', null, 'detail-row');
    entry.append(el('strong', `${leagues[row.league] || row.league} · ${row.source}`),
      el('p', `赛程 ${row.fixtureCount} 场 · ${status(row.fixtureStatus)}；历史 ${row.historyCount} 场 · ${status(row.historyStatus)}`, 'note'));
    container.append(entry);
  }
  if (!rows.length) container.append(el('p', '本报告未记录可核验的来源覆盖明细。', 'muted'));
}
function render() {
  if (!report) return;
  const groups = grouped(); $('count-analysis').textContent = groups.analysis.length; $('count-strict').textContent = groups.strict.length; $('count-missing').textContent = groups.missing.length;
  const expired = report.fixtures.filter(r => r.forecast.status === 'forecast' && !current(r)).length;
  const message = [failedRefresh ? '本次刷新失败，当前显示上次成功读取的报告。' : '',
    freshness?.mode === 'bootstrap' ? '当前显示启动快照，尚未连接实时报告源；更新时间以报告为准。' : '',
    health?.status === 'upstream_unavailable' || freshness?.mode === 'upstream_unavailable' ? '报告上游暂不可用，当前数据不代表最新采集结果。' : '',
    expired ? `${expired} 场预测已过期或开赛，已移入暂不可评估。` : ''].filter(Boolean).join(' ');
  $('warning').hidden = !message; $('warning').textContent = message;
  const rows = groups[view].filter(r => $('league').value === 'all' || r.fixture.league === $('league').value);
  renderCards(rows);
  $('pool-note').textContent = `本轮输入 ${report.summary.fixtures} 场 · 当前视图 ${rows.length} 场 · 生成于 ${time(report.generatedAt)}（北京时间）`;
  $('validation').replaceChildren();
  const hasPurposes = report.backtests.some(b => ['reference-horizon', 'actual-publication-horizon'].includes(b.purpose));
  // The producer reuses a cached actual-horizon result when it exactly matches a reference horizon.
  const referenceRows = report.backtests.filter(b => b.purpose === 'reference-horizon'
    || b.purpose === 'actual-publication-horizon' && [1, 24, 72, 168].includes(b.horizonHours));
  const backtests = hasPurposes ? [...new Map(referenceRows.map(b => [
    JSON.stringify([safeLabel(b.source), b.league, b.horizonHours, safeLabel(b.visibility)]), b])).values()] : report.backtests;
  for (const b of backtests) { $('validation').append(el('p', `${leagues[b.league] || b.league} · ${safeLabel(b.source, '来源未记录')} · ${horizonLabel(b.horizonHours)} · ${visibilityLabel(b.visibility)}`),
    el('p', `${b.evaluated} 场回测 / ${b.skipped} 场跳过`, 'note'),
    el('p', b.metrics ? `Brier ${b.metrics.brier.toFixed(4)}，基准 ${b.metrics.baselineBrier.toFixed(4)}；Log loss ${b.metrics.logLoss.toFixed(4)}` : '当前无足够回测数据。', 'note')); }
  if (!$('validation').childNodes.length) $('validation').append(el('p', '当前无足够回测数据。', 'muted'));
  renderCoverage();
  $('delivery').replaceChildren();
  const statuses = { published: '已完成', accepted: '平台已接收', failed: '失败', not_configured: '待配置', not_attempted: '未执行', skipped: '已跳过', unknown: '发送结果待核对' };
  const labels = { files: '报告生成', githubArtifact: '报告附件', externalWebsite: '网站数据', notifications: 'Telegram 通知' };
  if (receipt?.reportId === report.publication.reportId) for (const [key, label] of Object.entries(labels)) {
    const n = el('div', null, 'receipt'); n.append(el('span', label), el('span', statuses[receipt.channels[key]?.status] || '状态待同步')); $('delivery').append(n);
  } else $('delivery').append(el('p', '最新发布回执正在同步。', 'muted'));
  $('updated').textContent = `报告 ID ${report.publication.reportId.slice(0,12)} · 更新时间 ${time(report.generatedAt)}`;
  const artifactUrl = receipt?.reportId === report.publication.reportId ? receipt.channels.githubArtifact?.url : null;
  $('run-link').href = typeof artifactUrl === 'string' && new RegExp(`^https://github\\.com/${REPO}/actions/runs/[0-9]+(?:/artifacts/[0-9]+)?$`).test(artifactUrl)
    ? artifactUrl : WORKFLOW_URL;
  $('attribution').replaceChildren();
  for (const a of report.attribution) { const n = el('a', `${a.name} · ${a.license}`); if (/^https:\/\//.test(a.url)) { n.href = a.url; n.target = '_blank'; n.rel = 'noreferrer'; $('attribution').append(n); } }
  const data = el('a', 'OpenLigaDB 原始数据与许可 ↗'); data.href = BASE+'openligadb-fixtures.json'; data.target = '_blank'; data.rel = 'noreferrer'; $('attribution').append(data);
}
const loader = createSnapshotLoader();
let refreshing = null;
function load() {
  if (refreshing) return refreshing;
  $('refresh').disabled = true; $('sync-status').textContent = '正在检查最新报告…';
  refreshing = (async () => {
    try {
      const next = await loader.load();
      report = next.report; receipt = next.receipt; freshness = next.freshness || null; health = next.health || null; failedRefresh = false;
      render(); $('sync-status').textContent = `已检查 · ${time(new Date().toISOString())} 北京时间`;
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') { location.assign('/login'); return; }
      failedRefresh = true; $('sync-status').textContent = '暂时无法读取最新报告';
      if (report) render(); else $('cards').replaceChildren(el('p', '最新报告尚未就绪。可以稍后刷新，或查看采集任务状态。', 'empty'));
    } finally { $('refresh').disabled = false; }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
if (typeof document !== 'undefined') {
  $('refresh').addEventListener('click', load); $('league').addEventListener('change', render);
  const tabs = [...document.querySelectorAll('[data-view]')];
  function selectTab(button) {
    view = button.dataset.view;
    for (const tab of tabs) { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; }
    $('cards').setAttribute('aria-labelledby', button.id); render();
  }
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => selectTab(button));
    button.addEventListener('keydown', event => {
      const target = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault(); selectTab(tabs[target]); tabs[target].focus();
    });
  });
  setInterval(load, 60000); setInterval(render, 30000); load();
}
