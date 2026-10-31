import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readJson } from './storage.mjs';
import { updatePublicationChannel, verifyPublication } from './publication.mjs';
import { persistReport, persistReportReceipt } from './report-store.mjs';
import { claimNotification, recordNotificationOutcome, readNotificationOutcome } from './outbox.mjs';
import { requireGreenForecastDelivery } from './publication-release-gate.mjs';

export function deliveryConfig(value) {
  const w = value?.website, t = value?.telegram;
  if (value?.version !== 1 || typeof w?.enabled !== 'boolean' || typeof t?.enabled !== 'boolean'
    || w.repository !== 'wangxtong/Dimension-Football-' || w.branch !== 'published-reports'
    || t.tokenVariable !== 'TELEGRAM_BOT_TOKEN' || t.chatIdVariable !== 'TELEGRAM_CHAT_ID'
    || t.destinationFingerprint !== undefined && !/^[a-f0-9]{16}$/.test(t.destinationFingerprint)
    || t.summaryIntervalMinutes !== undefined && (!Number.isInteger(t.summaryIntervalMinutes) || t.summaryIntervalMinutes < 60 || t.summaryIntervalMinutes > 1440)) throw new Error('INVALID_DELIVERY_CONFIG');
  const url = new URL(w.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('INVALID_DELIVERY_CONFIG');
  return value;
}
const stamp = () => new Date().toISOString();
async function boundedJson(response, limit) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('DELIVERY_INVALID_RESPONSE');
  let length = 0, text = ''; const decoder = new TextDecoder();
  try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > limit) throw new Error('DELIVERY_RESPONSE_TOO_LARGE'); text += decoder.decode(part.value, { stream:true }); } text += decoder.decode(); }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(text);
}
export function githubDeliveryClient(token, repository, fetchImpl = fetch) {
  if (typeof token !== 'string' || !token.trim() || repository !== 'wangxtong/Dimension-Football-') throw new Error('GITHUB_DELIVERY_NOT_CONFIGURED');
  return async (path, { method = 'GET', body, allow404 = false } = {}) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${token}`, 'Content-Type':'application/json', 'User-Agent':'DimensionFootball-Delivery/1.0' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (allow404 && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`GITHUB_DELIVERY_HTTP_${response.status}`); }
    return boundedJson(response, 4000000);
  };
}
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export async function commitReportFiles(api, files, reportId) {
  if (!/^[a-f0-9]{64}$/.test(reportId) || Object.keys(files).some(name => !['predictions.json', 'openligadb-fixtures.json', 'publication.json'].includes(name))) throw new Error('INVALID_DELIVERY_FILES');
  const ref = await api('/git/ref/heads/published-reports', { allow404: true });
  if (ref && !sha(ref.object?.sha)) throw new Error('INVALID_REMOTE_REF');
  const parent = ref ? await api(`/git/commits/${ref.object.sha}`) : null;
  const tree = await api('/git/trees', { method:'POST', body:{ ...(parent ? { base_tree: parent.tree.sha } : {}),
    tree:Object.entries(files).map(([path,content]) => ({ path, mode:'100644', type:'blob', content })) } });
  if (!sha(tree.sha)) throw new Error('INVALID_REMOTE_TREE');
  const commit = await api('/git/commits', { method:'POST', body:{ message:`Publish forecast report ${reportId}`, tree:tree.sha, parents:ref ? [ref.object.sha] : [] } });
  if (!sha(commit.sha)) throw new Error('INVALID_REMOTE_COMMIT');
  await api(ref ? '/git/refs/heads/published-reports' : '/git/refs', { method:ref ? 'PATCH' : 'POST', body:ref ? { sha:commit.sha, force:false } : { ref:'refs/heads/published-reports', sha:commit.sha } });
  return commit.sha;
}
export async function publishGitHubArchive(directory, { config, env = {}, fetchImpl = fetch, expectedReportId }) {
  deliveryConfig(config);
  return updatePublicationChannel(directory, 'repositoryArchive', async receipt => {
    if (receipt.simulated) return { status:'skipped', checkedAt:stamp(), code:'SIMULATION_NOT_PUBLISHED' };
    if (!config.website.enabled || !env.GITHUB_TOKEN) return { status:'not_configured', checkedAt:stamp(), code:'GITHUB_DELIVERY_NOT_CONFIGURED' };
    const api = githubDeliveryClient(env.GITHUB_TOKEN, config.website.repository, fetchImpl);
    const files = { 'predictions.json':await readFile(resolve(directory,'predictions.json'),'utf8'), 'publication.json':JSON.stringify(receipt) };
    try { files['openligadb-fixtures.json'] = await readFile(resolve(directory,'openligadb-fixtures.json'),'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const report = JSON.parse(files['predictions.json']);
      if (report.fixtures.some(row => row.fixture?.source === 'openligadb')) throw Error('SOURCE_SNAPSHOT_REQUIRED');
      files['openligadb-fixtures.json'] = JSON.stringify({ reportId:receipt.reportId, applicable:false });
    }
    const commitSha = await commitReportFiles(api, files, receipt.reportId);
    for (const [name, content] of Object.entries(files)) {
      const remote = await api(`/contents/${name}?ref=${commitSha}`), bytes = Buffer.from(remote.content || '', 'base64');
      if (remote.encoding !== 'base64' || !bytes.equals(Buffer.from(content))) throw Error('ARCHIVE_READBACK_MISMATCH');
    }
    return { status:'published', checkedAt:stamp(), commitSha,
      url:`https://github.com/${config.website.repository}/tree/${commitSha}`, meaning:'repository-archive-only-not-site-delivery' };
  }, { expectedReportId });
}
export async function publishWebsite(directory, { config, env = {}, fetchImpl = fetch, clock = stamp, expectedReportId }) {
  await requireGreenForecastDelivery(directory);
  deliveryConfig(config);
  return updatePublicationChannel(directory, 'externalWebsite', async receipt => {
    const checkedAt = clock(), base = { checkedAt, servedVerified:false };
    if (receipt.simulated) return { ...base, status:'skipped', code:'SIMULATION_NOT_PUBLISHED' };
    if (!config.website.enabled) return { ...base, status:'skipped', code:'WEBSITE_DISABLED' };
    const stored = await persistReport(directory, { nowISO:checkedAt });
    if (!/^[a-f0-9]{64}$/.test(env.REPORTS_PROBE_TOKEN || '')) return { ...base, status:'not_configured', stored:true, code:'WEBSITE_PROBE_NOT_CONFIGURED' };
    try {
      const response = await fetchImpl(new URL('/internal/report-status', config.website.url).href, {
        method:'GET', redirect:'error', signal:AbortSignal.timeout(15000),
        headers:{ Accept:'application/json', Authorization:'Bearer '+env.REPORTS_PROBE_TOKEN } });
      if (!response.ok) { await response.body?.cancel(); return { ...base, status:'failed', stored:true, code:'WEBSITE_PROBE_HTTP_ERROR', httpStatus:response.status }; }
      const probe = await boundedJson(response, 16000);
      if (probe.version !== 1 || probe.reportId !== receipt.reportId || probe.reportHash !== stored.reportHash)
        return { ...base, status:'failed', stored:true, code:'WEBSITE_REPORT_MISMATCH' };
      if (probe.mode !== 'ecs' || probe.health !== 'available') return { ...base, status:'failed', stored:true, code:'WEBSITE_LIVE_FEED_UNAVAILABLE', mode:probe.mode === 'bootstrap' ? 'bootstrap' : 'unavailable' };
      return { status:'published', checkedAt:clock(), servedVerified:true, stored:true, url:config.website.url,
        reportId:receipt.reportId, reportHash:stored.reportHash, mode:'ecs', meaning:'same-report-served-by-site-via-ecs-not-user-read' };
    } catch { return { ...base, status:'failed', stored:true, code:'WEBSITE_PROBE_FAILED' }; }
  }, { repeat:true, expectedReportId });
}

export async function publishWebsiteReceipt(directory, { config, clock = stamp, persistReceipt = persistReportReceipt, expectedReportId }) {
  await requireGreenForecastDelivery(directory);
  deliveryConfig(config);
  return updatePublicationChannel(directory, 'receiptSync', async receipt => {
    if (receipt.simulated) return { status:'skipped', checkedAt:clock(), code:'SIMULATION_NOT_PUBLISHED' };
    const result = { status:'published', checkedAt:clock(), reportId:receipt.reportId, meaning:'receipt-saved-to-bound-report-snapshot' };
    const saved = { ...receipt, channels:{ ...receipt.channels, receiptSync:result }, events:[...receipt.events, { channel:'receiptSync', ...result }] };
    try { await persistReceipt(directory, saved); }
    catch { return { status:'failed', checkedAt:clock(), reportId:receipt.reportId, code:'RECEIPT_SYNC_FAILED' }; }
    return result;
  }, { repeat:true, expectedReportId });
}

export function telegramText(report, siteUrl) {
  return `维度足球 · 赛前分析更新\n生成时间：${report.generatedAt}\n普通预测 ${report.summary.forecasts} 场｜严格盘口候选 ${report.summary.strictCandidates} 场｜暂不可评估 ${report.summary.unavailable} 场\n`
    + '普通预测为未校准统计基线；盘口候选仍需人工复核。\n' + `查看报告：${siteUrl}`;
}
async function telegramRejection(response, { token, fingerprint, fetchImpl }) {
  let data = null; try { data = await boundedJson(response,32000); } catch { /* Never persist untrusted response text. */ }
  const description = typeof data?.description === 'string' ? data.description.toLowerCase() : '';
  const code = description.includes('chat not found') ? 'TELEGRAM_CHAT_NOT_FOUND'
    : description.includes('not enough rights') || description.includes('have no rights') || description.includes('chat_write_forbidden') ? 'TELEGRAM_CHAT_WRITE_FORBIDDEN'
    : description.includes('kicked') || description.includes('not a member') ? 'TELEGRAM_BOT_NOT_IN_CHAT'
    : description.includes('blocked by the user') ? 'TELEGRAM_BOT_BLOCKED'
    : description.includes('migrated to a supergroup') ? 'TELEGRAM_CHAT_MIGRATED'
    : response.status === 401 ? 'TELEGRAM_TOKEN_REJECTED'
    : response.status === 429 ? 'TELEGRAM_RATE_LIMITED' : 'TELEGRAM_API_REJECTED';
  const result = { status:'failed', checkedAt:stamp(), channel:'telegram', code, httpStatus:response.status, destinationFingerprint:fingerprint };
  // A readonly identity check distinguishes a wrong recipient from a different
  // valid bot token. It never retries sendMessage or stores token/chat IDs.
  if (response.status === 400 || response.status === 403) {
    try {
      const identity = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { method:'GET', redirect:'error', signal:AbortSignal.timeout(5000) });
      if (!identity.ok) { await identity.body?.cancel(); return result; }
      const info = await boundedJson(identity,16000);
      if (info.ok === true && info.result?.is_bot === true && /^[A-Za-z0-9_]{5,32}$/.test(info.result.username || '')) result.botUsername = info.result.username;
    } catch { /* Preserve the confirmed send rejection even if diagnostics fail. */ }
  }
  return result;
}
export async function publishTelegram(directory, { config, env = {}, fetchImpl = fetch, clock = stamp, expectedReportId }) {
  await requireGreenForecastDelivery(directory);
  deliveryConfig(config);
  return updatePublicationChannel(directory, 'notifications', async receipt => {
    if (receipt.simulated) return { status:'skipped', checkedAt:stamp(), code:'SIMULATION_NOT_SENT' };
    const token = env[config.telegram.tokenVariable]; let chatId = env[config.telegram.chatIdVariable];
    if (!config.telegram.enabled || !token || !chatId) return { status:'not_configured', checkedAt:stamp(), channel:'telegram', code:'TELEGRAM_CREDENTIALS_REQUIRED' };
    if (!/^\d{5,20}:[A-Za-z0-9_-]{20,150}$/.test(token) || !/^-?\d{5,20}$/.test(String(chatId))) throw new Error('TELEGRAM_CONFIGURATION_INVALID');
    const digest = id => createHash('sha256').update(String(id)).digest('hex').slice(0,16);
    let adjustment;
    if (config.telegram.destinationFingerprint && digest(chatId) !== config.telegram.destinationFingerprint) {
      if (/^100\d+$/.test(String(chatId)) && digest('-'+chatId) === config.telegram.destinationFingerprint) {
        chatId = '-'+chatId; adjustment = 'restored-verified-group-minus-sign';
      } else return {status:'failed',checkedAt:stamp(),channel:'telegram',code:'TELEGRAM_DESTINATION_MISMATCH',destinationFingerprint:digest(chatId)};
    }
    const report = await readJson(resolve(directory,'predictions.json'));
    const nowISO = clock(), age = Date.parse(nowISO) - Date.parse(report.generatedAt);
    const fingerprint = createHash('sha256').update(String(chatId)).digest('hex').slice(0,16);
    const recovered = await readNotificationOutcome(directory, { reportId:receipt.reportId, destinationFingerprint:fingerprint, nowISO });
    if (recovered) return recovered;
    // Preserve receipts created before this outbox was introduced as well.
    try {
      const saved = await readJson(resolve(directory,'.delivery','reports',receipt.reportId,'receipt.json'));
      const prior = saved.channels?.notifications;
      if (saved.reportId !== receipt.reportId) throw Error('PUBLICATION_REPORT_MISMATCH');
      if (['accepted','unknown'].includes(prior?.status) && (!prior.destinationFingerprint || prior.destinationFingerprint === fingerprint)) return prior;
    } catch (error) {
      if (error.code !== 'ENOENT') return { status:'unknown', checkedAt:nowISO, channel:'telegram', destinationFingerprint:fingerprint, code:'DELIVERY_STORED_RECEIPT_UNREADABLE' };
    }
    if (!Number.isFinite(age) || age < -60000 || age > 3600000) return { status:'skipped', checkedAt:nowISO, code:'REPORT_EXPIRED' };
    const { claim, result:previous } = await claimNotification(directory, { reportId:receipt.reportId, destinationFingerprint:fingerprint,
      nowISO, intervalMinutes:config.telegram.summaryIntervalMinutes || 60 });
    if (previous) return previous;
    const send = async () => { try {
      // The token is sent only to the fixed Telegram API origin and is never logged.
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, { method:'POST', redirect:'error', signal:AbortSignal.timeout(10000),
        headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ chat_id:chatId,
          text:telegramText(report,config.website.url) + (receipt.channels.externalWebsite?.servedVerified === true ? '' : '\n网站实时交付尚未核验；本通知仅为报告摘要。'), link_preview_options:{is_disabled:true} }) });
      if (!response.ok) return telegramRejection(response,{token,fingerprint,fetchImpl});
      const data = await boundedJson(response,32000);
      if (!response.ok || data.ok !== true) return { status:'failed', checkedAt:stamp(), channel:'telegram', code:'TELEGRAM_API_REJECTED', httpStatus:response.status };
      if (!Number.isSafeInteger(data.result?.message_id) || String(data.result?.chat?.id) !== String(chatId)) return { status:'unknown', checkedAt:stamp(), channel:'telegram', code:'TELEGRAM_RECEIPT_UNVERIFIED' };
      return { status:'accepted', checkedAt:stamp(), channel:'telegram', messageId:data.result.message_id, destinationFingerprint:fingerprint,
        ...(adjustment ? {configurationAdjusted:adjustment} : {}),
        meaning:'telegram-api-accepted-not-a-user-read-receipt' };
    } catch { return { status:'unknown', checkedAt:stamp(), channel:'telegram', code:'DELIVERY_RESULT_UNKNOWN_NO_AUTOMATIC_RETRY' }; } };
    const result = await send();
    try { return await recordNotificationOutcome(directory, claim, result); }
    catch { return { status:'unknown', checkedAt:clock(), channel:'telegram', destinationFingerprint:fingerprint, code:'DELIVERY_OUTCOME_NOT_PERSISTED_NO_AUTOMATIC_RETRY' }; }
  }, { expectedReportId });
}

// Each stage records its own outcome. A site failure does not hide the notification
// result, and the final receipt is attempted even when an earlier stage throws.
export async function publishAll(directory, options) {
  await requireGreenForecastDelivery(directory);
  deliveryConfig(options.config);
  const initial = await readJson(resolve(directory, 'publication.json'));
  const expectedReportId = options.expectedReportId || initial.reportId;
  const bound = { ...options, expectedReportId }, failures = [];
  for (const [channel, operation] of [['externalWebsite',publishWebsite], ['notifications',publishTelegram], ['receiptSync',publishWebsiteReceipt]]) {
    try { await operation(directory, bound); } catch { failures.push(channel); }
  }
  if (options.env?.GITHUB_TOKEN) {
    try { await publishGitHubArchive(directory, bound); } catch { failures.push('repositoryArchive'); }
    await publishWebsiteReceipt(directory, bound);
  }
  const receipt = await readJson(resolve(directory, 'publication.json'));
  if (receipt.reportId !== expectedReportId) throw Error('PUBLICATION_REPORT_MISMATCH');
  if (failures.some(channel => receipt.channels[channel]?.status !== 'failed')) throw Error('PUBLICATION_SEQUENCE_INCOMPLETE');
  await verifyPublication(directory, receipt);
  return receipt;
}
