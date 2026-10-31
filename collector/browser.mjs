import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function browserRuntime({ env = process.env, enabled = true } = {}) {
  const mode = env.VANTIS_CRAWLER_ENGINE || 'auto';
  if (!['auto', 'http', 'crawlee'].includes(mode)) throw new Error('INVALID_CRAWLER_ENGINE');
  if (!enabled || mode === 'http') return { metadata: { engine: 'http', available: false, reason: 'http_selected' } };
  try {
    const { createBrowserRuntime } = await import('./browser-runtime/index.mjs');
    const runtime = await createBrowserRuntime({ env });
    try {
      const checked = await runtime.verify();
      if (!checked.launchVerified) throw new Error('browser_launch_failed');
      runtime.metadata.launchVerified = true;
    } catch { throw Object.assign(new Error('browser_launch_failed'), { code: 'browser_launch_failed' }); }
    return runtime;
  } catch (error) {
    const reason = ['browser_not_installed', 'browser_session_permissions', 'browser_session_scope_invalid', 'browser_proxy_unsupported',
      'browser_runtime_path_invalid', 'browser_dependency_version_mismatch', 'browser_launch_failed'].includes(error.code)
      ? error.code : ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code) ? 'browser_dependencies_missing' : 'browser_runtime_unavailable';
    // Explicit browser selection or a configured login session must not silently turn anonymous.
    if (mode === 'crawlee' || env.VANTIS_STATAREA_STORAGE_STATE) throw new Error(reason);
    return { metadata: { engine: 'http', available: false, reason } };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const runtime = await browserRuntime();
    const report = { ...runtime.metadata, platform: process.platform, arch: process.arch, node: process.versions.node };
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.launchVerified ? 0 : 1;
  } catch { console.error('BROWSER_CHECK_FAILED: 检查依赖、浏览器、会话文件权限和系统库；未输出会话或代理凭据。'); process.exitCode = 1; }
}
