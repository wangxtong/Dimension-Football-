import { analyzeFullMarketSnapshot } from './full-market-analysis.mjs';
import { analyzeFixtureHistory } from './team-analysis.mjs';
import { teamName } from './sources/team-names.mjs';
import { isoMillis } from './policy.mjs';

const unique = rows => [...new Set(rows)];
const leagueIds = { PL: 39, PD: 140, SA: 135, BL1: 78, FL1: 61 };
const pickNames = { home: '主胜', draw: '平局', away: '客胜', over: '大2.5球', under: '小2.5球' };
const reasonNames = {
  LIVE_SOURCE_STALE: '赔率来源更新时间超过5分钟', RESEARCH_SOURCE_STALE: '赔率来源更新时间超过3小时',
  SELECTED_ODDS_OUTSIDE_1_65_TO_1_95: '该方向参考赔率不在1.65–1.95',
  FEWER_THAN_THREE_COMPLETE_COMPANIES: '完整配对报价少于3家公司',
  SECOND_INDEPENDENT_SOURCE_NOT_IN_SNAPSHOT: '该赔率快照只有一个数据供应商，未完成第二独立来源核验',
  OPENING_HISTORY_NOT_IN_SNAPSHOT: '未取得可核验初盘轨迹',
  INDEPENDENT_FORECAST_NOT_IN_SNAPSHOT: '本盘口快照未包含独立预测核验',
  EXISTING_FORMAL_POLICY_GATE_REQUIRED: '仍需完整的正式推荐规则评估',
  PAGE_HTTP_DATE_UNVERIFIED: 'HTTP响应时间未核验', RESPONSE_FIXTURE_IDENTITY_MISMATCH: '赔率赛事身份不一致',
  SOURCE_TIMESTAMP_INVALID: '赔率源更新时间缺失', SOURCE_TIMESTAMP_FUTURE: '赔率源更新时间超前',
  INDEPENDENT_FORECAST_MISSING: '未取得有效独立胜平负辅助', INDEPENDENT_FORECAST_CONFLICT: '独立胜平负辅助与市场方向冲突',
};
const reasonText = code => reasonNames[code] || code;
function validResponse(row, endpoint) {
  const data = row?.data;
  return !row?.error && data?.get === endpoint && data.errors && typeof data.errors === 'object'
    && !Object.keys(data.errors).length && Array.isArray(data.response) && data.results === data.response.length;
}
const responseRows = (row, endpoint) => validResponse(row, endpoint) ? row.data.response : [];

/** Every fixture receives every dimension; missing one dimension never stops the others. */
export function buildFullAnalysis({ evidence, marketSnapshot, priorHistory = [], independentReport, nowISO } = {}) {
  if (!Array.isArray(evidence?.fixtures) || !Array.isArray(evidence?.evidence)) throw new TypeError('Invalid analysis evidence');
  const allSources = [...evidence.evidence, ...priorHistory];
  const asOf = isoMillis(nowISO ?? new Date(Math.max(...[marketSnapshot?.fetchedAt, evidence.capturedAt,
    ...allSources.map(row => row?.fetchedAt)].map(isoMillis).filter(Number.isFinite))).toISOString());
  if (!Number.isFinite(asOf)) throw new TypeError('Invalid analysis time');
  const available = row => Number.isFinite(isoMillis(row?.fetchedAt)) && isoMillis(row.fetchedAt) <= asOf;
  const targets = evidence.evidence.filter(row => row.kind === 'fixtures' && available(row)).flatMap(row => responseRows(row, 'fixtures'));
  const reconcile = fixture => {
    if (!fixture || typeof fixture !== 'object') return fixture;
    const rows = targets.filter(row => `af-${row?.fixture?.id}` === fixture.id);
    const target = rows.length === 1 ? rows[0] : null;
    if (!target || target.league?.id !== leagueIds[fixture.league]
      || target.teams?.home?.name !== fixture.home || target.teams?.away?.name !== fixture.away
      || !Number.isFinite(Date.parse(target.fixture.date)) || target.fixture.timestamp * 1000 !== Date.parse(target.fixture.date)) return fixture;
    return { ...fixture, kickoff: new Date(target.fixture.date).toISOString(),
      status: target.fixture.status?.short === 'NS' ? 'SCHEDULED' : 'INACTIVE' };
  };
  const fixtures = evidence.fixtures.map(reconcile);
  const market = analyzeFullMarketSnapshot({ ...marketSnapshot,
    fixtures: marketSnapshot.fixtures.map(entry => ({ ...entry, fixture: reconcile(entry?.fixture) })) }, { nowISO: new Date(asOf).toISOString() });
  const index = new Map(market.fixtures.filter(row => row.fixture?.id).map(row => [row.fixture.id, row]));
  const history = evidence.evidence.filter(row => row.kind === 'history' && available(row)).flatMap(row => responseRows(row, 'fixtures'))
    .concat(priorHistory.filter(available).flatMap(row => responseRows(row, 'fixtures')));
  const matches = fixtures.map(fixture => {
    const id = Number(fixture.id.replace(/^af-/, ''));
    const candidates = targets.filter(row => row?.fixture?.id === id);
    const target = candidates.length === 1 ? candidates[0] : null;
    const identityVerified = !!target && Date.parse(target.fixture.date) === Date.parse(fixture.kickoff)
      && target.fixture.timestamp * 1000 === Date.parse(target.fixture.date)
      && target.league?.id === leagueIds[fixture.league] && target.teams?.home?.name === fixture.home && target.teams?.away?.name === fixture.away;
    const find = kind => evidence.evidence.filter(row => row.kind === kind && row.fixtureId === fixture.id);
    const responses = kind => find(kind).filter(available).flatMap(row => responseRows(row, kind === 'lineups' ? 'fixtures/lineups' : kind));
    const predictions = responses('predictions');
    const prediction = predictions.length === 1 ? predictions[0] : null;
    const predictionIdentity = !!target && prediction?.league?.id === target.league.id
      && prediction?.teams?.home?.id === target.teams.home.id && prediction?.teams?.away?.id === target.teams.away.id;
    const rawInjuries = responses('injuries');
    const allowedTeamIds = new Set([target?.teams?.home?.id, target?.teams?.away?.id].filter(value => Number.isSafeInteger(value) && value > 0));
    const injuries = rawInjuries.filter(row => row?.fixture?.id === id && Number.isSafeInteger(row?.player?.id) && row.player.id > 0
      && typeof row.player.name === 'string' && allowedTeamIds.has(row?.team?.id));
    const lineups = responses('lineups').filter(row => allowedTeamIds.has(row?.team?.id)
      && Array.isArray(row.startXI) && row.startXI.length === 11 && row.startXI.every(item => Number.isSafeInteger(item?.player?.id) && item.player.id > 0)
      && new Set(row.startXI.map(item => item.player.id)).size === 11);
    const lineupsVerified = lineups.length === 2 && new Set(lineups.map(row => row.team.id)).size === 2;
    const form = analyzeFixtureHistory({ fixture: identityVerified ? target : { ...fixture, leagueId: leagueIds[fixture.league] },
      history: identityVerified ? history : [], nowISO: market.analyzedAt });
    const markets = index.get(fixture.id)?.markets || {};
    const independentRow = independentReport?.results?.find(row => row.fixture?.id === fixture.id);
    const independentIdentity = independentRow && ['id', 'league', 'home', 'away', 'source'].every(key => independentRow.fixture[key] === fixture[key])
      && isoMillis(independentRow.fixture.kickoff) === isoMillis(fixture.kickoff);
    const independentSignals = (independentIdentity ? independentRow.lastEvidence?.signals || [] : []).filter(row => row?.sourceId === 'statarea'
      && row.market === '1x2' && ['home', 'draw', 'away'].includes(row.selection) && Number.isFinite(row.probability) && row.probability >= 0 && row.probability <= 1
      && ['automatic', 'owner-verified'].includes(row.verificationMethod) && isoMillis(row.observedAt) <= asOf
      && asOf - isoMillis(row.observedAt) <= 21600000 && isoMillis(row.validUntil) > asOf);
    const independentComparison = !independentSignals.length ? 'missing' : !markets.matchWinner?.selection ? 'market_unavailable'
      : independentSignals.some(signal => signal.selection !== markets.matchWinner.selection) ? 'conflict' : 'same_direction';
    const originalFixture = evidence.fixtures.find(row => row.id === fixture.id);
    return { fixture, identityVerified, scheduleChanged: Number.isFinite(isoMillis(originalFixture.kickoff)) && Number.isFinite(isoMillis(fixture.kickoff))
      && isoMillis(originalFixture.kickoff) !== isoMillis(fixture.kickoff),
      originalKickoff: originalFixture.kickoff, analysisStepsCompleted: ['identity', 'recentForm', 'venueForm', 'headToHead', 'rest',
      'injuries', 'lineups', 'matchWinner', 'goalsOverUnder25', 'asianHandicap', 'independentForecast', 'recommendationGate'],
      history: form, markets,
      injuries: { status: !find('injuries').some(row => available(row) && validResponse(row, 'injuries')) ? 'unavailable' : injuries.length ? 'reported' : 'not_reported',
        invalidRecordCount: rawInjuries.length - injuries.length,
        records: injuries.map(row => ({ teamId: row.team.id, team: row.team.name, playerId: row.player.id,
          player: row.player.name, type: row.player.type, reason: row.player.reason })),
        note: '仅为供应商报告；无记录不代表没有伤停。' },
      lineups: { status: lineupsVerified ? 'reported' : 'unconfirmed', teams: lineupsVerified ? lineups : [],
        note: '尚未公布不代表确认阵容；临场需复核。' },
      providerPrediction: { status: predictionIdentity ? 'available' : 'unverified',
        prediction: predictionIdentity ? prediction.predictions : null,
        note: 'API供应商模型意见，未校准；不是事实、市场概率或命中率。' },
      independentForecast: { signals: independentSignals, comparison: independentComparison, note: 'Statarea仅辅助胜平负，不改写为大小球概率。' },
      actions: Object.fromEntries(['matchWinner', 'goalsOverUnder25'].map(key => [key, { action: '不下注',
        reasons: unique([...(identityVerified ? [] : ['FIXTURE_IDENTITY_UNVERIFIED']),
          ...(markets[key]?.formalRecommendation?.blockers || ['MARKET_UNAVAILABLE']).filter(code => key !== 'matchWinner' || code !== 'INDEPENDENT_FORECAST_NOT_IN_SNAPSHOT'),
          ...(key !== 'matchWinner' || independentComparison === 'same_direction' ? [] : [independentComparison === 'conflict' ? 'INDEPENDENT_FORECAST_CONFLICT' : 'INDEPENDENT_FORECAST_MISSING'])]) }])),
    };
  });
  const count = fn => matches.filter(fn).length;
  return { version: 1, analyzedAt: market.analyzedAt,
    sourceMetadata: allSources.map(row => ({ kind: row.kind || 'history', fixtureId: row.fixtureId ?? null,
      fetchedAt: Number.isFinite(isoMillis(row.fetchedAt)) ? row.fetchedAt : null,
      httpStatus: Number.isInteger(row.httpStatus) ? row.httpStatus : null,
      httpDate: Number.isFinite(Date.parse(row.httpDate)) ? row.httpDate : null,
      sha256: /^[a-f0-9]{64}$/.test(row.sha256 || '') ? row.sha256 : null,
      adoptedBeforeCutoff: available(row), responseVerified: !!validResponse(row, row.data?.get),
      note: row.httpDate ? null : 'HTTP_DATE_NOT_RETAINED' })),
    summary: { fixtures: matches.length, processedAllDimensions: count(row => row.analysisStepsCompleted.length === 12),
      identityVerified: count(row => row.identityVerified), withRecentFiveBothTeams: count(row => row.history.home.last5.sampleCount === 5 && row.history.away.last5.sampleCount === 5),
      withVenueFiveBothTeams: count(row => row.history.home.venueLast5.sampleCount === 5 && row.history.away.venueLast5.sampleCount === 5),
      withMatchWinnerMarket: count(row => row.markets.matchWinner?.companyCount >= 3),
      withGoalsMarket: count(row => row.markets.goalsOverUnder25?.companyCount >= 3),
      injuriesReported: count(row => row.injuries.status === 'reported'), lineupsReported: count(row => row.lineups.status === 'reported'),
      formalRecommendations: 0 },
    methodology: ['全部输入赛事逐项处理；分析完成不等于数据完整或可下注。',
      '胜平负与全场大小球2.5独立分析；缺亚洲盘不会停止其它维度。',
      '各公司先以赔率倒数归一化，再对结果取中位数并归一化；数字只描述市场价格，非真实胜率、命中率或期望收益。',
      '研究参考允许显示带时间的旧报价；正式推荐维持5分钟实盘核验和1.65–1.95等原门槛。',
      '历史为五大联赛2025/2026赛季FT赛果，并可补充目标球队近期比赛；具体比赛和赛事ID保留在JSON。未覆盖完整杯赛日历、精确终场时间、xG、战术和天气。',
      '不把首次采集冒充初盘；本轮两个玩法均不下注。'], matches };
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const time = value => Number.isFinite(isoMillis(value)) ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value)) : '未知';
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '未知';
const price = value => Number.isFinite(value) ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : '未知';
const formText = value => value?.sampleCount ? `${value.wins}胜${value.draws}平${value.losses}负；进${value.goalsFor}/失${value.goalsAgainst}（${value.sampleCount}场）` : '没有可核验样本';
function marketHtml(label, value, action) {
  if (!value) return `<section><h3>${label}怎么下：不下注</h3><p>没有可核验市场数据。</p></section>`;
  return `<section><h3>${label}怎么下：${esc(action.action)}</h3><p>市场单一方向参考：<b>${esc(pickNames[value.selection] || '未知')}</b> · 中位数赔率 ${price(value.decimalOdds)} · 去水参考 ${pct(value.normalizedImpliedProbability)}</p>
  <p>${value.companyCount}家公司完整配对；源更新 ${time(value.updatedAt)}；源年龄 ${value.ageMs === null ? '未知' : Math.round(value.ageMs / 60000) + '分钟'}。</p>
  <p class="reason">${action.reasons.map(code => esc(reasonText(code))).join('；')}。</p>
  <details><summary>逐家公司赔率与时间</summary><table><tr><th>公司</th><th>完整报价</th><th>源更新时间</th></tr>${value.companyEvidence.map(row => `<tr><td>${esc(row.bookmaker)}</td><td>${Object.entries(row.odds).map(([key, odd]) => `${pickNames[key] || key} ${price(odd)}`).join(' / ')}</td><td>${time(row.updatedAt)}</td></tr>`).join('')}</table></details></section>`;
}
export function renderFullAnalysisHtml(report) {
  const s = report.summary;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${s.fixtures}场逐项分析 · 维度足球</title>
  <style>body{margin:0;background:#f4f6f8;color:#17212b;font:16px/1.75 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:30px 20px}header,article{background:white;border:1px solid #dce2e7;border-radius:12px;padding:24px;margin:20px 0}h1{font-size:30px}h2{font-size:23px}h3{color:#075b58;font-size:19px}section{border-left:4px solid #16867d;padding:6px 16px;margin:16px 0;background:#f4faf9}.reason{color:#705516;font-size:14px}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:8px;border-bottom:1px solid #e1e6ea}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}.muted{color:#5a6874;font-size:14px}details{margin-top:12px}summary{cursor:pointer}nav a{display:inline-block;padding:4px 10px;color:#075b58}@media(max-width:650px){.grid{grid-template-columns:1fr}main{padding:12px}article{padding:16px}}@media print{details{display:block}article{break-inside:avoid}nav{display:none}}</style><main>
  <header><h1>${s.fixtures}场逐项分析</h1><p>分析截点：${time(report.analyzedAt)}（北京时间）</p><p><b>逐项处理 ${s.processedAllDimensions}/${s.fixtures}场</b> · 胜平负报价 ${s.withMatchWinnerMarket}场 · 大小球报价 ${s.withGoalsMarket}场 · 正式推荐 ${s.formalRecommendations}场</p><p>近5场双方齐全 ${s.withRecentFiveBothTeams}场；主/客场5场双方齐全 ${s.withVenueFiveBothTeams}场；伤停有报告 ${s.injuriesReported}场；首发已报告 ${s.lineupsReported}场。</p><p><b>本轮两个玩法均不下注。</b>以下单一方向为价格研究参考，不能把旧报价当作当前可执行赔率。</p><details><summary>分析范围与规则</summary><ul>${report.methodology.map(row => `<li>${esc(row)}</li>`).join('')}</ul></details></header>
  <nav>${report.matches.map((row, i) => `<a href="#m${i}">${i + 1}. ${esc(teamName(row.fixture.home))}</a>`).join('')}</nav>
  ${report.matches.map((row, i) => `<article id="m${i}"><h2>${i + 1}. ${esc(teamName(row.fixture.home))} vs ${esc(teamName(row.fixture.away))}</h2><p class="muted">${esc(row.fixture.league)} · ${time(row.fixture.kickoff)}（北京时间） · 赛事身份${row.identityVerified ? '已核验' : '未通过核验'}</p>${row.scheduleChanged ? `<p class="reason">已发现改期：原 ${time(row.originalKickoff)} → 最新 ${time(row.fixture.kickoff)}。旧时间关联的赔率不采用。</p>` : ''}
  ${marketHtml('胜平负', row.markets.matchWinner, row.actions.matchWinner)}${marketHtml('大小球（全场2.5）', row.markets.goalsOverUnder25, row.actions.goalsOverUnder25)}
  <div class="grid"><div><h3>主队近期与主场</h3><p>近5场：${formText(row.history.home.last5)}<br>近5主场：${formText(row.history.home.venueLast5)}<br>距上场开球：${row.history.home.restDays ?? '未知'}天</p></div><div><h3>客队近期与客场</h3><p>近5场：${formText(row.history.away.last5)}<br>近5客场：${formText(row.history.away.venueLast5)}<br>距上场开球：${row.history.away.restDays ?? '未知'}天</p></div></div>
  <p>同联赛交锋（本报告主队视角）：${formText(row.history.headToHead)}；样本不足5场时不能视为完整交锋结论。</p>
  <p>伤停：${row.injuries.status === 'reported' ? row.injuries.records.length + '条供应商记录' : '未取得供应商伤停记录，不能认定无人伤停'}。首发：${row.lineups.status === 'reported' ? '供应商已报告' : '尚未公布/未取得确认'}。</p>
  <details><summary>伤停记录</summary><ul>${row.injuries.records.map(record => `<li>${esc(teamName(record.team))}：${esc(record.player)} · ${esc(record.type)} · ${esc(record.reason)}</li>`).join('') || '<li>无可核验记录</li>'}</ul></details>
  <p>独立胜平负辅助：${row.independentForecast.signals.map(signal => esc(signal.sourceId) + ' ' + esc(pickNames[signal.selection]) + ' ' + pct(signal.probability)).join('；') || '无有效记录'}。与市场方向：${({same_direction:'同向',conflict:'冲突',missing:'缺独立辅助',market_unavailable:'市场未通过核验'})[row.independentForecast.comparison]}。该信息不用于补造大小球概率。</p>
  <p class="muted">API模型百分比（未校准）：${row.providerPrediction.status === 'available' ? esc(JSON.stringify(row.providerPrediction.prediction?.percent)) : '赛事身份未核验，不采用'}。亚洲让球报价公司数：${row.markets.asianHandicap?.companyCount ?? 0}；该维度独立记录，不能替代胜平负或大小球。</p></article>`).join('')}
  </main></html>`;
}
