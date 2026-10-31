import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRelease, hashReleaseFileManifest } from './release-authorization.mjs';

const commit = 'a'.repeat(40);
const sha = 'b'.repeat(64);
const tools = 'c'.repeat(64);
const manifest = {
  version: 1, kind: 'release', sourceCommit: commit, archiveSha256: sha, toolingDigest: tools,
  files: {
    'collector/operations.mjs': { sha256: 'd'.repeat(64), size: 123 },
    'deploy/release.sh': { sha256: 'e'.repeat(64), size: 456 }
  }
};
const now = Date.parse('2026-10-31T10:00:00Z');

async function fixture(change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'vantis-auth-test-'));
  const approvals = join(root, 'release-approvals');
  await mkdir(approvals, { mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  await writeFile(join(root, 'release-authorization.pub.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const approval = {
    version: 1, scope: 'ecs-code-release', sourceCommit: commit, archiveSha256: sha, toolingDigest: tools,
    filesDigest: hashReleaseFileManifest(manifest.files),
    ciRunUrl: 'https://github.com/wangxtong/Dimension-Football-/actions/runs/123', ciCommit: commit,
    ciEvent: 'push', ciBranch: 'main', targetInstanceId: 'i-j6c4g9s2y6b5irl5gcr9',
    ciConclusion: 'success', previousVersionRegressionPassed: true, ecsAuthorizationGranted: true,
    approvedBy: 'maintainer-a', reviewedBy: 'reviewer-b', approvedAt: '2026-10-31T09:00:00Z',
    expiresAt: '2026-11-01T09:00:00Z'
  };
  change(approval);
  const payload = Buffer.from(JSON.stringify(approval));
  const approved = join(approvals, commit + '.json');
  await writeFile(approved, payload);
  await writeFile(approved + '.sig', sign(null, payload, pair.privateKey));
  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, approved, manifestPath, options: { configDir: root, trustedUid: process.getuid(), now } };
}
async function checkRejected(action, expected) {
  const f = await fixture();
  try {
    await action(f);
    await assert.rejects(authorizeRelease(f.manifestPath, f.options), new RegExp(expected));
  } finally { await rm(f.root, { recursive: true, force: true }); }
}
test('digest is insensitive to file listing order but sensitive to file changes', () => {
  const entries = Object.entries(manifest.files);
  assert.equal(hashReleaseFileManifest(Object.fromEntries(entries)),
    hashReleaseFileManifest(Object.fromEntries(entries.reverse())));
  assert.notEqual(hashReleaseFileManifest(manifest.files),
    hashReleaseFileManifest({ ...manifest.files,
      'collector/operations.mjs': { sha256: '0'.repeat(64), size: 123 } }));
});
test('cross-language UTF-8 filename ordering has a fixed signing digest', () => {
  const files = {
    'collector/😀.mjs': { sha256: 'a'.repeat(64), size: 12 },
    'collector/.mjs': { sha256: 'b'.repeat(64), size: 34 }
  };
  // Python json.dumps with ensure_ascii=False and UTF-8 byte-sorted paths.
  assert.equal(hashReleaseFileManifest(files),
    'aeb18281708f408c74e7bf3fba20a0e43c9d73afe932ec127297771f18811b47');
});
test('valid independently signed pinned artifact authorizes code switch only', async () => {
  const f = await fixture();
  try {
    const result = await authorizeRelease(f.manifestPath, f.options);
    assert.equal(result.sourceCommit, commit);
    assert.equal(result.forecastReleaseAuthorized, false);
    assert.equal(result.ecsDeployed, false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('fail closed for absent signature, altered bytes, unapproved digest and expiration', async () => {
  await checkRejected(async f => rm(f.approved + '.sig'), 'TRUST_PATH_MISSING');
  await checkRejected(async f => writeFile(f.approved, '{}'), 'SIGNATURE_INVALID');
  await checkRejected(async f => writeFile(f.manifestPath, JSON.stringify({ ...manifest, archiveSha256: 'd'.repeat(64) })), 'ARTIFACT_IDENTITY_MISMATCH');
  // A malicious/stale extracted tree can update its own manifest.entries while
  // retaining the approved sourceCommit/archiveSha256/toolingDigest strings.
  // The detached signature must authenticate the *full payload file list*.
  await checkRejected(async f => writeFile(f.manifestPath, JSON.stringify({
    ...manifest, files: { ...manifest.files,
      'collector/operations.mjs': { sha256: 'f'.repeat(64), size: 123 } }
  })), 'ARTIFACT_IDENTITY_MISMATCH');
  await checkRejected(async f => writeFile(f.manifestPath, JSON.stringify({
    ...manifest, files: { ...manifest.files, 'collector/malicious.mjs': { sha256: 'f'.repeat(64), size: 13 } }
  })), 'ARTIFACT_IDENTITY_MISMATCH');
  await checkRejected(async f => writeFile(f.manifestPath, JSON.stringify({ ...manifest, files: null })), 'SOURCE_FILE_MANIFEST_INVALID');
  await checkRejected(async f => writeFile(f.manifestPath, JSON.stringify({
    ...manifest, files: { 'collector/operations.mjs': { sha256: 'invalid', size: 123 } }
  })), 'SOURCE_FILE_MANIFEST_INVALID');
  await checkRejected(async f => { f.options.now += 3 * 24 * 3600 * 1000; }, 'APPROVAL_EXPIRED_OR_INVALID');
});
test('rejects insecure local trust material and symlink approvals', async () => {
  await checkRejected(async f => chmod(f.approved, 0o666), 'TRUST_PATH_UNSAFE');
  await checkRejected(async f => {
    await rename(f.approved, f.approved + '.original');
    await symlink(f.approved + '.original', f.approved);
  }, 'TRUST_PATH_UNSAFE');
});
test('even signed files cannot omit independent approval or green CI attestation', async () => {
  for (const change of [
    a => { a.reviewedBy = a.approvedBy; },
    a => { a.ciConclusion = 'failure'; },
    a => { a.ciEvent = 'pull_request'; },
    a => { a.ciBranch = 'feature/pr-head'; },
    a => { a.targetInstanceId = 'unapproved-server'; },
    a => { a.previousVersionRegressionPassed = false; },
    a => { a.ecsAuthorizationGranted = false; }
  ]) {
    const f = await fixture(change);
    try { await assert.rejects(authorizeRelease(f.manifestPath, f.options), /INDEPENDENT_APPROVAL_INCOMPLETE/); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
