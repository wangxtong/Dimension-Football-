import { formatTelegramPublication } from './telegram-presentation.mjs';
import { requireHostedForecastRelease } from './release-policy.mjs';

// SHA-256(String(chat_id)), hex, first 16 chars; pinned to config/delivery.json.
export const VERIFIED_TARGET_FINGERPRINT = 'c061d82bf8f5ff23';
export const VERIFIED_DASHBOARD_ORIGIN = 'https://dimension-football-live-wangxtong.secretmelon37.chatgpt.site';
const idOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fingerprintOK = value => typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
const error = code => Object.assign(new Error(code), { code });
const encode = value => new TextEncoder().encode(value);
const stamp = now => new Date(now).toISOString();
const hourly = now => stamp(now).slice(0, 13);
const prefix = 'notifications/';
const terminal = new Set(['accepted', 'unknown', 'failed', 'skipped']);
// loadBundle owns the full persisted schema/hash validation; verify consumed identities again here.
function validateBundle(bundle) {
  const report = bundle?.report, receipt = bundle?.receipt;
  if (!idOK(bundle?.reportId) || report?.publication?.reportId !== bundle.reportId || report.simulated !== false
    || !Number.isFinite(Date.parse(report.generatedAt)) || !Array.isArray(report.fixtures) || report.fixtures.length > 3000
    || !receipt || receipt.reportId !== bundle.reportId || receipt.simulated !== false
    || Date.parse(receipt.generatedAt) !== Date.parse(report.generatedAt) || !receipt.channels?.notifications) throw error('HOSTED_NOTIFICATION_BUNDLE_INVALID');
  for (const row of report.fixtures) {
    if (!row?.fixture || typeof row.fixture.home !== 'string' || typeof row.fixture.away !== 'string'
      || !Number.isFinite(Date.parse(row.fixture.kickoff)) || !['forecast', 'unavailable'].includes(row.forecast?.status)) throw error('HOSTED_NOTIFICATION_BUNDLE_INVALID');
    if (row.forecast.status === 'forecast') {
      const p = row.forecast.probabilities;
      if (!p || !['home', 'draw', 'away'].every(key => Number.isFinite(p[key]) && p[key] >= 0 && p[key] <= 1)
        || Math.abs(p.home + p.draw + p.away - 1) > .00001 || !Number.isFinite(Date.parse(row.forecast.freshness?.validUntil))) throw error('HOSTED_NOTIFICATION_BUNDLE_INVALID');
    }
  }
}
async function targetFingerprint(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encode(String(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
function dashboardUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== VERIFIED_DASHBOARD_ORIGIN || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}
const currentForecast = (row, now) => row.forecast.status === 'forecast'
  && ['SCHEDULED', 'TIMED'].includes(row.fixture.status)
  && Date.parse(row.fixture.kickoff) > now && Date.parse(row.forecast.freshness?.validUntil) > now;
function readiness(bundle, now) {
  if (bundle.freshness?.mode !== 'hosted' || bundle.health?.status !== 'available') return 'HOSTED_REPORT_NOT_SERVED';
  const age = now - Date.parse(bundle.report.generatedAt);
  if (age < 0 || age > 3600000) return 'REPORT_EXPIRED';
  if (!bundle.report.fixtures.some(row => currentForecast(row, now)) && bundle.report.fixtures.some(row => row.forecast.status === 'forecast')) return 'FORECASTS_EXPIRED';
  return null;
}
export function hostedSummary(report, siteUrl, now) {
  return formatTelegramPublication({report,siteURL:siteUrl,now}).text;
}

async function readClaim(bucket, key, fingerprint, reportId) {
  const object = await bucket.get(key); if (!object) return null;
  if (object.size > 64000) throw error('HOSTED_NOTIFICATION_CLAIM_INVALID');
  const row = JSON.parse(await object.text());
  if (row.version !== 1 || !idOK(row.reportId) || row.reportId !== reportId || row.destinationFingerprint !== fingerprint || typeof object.etag !== 'string'
    || !['prepared', 'complete'].includes(row.state) || typeof row.attemptId !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(row.hour) || row.state === 'complete' && (!terminal.has(row.outcome?.status)
      || row.outcome.reportId !== row.reportId || row.outcome.destinationFingerprint !== fingerprint)) throw error('HOSTED_NOTIFICATION_CLAIM_INVALID');
  return { key, etag: object.etag, row };
}
async function putClaim(bucket, key, row, etag) {
  const stored = await bucket.put(key, JSON.stringify(row), {
    onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' }, httpMetadata: { contentType: 'application/json' },
  });
  if (stored && typeof stored.etag !== 'string') throw error('HOSTED_NOTIFICATION_CLAIM_INVALID');
  return stored ? { key, etag: stored.etag, row } : null;
}
async function completeClaim(bucket, claim, outcome) {
  const saved = await putClaim(bucket, claim.key, { ...claim.row, state: 'complete', outcome }, claim.etag);
  if (!saved) throw error('HOSTED_NOTIFICATION_CLAIM_CONFLICT');
  return saved;
}
function knownOutcome(claim, now) {
  return claim.row.state === 'complete' ? claim.row.outcome : { status: 'unknown', channel: 'telegram', checkedAt: stamp(now),
    reportId: claim.row.reportId, destinationFingerprint: claim.row.destinationFingerprint, code: 'TELEGRAM_CLAIM_UNRESOLVED_NO_RETRY' };
}
async function saveReceipt(env, receipt, outcome, updateReceipt) {
  if (receipt.channels.notifications?.status === 'accepted') return receipt;
  const next = { ...receipt, channels: { ...receipt.channels, notifications: outcome } };
  try {
    const saved = await updateReceipt(env, next);
    if (saved?.reportId !== receipt.reportId || !saved.channels?.notifications) throw error('HOSTED_NOTIFICATION_RECEIPT_MISMATCH');
    return saved;
  }
  catch {
    return { ...next, channels: { ...next.channels, receiptSync: { status: 'failed', checkedAt: outcome.checkedAt,
      code: 'HOSTED_NOTIFICATION_RECEIPT_SYNC_FAILED', reportId: receipt.reportId } } };
  }
}
async function telegramJSON(response) {
  const reader = response.body?.getReader(); if (!reader) throw error('TELEGRAM_RECEIPT_UNVERIFIED');
  let total = 0, text = ''; const decoder = new TextDecoder();
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; total += part.value.byteLength;
      if (total > 32000) throw error('TELEGRAM_RECEIPT_UNVERIFIED'); text += decoder.decode(part.value, { stream: true }); }
    return JSON.parse(text + decoder.decode());
  } finally { await reader.cancel().catch(() => {}); }
}
async function sendTelegram({ token, chatId, presentation, fetchImpl, base }) {
  const controller = new AbortController(); let timer;
  try {
    return await Promise.race([(async () => {
      // Telegram's fixed Bot API embeds the token in its HTTPS path. Never return/log it.
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, ...presentation }) });
      const data = await telegramJSON(response);
      if (response.ok && data.ok === true && Number.isSafeInteger(data.result?.message_id) && data.result.message_id > 0
        && String(data.result?.chat?.id) === chatId) return { ...base, status: 'accepted', code: 'TELEGRAM_ACCEPTED',
        messageId: data.result.message_id, targetVerified: true, meaning: 'telegram-api-accepted-not-user-read' };
      if (response.status >= 400 && response.status < 500 && data.ok === false) return { ...base, status: 'failed',
        code: response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_API_REJECTED', httpStatus: response.status };
      return { ...base, status: 'unknown', code: 'TELEGRAM_OUTCOME_UNKNOWN_NO_RETRY' };
    })(), new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ ...base, status: 'unknown', code: 'TELEGRAM_OUTCOME_UNKNOWN_NO_RETRY' }); }, 10000); })]);
  } catch { return { ...base, status: 'unknown', code: 'TELEGRAM_OUTCOME_UNKNOWN_NO_RETRY' }; }
  finally { clearTimeout(timer); controller.abort(); }
}

/** Tests may construct a notifier with synthetic target identity; production export below is pinned. */
export function createHostedNotifier({ verifiedTargetFingerprint = VERIFIED_TARGET_FINGERPRINT } = {}) {
  if (!fingerprintOK(verifiedTargetFingerprint)) throw error('HOSTED_NOTIFICATION_CONFIGURATION_INVALID');
  return async function notify(env, { reportId, fetchImpl = fetch, now = Date.now(), loadBundle, updateReceipt } = {}) {
    requireHostedForecastRelease();
    if (!idOK(reportId) || !Number.isFinite(now) || typeof loadBundle !== 'function' || typeof updateReceipt !== 'function') throw error('HOSTED_NOTIFICATION_INVALID_REQUEST');
    if (!env.BUCKET?.get || !env.BUCKET?.put) throw error('HOSTED_NOTIFICATION_STORAGE_UNAVAILABLE');
    const started = Date.now(), time = () => now + Math.max(0, Date.now() - started);
    const bundle = await loadBundle(env);
    if (!bundle || bundle.reportId !== reportId) throw error('HOSTED_REPORT_NOT_CURRENT');
    validateBundle(bundle);
    if (!bundle.receipt) throw error('HOSTED_RECEIPT_REQUIRED');
    const receipt = bundle.receipt;
    const base = { channel: 'telegram', reportId, checkedAt: stamp(time()), destinationFingerprint: verifiedTargetFingerprint };
    const finish = outcome => saveReceipt(env, receipt, { ...base, ...outcome }, updateReceipt);
    if (receipt.channels.notifications?.status === 'accepted') return receipt;
    const reportKey = `${prefix}reports/${reportId}-${verifiedTargetFingerprint}.json`;
    let existing;
    try { existing = await readClaim(env.BUCKET, reportKey, verifiedTargetFingerprint, reportId); }
    catch { return finish({ status: 'unknown', code: 'HOSTED_NOTIFICATION_CLAIM_UNREADABLE_NO_RETRY' }); }
    if (existing && !(existing.row.state === 'complete' && existing.row.outcome?.code === 'HOSTED_HOURLY_DEDUPLICATED' && existing.row.hour !== hourly(time())))
      return finish(knownOutcome(existing, time()));
    if (receipt.channels.notifications?.status === 'unknown') return receipt;
    const blocked = readiness(bundle, time());
    if (blocked) return finish({ status: 'skipped', code: blocked });
    const token = env.TELEGRAM_BOT_TOKEN; let chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return finish({ status: 'not_configured', code: 'TELEGRAM_CREDENTIALS_REQUIRED' });
    if (typeof token !== 'string' || !/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(token)
      || typeof chatId !== 'string' || !/^-?\d{5,20}$/.test(chatId)) return finish({ status: 'failed', code: 'TELEGRAM_CONFIGURATION_INVALID' });
    if (await targetFingerprint(chatId) !== verifiedTargetFingerprint) {
      if (/^100\d+$/.test(chatId) && await targetFingerprint('-' + chatId) === verifiedTargetFingerprint) chatId = '-' + chatId;
      else return finish({ status: 'failed', code: 'TELEGRAM_DESTINATION_MISMATCH' });
    }
    const origin = dashboardUrl(env.DASHBOARD_ORIGIN);
    if (!origin) return finish({ status: 'failed', code: 'DASHBOARD_ORIGIN_INVALID' });
    const row = { version: 1, reportId, destinationFingerprint: verifiedTargetFingerprint, state: 'prepared',
      attemptId: crypto.randomUUID(), hour: hourly(time()), createdAt: stamp(time()) };
    let claim;
    try {
      claim = await putClaim(env.BUCKET, reportKey, row, existing?.etag);
      if (!claim) { const previous = await readClaim(env.BUCKET, reportKey, verifiedTargetFingerprint, reportId); return finish(previous ? knownOutcome(previous, time()) : { status: 'unknown', code: 'HOSTED_NOTIFICATION_CLAIM_UNREADABLE_NO_RETRY' }); }
    } catch { return finish({ status: 'unknown', code: 'HOSTED_NOTIFICATION_CLAIM_UNCERTAIN_NO_RETRY' }); }
    let hourClaim, outcome;
    try {
      hourClaim = await putClaim(env.BUCKET, `${prefix}hours/${row.hour}-${verifiedTargetFingerprint}.json`, row);
      if (!hourClaim) outcome = { ...base, status: 'skipped', code: 'HOSTED_HOURLY_DEDUPLICATED', hour: row.hour };
      else {
        const current = await loadBundle(env);
        if (!current || current.reportId !== reportId) outcome = { ...base, status: 'skipped', code: 'HOSTED_REPORT_CHANGED_BEFORE_SEND' };
        else {
          validateBundle(current);
          const unavailable = readiness(current, time());
          outcome = unavailable ? { ...base, status: 'skipped', code: unavailable }
            : await sendTelegram({ token, chatId, presentation:formatTelegramPublication({report:current.report,receipt:current.receipt,siteURL:origin,now:time()}), fetchImpl, base });
        }
      }
    } catch { outcome = { ...base, status: 'unknown', code: 'TELEGRAM_OUTCOME_UNKNOWN_NO_RETRY' }; }
    outcome = { ...outcome, checkedAt: stamp(time()) };
    // The per-report record is authoritative for recovery across UTC hours.
    try { claim = await completeClaim(env.BUCKET, claim, outcome); }
    catch { return finish({ status: 'unknown', code: 'HOSTED_NOTIFICATION_OUTCOME_NOT_PERSISTED_NO_RETRY' }); }
    if (hourClaim) { try { await completeClaim(env.BUCKET, hourClaim, outcome); } catch { /* Hour remains claimed; never reclaim it. */ } }
    return finish(outcome);
  };
}

export const notifyHostedReport = createHostedNotifier();
