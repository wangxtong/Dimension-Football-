import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './storage.mjs';
import { readPolicy, DEFAULT_POLICY, isoMillis } from './policy.mjs';
import { runCollection } from './pipeline.mjs';
import { collectPublicEvidence, fetchFootballFixtures, fetchApiFootballFixtures } from './sources/index.mjs';
import { demoInput } from './demo.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const HELP = `维度足球长期公开信息采集（Node.js 24+）

用法：npm run collect -- [选项]
  --input FILE             新鲜的真实赛程JSON；数组或 {"fixtures": [...]}；也可设置 FIXTURES_FILE
  --state FILE             检查点；默认 .collection-state/state.json
  --out DIR                双版本报告目录；默认 reports
  --config FILE            规则配置；默认 config/collection.json
  --budget-minutes N       单轮预算，不超过20分钟
  --evidence FILE          外部证据 {"quotes": [...], "signals": [...]}，默认不受信任
  --accept-reviewed-evidence 明确确认这些证据已由所有者核验；来源/身份/时间仍逐项检查
  --demo                   无网络模拟，使用独立检查点，生产候选始终为0
  --help                   显示帮助

不指定赛程文件时，优先使用 FOOTBALL_DATA_API_KEY（别名 FOOTBALL_DATA_API_TOKEN）；
未配置时使用 API_FOOTBALL_KEY，分别连接 football-data.org 与 API-Football 官方接口。
程序不需要 OpenAI API，不发送 Telegram，不调用旧站点写接口或任何下注接口。
`;

export function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (['--demo', '--help', '--accept-reviewed-evidence'].includes(argument)) {
      const key = argument.slice(2); if (Object.hasOwn(result, key)) throw new Error('DUPLICATE_ARGUMENT'); result[key] = true; continue;
    }
    if (!['--input', '--state', '--out', '--config', '--budget-minutes', '--evidence'].includes(argument)) throw new Error('UNKNOWN_ARGUMENT');
    const key = argument.slice(2), value = argv[++index];
    if (!value || value.startsWith('--') || Object.hasOwn(result, key)) throw new Error('INVALID_ARGUMENT');
    result[key] = value;
  }
  if (result['accept-reviewed-evidence'] && !result.evidence || result.demo && (result.input || result.evidence)) throw new Error('CONFLICTING_ARGUMENTS');
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
  let fixtures, fixtureDiagnostics = [], poolComplete = true, simulated = !!options.demo, demo;
  const inputFile = options.input || (!simulated && env.FIXTURES_FILE);
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
    if (!footballDataKey && !apiFootballKey) throw new Error('FIXTURE_API_KEY_OR_INPUT_REQUIRED');
    const fetchFixtures = footballDataKey ? fetchFootballFixtures : fetchApiFootballFixtures;
    const result = await fetchFixtures({ apiKey: footballDataKey || apiFootballKey, nowISO, days: policy.days, fetchImpl: boundedFetch() });
    fixtures = result.fixtures;
    fixtureDiagnostics = result.diagnostics;
    poolComplete = fixtureDiagnostics.length === 5 && fixtureDiagnostics.every(source => ['available', 'complete'].includes(source.status));
  }
  const importedEvidence = options.evidence ? reviewedEvidence(await readJson(resolve(cwd, options.evidence)), options['accept-reviewed-evidence']) : { quotes: [], signals: [] };
  const result = await runCollection({ fixtures, statePath, outDir, policy, simulated, fixtureDiagnostics, poolComplete, clock, startedTick, signal,
    importedEvidence, collectEvidence: simulated ? async () => structuredClone(demo.evidence)
      : async ({ fixtures, nowISO, signal }) => collectPublicEvidence({ fixtures, nowISO, fetchImpl: boundedFetch(signal) }),
  });
  const allFixturesFailed = !inputFile && !simulated && fixtureDiagnostics.length > 0 && fixtureDiagnostics.every(source => !['available', 'complete'].includes(source.status));
  const exitCode = signal?.aborted || allFixturesFailed || result.report.status === 'failed' ? 1 : 0;
  const s = result.report.summary;
  stdout(`${simulated ? '【模拟验证】' : '【真实采集】'}${result.report.status}；输入池${s.total}场，本轮深查${s.processed}场，待续查${s.pending}场，生产候选${s.candidates}场。\n`);
  stdout(`报告：${result.files.briefPath}\n详细：${result.files.messagePath}\n`);
  return { ...result, exitCode };
}

export const SAFE_ERRORS = new Set(['INVALID_POLICY', 'FIXTURE_POOL_INVALID_OR_TOO_LARGE', 'INVALID_FIXTURE', 'CONFLICTING_FIXTURE_ID',
  'INVALID_NOW', 'JSON_FILE_TOO_LARGE', 'COLLECTION_ALREADY_LOCKED', 'STATE_UNREADABLE', 'STATE_INVALID_OR_MODE_MISMATCH',
  'DUPLICATE_ARGUMENT', 'UNKNOWN_ARGUMENT', 'INVALID_ARGUMENT', 'CONFLICTING_ARGUMENTS', 'INVALID_BUDGET', 'INVALID_EVIDENCE_FILE',
  'INVALID_FIXTURE_FILE', 'FIXTURE_API_KEY_OR_INPUT_REQUIRED', 'EXAMPLE_FIXTURES_REQUIRE_DEMO']);

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
