import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only a root-owned, off-repository approval may authorize production.
// Existing unit-test CI or contents of a Git commit are never sufficient.
export const REQUIRED_CHECKS = Object.freeze([
  'COMMERCIAL_API_AUTHORIZED',
  'FIVE_LEAGUE_BACKTEST_SUFFICIENT',
  'WALK_FORWARD_NO_LOOKAHEAD',
  'PROBABILITY_CALIBRATION',
  'ASIAN_ODDS_INDEPENDENCE_AND_OPENING',
  'PREMATCH_DATA_FROZEN',
  'ALL_REGRESSIONS',
  'CI_ON_EXACT_COMMIT',
  'MERGED_PR_ON_EXACT_COMMIT',
  'STAGING_SMOKE',
  'OLD_VERSION_NO_REGRESSION',
  'ROLLBACK_READY',
]);
const SHA = /^[0-9a-f]{40}$/;
const HEX = /^[0-9a-f]{64}$/;
const githubPr = /^https:\/\/github\.com\/wangxtong\/Dimension-Football-\/pull\/[1-9]\d*$/;
const githubCi = /^https:\/\/github\.com\/wangxtong\/Dimension-Football-\/actions\/runs\/[1-9]\d*$/;
const ROOT = '/etc/vantis/release-approvals';
export function validateReleaseApproval(value, expectedCommit, now = Date.now()) {
  if (!SHA.test(expectedCommit) || !value || Array.isArray(value) || typeof value !== 'object'
    || value.schemaVersion !== 1 || value.commitSha !== expectedCommit
    || value.BACKTEST_ALL_GREEN_ONLY !== 'GREEN' || value.RELEASE_GATE !== 'GREEN'
    || !value.checks || Array.isArray(value.checks) || typeof value.checks !== 'object') return false;
  if (REQUIRED_CHECKS.some(check => value.checks[check] !== 'GREEN')) return false;
  if (Object.values(value.checks).some(status => status !== 'GREEN')) return false;
  if (!value.evidence || typeof value.evidence !== 'object') return false;
  const e = value.evidence;
  if (!SHA.test(e.baselineSha || '') || e.baselineSha === expectedCommit
    || e.candidateSha !== expectedCommit || !HEX.test(e.backtestSha256 || '')
    || !HEX.test(e.stagingSmokeSha256 || '') || !HEX.test(e.regressionSha256 || '')
    || !githubCi.test(e.ciRunUrl || '') || !githubPr.test(e.mergedPrUrl || '')) return false;
  const updated = Date.parse(value.approvedAt);
  return Number.isFinite(updated) && Number.isFinite(now)
    && updated <= now && now - updated < 48 * 60 * 60 * 1000;
}
export async function checkRootApproval(commit) {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0 || !SHA.test(commit))
    throw Error('release blocked');
  const directory = await lstat(ROOT);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0
    || directory.mode & 0o022) throw Error('release blocked');
  const filename = ROOT + '/' + commit + '.json';
  const state = await lstat(filename);
  if (!state.isFile() || state.isSymbolicLink() || state.uid !== 0
    || state.mode & 0o077 || state.size > 32768 || state.size < 100)
    throw Error('release blocked');
  const content = JSON.parse(await readFile(filename, 'utf8'));
  if (!validateReleaseApproval(content, commit)) throw Error('release blocked');
  return true;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || !await checkRootApproval(process.argv[2])) throw Error('release blocked');
    process.stdout.write('Root-owned release approval verified for exact commit\n');
  } catch {
    process.stderr.write('RELEASE_GATE=BLOCKED; existing production version retained\n');
    process.exitCode = 1;
  }
}
