import { registerHooks } from 'node:module';
import { randomUUID } from 'node:crypto';

// Protocol-only tests can exercise post-release mechanics without adding a
// production bypass. Real gate and built-Worker tests never use this helper.
export async function loadHostedProtocolModule(relativePath) {
  const entry = new URL(relativePath, import.meta.url);
  entry.searchParams.set('offline-protocol-test', randomUUID());
  const policy = new URL('../../release-policy.mjs', import.meta.url).href;
  const mock = `data:text/javascript,${encodeURIComponent('export function requireHostedForecastRelease() {}')}`;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return context.parentURL === entry.href && resolved.url === policy ? { url: mock, shortCircuit: true } : resolved;
  } });
  try { return await import(entry.href); }
  finally { hook.deregister(); }
}
