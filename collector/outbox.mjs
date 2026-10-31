import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, readJson } from './storage.mjs';

const rootPath = directory => resolve(directory, '.delivery', 'outbox');
const valid = (reportId, fingerprint) => /^[a-f0-9]{64}$/.test(reportId || '') && /^[a-f0-9]{16}$/.test(fingerprint || '');
const filePath = (directory, reportId, fingerprint) => resolve(rootPath(directory), `${reportId}-${fingerprint}.json`);
async function exclusiveJson(path, value) {
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  return true;
}
const unknown = (fingerprint, nowISO, code) => ({ status: 'unknown', channel: 'telegram', checkedAt: nowISO, destinationFingerprint: fingerprint, code });

export async function readNotificationOutcome(directory, { reportId, destinationFingerprint, nowISO = new Date().toISOString() }) {
  if (!valid(reportId, destinationFingerprint)) throw Error('INVALID_OUTBOX_CLAIM');
  let existing;
  try { existing = await readJson(filePath(directory, reportId, destinationFingerprint), 16000); }
  catch (error) { return error.code === 'ENOENT' ? null : unknown(destinationFingerprint, nowISO, 'DELIVERY_OUTBOX_UNREADABLE'); }
  if (existing.version !== 1 || existing.reportId !== reportId || existing.destinationFingerprint !== destinationFingerprint
    || existing.result && !['accepted', 'unknown', 'failed', 'skipped'].includes(existing.result.status))
    return unknown(destinationFingerprint, nowISO, 'DELIVERY_OUTBOX_UNREADABLE');
  return existing.result || unknown(destinationFingerprint, nowISO, 'DELIVERY_CLAIM_UNRESOLVED_NO_AUTOMATIC_RETRY');
}

// An unresolved claim is never reclaimed automatically: Telegram offers no idempotency key.
// The hourly slot is also exclusive and durable, including when its sender crashes.
export async function claimNotification(directory, { reportId, destinationFingerprint, nowISO = new Date().toISOString(), intervalMinutes = 60 }) {
  if (!valid(reportId, destinationFingerprint) || !Number.isFinite(Date.parse(nowISO))
    || !Number.isInteger(intervalMinutes) || intervalMinutes < 60 || intervalMinutes > 1440) throw Error('INVALID_OUTBOX_CLAIM');
  const root = rootPath(directory), path = filePath(directory, reportId, destinationFingerprint);
  await mkdir(root, { recursive: true });
  const claim = { version: 1, reportId, destinationFingerprint, claimId: randomUUID(), claimedAt: nowISO, status: 'pending' };
  if (!await exclusiveJson(path, claim)) {
    return { result: await readNotificationOutcome(directory, { reportId, destinationFingerprint, nowISO })
      || unknown(destinationFingerprint, nowISO, 'DELIVERY_OUTBOX_UNREADABLE') };
  }
  const bucket = Math.floor(Date.parse(nowISO) / (intervalMinutes * 60000));
  const slot = resolve(root, `summary-${destinationFingerprint}-${intervalMinutes}-${bucket}.json`);
  if (!await exclusiveJson(slot, { reportId, claimedAt: nowISO })) {
    const result = { status: 'skipped', channel: 'telegram', checkedAt: nowISO, destinationFingerprint,
      code: 'HOURLY_SUMMARY_ALREADY_CLAIMED', nextSummaryAt: new Date((bucket + 1) * intervalMinutes * 60000).toISOString() };
    await recordNotificationOutcome(directory, claim, result);
    return { result };
  }
  return { claim };
}

export async function recordNotificationOutcome(directory, claim, result) {
  if (!valid(claim?.reportId, claim?.destinationFingerprint)
    || !['accepted', 'unknown', 'failed', 'skipped'].includes(result?.status)) throw Error('INVALID_OUTBOX_OUTCOME');
  const path = filePath(directory, claim.reportId, claim.destinationFingerprint), saved = await readJson(path, 16000);
  if (saved.claimId !== claim.claimId || saved.reportId !== claim.reportId) throw Error('OUTBOX_CLAIM_MISMATCH');
  if (saved.result) return saved.result;
  await atomicJson(path, { ...saved, status: result.status, result });
  return result;
}
