#!/usr/bin/env node
/**
 * Fail-closed ECS code-release authorization, independent of Git/CI status.
 * Verifies an administrator-pinned Ed25519 key and detached signature over
 * the exact approval JSON bytes. Does not issue approvals or deploy code.
 */
import { createHash, createPublicKey, verify } from 'node:crypto';
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
// Bind the signed approval to the *entire* extracted payload, not only the
// archiveSha256 string copied into an editable extraction manifest. The caller
// separately verifies each actual file against manifest.files using bundle.py.
// Canonical bytes: JSON UTF-8 of sorted [path, sha256, size] tuples.
export function hashReleaseFileManifest(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) blocked('SOURCE_FILE_MANIFEST_INVALID');
  const paths = Object.keys(files).sort();
  if (!paths.length || paths.length > 20000) blocked('SOURCE_FILE_MANIFEST_INVALID');
  const entries = paths.map(path => {
    const file = files[path];
    if (!path || path.includes('\\0') || !file || typeof file !== 'object' || Array.isArray(file) ||
        !SHA64.test(file.sha256 ?? '') || !Number.isSafeInteger(file.size) || file.size < 0)
      blocked('SOURCE_FILE_MANIFEST_INVALID');
    return [path, file.sha256, file.size];
  });
  return createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex');
}
async function trusted(path, kind, uid) {
  const st = await lstat(path).catch(() => blocked('TRUST_PATH_MISSING'));
  if (st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022) !== 0 ||
      (kind === 'directory' ? !st.isDirectory() : !st.isFile())) blocked('TRUST_PATH_UNSAFE');
}
export async function authorizeRelease(manifestPath, { configDir = '/etc/vantis', trustedUid = 0, now = Date.now() } = {}) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const commit = manifest.sourceCommit;
  const filesDigest = hashReleaseFileManifest(manifest.files);
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
  try {
    const publicKey = createPublicKey(key);
    if (publicKey.asymmetricKeyType !== 'ed25519' || signature.length !== 64) blocked('SIGNATURE_INVALID');
    valid = verify(null, payload, publicKey, signature);
  }
  catch { blocked('SIGNATURE_INVALID'); }
  if (!valid) blocked('SIGNATURE_INVALID');

  let approval;
  try { approval = JSON.parse(payload.toString('utf8')); }
  catch { blocked('APPROVAL_JSON_INVALID'); }
  if (approval.version !== 1 || approval.scope !== 'ecs-code-release' ||
      approval.sourceCommit !== commit || approval.archiveSha256 !== manifest.archiveSha256 ||
      approval.toolingDigest !== manifest.toolingDigest ||
      !SHA64.test(approval.filesDigest ?? '') || approval.filesDigest !== filesDigest)
    blocked('ARTIFACT_IDENTITY_MISMATCH');
  // pull_request workflows build ephemeral merge commits; production requires
  // an independently audited push CI run for the real main commit instead.
  if (!CI_RUN.test(approval.ciRunUrl ?? '') || approval.ciCommit !== commit ||
      approval.ciEvent !== 'push' || approval.ciBranch !== 'main' ||
      approval.targetInstanceId !== 'i-j6c4g9s2y6b5irl5gcr9' ||
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
