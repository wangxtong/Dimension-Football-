import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REQUIRED_CHECKS, validateReleaseApproval } from '../release-gate.mjs';

const sha = 'a'.repeat(40);
const now = Date.parse('2026-10-31T12:00:00Z');
function valid() {
  return {
    schemaVersion: 1, commitSha: sha, approvedAt: '2026-10-31T11:00:00Z',
    BACKTEST_ALL_GREEN_ONLY: 'GREEN', RELEASE_GATE: 'GREEN',
    checks: Object.fromEntries(REQUIRED_CHECKS.map(name => [name, 'GREEN'])),
    evidence: {
      baselineSha: 'b'.repeat(40), candidateSha: sha,
      backtestSha256: 'c'.repeat(64), stagingSmokeSha256: 'd'.repeat(64),
      regressionSha256: 'e'.repeat(64),
      ciRunUrl: 'https://github.com/wangxtong/Dimension-Football-/actions/runs/123',
      mergedPrUrl: 'https://github.com/wangxtong/Dimension-Football-/pull/12',
    },
  };
}
test('external exact-commit approval accepts only complete GREEN with bounded age', () => {
  assert.equal(validateReleaseApproval(valid(), sha, now), true);
  assert.equal(validateReleaseApproval(valid(), 'f'.repeat(40), now), false);
  assert.equal(validateReleaseApproval(valid(), sha, now + 49 * 60 * 60 * 1000), false);
});
test('every blocking status and missing check stops production', () => {
  for (const status of ['FAIL','WARN_BLOCKING','UNKNOWN','BACKTEST_INSUFFICIENT','PENDING','success']) {
    for (const name of REQUIRED_CHECKS) {
      const data = valid(); data.checks[name] = status;
      assert.equal(validateReleaseApproval(data, sha, now), false);
    }
    for (const name of ['BACKTEST_ALL_GREEN_ONLY','RELEASE_GATE']) {
      const data = valid(); data[name] = status;
      assert.equal(validateReleaseApproval(data, sha, now), false);
    }
  }
  for (const name of REQUIRED_CHECKS) {
    const data = valid(); delete data.checks[name];
    assert.equal(validateReleaseApproval(data, sha, now), false);
  }
});
test('commit, evidence, origin and expiry mismatches fail closed', () => {
  const variants = [
    item => { item.evidence.candidateSha = 'f'.repeat(40); },
    item => { item.evidence.baselineSha = sha; },
    item => { item.evidence.backtestSha256 = ''; },
    item => { item.evidence.ciRunUrl = 'https://example.invalid/check'; },
    item => { item.evidence.mergedPrUrl = 'https://github.com/another/repo/pull/1'; },
    item => { item.checks.UNREVIEWED_TEST = 'UNKNOWN'; },
    item => { item.approvedAt = '2026-11-02T00:00:00Z'; },
  ];
  for (const alter of variants) { const data = valid(); alter(data); assert.equal(validateReleaseApproval(data, sha, now), false); }
});
test('installer, bootstrap and sync all point to external gate and private Git path', async () => {
  const files = {};
  for (const name of ['sync.sh','release.sh','install.sh','bootstrap.sh','private-git-askpass.sh']) {
    files[name] = await readFile(new URL('../'+name, import.meta.url), 'utf8');
  }
  for (const name of ['sync.sh','release.sh','install.sh','bootstrap.sh'])
    assert.match(files[name], /release-gate\.mjs/);
  assert.match(files['sync.sh'], /GIT_ASKPASS/);
  assert.match(files['sync.sh'], /github-read-token/);
  assert.match(files['bootstrap.sh'], /GIT_ASKPASS/);
  assert.doesNotMatch(files['sync.sh'], /codeload\.github\.com/);
  assert.doesNotMatch(files['bootstrap.sh'], /codeload\.github\.com\/wangxtong/);
});
