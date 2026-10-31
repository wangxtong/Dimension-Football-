import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson } from './storage.mjs';

const ROOT = '/etc/vantis/publish-approvals';
const CURRENT_COMMIT = '/opt/vantis/current/.source-commit';
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
export const FIVE_LEAGUES = Object.freeze(['PL', 'PD', 'SA', 'BL1', 'FL1']);
export const RELEASE_CHECKS = Object.freeze([
  'COMMERCIAL_API_AUTHORIZED',
  'FIVE_LEAGUE_BACKTEST_SUFFICIENT',
  'PROSPECTIVE_FROZEN_NO_LOOKAHEAD',
  'PROBABILITY_CALIBRATION',
  'INDEPENDENT_ASIAN_ODDS_AND_TRUE_OPENING',
  'FULL_REGRESSION_TESTS',
  'PR_MERGED_CI_EXACT_COMMIT_GREEN',
  'STAGING_SMOKE',
  'OLD_VERSION_NO_REGRESSION',
  'PRODUCTION_ROLLBACK_READY',
]);
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const evidenceLink = (value, suffix) => typeof value === 'string'
  && value.startsWith('https://github.com/wangxtong/Dimension-Football-/' + suffix)
  && /^[1-9][0-9]*$/.test(value.slice(('https://github.com/wangxtong/Dimension-Football-/' + suffix).length));

// Pure format-and-content validation for individually reviewed, off-repository
// attestations. It does not mint or certify that any real evidence exists.
export function validateGreenForecastApproval({ report, receipt, approval, commitSha, nowMs }) {
  if (!SHA.test(commitSha || '') || !receipt || !HASH.test(receipt.reportId || '')
    || receipt.simulated || receipt.channels?.files?.status !== 'published'
    || !report || report.simulated || report.publication?.reportId !== receipt.reportId
    || report.model?.calibrated !== true || !Array.isArray(report.backtests)
    || !Array.isArray(report.fixtures) || !report.summary
    || !Number.isFinite(nowMs)) return false;
  const generatedAt = Date.parse(report.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > nowMs || nowMs - generatedAt > 3600000) return false;
  for (const league of FIVE_LEAGUES) {
    const matches = report.backtests.filter(x => x.league === league);
    if (matches.length !== 1 || matches[0].status !== 'verified-prospective'
      || matches[0].provenance !== 'prospective-ledger'
      || !Number.isSafeInteger(matches[0].evaluated) || matches[0].evaluated < 200
      || !Number.isFinite(matches[0].metrics?.brier)
      || !Number.isFinite(matches[0].metrics?.logLoss)) return false;
  }
  if (!approval || approval.schemaVersion !== 1 || approval.commitSha !== commitSha
    || approval.reportId !== receipt.reportId || approval.reportSha256 !== digest(report)
    || approval.BACKTEST_ALL_GREEN_ONLY !== 'GREEN' || approval.RELEASE_GATE !== 'GREEN'
    || !approval.checks || typeof approval.checks !== 'object' || Array.isArray(approval.checks)
    || RELEASE_CHECKS.some(name => approval.checks[name] !== 'GREEN')
    || Object.values(approval.checks).some(value => value !== 'GREEN')) return false;
  const time = Date.parse(approval.approvedAt);
  if (!Number.isFinite(time) || time < generatedAt || time > nowMs || nowMs - time > 3600000) return false;
  const e = approval.evidence;
  return !!e && HASH.test(e.backtestSha256 || '') && HASH.test(e.stagingSmokeSha256 || '')
    && HASH.test(e.regressionSha256 || '') && evidenceLink(e.mergedPrUrl, 'pull/')
    && evidenceLink(e.ciRunUrl, 'actions/runs/')
    && SHA.test(e.oldProductionSha || '') && e.oldProductionSha !== commitSha;
}

async function protectedFile(path, {groupReadable = false} = {}) {
  const entry = await lstat(path);
  const mode = entry.mode & 0o777;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0
    || (mode & 0o022) !== 0 || (mode & 0o004) !== 0
    || (groupReadable && (mode & 0o040) === 0))
    throw new Error('RELEASE_GATE_BLOCKED');
  return readFile(path, 'utf8');
}

export async function requireGreenForecastDelivery(directory, nowMs = Date.now()) {
  try {
    const receipt = await readJson(resolve(directory, 'publication.json'));
    if (!HASH.test(receipt?.reportId || '')) throw Error();
    const report = await readJson(resolve(directory, 'predictions.json'));
    const current = (await readFile(CURRENT_COMMIT, 'utf8')).trim();
    const directoryStat = await lstat(ROOT);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
      || directoryStat.uid !== 0 || (directoryStat.mode & 0o022) !== 0) throw Error();
    const source = await protectedFile(ROOT + '/' + receipt.reportId + '.json', { groupReadable:true });
    const approval = JSON.parse(source);
    if (!validateGreenForecastApproval({report,receipt,approval,commitSha:current,nowMs}))
      throw Error();
    return { reportId:receipt.reportId, commitSha:current, release:'GREEN' };
  } catch {
    throw new Error('RELEASE_GATE_BLOCKED');
  }
}
