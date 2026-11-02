import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, atomicJson } from './storage.mjs';
import { readPredictionLedger, frozenPredictionIssues, scorePredictionRecord } from './prediction-ledger.mjs';
import { scoreProbabilities, validProbabilities } from './forecast-evaluation.mjs';
import { teamName } from './sources/team-names.mjs';
import { venueFor } from './sources/venue-coordinates.mjs';
import { attachWeather, weatherSummary } from './sources/weather.mjs';

const DAY = 86_400_000;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
// 'football-data.org' 才是采集端写入 fixture.source 的真实值；只认 'football-data'
// 会让该来源的比赛在研究日报里整批被跳过（每天表现为 0 场）。
const SOURCES = new Set(['openligadb', 'thesportsdb-free', 'api-football', 'football-data', 'football-data.org']);
const LEAGUES = new Set(['PL', 'PD', 'SA', 'BL1', 'FL1']);
const LABEL = '研究参考，非投注建议；概率未经正式校准，不代表有投注价值或保证命中率。';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const dayCN = value => new Date(Date.parse(value) + 8 * 3600_000).toISOString().slice(0, 10);
const lowerDay = (now, days) => new Date(Date.parse(dayCN(now) + 'T00:00:00.000Z') - (days - 1) * DAY).toISOString().slice(0, 10);
const plain = value => typeof value === 'string' && value.length <= 200 && !/[\x00-\x1f\x7f]/u.test(value);
const finiteOrNull = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
// 天气是“开球时段实况预报”的展示附件，不参与任何概率或账本计算；非法输入一律降级成 unavailable。
const WEATHER_REASONS = new Set(['disabled', 'no-venue', 'no-kickoff', 'hour-out-of-range',
  'budget-exhausted', 'request-failed', 'timeout', 'invalid-response', 'not-fetched']);
function safeWeather(row) {
  if (!row || typeof row !== 'object' || row.status !== 'ok') {
    const reason = row && typeof row.reason === 'string' && WEATHER_REASONS.has(row.reason)
      ? row.reason : 'not-fetched';
    return { status: 'unavailable', reason };
  }
  const hourUTC = typeof row.hourUTC === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(row.hourUTC)
    ? row.hourUTC : null;
  const temperatureC = finiteOrNull(row.temperatureC);
  if (hourUTC === null || temperatureC === null) return { status: 'unavailable', reason: 'invalid-response' };
  return { status: 'ok', hourUTC, temperatureC, windKmh: finiteOrNull(row.windKmh),
    precipitationMm: finiteOrNull(row.precipitationMm),
    precipitationProbabilityPct: finiteOrNull(row.precipitationProbabilityPct),
    weatherCode: finiteOrNull(row.weatherCode),
    source: plain(row.source) ? row.source : 'open-meteo',
    model: plain(row.model) ? row.model : 'best_match' };
}
function safeForecast(row) {
  return row && SOURCES.has(row.source) && LEAGUES.has(row.league)
    && HASH.test(row.reportId || '') && HASH.test(row.modelHash || '')
    && frozenPredictionIssues(row).length === 0;
}
function chooseFrozen(event, nowMs) {
  const candidates = event.predictions.filter(row => validTime(row.recordedAt)
    && Date.parse(row.recordedAt) <= nowMs && safeForecast(row))
    .sort((a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt)
      || a.predictionId.localeCompare(b.predictionId));
  return candidates[0] || null;
}
function resolution(event, prediction, nowMs) {
  const versions = event.results.filter(row => validTime(row.recordedAt)
    && validTime(row.resultObservedAt) && Date.parse(row.recordedAt) <= nowMs
    && Date.parse(row.resultObservedAt) <= nowMs
    && row.source === prediction.source && row.fixtureId === prediction.fixtureId)
    .sort((a, b) => Date.parse(b.resultObservedAt) - Date.parse(a.resultObservedAt)
      || a.resultVersionId.localeCompare(b.resultVersionId));
  if (!versions.length) return { status: 'pending-ft' };
  if (versions[1] && versions[1].resultObservedAt === versions[0].resultObservedAt
    && versions[1].contentHash !== versions[0].contentHash) return { status: 'ambiguous-ft' };
  let score;
  try { score = scorePredictionRecord(prediction, versions[0]); }
  catch { return { status: 'identity-conflict' }; }
  if (score.status !== 'scored') return { status: score.status };
  if (!validTime(versions[0].resultObservedAt) || Date.parse(versions[0].resultObservedAt) <= Date.parse(prediction.kickoff))
    return { status: 'invalid-ft-clock' };
  return { status: 'scored', actual: score.actual, resultVersionId: versions[0].resultVersionId,
    resultObservedAt: versions[0].resultObservedAt, ...scoreProbabilities(prediction.probabilities, score.actual) };
}
function summarize(rows, today, days) {
  const start = lowerDay(today + 'T00:00:00.000Z', days);
  const selected = rows.filter(row => row.kickoffDay >= start && row.kickoffDay <= today);
  const scored = selected.filter(row => row.score.status === 'scored');
  const pending = selected.filter(row => row.score.status === 'pending-ft' || row.score.status === 'pending-postponed');
  const voided = selected.length - scored.length - pending.length;
  const average = key => scored.reduce((n, row) => n + row.score[key], 0) / scored.length;
  return { days, fromDay: start, toDay: today, eligibleFrozen: selected.length, scored: scored.length,
    pending: pending.length, voided, hitRate: scored.length ? average('accuracy') : null,
    brier: scored.length ? average('brier') : null, logLoss: scored.length ? average('logLoss') : null,
    sampleStatus: scored.length >= 30 ? 'descriptive-only' : 'insufficient-prospective-sample' };
}
function chronology(doc, ledger, nowMs) {
  const reportId = doc?.publication?.reportId;
  const indexes = new Map(ledger.events.flatMap(event => event.predictions
    .filter(row => row.reportId === reportId)
    .map(row => [row.source + ':' + row.fixtureId + ':' + row.predictionId, row])));
  const pool = [];
  for (const row of doc?.fixtures || []) {
    const f = row.fixture, p = row.forecast;
    if (!f || !p || p.status !== 'forecast' || !validTime(f.kickoff)
      || Date.parse(f.kickoff) <= nowMs || Date.parse(f.kickoff) > nowMs + 36 * 3600_000
      || !SOURCES.has(f.source) || !LEAGUES.has(f.league)) continue;
    if (!plain(f.home) || !plain(f.away) || !validProbabilities(p.probabilities)) continue;
    const record = [...indexes.values()].find(x => x.fixtureId === f.id && x.source === f.source
      && x.reportId === reportId && x.kickoff === new Date(f.kickoff).toISOString()
      && x.generatedAt === p.generatedAt && safeForecast(x)
      && Object.keys(x.probabilities).every(k => Math.abs(x.probabilities[k] - p.probabilities[k]) < 1e-8)
      && Date.parse(x.validUntil) > nowMs);
    if (!record) continue;
    pool.push({ predictionId: record.predictionId, fixtureId: f.id, source: f.source, league: f.league,
      home: f.home, away: f.away, kickoff: f.kickoff, recordedAt: record.recordedAt,
      sourceReportId: reportId, modelId: record.model.id, modelVersion: record.model.version,
      modelHash: record.modelHash, trainingHash: record.trainingHash,
      probabilities: record.probabilities, selection: Object.entries(record.probabilities)
        .sort((a, b) => b[1] - a[1])[0][0], calibrated: record.model.calibrated === true,
      expectedGoals: record.expectedGoals ?? null, topScores: record.topScores ?? [] });
  }
  return pool.sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff) || a.fixtureId.localeCompare(b.fixtureId));
}
export function buildDailyResearchReport({ document = null, ledger, nowISO, codeSha, weather = null }) {
  if (!validTime(nowISO) || !COMMIT.test(codeSha || '') || !ledger || !Array.isArray(ledger.events))
    throw new Error('RESEARCH_INPUT_INVALID');
  const today = dayCN(nowISO), nowMs = Date.parse(nowISO);
  if (document && (document.simulated !== false || document.kind !== 'prematch-forecast-report'
    || !HASH.test(document.publication?.reportId || '') || !validTime(document.generatedAt)
    || Date.parse(document.generatedAt) > nowMs || !Array.isArray(document.fixtures)))
    throw new Error('RESEARCH_SOURCE_REPORT_INVALID');
  const current = document && dayCN(document.generatedAt) === today;
  const predictions = current && ledger.exists ? chronology(document, ledger, nowMs) : [];
  const weatherRows = weather && typeof weather === 'object' && !Array.isArray(weather) ? weather : {};
  const all = ledger.events.map(event => ({ event, frozen: chooseFrozen(event, nowMs) }))
    .filter(row => row.frozen)
    .map(({ event, frozen }) => ({ kickoffDay: dayCN(frozen.kickoff), league: frozen.league, source: frozen.source,
      fixtureId: frozen.fixtureId, modelId: frozen.model.id, modelVersion: frozen.model.version,
      modelHash: frozen.modelHash, predictionId: frozen.predictionId, score: resolution(event, frozen, nowMs) }));
  const trailing30 = summarize(all, today, 30);
  const perLeague = [...LEAGUES].map(league => ({ league, ...summarize(all.filter(row => row.league === league), today, 30) }));
  const payload = { version: 1, kind: 'research-daily-1x2', mode: 'research-reference', disclaimer: LABEL,
    generatedAt: nowISO, beijingDay: today, codeSha, sourceReportId: current ? document.publication.reportId : null,
    sourceReportSha256: current ? hash(document) : null,
    state: !current ? 'no-today-source-report' : !ledger.exists ? 'ledger-not-restored'
      : predictions.length ? 'frozen-research-forecasts' : 'zero-qualified-forecasts',
    forecasts: { total: predictions.length, candidates: predictions.map(row => ({ ...row,
      venue: venueFor(row.home) ? { city: venueFor(row.home).city } : null,
      weather: safeWeather(weatherRows[row.source + ':' + row.fixtureId]) })), skipped: current
      ? document.fixtures.length - predictions.length : 0, isPublishedRecommendation: false },
    prospective: { provenance: 'immutable-prematch-ledger-plus-observed-full-time',
      uniqueFixtureRule: 'earliest-valid-frozen-prediction-per-source-fixture',
      oneDay: summarize(all, today, 1), sevenDays: summarize(all, today, 7), thirtyDays: trailing30,
      byLeague30Days: perLeague, retainedFrozen: all.length },
    strictMarkets: { separation: 'independent-dual-source-and-provider-opening',
      sourceScreenedCandidates: current ? document.summary?.strictCandidates ?? null : null,
      releasedCandidates: 0, reviewed: false, note: '严格盘口必须独立验真双源和供应商原生初盘；本研究报表不替盘口授权或正式发布。' },
    commercialReleaseGate: 'BLOCKED', researchGate: 'INDEPENDENT_OF_COMMERCIAL',
    externalTelegramSent: false,
    limitations: ['天气为开球整点（UTC）的 Open-Meteo 预报（免费、无key、CC-BY-4.0），按主队所在城市坐标获取；查不到坐标显示“—”，不猜测；天气不参与概率、预期进球、大小球或比分计算，也不写入冻结账本。',
      '结果按真实赛前冻结账本及事后实际取得的90分钟FT计算；未取得FT的保持pending。',
      '每日、7日、30日为北京时间赛事开赛日窗口；同场只计最早合格冻结一次，按联赛/版本查看避免混合解释。',
      '研究模型未经正式校准，当前输出不代表投注建议或正式预测发布。',
      '常规研究不依赖双源盘口；严格盘口仍需双独立来源、真实初盘，0场可为0场。',
      '来源采集与跨日连续性、线上展示及通知送达须由独立验收；GitHub cron不是SLA。'] };
  return { ...payload, reportId: hash(payload) };
}
function pct(value) { return value === null ? '无已评分样本' : (value * 100).toFixed(1) + '%'; }
export function renderDailyResearchMarkdown(report) {
  const lines = ['# 维度足球｜每日1X2研究参考', '', '**研究参考，非投注建议。** 不是正式推荐，不保证命中率。', '',
    '北京时间：' + report.beijingDay + '；版本：' + report.codeSha + '；报告ID：' + report.reportId, '',
    '研究状态：' + report.state + '；今日有效冻结 ' + report.forecasts.total + ' 场；严格盘口实际对外候选 0 场（独立核验）。', '',
    '| 赛事 | 开球(UTC) | 天气(开球时段) | 主胜 | 平 | 客胜 | 研究最高概率 | 预期进球(主/客) | 大小球 | 比分参考 |',
    '| --- | --- | --- | ---: | ---: | ---: | --- | ---: | --- | --- |'];
  for (const row of report.forecasts.candidates) {
    const eg = row.expectedGoals;
    const total = eg ? eg.home + eg.away : null;
    const scores = row.topScores.map(s => s.home + ':' + s.away).join('/') || '—';
    lines.push('| ' + teamName(row.home).replace(/[|\r\n]/g,' ') + ' vs '
      + teamName(row.away).replace(/[|\r\n]/g,' ') + ' | ' + row.kickoff + ' | '
      + weatherSummary(row.weather).cn + ' | '
      + pct(row.probabilities.home) + ' | ' + pct(row.probabilities.draw) + ' | '
      + pct(row.probabilities.away) + ' | ' + ({home:'主胜',draw:'平',away:'客胜'}[row.selection]) + ' | '
      + (eg ? eg.home.toFixed(1) + '/' + eg.away.toFixed(1) : '—') + ' | '
      + (total === null ? '—' : (total >= 2.5 ? '大2.5' : '小2.5') + '(' + total.toFixed(1) + ')') + ' | '
      + scores + ' |');
  }
  if (!report.forecasts.total) lines.push('| — | — | — | — | — | — | 无合格赛前研究预测，不补场 |');
  lines.push('', '天气：Open-Meteo 免费接口（CC-BY-4.0），取开球整点（UTC）预报，按主队所在城市坐标获取；'
    + '查不到坐标显示“—”，不猜测、不插值。天气仅是展示附件，不参与概率、预期进球、大小球或比分计算。', '',
    '## 真实前瞻FT核账（每场只计一次）', '',
    '| 窗口 | 冻结场数 | 已评分 | 待FT | 无效/作废 | 命中率 | Brier | LogLoss |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of [report.prospective.oneDay, report.prospective.sevenDays, report.prospective.thirtyDays])
    lines.push('| ' + row.days + '日 | ' + row.eligibleFrozen + ' | ' + row.scored + ' | '
      + row.pending + ' | ' + row.voided + ' | ' + pct(row.hitRate) + ' | '
      + (row.brier === null ? '—' : row.brier.toFixed(4)) + ' | '
      + (row.logLoss === null ? '—' : row.logLoss.toFixed(4)) + ' |');
  lines.push('', '说明：历史回测、模拟数据、赛后补造预测均不得计入真实前瞻。不同模型版本合并总体仅作描述性统计；若真实评分不足30场不作优劣结论。', '');
  return lines.join('\n');
}
export async function produceDailyResearchReport({ root, nowISO = new Date().toISOString(), codeSha = process.env.GITHUB_SHA } = {}) {
  if (!root) throw new Error('RESEARCH_ROOT_REQUIRED');
  const out = resolve(root, 'reports'), directory = resolve(out, 'forecast-ledger');
  let document = null;
  try { document = await readJson(join(out, 'predictions.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ledger = await readPredictionLedger({ directory });
  let report = buildDailyResearchReport({ document, ledger, nowISO, codeSha });
  if (report.forecasts.total && process.env.WEATHER_ENABLED !== '0') {
    try {
      const matches = report.forecasts.candidates.map(row => ({ key: row.source + ':' + row.fixtureId,
        home: row.home, kickoff: row.kickoff }));
      const attached = await attachWeather(matches, { venueByKey: venueFor });
      report = buildDailyResearchReport({ document, ledger, nowISO, codeSha, weather: attached.weather });
    } catch {
      // 天气属于展示附件：获取失败保留无天气版本，绝不阻断日报。
    }
  }
  const target = join(out, 'research-daily');
  await mkdir(target, { recursive: true });
  await atomicJson(join(target, 'latest.json'), report);
  await writeFile(join(target, 'latest.md'), renderDailyResearchMarkdown(report));
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.length !== 2 || argv[0] !== '--root') {
    console.error('用法：node collector/research-daily-report.mjs --root <已验证研究状态目录>');
    process.exitCode = 2;
  } else {
    try {
      const value = await produceDailyResearchReport({ root: argv[1] });
      console.log(JSON.stringify({ kind: value.kind, state: value.state, reportId: value.reportId,
        frozen: value.forecasts.total, scored30Days: value.prospective.thirtyDays.scored,
        commercialReleaseGate: value.commercialReleaseGate, telegramSent: value.externalTelegramSent }));
    } catch(error) {
      console.error('RESEARCH_DAILY_REPORT_FAILED: ' + (/^RESEARCH_|^LEDGER_|^INVALID_/.test(error?.message || '') ? error.message : 'UNVERIFIED_INPUT'));
      process.exitCode = 1;
    }
  }
}
