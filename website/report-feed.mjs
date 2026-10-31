import { validateBundle } from './report-schema.mjs';
import { loadHostedBundle } from './hosted-publications.mjs';

const MAX_FEED_BYTES = 4_000_000;
async function feedText(body, limit = MAX_FEED_BYTES) {
  const reader = body?.getReader();
  if (!reader) throw new Error('REPORT_BODY_MISSING');
  let count = 0, text = ''; const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      count += part.value.byteLength; if (count > limit) throw new Error('REPORT_TOO_LARGE');
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
async function bootstrapFeed(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_FEED_BYTES) return null;
  let text = value;
  if (value.startsWith('gzip:')) {
    const bytes = Uint8Array.from(atob(value.slice(5)), c => c.charCodeAt(0));
    text = await feedText(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
  }
  return validateBundle(JSON.parse(text));
}
export async function dashboardReportHash(report) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(report)));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function readDashboardBundle(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  let bundle = null, failure = null, mode = 'bootstrap';
  if (env.HOSTED_PUBLICATION_ENABLED === 'true') {
    try {
      const hosted = await loadHostedBundle(env, { now });
      if (hosted) { bundle = validateBundle(hosted); mode = 'hosted'; }
    } catch { failure = 'HOSTED_REPORT_UNAVAILABLE'; }
  }
  if (!bundle && env.REPORTS_ORIGIN && env.HOSTED_PUBLICATION_ENABLED !== 'true') {
    let origin;
    try {
      origin = new URL(env.REPORTS_ORIGIN);
      if (origin.protocol !== 'https:' || origin.username || origin.password || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(origin.pathname) || origin.search || origin.hash
        || !/^[A-Za-z0-9_-]{32,200}$/.test(env.REPORTS_READ_TOKEN || '')) throw Error();
      if(!origin.pathname.endsWith('/'))origin.pathname+='/';
    } catch { throw new Error('REPORTS_ORIGIN_CONFIGURATION_INVALID'); }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const upstream = await fetchImpl(new URL('api/report', origin).href, { redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + env.REPORTS_READ_TOKEN } });
      if (!upstream.ok || !/application\/json/i.test(upstream.headers.get('content-type') || '')) {
        await upstream.body?.cancel(); throw new Error('REPORT_UPSTREAM_UNAVAILABLE');
      }
      bundle = validateBundle(JSON.parse(await feedText(upstream.body))); mode = 'ecs';
    } catch { failure = 'REPORT_UPSTREAM_UNAVAILABLE'; }
    finally { clearTimeout(timer); }
  }
  if (!bundle) {
    let value=env.DASHBOARD_BOOTSTRAP_REPORT;
    const chunks=typeof value==='string'&&/^chunks:([1-9]|[12][0-9]|3[0-2])$/.exec(value);
    if(chunks){
      const parts=Array.from({length:Number(chunks[1])},(_,i)=>env['DASHBOARD_BOOTSTRAP_REPORT_'+(i+1)]);
      if(parts.some(part=>typeof part!=='string'||!part||part.length>4800))throw new Error('BOOTSTRAP_CHUNK_MISSING');
      value=parts.join('');
    }
    bundle = await bootstrapFeed(value);
  }
  if (!bundle) throw new Error(failure || 'REPORT_NOT_CONFIGURED');
  const generated = Date.parse(bundle.report.generatedAt);
  return { ...bundle, reportHash: await dashboardReportHash(bundle.report), freshness: {
    mode, generatedAt: bundle.report.generatedAt, checkedAt: new Date(now).toISOString(),
    ageSeconds: Math.max(0, Math.floor((now - generated) / 1000)), stale: now - generated > 3_600_000,
  }, health: { status: failure ? 'upstream_unavailable' : mode === 'bootstrap' ? 'bootstrap' : 'available', ...(failure ? { code: failure } : {}) } };
}
export function dashboardBundleFile(bundle, path) {
  if (path === '/api/report') return bundle;
  if (path === '/api/predictions.json') return bundle.report;
  if (path === '/api/publication.json') return bundle.receipt;
  if (path === '/api/openligadb-fixtures.json') return bundle.sourceData?.openligadb || null;
  return null;
}
