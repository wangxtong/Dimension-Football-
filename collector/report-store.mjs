import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, acquireLock } from './storage.mjs';
import { verifyPublication, mergePublicationReceipts } from './publication.mjs';
import { validateBundle, MAX_REPORT_BUNDLE_BYTES } from '../website/report-schema.mjs';

const id = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const reportHash = report => createHash('sha256').update(JSON.stringify(report)).digest('hex');
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function optionalJson(path) { try { return await json(path); } catch (error) { if(error.code==='ENOENT')return null; throw error; } }
const rootPath = directory => resolve(directory, '.delivery');
function publishableBundle(content, receipt) {
  const bundle = { ...content, receipt, reportHash:reportHash(content.report) };
  validateBundle(bundle);
  // Include the raw source snapshot, merged receipt and report hash, exactly as served.
  // Compressed transport does not increase the Worker's decoded-body allowance.
  if (Buffer.byteLength(JSON.stringify(bundle), 'utf8') > MAX_REPORT_BUNDLE_BYTES) throw new Error('REPORT_BUNDLE_TOO_LARGE');
  return bundle;
}
export async function persistReport(directory, { nowISO = new Date().toISOString() } = {}) {
  const receipt = await json(resolve(directory, 'publication.json'));
  await verifyPublication(directory, receipt);
  const report = await json(resolve(directory, 'predictions.json'));
  if (receipt.simulated || report.simulated) throw new Error('SIMULATION_NOT_PUBLISHED');
  if (!id(receipt.reportId) || report.publication?.reportId !== receipt.reportId || !Array.isArray(report.fixtures)
    || !Number.isFinite(Date.parse(report.generatedAt)) || Date.parse(report.generatedAt) > Date.parse(nowISO) + 60_000) throw new Error('INVALID_REPORT_BUNDLE');
  validateBundle({ version:1, reportId:receipt.reportId, report, receipt });
  const sourceData = {};
  if (report.fixtures.some(row => row.fixture?.source === 'openligadb')) {
    const raw = await json(resolve(directory, 'openligadb-fixtures.json'));
    if (!raw.attribution || !Array.isArray(raw.fixtures) || !Array.isArray(raw.history)) throw new Error('SOURCE_SNAPSHOT_REQUIRED');
    sourceData.openligadb = raw;
  }
  const content = { version:1, reportId:receipt.reportId, report, sourceData };
  const hash = reportHash(content), root = rootPath(directory), snapshot = resolve(root, 'reports', receipt.reportId);
  await mkdir(root, { recursive:true });
  const release = await acquireLock(resolve(root, 'publication-store'));
  try {
    const current = await optionalJson(resolve(root, 'current.json'));
    if (current && (!id(current.reportId) || !id(current.contentHash))) throw new Error('CORRUPT_REPORT_POINTER');
    if (current && Date.parse(current.generatedAt) > Date.parse(report.generatedAt)) throw new Error('REPORT_ORDER_CONFLICT');
    const existing = await optionalJson(resolve(snapshot, 'content.json'));
    if (existing && reportHash(existing) !== hash) throw new Error('IMMUTABLE_REPORT_CONFLICT');
    const previousReceipt = await optionalJson(resolve(snapshot, 'receipt.json'));
    const mergedReceipt = mergePublicationReceipts(previousReceipt, receipt);
    publishableBundle(content, mergedReceipt);
    await mkdir(snapshot, { recursive:true });
    if (!existing) await writeFile(resolve(snapshot, 'content.json'), JSON.stringify(content), { flag:'wx', mode:0o600 });
    await atomicJson(resolve(snapshot, 'receipt.json'), mergedReceipt);
    const pointer = { version:1, reportId:receipt.reportId, contentHash:hash, reportHash:reportHash(report),
      generatedAt:report.generatedAt, storedAt:nowISO, revision:current?.reportId===receipt.reportId?current.revision:(current?.revision||0)+1 };
    await atomicJson(resolve(root, 'current.json'), pointer);
    return pointer;
  } finally { await release(); }
}
export async function persistReportReceipt(directory, receipt) {
  if (!id(receipt?.reportId)) throw new Error('INVALID_RECEIPT');
  const root=rootPath(directory), snapshot=resolve(root,'reports',receipt.reportId);
  const release=await acquireLock(resolve(root,'publication-store'));
  try {
    const content=await json(resolve(snapshot,'content.json'));
    if(content.reportId!==receipt.reportId)throw new Error('PUBLICATION_REPORT_MISMATCH');
    const old=await optionalJson(resolve(snapshot,'receipt.json'));
    const mergedReceipt=mergePublicationReceipts(old,receipt);
    publishableBundle(content,mergedReceipt);
    await atomicJson(resolve(snapshot,'receipt.json'),mergedReceipt);
    return {reportId:receipt.reportId,updated:true};
  } finally { await release(); }
}
export async function loadReportBundle(directory, { reportId } = {}) {
  const root=rootPath(directory), current=await json(resolve(root,'current.json'));
  if (!id(current.reportId) || !id(current.contentHash) || !id(current.reportHash)) throw new Error('CORRUPT_REPORT_POINTER');
  const selected=reportId||current.reportId;
  if(!id(selected))throw new Error('INVALID_REPORT_ID');
  const snapshot=resolve(root,'reports',selected), content=await json(resolve(snapshot,'content.json'));
  const receipt=await json(resolve(snapshot,'receipt.json'));
  if(content.reportId!==selected || content.report.publication?.reportId!==selected || receipt.reportId!==selected)throw new Error('PUBLICATION_REPORT_MISMATCH');
  if(selected===current.reportId && (reportHash(content)!==current.contentHash || reportHash(content.report)!==current.reportHash))throw new Error('PUBLICATION_CONTENT_CHANGED');
  return publishableBundle(content,receipt);
}
