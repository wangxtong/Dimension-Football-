import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readJson } from '../storage.mjs';

const ORIGIN = 'https://www.statarea.com', LIMIT = 1_500_000;
const safeError = code => Object.assign(new Error(code), { code });
export function browserTarget(url) {
  try { const u = new URL(url); return u.origin === ORIGIN && !u.username && !u.password && !u.search && !u.hash
    && /^\/predictions(?:\/date\/20\d{2}-\d{2}-\d{2}\/competition)?$/.test(u.pathname); } catch { return false; }
}
async function executable(env, chromium) {
  const candidates = env.VANTIS_BROWSER_EXECUTABLE ? [env.VANTIS_BROWSER_EXECUTABLE]
    : [chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw safeError('browser_not_installed');
}
async function authorizedState(path) {
  if (!path) return undefined;
  const info = await stat(path);
  if (!info.isFile() || process.platform !== 'win32' && (info.mode & 0o077)) throw safeError('browser_session_permissions');
  const data = await readJson(path, 2_000_000);
  if (!Array.isArray(data?.cookies) || !Array.isArray(data.origins) || data.cookies.length > 500
    || data.cookies.some(cookie => !['www.statarea.com', '.statarea.com', 'statarea.com', '.www.statarea.com'].includes(cookie.domain))
    || data.origins.some(row => row.origin !== ORIGIN)) throw safeError('browser_session_scope_invalid');
  return data;
}

export async function createBrowserRuntime({ env = process.env, pageSetup } = {}) {
  if (env.VANTIS_CRAWLER_RUNTIME_DIR && !isAbsolute(env.VANTIS_CRAWLER_RUNTIME_DIR)) throw safeError('browser_runtime_path_invalid');
  const require = createRequire(env.VANTIS_CRAWLER_RUNTIME_DIR ? resolve(env.VANTIS_CRAWLER_RUNTIME_DIR, 'package.json') : import.meta.url);
  const { chromium } = require('playwright');
  const { PlaywrightCrawler, Configuration, ProxyConfiguration, Log, LogLevel } = require('@crawlee/playwright');
  const crawleeVersion = require('@crawlee/playwright/package.json').version, playwrightVersion = require('playwright/package.json').version;
  if (crawleeVersion !== '3.18.2' || playwrightVersion !== '1.64.1') throw safeError('browser_dependency_version_mismatch');
  const executablePath = await executable(env, chromium);
  const storageState = await authorizedState(env.VANTIS_STATAREA_STORAGE_STATE);
  const proxyUrl = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (proxyUrl && !['http:', 'https:'].includes(new URL(proxyUrl).protocol)) throw safeError('browser_proxy_unsupported');
  const metadata = { engine: 'crawlee-playwright', crawleeVersion, playwrightVersion,
    available: true, sessionConfigured: !!storageState, proxyConfigured: !!proxyUrl, browserRequests: 0 };

  async function fetchRendered(url, init = {}) {
    if (!browserTarget(url) || init.method && init.method !== 'GET') throw safeError('browser_target_denied');
    if (init.signal?.aborted) throw safeError('crawler_cancelled');
    let result, failure, resourceRequests = 0;
    // Per-call memory storage: no session cookies, raw HTML or request logs on disk.
    const config = new Configuration({ persistStorage: false, purgeOnStart: true, defaultRequestQueueId: randomUUID(),
      storageClientOptions: { persistStorage: false, writeMetadata: false } });
    const crawler = new PlaywrightCrawler({
      log: new Log({ level: LogLevel.OFF }), minConcurrency: 1, maxConcurrency: 1,
      maxRequestsPerCrawl: 1, maxRequestRetries: 0, maxSessionRotations: 0,
      useSessionPool: false, persistCookiesPerSession: false, retryOnBlocked: false,
      navigationTimeoutSecs: 15, requestHandlerTimeoutSecs: 5,
      ...(proxyUrl ? { proxyConfiguration: new ProxyConfiguration({ proxyUrls: [proxyUrl] }) } : {}),
      launchContext: { launcher: chromium, useIncognitoPages: true,
        launchOptions: { executablePath, headless: true, timeout: 10_000 } },
      browserPoolOptions: { useFingerprints: true, maxOpenPagesPerBrowser: 1,
        prePageCreateHooks: [(_id, _controller, options) => {
          Object.assign(options, { ignoreHTTPSErrors: false, acceptDownloads: false, serviceWorkers: 'block',
            ...(storageState ? { storageState } : {}) });
        }] },
      preNavigationHooks: [async ({ page }, gotoOptions) => {
        gotoOptions.waitUntil = 'domcontentloaded';
        await page.route('**/*', async route => {
          const request = route.request(), target = new URL(request.url());
          if (init.signal?.aborted || target.origin !== ORIGIN || request.method() !== 'GET'
            || ['image', 'media', 'font'].includes(request.resourceType()) || resourceRequests >= 20
            || request.isNavigationRequest() && !browserTarget(request.url())) return route.abort();
          resourceRequests++; metadata.browserRequests++;
          await route.continue();
        });
        // Dependency injection used by browser tests to serve local fixture HTML without public traffic.
        if (pageSetup) await pageSetup(page);
      }],
      requestHandler: async ({ page, response }) => {
        if (!response || !browserTarget(page.url())) throw safeError('browser_navigation_failed');
        const status = response.status(), headers = await response.allHeaders();
        if (Number(headers['content-length']) > LIMIT) throw safeError('crawler_response_too_large');
        await page.waitForSelector('.gmt, .competition', { timeout: 1000 }).catch(() => {});
        const text = await page.content();
        if (Buffer.byteLength(text) > LIMIT) throw safeError('crawler_response_too_large');
        if (storageState) headers['cache-control'] = 'no-store';
        // Only HTTP navigation metadata supplies dates; DOM execution never refreshes source timestamps.
        result = { text, status, headers };
      },
      failedRequestHandler: (_context, error) => { failure = ['crawler_response_too_large'].includes(error?.code) ? error.code : 'browser_navigation_failed'; },
    }, config);
    const stop = () => { crawler.browserPool.destroy().catch(() => {}); };
    init.signal?.addEventListener('abort', stop, { once: true });
    try {
      await crawler.run([{ url, uniqueKey: randomUUID() }]);
      if (init.signal?.aborted) throw safeError('crawler_cancelled');
      if (!result || failure) throw safeError(failure || 'browser_navigation_failed');
      return new Response(result.text, { status: result.status, headers: result.headers });
    } finally { init.signal?.removeEventListener('abort', stop); await crawler.browserPool.destroy(); }
  }
  async function verify() {
    let browser;
    try {
      browser = await chromium.launch({ executablePath, headless: true, timeout: 10_000 });
      const page = await browser.newPage();
      await page.setContent('<html><body><script>document.body.dataset.ready="yes"</script></body></html>');
      return { ...metadata, launchVerified: await page.locator('body').getAttribute('data-ready') === 'yes',
        platform: process.platform, arch: process.arch, node: process.versions.node };
    } finally { await browser?.close(); }
  }
  return { fetch: fetchRendered, matches: browserTarget, metadata, verify };
}
