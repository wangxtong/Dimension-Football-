import * as http from 'node:http';

// Initialize once at CLI startup, before requests. Keep the supplied proxy and CA
// trust; never fall back to direct traffic when a configured proxy is unsupported.
export function configureEnvironmentProxy(env = process.env, apply = http.setGlobalProxyFromEnv) {
  if (![env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy].some(Boolean)) return false;
  if (env.NODE_USE_ENV_PROXY === '1' || process.execArgv.includes('--use-env-proxy')) return true;
  if (typeof apply !== 'function') throw new Error('ENV_PROXY_REQUIRES_NODE_24_14');
  try { apply(env); } catch { throw new Error('ENV_PROXY_CONFIGURATION_INVALID'); }
  return true;
}
