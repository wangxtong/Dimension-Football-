import { validateReport, validateReceipt, validateBundle, validDate } from './report-schema.mjs';
import { teamName, sourceName, reasonText, leagueName, licenseName } from './locale-zh.mjs';
const REPO = 'wangxtong/Dimension-Football-', BASE = '/api/';
const WORKFLOW_URL = `https://github.com/${REPO}/actions/workflows/public-sources.yml`;
const choices = { home: '主胜', draw: '平局', away: '客胜' };
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
export function validateEvaluationEvidence(value) {
  const count = n => Number.isSafeInteger(n) && n >= 0 && n <= 1e7;
  const hash = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text);
  const metrics = row => row && Number.isFinite(row.accuracy) && row.accuracy >= 0 && row.accuracy <= 1
    && Number.isFinite(row.brier) && row.brier >= 0 && row.brier <= 2 && Number.isFinite(row.logLoss) && row.logLoss >= 0 && row.logLoss <= 100;
  if (!value || value.version !== 1 || value.kind !== 'historical-evaluation-evidence' || value.historicalOnly !== true
    || value.releaseGate !== 'BLOCKED' || !validDate(value.generatedAt) || !validDate(value.exportedAt)
    || !['reportId', 'manifestHash', 'inputsHash', 'modelHash', 'reportSha256', 'backtestsSha256'].every(key => hash(value.binding?.[key]))
    || !Number.isSafeInteger(value.model?.version) || value.model.version < 1 || value.model.calibrated !== false
    || !Array.isArray(value.groups) || value.groups.length > 100 || !value.groups.every(group => group && ['PL', 'PD', 'SA', 'BL1', 'FL1'].includes(group.league)
      && typeof group.source === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(group.source) && validHorizon(group.horizonHours)
      && group.visibility === 'snapshot' && count(group.evaluated) && count(group.skipped)
      && (group.metrics === null && group.baseline === null && group.evaluated === 0 || group.evaluated > 0 && metrics(group.metrics) && metrics(group.baseline)
        && ['accuracy', 'brier', 'logLoss'].every(key => Number.isFinite(group.deltaVsBaseline?.[key])
          && Math.abs(group.deltaVsBaseline[key] - (group.metrics[key] - group.baseline[key])) < 1e-8)))
    || !count(value.prospective?.evaluated) || !Array.isArray(value.limitations) || value.limitations.length > 20
    || !value.limitations.every(line => typeof line === 'string' && line.length <= 1000)) throw Error('HISTORICAL_EVIDENCE_INVALID');
  return value;
}
export function createEvaluationLoader({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let inFlight = null;
  return { load() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const response = await fetchImpl('/evaluation-evidence.json', { credentials: 'same-origin', cache: 'no-cache', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw Error('HISTORICAL_EVIDENCE_UNAVAILABLE');
      const body = await response.text();
      if (body.length > 2 * 1024 * 1024) throw Error('HISTORICAL_EVIDENCE_INVALID');
      return validateEvaluationEvidence(JSON.parse(body));
    })().finally(() => { inFlight = null; });
    return inFlight;
  } };
}
let evaluation = null, evaluationFailed = false;
const evaluationLoader = createEvaluationLoader();
function renderEvaluation() {
  const status = $('evaluation-state');
  status.classList.toggle('load-failed', evaluationFailed);
  status.textContent = evaluationFailed ? evaluation ? '历史证据刷新失败，保留上次有效档案；实时运行报告继续独立更新。'
    : '历史证据未加载，无法核验回测表现。实时赛程与运行状态仍可正常查看。'
    : evaluation ? `独立历史档案 · 数据截至 ${time(evaluation.generatedAt)} 北京时间 · 修订快照回顾，未做概率校准`
      : '正在加载独立历史证据；实时报告单独更新。';
  $('evaluation-content').hidden = !evaluation;
  if (!evaluation) return;
  const league = $('history-league').value, hours = Number($('history-horizon').value);
  const reference = evaluation.groups.filter(row => [1, 24, 72, 168].includes(row.horizonHours));
  const groups = [...new Map(reference.filter(row => league === 'all' || row.league === league)
    .map(row => [`${row.source}:${row.league}:${row.horizonHours}`, row])).values()].sort((a, b) => a.league.localeCompare(b.league) || a.horizonHours - b.horizonHours);
  const detailedGroups = evaluation.groups.filter(row => league === 'all' || row.league === league)
    .toSorted((a, b) => a.league.localeCompare(b.league) || a.horizonHours - b.horizonHours);
  const selected = groups.find(row => row.horizonHours === hours && row.metrics) || groups.find(row => row.horizonHours === hours);
  $('history-sample').textContent = selected ? `${selected.evaluated} 场` : '未取得样本';
  $('history-skipped').textContent = selected ? `${leagueName(selected.league)} · 提前 ${hours} 小时 · 跳过 ${selected.skipped} 场` : '此分组没有可核验记录';
  $('history-accuracy').textContent = selected?.metrics ? percent(selected.metrics.accuracy) : '样本不足';
  $('history-brier-delta').textContent = selected?.metrics ? `${selected.deltaVsBaseline.brier > 0 ? '+' : ''}${selected.deltaVsBaseline.brier.toFixed(4)}` : '不可比较';
  $('history-prospective').textContent = `${evaluation.prospective.evaluated} 场`;
  const chartRows = groups.filter(row => row.metrics && (league !== 'all' || row.horizonHours === hours));
  const chart = $('backtest-chart'); chart.replaceChildren();
  const maximum = Math.max(.01, ...chartRows.flatMap(row => [row.metrics.brier, row.baseline.brier]));
  chart.setAttribute('aria-label', chartRows.length ? `${league === 'all' ? '各联赛' : leagueName(league)}历史布里尔评分模型与基准横条对照，数值越低越好` : '所选联赛没有足够历史样本，未绘制图表');
  for (const row of chartRows) {
    const group = el('div', null, 'chart-row'), bars = el('div', null, 'chart-bars');
    group.append(el('span', league === 'all' ? leagueName(row.league) : `提前 ${row.horizonHours} 小时`, 'chart-label'));
    for (const [name, value] of [['模型', row.metrics.brier], ['基准', row.baseline.brier]]) {
      const track = el('div', null, name === '基准' ? 'chart-track baseline' : 'chart-track'), bar = el('i');
      bar.style.width = `${value / maximum * 80}%`; bar.setAttribute('aria-hidden', 'true');
      track.append(bar, el('span', value.toFixed(4))); track.setAttribute('aria-label', `${name}布里尔评分 ${value.toFixed(4)}`); bars.append(track);
    }
    group.append(bars); chart.append(group);
  }
  if (!chartRows.length) chart.append(el('p', '尚未取得足够的同源历史完赛样本。该联赛不计算命中率，也不补绘图表。', 'chart-empty'));
  const delta = selected?.deltaVsBaseline;
  $('chart-summary').textContent = selected?.metrics ? `${leagueName(selected.league)}提前 ${hours} 小时：模型 ${selected.metrics.brier.toFixed(4)}，基准 ${selected.baseline.brier.toFixed(4)}，同场差值 ${delta.brier.toFixed(4)}。不同提前量的评估集合可能不同，样本不可相加。`
    : '历史样本不足。图表与指标只在取得可核验评估记录后显示。';
  $('history-comparison').textContent = selected?.metrics ? `所选 ${selected.evaluated} 场中，模型方向命中率 ${percent(selected.metrics.accuracy)}，同场基准 ${percent(selected.baseline.accuracy)}，相差 ${(delta.accuracy * 100).toFixed(2)} 个百分点。这是历史样本内的对照，不代表未来优势或模型版本提升。`
    : '当前联赛缺少可评估的历史记录。赛程可用不等于历史完整，也不等于可以生成可靠预测。';
  const table = $('history-table'); table.replaceChildren();
  for (const row of detailedGroups) {
    const tr = el('tr'), name = el('td', leagueName(row.league)); name.append(el('small', sourceName(row.source))); tr.append(name);
    for (const value of [`${Number(row.horizonHours.toFixed(2))} 小时${row.purpose === 'actual-publication-horizon' ? ' · 实际' : ''}`, `${row.evaluated} / ${row.skipped}`, row.metrics ? percent(row.metrics.accuracy) : '样本不足',
      row.metrics ? row.metrics.brier.toFixed(4) : '不可评估', row.baseline ? row.baseline.brier.toFixed(4) : '不可评估', row.metrics ? row.metrics.logLoss.toFixed(4) : '不可评估']) tr.append(el('td', value));
    const state = el('td'); state.append(el('span', row.metrics ? '小样本回顾' : '历史不足', `data-status${row.metrics ? '' : ' missing'}`)); tr.append(state); table.append(tr);
  }
  $('history-binding').textContent = `模型第 ${evaluation.model.version} 版 · 未校准 · 历史报告编号 ${evaluation.binding.reportId.slice(0, 12)} · 档案截至 ${time(evaluation.generatedAt)} 北京时间。`;
  const evidenceLink = el('a', ' 查看原始历史证据 ↗'); evidenceLink.href = '/evaluation-evidence.json'; evidenceLink.target = '_blank'; evidenceLink.rel = 'noreferrer'; $('history-binding').append(evidenceLink);
  $('history-limitations').replaceChildren(...evaluation.limitations.map(line => el('li', line.replaceAll('BLOCKED', '暂停'))));
}
async function loadEvaluation() {
  try { evaluation = await evaluationLoader.load(); evaluationFailed = false; }
  catch { evaluationFailed = true; }
  renderEvaluation();
  if (report) render();
}
let report = null, receipt = null, view = 'analysis', failedRefresh = false, freshness = null, health = null;
const isObservation = () => ['observations', 'collection-observation'].includes(report?.publicationKind);
function renderPickBlockers() {
  const historicalLeagues = [...new Set((evaluation?.groups || []).filter(row => row.evaluated > 0 && row.metrics).map(row => row.league))];
  const historyStatus = !evaluation ? '独立历史档案待加载' : historicalLeagues.length
    ? `${historicalLeagues.map(leagueName).join('、')}已核验；其余 ${5 - historicalLeagues.length} 联赛暂无评估样本` : '档案内尚无可评估联赛';
  const paired = report.fixtures.filter(row => (row.marketCandidate.readiness?.quoteGroups.length || row.marketCandidate.candidate?.quoteGroups.length || 0) >= 2).length;
  const openings = report.fixtures.filter(row => (row.marketCandidate.readiness?.verifiedOpeningCount || 0) > 0 || row.marketCandidate.candidate?.opening).length;
  $('pick-blockers').replaceChildren(...[
    ['前瞻验证与校准', '尚未完成正式验收'], ['独立历史档案', historyStatus],
    ['严格盘口额外要求', `${paired} 场双源 · ${openings} 场初盘，完整门槛仍待验收`],
  ].map(([label, value]) => { const row = el('li'); row.append(el('span', label), el('b', value)); return row; }));
}
const current = row => row.forecast.status === 'forecast' && Date.parse(row.forecast.freshness?.validUntil) > Date.now() && Date.parse(row.fixture.kickoff) > Date.now();
const cardCache = new Map(), expanded = new Map();
function grouped() {
  if (!report) return { schedule: [], analysis: [], strict: [], missing: [] };
  return { schedule: report.fixtures, analysis: report.fixtures.filter(current), missing: report.fixtures.filter(r => !current(r)),
    strict: report.fixtures.filter(r => !report.simulated && r.marketCandidate.status === 'candidate' && Date.parse(r.fixture.kickoff) > Date.now()
      && r.marketCandidate.candidate?.quotes?.length && r.marketCandidate.candidate.quotes.every(q => Date.parse(q.validUntil) > Date.now())) };
}
function card(row) {
  const { fixture: f, forecast: p, marketCandidate: m } = row, root = el('article', null, 'card');
  root.dataset.fixtureId = f.id;
  const meta = el('div', null, 'meta'); meta.append(el('span', leagueName(f.league), 'league-tag'), el('span', `${time(f.kickoff)} 北京时间`));
  const teams = el('div', null, 'teams'); teams.append(el('div', teamName(f.home, { source: f.source, teamId: f.homeTeamId })), el('span', '对阵'), el('div', teamName(f.away, { source: f.source, teamId: f.awayTeamId }))); root.append(meta, teams);
  if (view === 'schedule') {
    const labels = { SCHEDULED:'未开赛', TIMED:'已定开球时间', FINISHED:'已完场', IN_PLAY:'比赛进行中', POSTPONED:'已延期', CANCELLED:'已取消' };
    root.append(el('div', labels[f.status] || '赛程状态待核验', 'pill'), el('p', `赛程来源：${sourceName(f.source)}`, 'facts'), el('p', '正式预测暂未发布；请在逐场状态与发布状态中查看当前阻断。', 'note'));
    return root;
  }
  if (view === 'strict') {
    const c = m.candidate; root.append(el('div', '严格候选 · 待人工复核', 'pill'), el('p', `${choices[c.selection]} ${c.handicap} @ ${c.decimalOdds}`),
      el('p', `独立来源：${c.quoteGroups.map(value => sourceName(value)).join(' / ')}`, 'facts'), el('p', `初盘 ${c.opening.handicap} @ ${c.opening.decimalOdds} · ${time(c.opening.observedAt)}`, 'facts'));
    return root;
  }
  if (!current(row)) {
    const why = p.status === 'forecast' ? ['预测已过期，等待下一轮采集'] : (p.reasons || []).map(code => reasonText(code));
    root.append(el('div', p.reasons?.includes('RELEASE_GATE_BLOCKED') ? '发布门禁中 · 未公开评估' : '暂不可评估', 'pill expired'), el('p', why.join('；')), el('p', `严格盘口额外证据：独立来源 ${m.readiness?.quoteGroups.length || 0} / 2；真实初盘 ${m.readiness?.verifiedOpeningCount || 0} 条`, 'facts'));
    return root;
  }
  root.append(el('div', `研究基线 · ${choices[p.selection] || '接近'} · 未正式发布`, 'pill'));
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
    ...(m.readiness?.blockers || []).map(code => reasonText(code))]) details.append(el('div', line, 'detail-row'));
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
  if (!wanted.length) wanted.push(el('p', view === 'strict' ? '本轮没有满足严格盘口条件的研究候选。今日优选保持零可发布，等待独立来源与真实初盘等证据。'
    : view === 'analysis' ? '本轮暂无有效研究预测。赛程仍可查看；同源历史、前瞻验证和数据时效需要分别满足要求。'
      : '当前筛选下没有赛事。可切换联赛或查看本轮已取得的赛程。', 'empty'));
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
    entry.append(el('strong', `${leagueName(row.league)} · ${sourceName(row.source)}`),
      el('p', isObservation() ? `赛程 ${row.fixtureCount} 场 · ${status(row.fixtureStatus)}；本轮观察不载入历史，评估见独立档案`
        : `赛程 ${row.fixtureCount} 场 · ${status(row.fixtureStatus)}；历史 ${row.historyCount} 场 · ${status(row.historyStatus)}`, 'note'));
    container.append(entry);
  }
  if (!rows.length) container.append(el('p', '本报告未记录可核验的来源覆盖明细。', 'muted'));
}
function render() {
  if (!report) return;
  $('today-date').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date()) + ' · 北京时间';
  $('count-fixtures').textContent = report.fixtures.length;
  $('schedule-summary').textContent = `${report.fixtures.length} 场真实赛程 · ${new Set(report.fixtures.map(row => row.fixture.league)).size} 个联赛`;
  // R1 has no authorized release path. Retained research candidates never fill
  // the 3–7 target or become publishable picks through client-side inference.
  $('count-publishable').textContent = '0'; $('today-picks-count').textContent = '0';
  renderPickBlockers();
  $('feed-mode').textContent = freshness?.mode === 'hosted' ? '持久实时采集报告' : freshness?.mode === 'ecs' ? '服务器报告' : freshness?.mode === 'bootstrap' ? '启动快照 · 未实时连接' : '数据来源待核验';
  $('collected-at').textContent = time(report.generatedAt);
  const age = Math.max(0, Math.floor((Date.now() - Date.parse(report.generatedAt)) / 60000));
  $('data-age').textContent = age < 60 ? `${age} 分钟` : `${Math.floor(age / 60)} 小时 ${age % 60} 分钟`;
  const leagueOverview = $('league-overview'); leagueOverview.replaceChildren();
  for (const code of ['PL','PD','SA','BL1','FL1']) {
    const count = report.fixtures.filter(row => row.fixture.league === code).length;
    const history = (report.coverage || []).filter(row => row?.league === code && Number.isSafeInteger(row.historyCount)).reduce((n,row) => n + row.historyCount, 0);
    const archived = evaluation?.groups.find(row => row.league === code && row.horizonHours === 24 && row.metrics);
    const historyLabel = isObservation() ? archived ? `独立历史评估 ${archived.evaluated} 场` : evaluation ? '历史档案暂无评估样本' : '独立历史档案待加载'
      : history ? `取得 ${history} 条来源历史` : '历史覆盖不足或未记录';
    const button = el('button',null,'league-card'); button.type='button';
    button.append(el('strong',leagueName(code)),el('span',`${count} 场赛程`),el('small',historyLabel));
    button.addEventListener('click',()=>{ $('league').value=code; location.hash='schedule'; render(); $('cards').scrollIntoView({block:'start'}); });
    leagueOverview.append(button);
  }
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
  for (const b of backtests) { $('validation').append(el('p', `${leagueName(b.league)} · ${sourceName(b.source)} · ${horizonLabel(b.horizonHours)} · ${visibilityLabel(b.visibility)}`),
    el('p', `${b.evaluated} 场回测 / ${b.skipped} 场跳过`, 'note'),
    el('p', b.metrics ? `布里尔评分 ${b.metrics.brier.toFixed(4)}，基准 ${b.metrics.baselineBrier.toFixed(4)}；对数损失 ${b.metrics.logLoss.toFixed(4)}` : '当前无足够回测数据。', 'note')); }
  if (!$('validation').childNodes.length) $('validation').append(el('p', '当前无足够回测数据。', 'muted'));
  renderCoverage();
  $('delivery').replaceChildren();
  const statuses = { published: '已完成', accepted: '平台已接收', failed: '失败', not_configured: '待配置', not_attempted: '未执行', skipped: '已跳过', unknown: '发送结果待核对' };
  const labels = { files: '报告生成', githubArtifact: '报告附件', externalWebsite: '网站数据', notifications: '机器人通知' };
  if (receipt?.reportId === report.publication.reportId) for (const [key, label] of Object.entries(labels)) {
    const n = el('div', null, 'receipt'); n.append(el('span', label), el('span', statuses[receipt.channels[key]?.status] || '状态待同步')); $('delivery').append(n);
  } else $('delivery').append(el('p', '最新发布回执正在同步。', 'muted'));
  $('updated').textContent = `报告编号 ${report.publication.reportId.slice(0,12)} · 更新时间 ${time(report.generatedAt)}`;
  const artifactUrl = receipt?.reportId === report.publication.reportId ? receipt.channels.githubArtifact?.url : null;
  $('run-link').href = typeof artifactUrl === 'string' && new RegExp(`^https://github\\.com/${REPO}/actions/runs/[0-9]+(?:/artifacts/[0-9]+)?$`).test(artifactUrl)
    ? artifactUrl : WORKFLOW_URL;
  $('attribution').replaceChildren();
  for (const a of report.attribution) { const n = el('a', `${sourceName(safeLabel(a.id, null) || a.name)} · ${licenseName(a.license)}`); if (/^https:\/\//.test(a.url)) { n.href = a.url; n.target = '_blank'; n.rel = 'noreferrer'; $('attribution').append(n); } }
  const data = el('a', report.publicationKind === 'observations' ? '赛程观察数据与许可 ↗' : '开放联赛原始数据与许可 ↗'); data.href = BASE+'openligadb-fixtures.json'; data.target = '_blank'; data.rel = 'noreferrer'; $('attribution').append(data);
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
      if (!location.hash && !new URLSearchParams(location.search).has('view') && ['observations', 'collection-observation'].includes(report.publicationKind)) document.querySelector('[data-view="schedule"]').click();
      render(); $('sync-status').textContent = `已检查 · ${time(new Date().toISOString())} 北京时间`;
    } catch (error) {
      if (error.message === 'AUTH_REQUIRED') { location.assign('/login'); return; }
      failedRefresh = true; $('sync-status').textContent = '暂时无法读取最新报告';
      if (report) render(); else {
        for (const id of ['count-fixtures', 'count-analysis', 'count-missing', 'collected-at']) $(id).textContent = '未取得';
        $('feed-mode').textContent = '实时报告暂不可用'; $('data-age').textContent = '无法核验';
        $('cards').replaceChildren(el('p', '最新报告尚未就绪。可以稍后刷新，或查看采集任务状态。', 'empty'));
      }
    } finally { $('refresh').disabled = false; }
  })().finally(() => { refreshing = null; });
  return refreshing;
}
if (typeof document !== 'undefined') {
  $('refresh').addEventListener('click', () => { load(); loadEvaluation(); }); $('league').addEventListener('change', render);
  $('history-league').addEventListener('change', renderEvaluation); $('history-horizon').addEventListener('change', renderEvaluation);
  const tabs = [...document.querySelectorAll('[data-view]')];
  function selectTab(button) {
    view = button.dataset.view;
    for (const tab of tabs) { tab.setAttribute('aria-selected', String(tab === button)); tab.tabIndex = tab === button ? 0 : -1; }
    $('cards').setAttribute('aria-labelledby', button.id); render();
  }
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => {selectTab(button); history.replaceState(null,'','#'+button.dataset.view);});
    button.addEventListener('keydown', event => {
      const target = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
      if (target === undefined) return;
      event.preventDefault(); selectTab(tabs[target]); tabs[target].focus();
    });
  });
  function followSection() {
    const target = location.hash.slice(1) || new URLSearchParams(location.search).get('view');
    const tab = tabs.find(button => button.dataset.view === target);
    if (tab) { selectTab(tab); $('matches').scrollIntoView({ block: 'start' }); }
    if (target === 'status') $('status').focus({preventScroll:true});
    if (['picks', 'backtest', 'overview'].includes(target)) $(target).scrollIntoView({ block: 'start' });
    for (const link of document.querySelectorAll('.section-nav a')) link.classList.toggle('nav-current', link.hash === `#${target || 'overview'}`);
  }
  addEventListener('hashchange',followSection); followSection();
  setInterval(load, 60000); setInterval(render, 30000); load(); loadEvaluation();
}
