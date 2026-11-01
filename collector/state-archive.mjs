import { createHash } from 'node:crypto';

export const ARCHIVE_LIMITS = Object.freeze({ shardBytes: 4 * 1024 * 1024, shardFiles: 10000,
  newShards: 32, shards: 2048, decodedBytes: 256 * 1024 * 1024, files: 200000 });
const HASH = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => object(value) && Object.keys(value).sort().join(',') === expected.split(',').sort().join(',');
const fail = code => { throw Error(code); };
export const archiveHash = bytes => createHash('sha256').update(bytes).digest('hex');
export const archivePath = path => typeof path === 'string' &&
  (/^reports\/forecast-ledger\/[a-f0-9]{64}\/(?:predictions|results|scores|opportunities)\/[a-f0-9]{64}\.json$/.test(path)
    || /^reports\/replays\/[a-f0-9]{64}\/(?:run-inputs|run-manifest)\.json$/.test(path));
export function createArchiveEpoch(origin, baseRevision) {
  if (typeof origin !== 'string' || !Number.isSafeInteger(baseRevision) || baseRevision < 0) fail('HOSTED_ARCHIVE_INVALID_EPOCH');
  return archiveHash(JSON.stringify({ version: 1, kind: 'state-archive-epoch', origin, baseRevision }));
}
export function emptyArchive(epoch) {
  if (!HASH.test(epoch)) fail('HOSTED_ARCHIVE_INVALID_EPOCH');
  return { version: 1, epoch, shards: [], fileCount: 0, decodedBytes: 0 };
}
export function validateArchive(archive, limits = ARCHIVE_LIMITS) {
  if (!keys(archive, 'version,epoch,shards,fileCount,decodedBytes') || archive.version !== 1 || !HASH.test(archive.epoch)
    || !Array.isArray(archive.shards) || !Number.isSafeInteger(archive.fileCount) || archive.fileCount < 0
    || !Number.isSafeInteger(archive.decodedBytes) || archive.decodedBytes < 0) fail('HOSTED_ARCHIVE_INVALID_MANIFEST');
  if (archive.shards.length > limits.shards || archive.fileCount > limits.files || archive.decodedBytes > limits.decodedBytes)
    fail('HOSTED_ARCHIVE_LIMIT_EXCEEDED');
  const seen = new Set(); let files = 0, bytes = 0;
  for (const shard of archive.shards) {
    if (!keys(shard, 'sha256,wireBytes,decodedBytes,fileCount') || !HASH.test(shard.sha256) || seen.has(shard.sha256)
      || !['wireBytes', 'decodedBytes', 'fileCount'].every(key => Number.isSafeInteger(shard[key]) && shard[key] > 0)
      || shard.wireBytes > limits.shardBytes || shard.fileCount > limits.shardFiles) fail('HOSTED_ARCHIVE_INVALID_DESCRIPTOR');
    seen.add(shard.sha256); files += shard.fileCount; bytes += shard.decodedBytes;
  }
  if (files !== archive.fileCount || bytes !== archive.decodedBytes) fail('HOSTED_ARCHIVE_TOTAL_MISMATCH');
  return archive;
}
export function decodeArchiveFile(file) {
  if (!keys(file, 'path,content') || !archivePath(file.path) || typeof file.content !== 'string'
    || file.content.length % 4 || /[^A-Za-z0-9+/=]/.test(file.content)) fail('HOSTED_ARCHIVE_INVALID_FILE');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content) fail('HOSTED_ARCHIVE_INVALID_FILE');
  try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('HOSTED_ARCHIVE_INVALID_JSON'); }
  return bytes;
}
export function createArchiveShard(epoch, files, limits = ARCHIVE_LIMITS) {
  if (!HASH.test(epoch) || !Array.isArray(files) || !files.length || files.length > limits.shardFiles) fail('HOSTED_ARCHIVE_INVALID_SHARD');
  const rows = [...files].sort((a, b) => a.path.localeCompare(b.path)), seen = new Set(); let decodedBytes = 0;
  for (const file of rows) {
    if (seen.has(file.path)) fail('HOSTED_ARCHIVE_DUPLICATE_PATH');
    seen.add(file.path); decodedBytes += decodeArchiveFile(file).length;
  }
  const body = { version: 1, kind: 'state-archive-shard', epoch, files: rows }, wire = JSON.stringify(body), wireBytes = Buffer.byteLength(wire);
  if (wireBytes > limits.shardBytes) fail('HOSTED_ARCHIVE_SHARD_TOO_LARGE');
  return { body, descriptor: { sha256: archiveHash(wire), wireBytes, decodedBytes, fileCount: rows.length } };
}
export function decodeArchiveShard(body, descriptor, epoch, limits = ARCHIVE_LIMITS) {
  if (!keys(body, 'version,kind,epoch,files') || body.version !== 1 || body.kind !== 'state-archive-shard' || body.epoch !== epoch)
    fail('HOSTED_ARCHIVE_INVALID_SHARD');
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > limits.shardFiles) fail('HOSTED_ARCHIVE_INVALID_SHARD');
  const wire = JSON.stringify(body), wireBytes = Buffer.byteLength(wire);
  if (wireBytes > limits.shardBytes) fail('HOSTED_ARCHIVE_SHARD_TOO_LARGE');
  const seen = new Set(); let decodedBytes = 0;
  const files = body.files.map(file => {
    const bytes = decodeArchiveFile(file);
    if (seen.has(file.path)) fail('HOSTED_ARCHIVE_DUPLICATE_PATH');
    seen.add(file.path); decodedBytes += bytes.length; return { path: file.path, bytes };
  });
  const observed = { sha256: archiveHash(wire), wireBytes, decodedBytes, fileCount: files.length };
  if (!keys(descriptor, 'sha256,wireBytes,decodedBytes,fileCount') || Object.entries(observed).some(([key, value]) => descriptor[key] !== value))
    fail('HOSTED_ARCHIVE_HASH_MISMATCH');
  return files;
}
export function appendArchive(archive, descriptors, limits = ARCHIVE_LIMITS) {
  validateArchive(archive, limits);
  if (descriptors.length > limits.newShards) fail('HOSTED_ARCHIVE_CHECKPOINT_BATCH_EXCEEDED');
  const next = { ...archive, shards: [...archive.shards, ...descriptors],
    fileCount: archive.fileCount + descriptors.reduce((n, row) => n + row.fileCount, 0),
    decodedBytes: archive.decodedBytes + descriptors.reduce((n, row) => n + row.decodedBytes, 0) };
  return validateArchive(next, limits);
}
