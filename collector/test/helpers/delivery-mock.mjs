import { registerHooks } from 'node:module';

// Only this test-owned import graph receives a fake gate dependency. Production
// delivery exports have no dependency/env switch capable of disabling the gate.
export async function withMockReleaseGate(moduleURL) {
  const target = new URL(moduleURL);
  target.searchParams.set('offline-test-release-dependency', '1');
  const mock = new URL('./release-gate-mock.mjs', import.meta.url).href;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === target.href && specifier === './publication-release-gate.mjs')
      return { url:mock, shortCircuit:true };
    return nextResolve(specifier, context);
  } });
  try { return await import(target); } finally { hook.deregister(); }
}

export const deliveryWithMockGate = () => withMockReleaseGate(new URL('../../delivery.mjs', import.meta.url));
