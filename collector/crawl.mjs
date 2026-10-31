import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson } from './storage.mjs';
import { PUBLIC_PROBES, withPublicCrawler, readCrawlerPolicy } from './sources/crawler.mjs';
import { browserRuntime } from './browser.mjs';
import { configureEnvironmentProxy } from './network.mjs';

export async function runCrawlCheck(argv, { cwd = process.cwd(), fetchImpl = fetch, signal, env = process.env,
  clock = () => new Date().toISOString(), stdout = text => process.stdout.write(text) } = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help') { stdout('npm run crawl:check -- [--source all|titan007|statarea|tiantian] [--state FILE] [--out FILE] [--crawler-config FILE] [--budget-seconds 1..60]\n只验证公开抓取链路，不生成赛事预测。\n'); return { exitCode: 0 }; }
    if (!['--source', '--state', '--out', '--crawler-config', '--budget-seconds'].includes(key) || options[key]
      || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('INVALID_CRAWL_ARGUMENT');
    options[key] = argv[++i];
  }
  const source = options['--source'] || 'all', budget = Number(options['--budget-seconds'] || 45) * 1000;
  if (!['all', 'titan007', 'statarea', 'tiantian'].includes(source) || !Number.isInteger(budget) || budget < 1000 || budget > 60_000) throw new Error('INVALID_CRAWL_ARGUMENT');
  const policy = readCrawlerPolicy(await readJson(options['--crawler-config'] ? resolve(cwd, options['--crawler-config']) : resolve(import.meta.dirname, '../config/crawler.json')));
  if (fetchImpl === fetch) configureEnvironmentProxy(env);
  const started = performance.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), budget);
  const combined = AbortSignal.any([signal, controller.signal].filter(Boolean));
  try {
    const { result, crawler } = await withPublicCrawler({ policy, statePath: resolve(cwd, options['--state'] || '.collection-state/crawl-check.json'),
      browser: await browserRuntime({env, enabled: fetchImpl === fetch}),
      fetchImpl, clock, signal: combined, remaining: () => budget - (performance.now() - started) }, async fetchPublic => {
      return Promise.all(PUBLIC_PROBES.filter(probe => source === 'all' || probe.sourceId === source).map(async probe => {
        try {
          const response = await fetchPublic(probe.url, probe.init);
          return { sourceId: probe.sourceId, endpoint: probe.url, status: 'fetched', bytes: Buffer.byteLength(await response.text()) };
        } catch { return { sourceId: probe.sourceId, endpoint: probe.url, status: 'unavailable' }; }
      }));
    });
    const report = { version: 1, kind: 'public-crawler-transport-check', checkedAt: clock(),
      evidence: 'HTTP抓取检查；不证明赛程身份、解析覆盖或预测有效性。', results: result, crawler };
    const outputPath = resolve(cwd, options['--out'] || 'reports/crawl-check.json');
    await atomicJson(outputPath, report);
    stdout(`公开爬虫抓取：${result.filter(row => row.status === 'fetched').length}/${result.length} 个端点返回内容；网络请求 ${crawler.networkRequests} 次。\n报告：${outputPath}\n`);
    return { report, outputPath, exitCode: combined.aborted || result.some(row => row.status !== 'fetched') ? 1 : 0 };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { process.exitCode = (await runCrawlCheck(process.argv.slice(2), { signal: controller.signal })).exitCode; }
  catch (error) {
    const safe = ['INVALID_CRAWL_ARGUMENT', 'INVALID_CRAWLER_POLICY', 'CRAWLER_STATE_INVALID', 'CRAWLER_STATE_UNREADABLE', 'COLLECTION_ALREADY_LOCKED'];
    console.error(safe.includes(error.message) ? error.message : 'CRAWL_CHECK_FAILED'); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
