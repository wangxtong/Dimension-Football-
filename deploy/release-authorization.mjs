#!/usr/bin/env node
/**
 * Fail-closed ECS code-release authorization, independent of Git/CI status.
 * Verifies an administrator-pinned Ed25519 key and detached signature over
 * the exact approval JSON bytes. Does not issue approvals or deploy code.
 */
import { createPublicKey, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const CI_RUN = /^https:\/\/github\.com\/wangxtong\/Dimension-Football-\/actions\/runs\/[1-9][0-9]*(?:\/attempts\/[1-9][0-9]*)?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

function blocked(code) {
  const error = new Error('RELEASE_AUTH_BLOCKED_' + code);
  error.code = code;
  throw error;
}
async function trusted(path, kind, uid) {
  const st = await lstat(path).catch(() => blocked('TRUST_PATH_MISSING'));
  if (st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022) !== 0 ||
      (kind === 'directory' ? !st.isDirectory() : !st.isFile())) blocked('TRUST_PATH_UNSAFE');
}
export async function authorizeRelease(manifestPath, { configDir = '/etc/vantis', trustedUid = 0, now = Date.now() } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const commit = manifest.sourceCommit;
  if (!SHA40.test(commit ?? '') || !SHA64.test(manifest.archiveSha256 ?? '') ||
      !SHA64.test(manifest.toolingDigest ?? '') || manifest.kind !== 'release' || manifest.version !== 1)
    blocked('SOURCE_MANIFEST_INVALID');

  const approvals = join(configDir, 'release-approvals');
  const keyPath = join(configDir, 'release-authorization.pub.pem');
  const approvalPath = join(approvals, commit + '.json');
  const signaturePath = approvalPath + '.sig';
  for (const dir of [configDir, approvals]) await trusted(dir, 'directory', trustedUid);
  for (const file of [keyPath, approvalPath, signaturePath]) await trusted(file, 'file', trustedUid);

  const [key, payload, signature] = await Promise.all([
    readFile(keyPath), readFile(approvalPath), readFile(signaturePath)
  ]);
  let valid = false;
  try { valid = verify(null, payload, createPublicKey(key), signature); }
  catch { blocked('SIGNATURE_INVALID'); }
  if (!valid) blocked('SIGNATURE_INVALID');

  let approval;
  try { approval = JSON.parse(payload.toString('utf8')); }
  catch { blocked('APPROVAL_JSON_INVALID'); }
  if (approval.version !== 1 || approval.scope !== 'ecs-code-release' ||
      approval.sourceCommit !== commit || approval.archiveSha256 !== manifest.archiveSha256 ||
      approval.toolingDigest !== manifest.toolingDigest) blocked('ARTIFACT_IDENTITY_MISMATCH');
  if (!CI_RUN.test(approval.ciRunUrl ?? '') || approval.ciCommit !== commit ||
      approval.ciConclusion !== 'success' || approval.previousVersionRegressionPassed !== true ||
      approval.ecsAuthorizationGranted !== true ||
      typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim() ||
      typeof approval.reviewedBy !== 'string' || !approval.reviewedBy.trim() ||
      approval.approvedBy.trim() === approval.reviewedBy.trim()) blocked('INDEPENDENT_APPROVAL_INCOMPLETE');

  const created = Date.parse(approval.approvedAt ?? '');
  const expiry = Date.parse(approval.expiresAt ?? '');
  if (!Number.isFinite(created) || !Number.isFinite(expiry) || created > now ||
      created < now - 7 * DAY_MS || expiry <= now || expiry > created + 7 * DAY_MS)
    blocked('APPROVAL_EXPIRED_OR_INVALID');
  return { status: 'authorized_for_code_switch_only', sourceCommit: commit,
    artifactDigest: manifest.archiveSha256, forecastReleaseAuthorized: false, ecsDeployed: false };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) blocked('MANIFEST_REQUIRED');
    console.log(JSON.stringify(await authorizeRelease(process.argv[2])));
  } catch (error) {
    console.error(error?.code ? 'RELEASE_AUTH_BLOCKED_' + error.code : 'RELEASE_AUTH_BLOCKED_UNKNOWN');
    process.exitCode = 1;
  }
}
