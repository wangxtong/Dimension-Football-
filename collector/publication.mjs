import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, acquireLock } from './storage.mjs';
import { digest } from './policy.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const RECEIPT = 'publication.json';
const clock = () => new Date().toISOString();
export async function beginPublication(report, directory) {
  if (report.inputHash !== undefined && (typeof report.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(report.inputHash))) throw Error('INVALID_REPORT_INPUT_HASH');
  const identity = [report.completedAt, report.simulated, report.summary, report.results.map(r => [r.fixture.id, r.forecast, r.result])];
  if (report.inputHash !== undefined) identity.push(report.inputHash);
  const reportId = digest(identity);
  const receipt = { version: 1, reportId, generatedAt: report.completedAt, simulated: report.simulated,
    channels: { files: { status: 'generating' }, githubSummary: { status: 'not_attempted' },
      githubArtifact: { status: 'not_attempted' }, repositoryArchive: { status: 'not_configured' },
      externalWebsite: { status: 'not_configured' }, notifications: { status: 'not_configured' }, receiptSync: { status: 'not_attempted' } },
    files: [], events: [] };
  await atomicJson(resolve(directory, RECEIPT), receipt);
  report.publication = { reportId, receipt: RECEIPT, target: 'repository-report-files', externalDelivery: 'see-receipt',
    note: 'Delivery outcomes are recorded in publication.json after each completed operation.' };
  return receipt;
}

export async function finishGeneration(directory, receipt, names, error = false) {
  if (!error) receipt.files = await Promise.all(names.map(async name => ({ name, sha256: hash(await readFile(resolve(directory, name))) })));
  receipt.channels.files = { status: error ? 'failed' : 'published', checkedAt: clock() };
  receipt.events.push({ channel: 'files', ...receipt.channels.files });
  await atomicJson(resolve(directory, RECEIPT), receipt);
  await atomicJson(resolve(directory, `publication-${receipt.reportId}.json`), receipt);
}

export async function verifyPublication(directory, receipt) {
  if (receipt?.version !== 1 || !/^[a-f0-9]{64}$/.test(receipt.reportId) || receipt.channels?.files?.status !== 'published'
    || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 30) throw new Error('PUBLICATION_NOT_READY');
  for (const file of receipt.files) {
    if (!/^[A-Za-z0-9_.-]+$/.test(file.name) || hash(await readFile(resolve(directory, file.name))) !== file.sha256) throw new Error('PUBLICATION_CONTENT_CHANGED');
  }
  const document = await readJson(resolve(directory, 'predictions.json'));
  if (document.publication?.reportId !== receipt.reportId) throw new Error('PUBLICATION_REPORT_MISMATCH');
}

// Replaying an initial generation receipt must not erase independently completed delivery.
export function mergePublicationReceipts(previous, incoming) {
  if (!previous) return incoming;
  if (previous.reportId !== incoming.reportId || previous.generatedAt !== incoming.generatedAt) throw new Error('PUBLICATION_REPORT_MISMATCH');
  const channels = { ...previous.channels };
  for (const [name, next] of Object.entries(incoming.channels)) {
    const old = channels[name];
    if (name === 'notifications' && old?.status === 'accepted' && next.status !== 'accepted') continue;
    if (name === 'notifications' && ['accepted', 'unknown'].includes(old?.status)
      && !['accepted', 'unknown'].includes(next.status)) continue;
    if (!old || (Date.parse(next.checkedAt) || 0) >= (Date.parse(old.checkedAt) || 0)) channels[name] = next;
  }
  const events = [...new Map([...(previous.events || []), ...(incoming.events || [])].map(event => [JSON.stringify(event), event])).values()];
  return { ...incoming, channels, events };
}

export async function updatePublicationChannel(directory, channel, operation, { repeat = false, expectedReportId } = {}) {
  if (!['githubSummary', 'githubArtifact', 'repositoryArchive', 'externalWebsite', 'notifications', 'receiptSync'].includes(channel)) throw new Error('INVALID_PUBLICATION_CHANNEL');
  const release = await acquireLock(resolve(directory, RECEIPT));
  try {
    const receipt = await readJson(resolve(directory, RECEIPT));
    if (expectedReportId && receipt.reportId !== expectedReportId) throw new Error('PUBLICATION_REPORT_MISMATCH');
    try {
      await verifyPublication(directory, receipt);
      if (!repeat && ['published', 'accepted', 'unknown'].includes(receipt.channels[channel]?.status)) return receipt;
      receipt.channels[channel] = await operation(receipt);
    } catch (error) {
      const safeCodes = ['PUBLICATION_CONTENT_CHANGED', 'PUBLICATION_REPORT_MISMATCH', 'PUBLICATION_NOT_READY', 'INVALID_REPORT_BUNDLE',
        'SOURCE_SNAPSHOT_REQUIRED', 'CORRUPT_REPORT_POINTER', 'REPORT_ORDER_CONFLICT', 'IMMUTABLE_REPORT_CONFLICT',
        'REPORT_BUNDLE_TOO_LARGE', 'REPORT_SCHEMA_INVALID', 'RECEIPT_SCHEMA_INVALID', 'SNAPSHOT_SCHEMA_INVALID',
        'ARCHIVE_READBACK_MISMATCH', 'TELEGRAM_CONFIGURATION_INVALID', 'INVALID_OUTBOX_CLAIM', 'OUTBOX_CLAIM_MISMATCH'];
      receipt.channels[channel] = { status: 'failed', checkedAt: clock(),
        code: safeCodes.includes(error.message) || /^GITHUB_DELIVERY_HTTP_\d{3}$/.test(error.message) ? error.message : 'DELIVERY_FAILED' };
      receipt.events.push({ channel, ...receipt.channels[channel] });
      await atomicJson(resolve(directory, RECEIPT), receipt);
      await atomicJson(resolve(directory, `publication-${receipt.reportId}.json`), receipt);
      throw error;
    }
    receipt.events.push({ channel, ...receipt.channels[channel] });
    await atomicJson(resolve(directory, RECEIPT), receipt);
    await atomicJson(resolve(directory, `publication-${receipt.reportId}.json`), receipt);
    return receipt;
  } finally { await release(); }
}

export function publicationMarkdown(receipt) {
  const names = { files: '报告文件', githubSummary: 'GitHub Summary', githubArtifact: 'GitHub 报告附件', repositoryArchive: 'GitHub 数据归档', externalWebsite: '外部网站', notifications: '消息通知', receiptSync: '持久回执同步' };
  const statuses = { published: '已完成', accepted: '平台已接收（非已读回执）', unknown: '发送结果未知，暂停重发', failed: '失败', not_attempted: '未执行', not_configured: '未配置', skipped: '已跳过', generating: '正在生成' };
  return `## 实际发布回执\n\n报告 ID：\`${receipt.reportId}\`\n\n| 交付渠道 | 状态 | 回执时间 / 链接 |\n| --- | --- | --- |\n`
    + Object.entries(receipt.channels).map(([key, row]) => `| ${names[key]} | ${statuses[row.status] || '未知'} | ${row.url ? `[查看产物](${row.url})` : row.checkedAt || '—'} |`).join('\n')
    + '\n\n状态按实际完成操作记录。附件中的回执是上传前快照，最终回执见本轮 publication-receipt 附件。\n';
}

export async function publishSummary(directory, summaryPath) {
  if (!summaryPath) throw new Error('SUMMARY_DESTINATION_REQUIRED');
  return updatePublicationChannel(directory, 'githubSummary', async receipt => {
    const marker = `<!-- dimension-report:${receipt.reportId} -->`;
    let existing = ''; try { existing = await readFile(summaryPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const confirmed = { status: 'published', checkedAt: clock() };
    if (!existing.includes(marker)) {
      const markdown = await readFile(resolve(directory, 'predictions.md'), 'utf8');
      // The receipt is persisted only after the append succeeds.
      const preview = { ...receipt, channels: { ...receipt.channels, githubSummary: confirmed } };
      // Completion marker comes last so an interrupted partial append is not a success.
      await appendFile(summaryPath, `${markdown}\n${publicationMarkdown(preview)}\n${marker}\n`);
    }
    return confirmed;
  });
}

export async function recordArtifact(directory, { outcome, id, url, digest: artifactDigest, repository, runId }) {
  return updatePublicationChannel(directory, 'githubArtifact', async () => {
    if (outcome !== 'success') return { status: outcome === 'skipped' ? 'skipped' : 'failed', checkedAt: clock(), code: 'UPLOAD_NOT_SUCCESSFUL' };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '') || !/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(id))
      || url !== `https://github.com/${repository}/actions/runs/${runId}/artifacts/${id}`
      || !/^(sha256:)?[a-f0-9]{64}$/.test(artifactDigest || '')) throw new Error('ARTIFACT_RECEIPT_INVALID');
    return { status: 'published', checkedAt: clock(), id: String(id), url, sha256: artifactDigest.replace(/^sha256:/, '') };
  });
}
