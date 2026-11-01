import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { auditSourceReadiness, loadSourceReadiness, runSourceReadiness } from '../source-readiness.mjs';
import { createReplayBundle } from '../data/run-manifest.mjs';
import { DEFAULT_POLICY } from '../policy.mjs';
import { FORECAST_MODEL } from '../forecast.mjs';
import { DEFAULT_SOURCE_POLICY } from '../sources/manager.mjs';
import { DEFAULT_PROVIDER_POLICY } from '../sources/providers.mjs';

const NOW = '2026-10-31T07:50:00.000Z';
function example() {
  const fixtures = [['openligadb', 'BL1'], ['thesportsdb-free', 'PL']].map(([source, league], index) => ({
    id: `f${index}`, source, sourceFixtureId: String(index + 1), league, home: 'Home', away: 'Away', homeTeamId: '1', awayTeamId: '2',
    kickoff: '2026-10-31T14:30:00.000Z', status: 'SCHEDULED', updatedAt: NOW }));
  const history = [{ id: 'h1', source: 'openligadb', sourceFixtureId: 'h1', league: 'BL1', home: 'Home', away: 'Away',
    homeTeamId: '1', awayTeamId: '2', kickoff: '2026-10-30T14:30:00.000Z', status: 'FINISHED', period: 'full-time',
    homeGoals: 1, awayGoals: 0, resultObservedAt: NOW, observedAt: NOW, fetchedAt: NOW }];
  const bundle = createReplayBundle({ fixtures, history, reportId: 'a'.repeat(64), generatedAt: NOW, cutoff: NOW,
    codeVersion: 'b'.repeat(40), policy: DEFAULT_POLICY, model: FORECAST_MODEL });
  const report = { simulated: false, completedAt: NOW, poolComplete: false, publication: { reportId: bundle.manifest.reportId },
    replay: { inputHash: bundle.manifest.inputsHash }, diagnostics: [
      { id: 'openligadb', league: 'BL1', status: 'partial', code: 'community_schedule_unverified', httpStatus: 200, checkedAt: NOW },
      { id: 'tiantian', status: 'pending', code: 'prediction_format_not_verified', httpStatus: 200, checkedAt: NOW },
      { id: 'm88', code: 'robots_denied', checkedAt: NOW },
      { id: 'sportmonks', league: 'PL', code: 'plan_restricted', httpStatus: 403, checkedAt: NOW },
    ], providers: { catalog: [{ id: 'the-odds-api', configured: false }] },
    results: bundle.inputs.fixtures.map((fixture, i) => ({ fixture, forecast: { status: i ? 'unavailable' : 'forecast' },
      marketReadiness: { quotes: pair('hkjc', 'HKJC') } })) };
  return { report, bundle, asOf: NOW, sourcePolicy: DEFAULT_SOURCE_POLICY, providerPolicy: DEFAULT_PROVIDER_POLICY };
}
function pair(sourceId, bookmaker, line = -.5) {
  return ['home', 'away'].map((selection, i) => ({ sourceId, bookmaker, selection, handicap: i ? -line : line,
    decimalOdds: 1.9, providerMatchId: 'p1', market: 'asian-handicap', period: 'full-time', observedAt: NOW,
    sourceUpdatedAt: NOW, validUntil: '2026-10-31T07:55:00.000Z' }));
}

test('network response, data coverage and unknown authorization remain separate; partial leagues retain success', () => {
  const audit = auditSourceReadiness(example());
  assert.equal(audit.summary.fixtures, 2); assert.equal(audit.summary.history, 1);
  const bl = audit.leagueCoverage.find(row => row.league === 'BL1'), pl = audit.leagueCoverage.find(row => row.league === 'PL');
  assert.deepEqual([bl.history, bl.forecasts, pl.history, pl.forecasts], [1, 1, 0, 0]);
  const monitor = audit.sources.find(row => row.id === 'tiantian');
  assert.equal(monitor.network.status, 'responded'); assert.equal(monitor.authorization.verifiedGrant, null);
  assert.ok(monitor.leagues.every(row => row.quotes.retainedPairedCount === 0));
  assert.equal(audit.sources.find(row => row.id === 'titan007').authorization.status, 'blocked-by-robots');
  assert.equal(audit.sources.find(row => row.id === 'sportmonks').network.status, 'responded');
  assert.equal(audit.sources.find(row => row.id === 'sportmonks').authorization.status, 'restricted');
  assert.equal(audit.sources.find(row => row.id === 'the-odds-api').authorization.status, 'not-configured');
  assert.equal(audit.releaseAuthorization, false);
});

test('retained collection quotes are not current quotes; shared Titan bookmakers cannot invent independence', () => {
  const input = example();
  input.report.results[0].marketReadiness.quotes = [...pair('titan007', 'M88'), ...pair('titan007', '12Bet'), ...pair('titan007', 'SBOBET')];
  input.report.results[1].marketReadiness.quotes = [];
  const audit = auditSourceReadiness({ ...input, asOf: '2026-10-31T08:00:00.000Z' });
  assert.equal(audit.summary.retainedQuoteRows, 6); assert.equal(audit.summary.unexpiredRetainedQuoteRowsAtAudit, 0);
  assert.deepEqual(audit.summary.independentQuoteGroupsAtReport, ['titan007']);
  assert.equal(audit.summary.fixturesWithAlignedIndependentQuotes, 0);
  assert.ok(audit.gaps.includes('SECOND_ALIGNED_INDEPENDENT_ASIAN_SOURCE_MISSING'));
  input.report.results[0].marketReadiness.quotes.push(...pair('hkjc', 'HKJC', -1));
  assert.equal(auditSourceReadiness(input).summary.fixturesWithAlignedIndependentQuotes, 0);
});

test('cross-report inputs, changed history, duplicate fixtures and malformed quote pairs fail closed', () => {
  const input = example(), wrong = structuredClone(input);
  wrong.bundle.inputs.history.push(wrong.bundle.inputs.history[0]);
  assert.throws(() => auditSourceReadiness(wrong), /RUN_INPUT_HASH_MISMATCH/);
  wrong.bundle = input.bundle; wrong.report.publication.reportId = 'c'.repeat(64);
  assert.throws(() => auditSourceReadiness(wrong), /RUN_REPORT_ID_MISMATCH/);
  const duplicate = example(); duplicate.report.results[1] = duplicate.report.results[0];
  assert.throws(() => auditSourceReadiness(duplicate), /SOURCE_AUDIT_REPORT_MISMATCH/);
  const missingSide = example(); missingSide.report.results[0].marketReadiness.quotes.pop();
  const audit = auditSourceReadiness(missingSide);
  assert.equal(audit.summary.retainedQuoteRows, 2); assert.equal(audit.summary.rejectedRetainedQuoteRows, 1);
});

test('the loader verifies publication hashes and ignores unrelated bridge or history files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'source-readiness-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = example(), documents = { 'latest.json': input.report, 'run-manifest.json': input.bundle.manifest,
    'run-inputs.json': input.bundle.inputs, 'predictions.json': { publication: input.report.publication } };
  const files = [];
  for (const [name, document] of Object.entries(documents)) {
    const bytes = JSON.stringify(document); await writeFile(join(dir, name), bytes);
    files.push({ name, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  await writeFile(join(dir, 'publication.json'), JSON.stringify({ version: 1, reportId: input.bundle.manifest.reportId,
    channels: { files: { status: 'published' } }, files }));
  await writeFile(join(dir, 'bridge-private-history.json'), JSON.stringify({ history: Array(1785).fill({ irrelevant: true }) }));
  const audit = await loadSourceReadiness({ reportDir: dir, asOf: NOW });
  assert.equal(audit.summary.history, 1);
  let output = ''; await runSourceReadiness(['--report-dir', dir, '--as-of', NOW], { stdout: value => { output += value; } });
  assert.equal(JSON.parse(output).summary.history, 1);
  await writeFile(join(dir, 'latest.json'), JSON.stringify({ ...input.report, diagnostics: [] }));
  await assert.rejects(loadSourceReadiness({ reportDir: dir, asOf: NOW }), /PUBLICATION_CONTENT_CHANGED/);
});

test('unrecognized diagnostic text and configuration extras are never echoed', () => {
  const input = example(); input.report.diagnostics.push({ id: 'hkjc', code: 'synthetic-secret', checkedAt: NOW });
  input.report.providers.catalog.push({ id: 'sportmonks', configured: true, apiKey: 'synthetic-secret' });
  const audit = auditSourceReadiness(input);
  assert.ok(!JSON.stringify(audit).includes('synthetic-secret'));
});

test('Macau production origin evidence never asserts quote coverage, current licensing or a live source from registration', () => {
  const input = example();
  input.report.diagnostics.push({ id: 'macauslot', status: 'pending', code: 'incomplete_market', httpStatus: 200, checkedAt: NOW });
  const source = auditSourceReadiness(input).sources.find(row => row.id === 'macauslot');
  assert.equal(source.network.status, 'responded');
  assert.ok(source.network.codes.includes('incomplete_market'));
  assert.equal(source.productionOrigin.group, 'macauslot-official');
  assert.equal(source.productionOrigin.evidence[0].documentDate, '2019-07-23');
  assert.equal(source.authorization.verifiedGrant, null);
  assert.equal(source.authorization.redistributionRights, 'not-established-by-this-audit');
  assert.ok(source.leagues.every(row => row.quotes.retainedPairedCount === 0));
});
