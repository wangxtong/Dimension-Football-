import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorizeRelease } from './release-authorization.mjs';

const commit = 'a'.repeat(40);
const sha = 'b'.repeat(64);
const tools = 'c'.repeat(64);
const manifest = { version: 1, kind: 'release', sourceCommit: commit, archiveSha256: sha, toolingDigest: tools };
const now = Date.parse('2026-10-31T10:00:00Z');

async function fixture(change = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'vantis-auth-test-'));
  const approvals = join(root, 'release-approvals');
  await mkdir(approvals, { mode: 0o700 });
  const pair = generateKeyPairSync('ed25519');
  await writeFile(join(root, 'release-authorization.pub.pem'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const approval = {
    version: 1, scope: 'ecs-code-release', sourceCommit: commit, archiveSha256: sha, toolingDigest: tools,
    ciRunUrl: 'https://github.com/wangxtong/Dimension-Football-/actions/runs/123', ciCommit: commit,
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
    a => { a.previousVersionRegressionPassed = false; },
    a => { a.ecsAuthorizationGranted = false; }
  ]) {
    const f = await fixture(change);
    try { await assert.rejects(authorizeRelease(f.manifestPath, f.options), /INDEPENDENT_APPROVAL_INCOMPLETE/); }
    finally { await rm(f.root, { recursive: true, force: true }); }
  }
});
