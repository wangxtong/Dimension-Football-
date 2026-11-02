import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, atomicJson, readJson } from './storage.mjs';
import { runPublic } from './public.mjs';
import { runCli, SAFE_ERRORS } from './run.mjs';
import { fetchPublicResults } from './sources/public-fixtures.mjs';
import { collectFootballDataHistory } from './sources/football-data-history.mjs';
import { verifyAcquisitionSnapshot } from './data/acquisition-snapshot.mjs';
import { verifyReplayBundle } from './data/run-manifest.mjs';
import { prepareForecastHistory, BACKTEST_HORIZONS, FORECAST_MODEL } from './forecast.mjs';
import { appendResultAndScore, evaluatePredictionLedger } from './prediction-ledger.mjs';
import { isoMillis } from './policy.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { requireGreenForecastDelivery } from './publication-release-gate.mjs';

const LANES = new Set(['fixtures', 'markets', 'delivery', 'results']);
const HELP = '用法：node collector/orchestrate.mjs --lane fixtures|markets|delivery|results [--mode publish|private-research] [--state FILE] [--out DIR] [--budget-minutes N]\nprivate-research 仅冻结和结算私有研究，不能执行 delivery，不构成正式发布。默认报告目录 /var/lib/vantis/reports；--help 不访问网络、不写文件。\n';
const BLOCKERS = new Set(['FIXTURE_CACHE_EXPIRED', 'FIXTURE_CACHE_MISSING', 'ACQUISITION_SNAPSHOT_CHANGED', 'INVALID_ACQUISITION_SNAPSHOT',
  'NO_GENERATED_REPORT', 'COLLECTION_ALREADY_LOCKED', 'INPUT_ARCHIVE_INCOMPLETE', 'CANCELLED', 'BUDGET_EXHAUSTED', 'RELEASE_GATE_BLOCKED']);
const MANAGED_KEYS = ['FOOTBALL_DATA_API_KEY', 'FOOTBALL_DATA_API_TOKEN', 'API_FOOTBALL_KEY', 'SPORTMONKS_API_TOKEN'];
const dynamicPublisher = async (directory, options) => (await import('./delivery.mjs')).publishAll(directory,
  { ...options, config: await readJson(resolve(import.meta.dirname, '../config/delivery.json')) });
const ORCHESTRATION_ERRORS = new Set(['INVALID_ORCHESTRATION_ARGUMENTS', 'INVALID_LANE', 'ORCHESTRATION_STATE_INVALID',
  'INVALID_RUN_MANIFEST', 'INVALID_REPLAY_INPUTS', 'RUN_INPUT_HASH_MISMATCH', 'RUN_REPORT_ID_MISMATCH', 'RUN_CODE_VERSION_MISMATCH',
  'IMMUTABLE_LEDGER_CONFLICT', 'LEDGER_INTEGRITY_FAILURE', 'IMMUTABLE_REPLAY_CONFLICT', 'PUBLICATION_REPORT_MISMATCH',
  'PUBLICATION_NOT_READY', 'PUBLICATION_CONTENT_CHANGED', 'PUBLICATION_SEQUENCE_INCOMPLETE', 'INVALID_PROSPECTIVE_EVALUATION']);
const deliveryIncomplete = receipt => receipt.channels && Object.values(receipt.channels).some(row => ['failed', 'unknown'].includes(row.status))
  || receipt.channels?.externalWebsite?.status === 'not_configured';
const privateOutcome = outcome => ({ ...outcome, mode: 'private-research', forecastPublished: false,
  publicationStatus: 'not_attempted', releaseGate: { decision: 'BLOCKED', productionAuthorization: false },
  meaning: 'Private pre-match freezes and result scoring are not evidence of public forecast delivery.' });

export function parseOrchestrationArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--help') { if (options.help) throw new Error('DUPLICATE_ARGUMENT'); options.help = true; continue; }
    if (!['--lane', '--mode', '--state', '--out', '--budget-minutes'].includes(argument)) throw new Error('UNKNOWN_ARGUMENT');
    const key = argument.slice(2), value = argv[++i];
    if (!value || value.startsWith('--') || options[key] !== undefined) throw new Error('INVALID_ARGUMENT');
    options[key] = value;
  }
  if (options.help) return options;
  if (!LANES.has(options.lane)) throw new Error('INVALID_LANE');
  const mode = options.mode || 'publish';
  if (!['publish', 'private-research'].includes(mode)) throw new Error('INVALID_ORCHESTRATION_MODE');
  if (mode === 'private-research' && options.lane === 'delivery') throw new Error('PRIVATE_RESEARCH_DELIVERY_FORBIDDEN');
  const minutes = Number(options['budget-minutes'] ?? 2);
  if (!Number.isFinite(minutes) || minutes * 60000 < 100 || minutes > 20) throw new Error('INVALID_BUDGET');
  return { ...options, mode, budgetMs: Math.floor(minutes * 60000) };
}

async function retainedInputs(directory) {
  let manifest, inputs;
  try { manifest = await readJson(resolve(directory, 'run-manifest.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { inputs = await readJson(resolve(directory, 'run-inputs.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!manifest && !inputs) return { fixtures: [], history: [] };
  if (!manifest || !inputs) throw new Error('INPUT_ARCHIVE_INCOMPLETE');
  return verifyReplayBundle({ manifest, inputs }).inputs;
}

async function laneReceipt(statePath, lane, outcome, checkedAt) {
  const path = `${statePath}.lanes.json`; let previous;
  try { previous = await readJson(path, 64000); }
  catch (error) { if (error.code !== 'ENOENT') throw error; previous = { version: 1, lanes: {} }; }
  if (previous?.version !== 1 || !previous.lanes || Array.isArray(previous.lanes)
    || Object.keys(previous.lanes).some(key => !LANES.has(key))) throw new Error('ORCHESTRATION_STATE_INVALID');
  previous.lanes[lane] = { checkedAt, status: outcome.status, code: outcome.code || null,
    reportId: /^[a-f0-9]{64}$/.test(outcome.reportId || '') ? outcome.reportId : null,
    exitCode: outcome.exitCode, ...(outcome.summary ? { summary: outcome.summary } : {}),
    ...(outcome.mode === 'private-research' ? { mode: outcome.mode, forecastPublished: false, publicationStatus: 'not_attempted' } : {}),
    ...(outcome.releaseGate ? { releaseGate:outcome.releaseGate } : {}) };
  await atomicJson(path, previous);
}

function mergedHistory(previous, current) {
  const records = new Map(previous.map(row => [`${row.source}:${row.id}`, row]));
  for (const row of current) records.set(`${row.source}:${row.id}`, row);
  return prepareForecastHistory([...records.values()]);
}

export async function runOrchestration(argv = [], { env = process.env, cwd = process.cwd(), clock = () => new Date().toISOString(),
  stdout = text => process.stdout.write(text), fetchImpl = fetch, signal, dependencies = {} } = {}) {
  const options = parseOrchestrationArgs(argv);
  if (options.help) { stdout(HELP); return { help: true, exitCode: 0 }; }
  const statePath = resolve(cwd, options.state || '/var/lib/vantis/state/state.json'), out = resolve(cwd, options.out || '/var/lib/vantis/reports');
  const started = performance.now(), remaining = () => Math.max(0, options.budgetMs - (performance.now() - started));
  const dep = { runPublic, runCli, fetchPublicResults, appendResultAndScore, evaluatePredictionLedger, publishAll: dynamicPublisher, collectHistory: collectFootballDataHistory, ...dependencies };
  const common = { env, cwd, clock, fetchImpl, stdout, signal };
  let release = null, outcome;
  try {
    if (!Number.isFinite(isoMillis(clock()))) throw new Error('INVALID_NOW');
    if (signal?.aborted) throw new Error('CANCELLED');
    release = await acquireLock(`${statePath}.orchestration`);
    const args = () => {
      if (remaining() < 100) throw new Error('BUDGET_EXHAUSTED');
      return ['--state', statePath, '--out', out, '--budget-minutes', String(remaining() / 60000)];
    };
    const publish = async reportId => {
      if (signal?.aborted) throw new Error('CANCELLED');
      if (remaining() < 1) throw new Error('BUDGET_EXHAUSTED');
      await requireGreenForecastDelivery(out);
      const boundedFetch = (url, init = {}) => fetchImpl(url, { ...init,
        signal: AbortSignal.any([init.signal, signal, AbortSignal.timeout(Math.max(1, Math.ceil(remaining())))].filter(Boolean)) });
      return dep.publishAll(out, { env, fetchImpl: boundedFetch, clock, ...(reportId ? { expectedReportId: reportId } : {}) });
    };
    if (options.lane === 'delivery') {
      if (fetchImpl === fetch) configureEnvironmentProxy(env);
      const receipt = await publish();
      outcome = { lane: options.lane, status: deliveryIncomplete(receipt) ? 'partial' : 'complete', reportId: receipt.reportId, receipt,
        ...(deliveryIncomplete(receipt) ? { code: 'DELIVERY_INCOMPLETE' } : {}), exitCode: deliveryIncomplete(receipt) ? 1 : 0 };
    } else if (options.lane === 'markets') {
      let input;
      try { input = await readJson(resolve(out, 'public-fixtures.json')); }
      catch (error) { if (error.code === 'ENOENT') throw new Error('FIXTURE_CACHE_MISSING'); throw error; }
      const snapshot = verifyAcquisitionSnapshot(input, { nowISO: clock() });
      const now = Date.parse(clock()), due = snapshot.fixtures.filter(row => ['SCHEDULED', 'TIMED'].includes(row.status)
        && Date.parse(row.kickoff) > now && Date.parse(row.kickoff) <= now + 86400000);
      if (!due.length) outcome = { lane: options.lane, status: 'skipped', code: 'NO_FIXTURES_WITHIN_24_HOURS', exitCode: 0 };
      else {
        const collection = await dep.runCli(['--basic', '--input', resolve(out, 'public-fixtures.json'), ...args()],
          { ...common, evidenceMode: 'markets', marketHorizonHours: 24, persistAcquisition: false });
        const reportId = collection.report?.publication?.reportId;
        if (!reportId) throw new Error('NO_GENERATED_REPORT');
        if (options.mode === 'private-research') outcome = { lane: options.lane, status: collection.exitCode || collection.report.status === 'partial' || collection.report.status === 'failed'
          ? 'partial' : 'complete', reportId, collection, exitCode: collection.exitCode || 0 };
        else {
          const receipt = await publish(reportId);
          outcome = { lane: options.lane, status: collection.exitCode || collection.report.status === 'partial' || collection.report.status === 'failed'
            || deliveryIncomplete(receipt) ? 'partial' : 'complete', reportId, receipt, collection,
            ...(deliveryIncomplete(receipt) ? { code: 'DELIVERY_INCOMPLETE' } : {}), exitCode: collection.exitCode || Number(!!deliveryIncomplete(receipt)) };
        }
      }
    } else if (options.lane === 'fixtures') {
      const priorInputs = await retainedInputs(out);
      let fallbackHistory = priorInputs.history;
      const managed = MANAGED_KEYS.some(key => typeof env[key] === 'string' && env[key].trim()) || !!env.FIXTURES_FILE;
      const footballDataKey = [env.FOOTBALL_DATA_API_KEY, env.FOOTBALL_DATA_API_TOKEN]
        .find(value => typeof value === 'string' && value.trim());
      // 免费采集默认只有德甲(OpenLigaDB)历史，其余四大联赛样本不足会让当日可预测场次变成 0。
      // 这里用同一 football-data 账号补齐同源已完赛结果；历史属于增强项，失败只降级、不阻断赛程采集。
      if (managed && footballDataKey && options.mode === 'private-research') {
        try {
          const extra = await dep.collectHistory({ apiKey: footballDataKey.trim(), nowISO: clock(),
            fetchImpl, signal, timeoutMs: 12_000 });
          if (extra && Array.isArray(extra.history) && extra.history.length) {
            const merged = new Map(fallbackHistory.map(row => [row.source + ':' + row.id, row]));
            for (const row of extra.history) merged.set(row.source + ':' + row.id, row);
            fallbackHistory = [...merged.values()];
          }
        } catch { /* 历史补齐失败时沿用既有 fallbackHistory */ }
      }
      const result = await dep.runPublic(['--collect', ...args()], { ...common, collectMode: managed ? 'managed' : 'public',
        evidenceMode: 'none', fallbackHistory, persistAcquisition: true, runCliImpl: dep.runCli });
      const reportId = result.collection?.report?.publication?.reportId;
      if (!reportId) throw new Error('NO_GENERATED_REPORT');
      if (options.mode === 'private-research') outcome = { lane: options.lane, status: result.exitCode || result.collection.report.status === 'partial' || result.collection.report.status === 'failed'
        ? 'partial' : 'complete', reportId, collection: result.collection, exitCode: result.exitCode || 0 };
      else {
        const receipt = await publish(reportId);
        outcome = { lane: options.lane, status: result.exitCode || result.collection.report.status === 'partial' || result.collection.report.status === 'failed'
          || deliveryIncomplete(receipt) ? 'partial' : 'complete', reportId, receipt, collection: result.collection,
          ...(deliveryIncomplete(receipt) ? { code: 'DELIVERY_INCOMPLETE' } : {}), exitCode: result.exitCode || Number(!!deliveryIncomplete(receipt)) };
      }
    } else {
      if (fetchImpl === fetch) configureEnvironmentProxy(env);
      const priorInputs = await retainedInputs(out), previous = priorInputs.history, publicResults = await dep.fetchPublicResults({ nowISO: clock(), clock, fetchImpl, signal, remaining,
        historyCachePath: `${statePath}.history.json`, cooldownStatePath: `${statePath}.public-cooldown.json` });
      let imported = [];
      if (typeof env.HISTORY_FILE === 'string' && env.HISTORY_FILE) {
        const value = await readJson(resolve(cwd, env.HISTORY_FILE)); imported = Array.isArray(value) ? value : value?.history;
        if (!Array.isArray(imported)) throw new Error('INVALID_HISTORY_FILE');
      }
      const clean = mergedHistory(previous, [...publicResults.history, ...imported]), directory = resolve(out, 'forecast-ledger');
      let recorded = 0, scored = 0, skipped = clean.rejected + clean.logicalConflicts;
      for (const result of clean.matches) {
        if (signal?.aborted) throw new Error('CANCELLED');
        if (remaining() <= 0) throw new Error('BUDGET_EXHAUSTED');
        if (!Number.isFinite(isoMillis(result.resultObservedAt || result.observedAt))) { skipped++; continue; }
        const saved = await dep.appendResultAndScore({ directory, result, nowISO: clock() });
        recorded += Number(saved.result.created); scored += saved.scores.filter(row => row.created).length;
      }
      const groups = [], identities = [...new Map([...clean.matches, ...priorInputs.fixtures]
        .map(row => [`${row.source}:${row.league}`, { source: row.source, league: row.league }])).values()];
      for (const identity of identities) for (const horizonHours of BACKTEST_HORIZONS) {
        if (remaining() <= 0) throw new Error('BUDGET_EXHAUSTED');
        groups.push({ ...identity, provenance: 'prospective-ledger', ...await dep.evaluatePredictionLedger({ directory, nowISO: clock(),
          horizonHours, toleranceHours: 1, source: identity.source, league: identity.league, modelId: FORECAST_MODEL.id, modelVersion: FORECAST_MODEL.version }) });
      }
      const generatedAt = clock(), evaluation = { version: 1, kind: 'prospective-evaluation', generatedAt, model: FORECAST_MODEL,
        ...(options.mode === 'private-research' ? { scope: 'private-research-freezes', forecastPublished: false, releaseGate: 'BLOCKED' } : {}),
        groups, diagnostics: publicResults.diagnostics, summary: { recordedResults: recorded, recordedScores: scored, skipped },
        limitations: ['Only retained pre-kickoff predictions can produce prospective scores.',
          'Automatic result refresh currently covers OpenLigaDB BL1; other providers require verified normalized historical inputs.'] };
      await atomicJson(resolve(out, 'prospective-evaluation.json'), evaluation);
      const partial = publicResults.diagnostics.some(row => row.status === 'unavailable') || clean.matches.some(row => row.source !== 'openligadb');
      outcome = { lane: options.lane, status: partial ? 'partial' : 'complete', summary: evaluation.summary, evaluation, exitCode: 0 };
    }
    if (options.mode === 'private-research') outcome = privateOutcome(outcome);
    await laneReceipt(statePath, options.lane, outcome, clock());
  } catch (error) {
    const code = BLOCKERS.has(error.message) || SAFE_ERRORS.has(error.message) || ORCHESTRATION_ERRORS.has(error.message) ? error.message : 'LANE_FAILED';
    outcome = { lane: options.lane, status: BLOCKERS.has(code) ? 'blocked' : 'failed', code, exitCode: 1 };
    if (code === 'RELEASE_GATE_BLOCKED' && error.releaseGate)
      outcome.releaseGate = error.releaseGate;
    if (options.mode === 'private-research') outcome = privateOutcome(outcome);
    if (release) await laneReceipt(statePath, options.lane, outcome, clock());
  } finally { if (release) await release(); }
  stdout(`${options.lane}: ${outcome.status}${outcome.code ? ` (${outcome.code})` : ''}\n`);
  return outcome;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = (await runOrchestration(process.argv.slice(2), { signal: controller.signal })).exitCode; }
  catch { console.error('调度入口失败：INVALID_ORCHESTRATION_ARGUMENTS'); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
