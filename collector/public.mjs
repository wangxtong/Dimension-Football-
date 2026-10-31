import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { atomicJson } from './storage.mjs';
import { fetchPublicFixtures } from './sources/public-fixtures.mjs';
import { configureEnvironmentProxy } from './network.mjs';
import { runCli, parseArgs, SAFE_ERRORS } from './run.mjs';

export async function runPublic(argv = [], { env = process.env, cwd = process.cwd(),
  clock = () => new Date().toISOString(), fetchImpl = fetch, stdout = text => process.stdout.write(text), signal,
  collectMode = 'public', evidenceMode = 'all', fallbackHistory = [], runCliImpl = runCli, persistAcquisition = false } = {}) {
  const collect = argv.includes('--collect');
  if (argv.filter(value => value === '--collect').length > 1) throw new Error('DUPLICATE_ARGUMENT');
  const options = parseArgs(argv.filter(value => value !== '--collect'));
  if (options.help) { stdout('用法：node collector/public.mjs [--collect] [--state FILE] [--out DIR] [--budget-minutes N]\n'); return { help: true, exitCode: 0 }; }
  if (!['public', 'managed'].includes(collectMode) || Object.keys(options).some(key => !['state', 'out', 'budget-minutes', 'budgetMs', 'evidence', 'accept-reviewed-evidence'].includes(key))
    || !collect && (options.evidence || options['accept-reviewed-evidence'])) throw new Error('INVALID_ARGUMENT');
  if (fetchImpl === fetch) configureEnvironmentProxy(env);
  const started = performance.now(), budgetMs = options.budgetMs || 300000;
  const remaining = () => Math.max(0, budgetMs - (performance.now() - started));
  const outDir = resolve(cwd, options.out || 'reports/public');
  const statePath = resolve(cwd, options.state || '.collection-state/public/state.json');
  const manifest = await fetchPublicFixtures({ nowISO: clock(), fetchImpl, clock, signal, remaining, includeHistory: collect,
    historyCachePath: `${statePath}.history.json`, cooldownStatePath: `${statePath}.public-cooldown.json` });
  const input = resolve(outDir, 'public-fixtures.json');
  await atomicJson(input, manifest);
  await atomicJson(resolve(outDir, 'public-source-fixtures.json'), manifest);
  // Keep the ODbL-derived portion separately downloadable with its attribution.
  await atomicJson(resolve(outDir, 'openligadb-fixtures.json'), {
    attribution: manifest.sources[0], checkedAt: manifest.checkedAt,
    fixtures: manifest.fixtures.filter(fixture => fixture.source === 'openligadb'),
    history: manifest.history,
  });
  const lines = ['# 公开信息源试接入', '', `检查时间：${manifest.checkedAt}；真实赛程样本：${manifest.fixtures.length} 场；完赛历史：${manifest.history.length} 场；完整覆盖：否。`, '',
    '| 来源 | 联赛 | 状态 | HTTP | 收到 / 有效赛程 |', '| --- | --- | --- | --- | ---: |',
    ...manifest.diagnostics.map(row => `| ${row.id} | ${row.league} | ${row.code} | ${row.httpStatus ?? '—'} | ${row.receivedCount ?? 0} / ${row.matchedCount} |`), '',
    ...manifest.limitations.map(value => `- ${value}`), '',
    '[OpenLigaDB 数据与 ODbL 许可](https://www.openligadb.de/lizenz)；[本轮 OpenLigaDB 数据](openligadb-fixtures.json)。',
    '[TheSportsDB 官方免费接口说明](https://www.thesportsdb.com/docs_api_guide.php)。', ''];
  await writeFile(resolve(outDir, 'public-sources.md'), lines.join('\n'));
  stdout(`公开源试接入：${manifest.fixtures.length} 场真实赛程样本；覆盖不完整。\n来源与许可：${resolve(outDir, 'public-sources.md')}\n`);
  if (signal?.aborted || remaining() < 100 || !manifest.fixtures.length && collectMode === 'public') return { manifest, exitCode: 1, collection: null };
  if (!collect) return { manifest, exitCode: 0, collection: null };
  const collection = await runCliImpl([...(collectMode === 'public' ? ['--basic', '--input', input] : []), '--state', statePath,
    '--out', outDir, '--budget-minutes', String(remaining() / 60000),
    ...(collectMode === 'managed' && typeof env.HISTORY_FILE === 'string' && env.HISTORY_FILE ? ['--history', env.HISTORY_FILE] : []),
    ...(options.evidence ? ['--evidence', options.evidence] : []), ...(options['accept-reviewed-evidence'] ? ['--accept-reviewed-evidence'] : [])],
    { env, cwd, clock, fetchImpl, stdout, signal, evidenceMode, fallbackHistory, persistAcquisition });
  return { manifest, collection, exitCode: collection.exitCode };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = (await runPublic(process.argv.slice(2), { signal: controller.signal })).exitCode; }
  catch (error) { console.error(`公开源试接入失败：${SAFE_ERRORS.has(error?.message) ? error.message : 'PUBLIC_COLLECTION_FAILED'}`); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
