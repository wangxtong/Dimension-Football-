import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoInput } from '../demo.mjs';
import { DEFAULT_POLICY, evaluateFixture, quoteSourceGroup, safeQuote } from '../policy.mjs';
import { reconcileMarketEvidence } from '../market-evidence.mjs';
import { buildMarketReadinessAudit, renderMarketReadiness, runMarketReadinessCli } from '../market-readiness.mjs';

const NOW = '2026-10-31T08:00:00.000Z';
const later = offset => new Date(Date.parse(NOW) + offset).toISOString();
const sourceConfig = { version: 1, fixturePriority: ['football-data.org', 'api-football', 'sportmonks'] };
const providerConfig = { version: 1, enabled: ['sportmonks', 'the-odds-api', 'isports'] };

function evidence({ opening = false } = {}) {
  const demo = demoInput(NOW), fixture = { ...demo.fixtures[0], id: 'test-1', source: 'test-fixtures', home: 'Home FC', away: 'Away FC' };
  const fixtureSnapshot = Object.fromEntries(['id', 'source', 'league', 'home', 'away', 'kickoff'].map(key => [key, fixture[key]]));
  const quotes = demo.evidence.quotes.map(q => {
    const hkjc = q.sourceId === 'oddstorm', sourceId = hkjc ? 'hkjc' : 'titan007', bookmaker = hkjc ? 'HKJC' : 'M88';
    const providerMatchId = hkjc ? 'hkjc-event' : 'titan-event';
    const evidenceUrl = hkjc ? 'https://bet.hkjc.com/en/football/hdc' : 'https://live.titan007.com/index2in1.aspx?id=17';
    return { ...q, fixtureId: fixture.id, fixtureSnapshot, sourceId, bookmaker, providerMatchId, evidenceUrl,
      ...(hkjc ? { sourceAsOf: NOW, providerPoolUpdatedAt: NOW, freshnessBasis: 'publisher-live-snapshot', cacheMaxAgeSeconds: 30 }
        : { provider: 'titan007-public-market', companyId: 17 }),
      opening: opening && q.opening ? { ...q.opening, fixtureId: fixture.id, fixtureSnapshot, sourceId, bookmaker, providerMatchId, evidenceUrl } : undefined };
  });
  return { fixture, quotes };
}

function reportFor(fixture, quotes, records = []) {
  return { version: 1, simulated: false, completedAt: NOW, publication: { reportId: 'a'.repeat(64) }, policy: DEFAULT_POLICY,
    summary: { total: 1, candidates: 0 }, candidates: [],
    diagnostics: [{ id: 'm88', status: 'unavailable', code: 'robots_denied', checkedAt: NOW }],
    results: [{ fixture, result: { status: 'source_insufficient', reasons: ['SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING'] }, openingRecords: records,
      lastEvidence: { quotes: quotes.map(q => ({ ...safeQuote(q), ...(q.opening ? { opening: q.opening } : {}) })), signals: [] } }] };
}
const audit = report => buildMarketReadinessAudit(report, { nowISO: NOW, sourceConfig, providerConfig });

test('different bookmakers on the Titan production feed remain exactly one independent channel', () => {
  const { fixture, quotes } = evidence();
  const titan = quotes.filter(q => q.sourceId === 'titan007');
  const threeBooks = [[17, 'M88'], [24, '12Bet'], [31, 'SBOBET']].flatMap(([companyId, bookmaker]) => titan.map(q => ({ ...q, companyId, bookmaker })));
  const result = audit(reportFor(fixture, threeBooks));
  assert.equal(result.rows[0].atReport.pairedQuoteCount, 6);
  assert.deepEqual(result.rows[0].atReport.groups, ['titan007']);
  assert.equal(result.summary.secondSourceMissingAtReport, 1);
  assert.equal(result.releaseStatus, 'BLOCKED'); assert.equal(result.recommendationsCreated, 0);
});

test('a shared production channel cannot acquire a second vote by changing the source label', () => {
  const d = demoInput(NOW), quotes = d.evidence.quotes.map(q => ({ ...q, provider: 'titan007-public-market' }));
  assert.equal(quoteSourceGroup(quotes.find(q => q.sourceId === 'oddstorm')), null);
  assert.notEqual(evaluateFixture(d.fixtures[0], { ...d.evidence, quotes }, NOW).status, 'candidate');
  for (const provider of ['the-odds-api', 'isports', 'api-football']) {
    assert.equal(quoteSourceGroup({ ...quotes[0], provider }), null);
  }
  assert.equal(quoteSourceGroup({ ...quotes[0], bookmaker: 'M88', companyId: 31 }), null);
  assert.equal(quoteSourceGroup({ ...quotes[0], bookmaker: 'M88', companyId: 17 }), 'titan007');
  assert.equal(safeQuote({ ...quotes[0], companyId: 17 }).provider, 'titan007-public-market');
});

test('enabled commercial providers do not manufacture formal market channels or true openings', () => {
  const { fixture, quotes } = evidence();
  const result = audit(reportFor(fixture, quotes.filter(q => q.sourceId === 'hkjc')));
  const references = result.channels.filter(c => ['sportmonks', 'the-odds-api', 'isports'].includes(c.id));
  assert.ok(references.every(c => c.configured && c.group === null));
  assert.deepEqual(result.rows[0].atReport.groups, ['hkjc-first-party']);
  assert.equal(result.summary.trueOpeningMissingAtReport, 1);
  assert.equal(result.summary.secondSourceMissingAtReport, 1);
  assert.equal(result.channels.find(c => c.id === 'titan007').diagnostics[0].code, 'robots_denied');
});

test('an old pool update is not an opening time and a fresh HTTP snapshot only supports bounded freshness', () => {
  const { fixture, quotes } = evidence();
  const hkjc = quotes.filter(q => q.sourceId === 'hkjc').map(q => ({ ...q, sourceUpdatedAt: later(-86400000), providerPoolUpdatedAt: later(-86400000) }));
  const report = reportFor(fixture, hkjc), result = buildMarketReadinessAudit(report, { nowISO: later(300001) });
  assert.equal(result.rows[0].atReport.pairedQuoteCount, 2);
  assert.equal(result.rows[0].atReport.openingEvidenceCount, 0);
  assert.equal(result.rows[0].atAudit.pairedQuoteCount, 0);
  assert.equal(result.summary.staleQuotesAtAudit, 2);
  assert.equal(result.rows[0].atReport.retainedQuoteCount, result.rows[0].atAudit.retainedQuoteCount);
  assert.equal(report.results[0].lastEvidence.quotes[0].observedAt, NOW);
});

test('first-seen or unarchived opening claims cannot replace a provider opening record', () => {
  const { fixture, quotes } = evidence({ opening: true });
  const firstSeen = quotes.map(q => ({ ...q, opening: q.opening ? { ...q.opening, basis: 'first-seen' } : undefined }));
  assert.equal(audit(reportFor(fixture, firstSeen)).rows[0].atReport.openingEvidenceCount, 0);
  assert.equal(audit(reportFor(fixture, quotes)).rows[0].atReport.openingEvidenceCount, 0);
  const saved = reconcileMarketEvidence(fixture, quotes, [], NOW);
  const valid = audit(reportFor(fixture, saved.quotes, saved.records));
  assert.equal(valid.rows[0].atReport.openingEvidenceCount, 2);
  assert.equal(valid.formalRecommendation.allowed, false);
  assert.equal(valid.evidenceBasis.canReplayFormalGate, false);
  assert.ok(valid.rows[0].evidenceGaps.includes('QUOTE_FIXTURE_BINDING_NOT_RETAINED'));
});

test('source changes and rescheduling invalidate old quote and opening identity', () => {
  const { fixture, quotes } = evidence({ opening: true });
  const saved = reconcileMarketEvidence(fixture, quotes, [], NOW);
  for (const change of [{ source: 'another-fixture-provider' }, { kickoff: later(8 * 3600000) }]) {
    const revised = { ...fixture, ...change };
    assert.equal(evaluateFixture(revised, { quotes, signals: [] }, NOW).status, 'source_insufficient');
    const result = audit(reportFor(revised, saved.quotes, saved.records));
    assert.equal(result.rows[0].atReport.openingEvidenceCount, 0);
    assert.ok(result.rows[0].atReport.blockers.includes('TRUE_OPENING_RECORD_MISSING'));
  }
});

test('fresh quote metadata cannot make a stale fixture identity market-ready', () => {
  const { fixture, quotes } = evidence();
  const result = audit(reportFor({ ...fixture, updatedAt: later(-86400001) }, quotes));
  assert.equal(result.rows[0].atReport.pairedQuoteCount, 0);
  assert.ok(result.rows[0].atReport.blockers.includes('FIXTURE_FRESHNESS_UNVERIFIED'));
});

test('corrupt, conflicting or overflowed opening archives never support opening readiness', () => {
  const { fixture, quotes } = evidence({ opening: true }), saved = reconcileMarketEvidence(fixture, quotes, [], NOW);
  for (const records of [saved.records.map(r => ({ ...r, hash: '0'.repeat(64) })), saved.records.map(r => ({ ...r, conflict: true })),
    saved.records.map(r => ({ ...r, fixtureKey: '0'.repeat(64) })),
    [...saved.records, { archiveStatus: 'capacity_exceeded', conflict: true }]]) {
    assert.equal(audit(reportFor(fixture, saved.quotes, records)).rows[0].atReport.openingEvidenceCount, 0);
  }
});

test('readiness lists unknown origin and identity gaps without copying arbitrary metadata or source responses', () => {
  const { fixture, quotes } = evidence();
  const rows = quotes.map(q => ({ ...q, provider: 'isports', authorization: 'must-not-retain', rawBody: 'must-not-retain' }));
  const report = reportFor(fixture, rows); report.unknownSecretField = 'must-not-retain';
  report.diagnostics.push({ id: 'isports', status: 'unavailable', code: 'private value must-not-retain', body: 'must-not-retain' });
  const result = audit(report);
  assert.equal(result.rows[0].atReport.pairedQuoteCount, 0);
  assert.ok(result.rows[0].atReport.blockers.includes('SOURCE_CHANNEL_IDENTITY_CONFLICT'));
  assert.ok(!JSON.stringify(result).includes('must-not-retain'));
  assert.ok(!renderMarketReadiness(result).includes('must-not-retain'));
});

test('future cutoffs, mismatched summaries and simulated reports cannot imply production readiness', () => {
  const { fixture, quotes } = evidence(), report = reportFor(fixture, quotes);
  assert.throws(() => buildMarketReadinessAudit(report, { nowISO: later(-1) }), /INVALID_READINESS_REPORT/);
  const result = audit({ ...report, simulated: true, summary: { total: 1, candidates: 1 } });
  assert.ok(result.integrityBlockers.includes('REPORT_SUMMARY_MISMATCH'));
  assert.ok(result.integrityBlockers.includes('NOT_A_PRODUCTION_REPORT'));
  assert.equal(result.releaseStatus, 'BLOCKED'); assert.equal(result.recommendationsCreated, 0);
});

test('runtime collection budgets are disclosed separately from changes to market gates', () => {
  const { fixture, quotes } = evidence(), report = reportFor(fixture, quotes);
  report.policy = { ...DEFAULT_POLICY, budgetMs: 117892 };
  const operational = audit(report);
  assert.deepEqual(operational.integrityBlockers, []);
  assert.deepEqual(operational.configuration.policyDifferences, [{ key: 'budgetMs', reported: 117892, configured: 1200000, scope: 'collection-operation' }]);
  const gate = buildMarketReadinessAudit(report, { nowISO: NOW, policy: { ...DEFAULT_POLICY, maxQuoteAgeMs: 60000 } });
  assert.ok(gate.integrityBlockers.includes('MARKET_POLICY_CHANGED_SINCE_REPORT'));
});

test('offline CLI binds file digests and produces readable evidence without any fetch capability', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'market-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { fixture, quotes } = evidence(), path = join(directory, 'report.json');
  await writeFile(path, JSON.stringify(reportFor(fixture, quotes.filter(q => q.sourceId === 'hkjc'))));
  let output = '';
  const result = await runMarketReadinessCli(['--report', path, '--format', 'json'], { nowISO: NOW, stdout: value => { output += value; } });
  assert.deepEqual(JSON.parse(output), result);
  assert.ok(Object.values(result.inputDigests).every(value => /^[a-f0-9]{64}$/.test(value)));
  const markdown = renderMarketReadiness(result);
  assert.match(markdown, /Market readiness — BLOCKED/);
  assert.match(markdown, /SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING/);
  assert.match(markdown, /TRUE_OPENING_RECORD_MISSING/);
  assert.match(markdown, /robots_denied/);
});
