import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readJson } from './storage.mjs';
import { readPolicy, DEFAULT_POLICY, isoMillis } from './policy.mjs';
import { runCollection } from './pipeline.mjs';
import { collectIntegratedEvidence } from './sources/index.mjs';
import { readProviderPolicy, readProviderHealth, providerStatus } from './sources/providers.mjs';
import { readCrawlerPolicy } from './sources/crawler.mjs';
import { browserRuntime } from './browser.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { collectManagedFixtures, readSourcePolicy, readSourceHealth, sourceHealthSnapshot } from './sources/manager.mjs';
import { demoInput } from './demo.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const HELP = `维度足球长期公开信息采集（Node.js 24+）

用法：npm run collect -- [选项]
  --input FILE             新鲜的真实赛程JSON；数组或 {"fixtures": [...]}；也可设置 FIXTURES_FILE
  --state FILE             检查点；默认 .collection-state/state.json
  --out DIR                双版本报告目录；默认 reports
  --config FILE            规则配置；默认 config/collection.json
  --sources-config FILE    信息源优先级与冷却配置；默认 config/sources.json
  --crawler-config FILE    网页爬虫限速、重试和缓存；默认 config/crawler.json
  --providers-config FILE 商业数据接口配置；默认 config/providers.json
  --provider-status        离线查看接口能力、凭据配置状态及历史健康，不显示密钥
  --source-status          离线查看指定 --state 对应的来源健康记录，不发起请求
  --budget-minutes N       单轮预算，不超过20分钟
  --evidence FILE          外部证据 {"quotes": [...], "signals": [...]}，默认不受信任
  --accept-reviewed-evidence 明确确认这些证据已由所有者核验；来源/身份/时间仍逐项检查
  --demo                   无网络模拟，使用独立检查点，生产候选始终为0
  --deep-analysis          用 API_FOOTBALL_KEY 对全部赛事逐项取证并输出独立HTML/JSON分析
  --help                   显示帮助

不指定赛程文件时，优先使用 FOOTBALL_DATA_API_KEY（别名 FOOTBALL_DATA_API_TOKEN）；
未配置或不完整时尝试 API_FOOTBALL_KEY、SPORTMONKS_API_TOKEN；失败冷却后自动复查。
配置 SPORTMONKS_API_TOKEN、THE_ODDS_API_KEY、ISPORTS_API_KEY 后自动采集对应分析材料。
深度分析固定使用 API-Football 赛事身份，不能用另一家的赛程代替。
程序不需要 OpenAI API，不发送 Telegram，不调用旧站点写接口或任何下注接口。
`;

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--demo', '--help', '--accept-reviewed-evidence', '--deep-analysis', '--source-status', '--provider-status'].includes(argument)) {
      const key = argument.slice(2); if (Object.hasOwn(result, key)) throw new Error('DUPLICATE_ARGUMENT'); result[key] = true; continue;
    }
    if (!['--input', '--state', '--out', '--config', '--sources-config', '--crawler-config', '--providers-config', '--budget-minutes', '--evidence'].includes(argument)) throw new Error('UNKNOWN_ARGUMENT');
    const key = argument.slice(2), value = argv[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error('INVALID_ARGUMENT');
    result[key] = value;
  }
  if (result['accept-reviewed-evidence'] && !result.evidence || result.demo && (result.input || result.evidence || result['deep-analysis'])) throw new Error('CONFLICTING_ARGUMENTS');
  if (result['source-status'] && Object.keys(result).some(key => !['source-status', 'state', 'sources-config', 'help'].includes(key))) throw new Error('CONFLICTING_ARGUMENTS');
  if (result['provider-status'] && Object.keys(result).some(key => !['provider-status', 'state', 'providers-config', 'help'].includes(key))) throw new Error('CONFLICTING_ARGUMENTS');
  if (result['budget-minutes'] !== undefined) {
    const minutes = Number(result['budget-minutes']);
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 20 || minutes * 60_000 < 100) throw new Error('INVALID_BUDGET');
    result.budgetMs = Math.floor(minutes * 60_000);
  }
  return result;
}

function reviewedEvidence(value, accepted) {
  if (!value || !Array.isArray(value.quotes) || !Array.isArray(value.signals) || value.quotes.length + value.signals.length > 30_000) throw new Error('INVALID_EVIDENCE_FILE');
  const normalize = rows => rows.map(row => ({ ...row, verified: accepted === true, verificationMethod: accepted ? 'owner-verified' : 'unverified' }));
  return { quotes: normalize(value.quotes), signals: normalize(value.signals) };
}

export async function runCli(argv, {
  env = process.env, cwd = process.cwd(), clock = () => new Date().toISOString(),
  stdout = text => process.stdout.write(text), fetchImpl = fetch, signal,
} = {}) {
  const options = parseArgs(argv);
  if (options.help) { stdout(HELP); return { help: true, exitCode: 0 }; }
  if (fetchImpl === fetch && !options.demo && !options['source-status'] && !options['provider-status']) configureEnvironmentProxy(env);
  const providerPolicy = readProviderPolicy(await readJson(options['providers-config'] ? resolve(cwd, options['providers-config']) : resolve(ROOT, 'config/providers.json')));
  if (options['provider-status']) {
    const state = await readProviderHealth(`${resolve(cwd, options.state || '.collection-state/state.json')}.providers.json`);
    const providers = providerStatus({ env, state, policy: providerPolicy, nowISO: clock() });
    stdout(`${JSON.stringify(providers, null, 2)}\n`);
    return { providers, exitCode: 0 };
  }
  const sourcePolicy = readSourcePolicy(await readJson(options['sources-config'] ? resolve(cwd, options['sources-config']) : resolve(ROOT, 'config/sources.json')));
  if (options['source-status']) {
    const healthPath = `${resolve(cwd, options.state || '.collection-state/state.json')}.sources.json`;
    const sourceManagement = sourceHealthSnapshot(await readSourceHealth(healthPath), sourcePolicy, clock());
    stdout(`${JSON.stringify(sourceManagement, null, 2)}\n`);
    return { sourceManagement, exitCode: 0 };
  }
  if (options['deep-analysis'] && (typeof env.API_FOOTBALL_KEY !== 'string' || !env.API_FOOTBALL_KEY.trim())) throw new Error('DEEP_ANALYSIS_API_KEY_REQUIRED');
  const crawlerPolicy = readCrawlerPolicy(await readJson(options['crawler-config'] ? resolve(cwd, options['crawler-config']) : resolve(ROOT, 'config/crawler.json')));
  const policy = readPolicy(await readJson(options.config ? resolve(cwd, options.config) : resolve(ROOT, 'config/collection.json')));
  if (options.budgetMs !== undefined) policy.budgetMs = options.budgetMs;
  const startedTick = performance.now(), remaining = () => Math.max(0, policy.budgetMs - (performance.now() - startedTick));
  const nowISO = clock();
  if (!Number.isFinite(isoMillis(nowISO))) throw new Error('INVALID_NOW');
  const statePath = resolve(cwd, options.state || (options.demo ? '.collection-state-demo/state.json' : '.collection-state/state.json'));
  const outDir = resolve(cwd, options.out || 'reports');
  // Global deadline is combined with every adapter's own per-request deadline.
  const boundedFetch = (signal) => async (url, init = {}) => {
    const left = Math.ceil(remaining());
    if (left <= 0 || signal?.aborted) throw new Error('BUDGET_EXHAUSTED');
    const signals = [init.signal, signal, abortSignal, AbortSignal.timeout(Math.max(1, left))].filter(Boolean);
    return fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
  };
  const abortSignal = signal;
  let fixtures, fixtureDiagnostics = [], poolComplete = true, simulated = !!options.demo, demo, sourceManagement = null;
  const inputFile = options.input || (!simulated && env.FIXTURES_FILE);
  const deepAnalysis = options['deep-analysis'] || (!simulated && !inputFile
    && typeof env.API_FOOTBALL_KEY === 'string' && env.API_FOOTBALL_KEY.trim()
    && ![env.FOOTBALL_DATA_API_KEY, env.FOOTBALL_DATA_API_TOKEN, env.SPORTMONKS_API_TOKEN].some(value => typeof value === 'string' && value.trim()));
  if (simulated) { demo = demoInput(nowISO); fixtures = demo.fixtures; }
  else if (inputFile) {
    const input = await readJson(resolve(cwd, inputFile));
    fixtures = Array.isArray(input) ? input : input?.fixtures;
    if (!Array.isArray(fixtures)) throw new Error('INVALID_FIXTURE_FILE');
    poolComplete = false; // The size of a supplied pool says nothing about global/site coverage.
    fixtureDiagnostics = [{ id: 'owner-fixtures', status: 'available', code: 'INPUT_POOL_ONLY', checkedAt: nowISO, matchedCount: fixtures.length }];
  } else {
    const footballDataKey = [env.FOOTBALL_DATA_API_KEY, env.FOOTBALL_DATA_API_TOKEN].find(value => typeof value === 'string' && value.trim());
    const apiFootballKey = typeof env.API_FOOTBALL_KEY === 'string' && env.API_FOOTBALL_KEY.trim() ? env.API_FOOTBALL_KEY : null;
    const sportmonksKey = typeof env.SPORTMONKS_API_TOKEN === 'string' && env.SPORTMONKS_API_TOKEN.trim() ? env.SPORTMONKS_API_TOKEN : null;
    if (!footballDataKey && !apiFootballKey && !sportmonksKey) throw new Error('FIXTURE_API_KEY_OR_INPUT_REQUIRED');
    const result = await collectManagedFixtures({ statePath: `${statePath}.sources.json`,
      credentials: { 'football-data.org': footballDataKey, 'api-football': apiFootballKey, sportmonks: sportmonksKey }, policy: sourcePolicy,
      nowISO, clock, days: policy.days, fetchImpl: boundedFetch(), signal, remaining,
      requiredSource: deepAnalysis ? 'api-football' : null });
    fixtures = result.fixtures;
    fixtureDiagnostics = result.diagnostics;
    poolComplete = result.poolComplete;
    sourceManagement = result.management;
  }
  const importedEvidence = options.evidence ? reviewedEvidence(await readJson(resolve(cwd, options.evidence)), options['accept-reviewed-evidence']) : { quotes: [], signals: [] };
  const result = await runCollection({ fixtures, statePath, outDir, policy, simulated, fixtureDiagnostics, poolComplete, sourceManagement, clock, startedTick, signal,
    importedEvidence, collectEvidence: simulated ? async () => structuredClone(demo.evidence)
      : async ({ fixtures, nowISO, signal: stageSignal }) => collectIntegratedEvidence({ fixtures, nowISO, env,
        providerStatePath: `${statePath}.providers.json`, providerPolicy, fetchImpl: boundedFetch(stageSignal),
        statePath: `${statePath}.crawl.json`, policy: crawlerPolicy, clock, remaining,
        browser: await browserRuntime({env, enabled: fetchImpl === fetch}),
        signal: AbortSignal.any([signal, stageSignal].filter(Boolean)) }),
  });
  const allFixturesFailed = !inputFile && !simulated && fixtureDiagnostics.length > 0 && fixtureDiagnostics.every(source => !['available', 'complete'].includes(source.status));
  const exitCode = signal?.aborted || sourceManagement?.interrupted || allFixturesFailed || result.report.status === 'failed' ? 1 : 0;
  const s = result.report.summary;
  stdout(`${simulated ? '【模拟验证】' : '【真实采集】'}${result.report.status}；输入池${s.total}场，本轮深查${s.processed}场，待续查${s.pending}场，生产候选${s.candidates}场。\n`);
  stdout(`报告：${result.files.briefPath}\n详细：${result.files.messagePath}\n`);
  if (sourceManagement) stdout(`赛程来源：${sourceManagement.selectedSource || '不可用'}；自动切换：${sourceManagement.fallbackUsed ? '是' : '否'}。\n`);
  if (deepAnalysis) {
    const [{ fetchFullAnalysisData }, { buildFullAnalysis, renderFullAnalysisHtml }] = await Promise.all([
      import('./sources/full-analysis.mjs'), import('./full-report.mjs'),
    ]);
    const data = await fetchFullAnalysisData({ fixtures, apiKey: env.API_FOOTBALL_KEY, nowISO: clock(),
      clock, fetchImpl: boundedFetch(signal), signal, maxRequests: 250 });
    const analysis = buildFullAnalysis({ evidence: data.evidence, marketSnapshot: data.marketSnapshot,
      priorHistory: data.priorHistory, independentReport: result.report });
    analysis.collectionStatus = data.status;
    analysis.collectionCoverage = data.coverage;
    const fullDirectory = resolve(outDir, 'full-analysis');
    await mkdir(fullDirectory, { recursive: true });
    for (const [name, value] of Object.entries({ 'evidence.json': data.evidence, 'markets.json': data.marketSnapshot,
      'history.json': data.priorHistory, 'diagnostics.json': data.diagnostics, 'latest.json': analysis })) {
      await writeFile(resolve(fullDirectory, name), JSON.stringify(value, null, 2));
    }
    const fullHtml = resolve(fullDirectory, 'latest.html');
    await writeFile(fullHtml, renderFullAnalysisHtml(analysis));
    result.fullAnalysis = analysis;
    result.fullAnalysisFiles = { html: fullHtml, json: resolve(fullDirectory, 'latest.json') };
    stdout(`逐项分析：${analysis.summary.processedAllDimensions}/${analysis.summary.fixtures}场；身份核验${analysis.summary.identityVerified}场；胜平负报价${analysis.summary.withMatchWinnerMarket}场；大小球报价${analysis.summary.withGoalsMarket}场。\n${fullHtml}\n`);
  }
  return { ...result, exitCode };
}

export const SAFE_ERRORS = new Set(['INVALID_POLICY', 'FIXTURE_POOL_INVALID_OR_TOO_LARGE', 'INVALID_FIXTURE', 'CONFLICTING_FIXTURE_ID',
  'INVALID_NOW', 'JSON_FILE_TOO_LARGE', 'COLLECTION_ALREADY_LOCKED', 'STATE_UNREADABLE', 'STATE_INVALID_OR_MODE_MISMATCH',
  'DUPLICATE_ARGUMENT', 'UNKNOWN_ARGUMENT', 'INVALID_ARGUMENT', 'CONFLICTING_ARGUMENTS', 'INVALID_BUDGET', 'INVALID_EVIDENCE_FILE',
  'INVALID_FIXTURE_FILE', 'FIXTURE_API_KEY_OR_INPUT_REQUIRED', 'EXAMPLE_FIXTURES_REQUIRE_DEMO', 'DEEP_ANALYSIS_API_KEY_REQUIRED',
  'INVALID_SOURCE_POLICY', 'SOURCE_STATE_UNREADABLE', 'SOURCE_STATE_INVALID', 'REQUIRED_SOURCE_DISABLED',
  'INVALID_CRAWLER_POLICY', 'CRAWLER_STATE_UNREADABLE', 'CRAWLER_STATE_INVALID',
  'INVALID_PROVIDER_POLICY', 'PROVIDER_STATE_UNREADABLE', 'PROVIDER_STATE_INVALID',
  'ENV_PROXY_REQUIRES_NODE_24_14', 'ENV_PROXY_CONFIGURATION_INVALID']);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = (await runCli(process.argv.slice(2), { signal: controller.signal })).exitCode; }
  catch (error) {
    console.error(`采集未完成：${SAFE_ERRORS.has(error?.message) ? error.message : 'COLLECTION_FAILED'}。使用 --help 查看运行方式；检查点会在已成功处理的场次后保存。`);
    process.exitCode = 1;
  }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
