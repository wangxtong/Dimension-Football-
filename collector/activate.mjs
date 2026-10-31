import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { readJson, atomicJson } from './storage.mjs';
import { runCli, parseArgs, SAFE_ERRORS } from './run.mjs';
import { providerStatus, readProviderPolicy } from './sources/providers.mjs';
import { readSourcePolicy } from './sources/manager.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE_KEYS = {
  'football-data.org': ['FOOTBALL_DATA_API_KEY', 'FOOTBALL_DATA_API_TOKEN'],
  'api-football': ['API_FOOTBALL_KEY'], sportmonks: ['SPORTMONKS_API_TOKEN'],
};
const present = value => typeof value === 'string' && !!value.trim();

// Configuration presence is not proof of entitlement or a successful API response.
export function activationPlan({ env, providerPolicy, sourcePolicy, nowISO }) {
  const fixtures = Object.entries(FIXTURE_KEYS).map(([id, keys]) => ({
    id, envNames: keys, enabled: sourcePolicy.fixturePriority.includes(id),
    configured: keys.some(key => present(env[key])),
  }));
  const fixtureFileConfigured = present(env.FIXTURES_FILE);
  return { version: 1, checkedAt: nowISO, status: 'configuration_required',
    canCollect: fixtureFileConfigured || fixtures.some(row => row.enabled && row.configured),
    fixtureFileConfigured, fixtures,
    providers: providerStatus({ env, policy: providerPolicy, nowISO }).map(row => ({
      id: row.id, name: row.name, envName: row.env ?? null, configured: row.configured,
      enabled: row.enabled, status: row.status === 'ready_to_check' ? 'not_attempted' : row.status,
      requests: 0, observationCount: 0,
    })), collection: null, error: null };
}

export function activationMarkdown(report) {
  return `# 数据源应用验收\n\n状态：${report.status}；检查时间：${report.checkedAt}\n\n`
    + '配置存在不等于授权有效；data_received 仅表示本轮收到匹配材料，不代表正式预测候选。\n\n'
    + '| 数据源 | 状态 | 请求数 | 匹配材料数 | 所需变量 |\n| --- | --- | ---: | ---: | --- |\n'
    + report.providers.map(row => `| ${row.name} | ${row.status} | ${row.requests} | ${row.observationCount} | ${row.envName || '需先取得接口协议与授权'} |`).join('\n')
    + `\n\n赛程凭据：${report.fixtures.map(row => `${row.id}=${row.configured ? '已配置' : '未配置'}${row.enabled ? '' : '（已禁用）'}`).join('；')}。\n`
    + `\n真实赛程文件：${report.fixtureFileConfigured ? '已声明，采集时校验' : '未配置'}。\n`
    + (report.collection ? `\n本轮采集状态：${report.collection.status}；输入池 ${report.collection.fixtures} 场；正式候选 ${report.collection.candidates} 场。\n` : '\n未执行真实采集。\n')
    + (report.error ? `\n错误：${report.error}。\n` : '')
    + '\n缺少配置时只生成本验收报告；不会使用模拟数据替代真实结果。定时采集仍由仓库变量 VANTIS_COLLECTION_ENABLED=true 开启。\n';
}

export async function runActivation(argv = [], {
  env = process.env, cwd = process.cwd(), clock = () => new Date().toISOString(),
  stdout = text => process.stdout.write(text), collect = runCli, signal,
} = {}) {
  const options = parseArgs(argv);
  if (Object.keys(options).some(key => !['state', 'out', 'budget-minutes', 'budgetMs'].includes(key))) throw new Error('INVALID_ARGUMENT');
  const [providerPolicy, sourcePolicy] = await Promise.all([
    readJson(resolve(ROOT, 'config/providers.json')).then(readProviderPolicy),
    readJson(resolve(ROOT, 'config/sources.json')).then(readSourcePolicy),
  ]);
  const report = activationPlan({ env, providerPolicy, sourcePolicy, nowISO: clock() });
  const outDir = resolve(cwd, options.out || 'reports');
  let exitCode = 0;
  if (report.canCollect) {
    try {
      const args = ['--basic', '--state', options.state || '.collection-state/state.json',
        '--out', options.out || 'reports', '--budget-minutes', options['budget-minutes'] || '5'];
      const result = await collect(args, { env, cwd, clock, stdout, signal });
      exitCode = result.exitCode;
      report.status = exitCode ? 'collection_failed' : 'collection_completed';
      report.collection = { status: result.report.status, fixtures: result.report.summary.total,
        candidates: result.report.summary.candidates };
      for (const row of report.providers) {
        const attempt = result.report.providers?.attempts?.find(attempt => attempt.id === row.id);
        if (!attempt) continue;
        row.requests = attempt.requests;
        row.observationCount = attempt.observationCount || 0;
        row.status = attempt.status === 'checked' ? row.observationCount ? 'data_received' : 'no_matching_data'
          : attempt.status === 'not_checked' ? 'not_attempted' : attempt.status;
      }
    } catch (error) {
      exitCode = 1;
      report.status = 'collection_failed';
      report.error = SAFE_ERRORS.has(error?.message) ? error.message : 'COLLECTION_FAILED';
    }
  }
  await mkdir(outDir, { recursive: true });
  await atomicJson(resolve(outDir, 'activation.json'), report);
  const markdown = activationMarkdown(report);
  await writeFile(resolve(outDir, 'activation.md'), markdown);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, markdown);
  stdout(markdown);
  return { report, exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = (await runActivation(process.argv.slice(2), { signal: controller.signal })).exitCode; }
  catch (error) {
    console.error(`应用验收失败：${SAFE_ERRORS.has(error?.message) ? error.message : 'ACTIVATION_FAILED'}`);
    process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
