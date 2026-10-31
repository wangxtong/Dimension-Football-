import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './storage.mjs';
import { verifyPublication } from './publication.mjs';
import { verifyReplayBundle } from './data/run-manifest.mjs';
import { canonicalTimestamp, dataHash } from './data/identity.mjs';
import { SOURCES, readPolicy, validOpening, validOpeningTrajectory } from './policy.mjs';
import { SOURCE_REGISTRY, readSourcePolicy } from './sources/manager.mjs';
import { PROVIDER_CATALOG, readProviderPolicy } from './sources/providers.mjs';
import { PUBLIC_FIXTURE_SOURCES } from './sources/public-fixtures.mjs';
import { FAILURE_CODES } from './sources/health.mjs';
import { CRAWLER_CODES } from './sources/crawler.mjs';

const LEAGUES = ['PL', 'PD', 'SA', 'BL1', 'FL1'];
const aliases = { m88: 'titan007', '12bet': 'titan007', sbobet: 'titan007' };
const sourceOf = row => aliases[row.sourceId || row.id] || row.sourceId || row.id;
const knownCodes = new Set([...FAILURE_CODES, ...CRAWLER_CODES, 'ok', 'matched', 'source_cooldown', 'cooldown', 'not_configured',
  'contract_required', 'community_schedule_unverified', 'free_tier_limited', 'history_cache_hit', 'history_cache_unavailable', 'prediction_format_not_verified',
  'public_live_snapshot_partial_coverage', 'no_matching_markets', 'no_matching_predictions', 'no_matching_fixtures',
  'outside_today_coverage', 'invalid_or_stale_markets', 'stale_page', 'fixture_identity_unmatched', 'market_not_published']);
const codeOf = row => knownCodes.has(row.code || row.note) ? row.code || row.note : 'unrecognized_diagnostic';
const time = value => canonicalTimestamp(value);
const lastTime = values => values.map(time).filter(Boolean).sort().at(-1) || null;
const countIds = rows => new Set(rows.map(row => row.fixtureId)).size;

function catalog(sourcePolicy, providerPolicy) {
  const entries = new Map();
  for (const id of Object.keys(SOURCE_REGISTRY)) entries.set(id, { id, implemented: true, leagues: LEAGUES,
    capabilities: ['fixtures'], fixtureEnabled: sourcePolicy.fixturePriority.includes(id), authorizationBasis: 'credential-required' });
  for (const row of PROVIDER_CATALOG) entries.set(row.id, { ...entries.get(row.id), id: row.id, implemented: row.implemented,
    leagues: row.implemented ? LEAGUES : [], capabilities: row.capabilities, evidenceEnabled: providerPolicy.enabled.includes(row.id),
    authorizationBasis: row.implemented ? 'credential-required' : 'contract-required', reference: row.setupUrl });
  for (const row of PUBLIC_FIXTURE_SOURCES) entries.set(row.id, { id: row.id, implemented: true, leagues: row.leagues,
    capabilities: row.id === 'openligadb' ? ['fixtures', 'history'] : ['fixtures'], authorizationBasis: 'declared-public-policy',
    declaredLicense: row.license, reference: row.licenseUrl });
  for (const [id, capabilities] of Object.entries({ hkjc: ['asian-handicap'], titan007: ['asian-handicap'],
    statarea: ['1x2-model'], tiantian: ['monitor-only'] })) entries.set(id, { id, implemented: true, leagues: LEAGUES,
      capabilities, authorizationBasis: 'documented-public-operation', reference: `collector/sources/${id === 'titan007' ? 'market-sources' : ['statarea', 'tiantian'].includes(id) ? 'signals' : id}.mjs` });
  for (const id of ['singbet', 'ibc', 'forebet', 'footymetrics', 'tactix', 'golsinyali', 'fotmob']) entries.set(id,
    { id, implemented: false, leagues: [], capabilities: ['authorization-dependent'], authorizationBasis: 'authorization-required' });
  return [...entries.values()];
}

function networkEvidence(rows) {
  const responses = rows.filter(row => Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599);
  const failures = rows.filter(row => /^(?:crawler_)?(?:timeout|network_unavailable)$/.test(codeOf(row)));
  return { status: responses.length ? failures.length ? 'partial-response' : 'responded' : failures.length ? 'failed' : 'not-observed',
    httpStatuses: [...new Set(responses.map(row => row.httpStatus))].sort(), lastResponseAt: lastTime(responses.map(row => row.checkedAt)),
    lastAttemptAt: lastTime(rows.map(row => row.checkedAt)), codes: [...new Set(rows.map(codeOf))].sort(),
    meaning: 'HTTP response evidence only; not usable-data or authorization evidence' };
}

function authorizationEvidence(entry, rows, configured) {
  const codes = rows.map(codeOf);
  const status = codes.includes('robots_denied') ? 'blocked-by-robots'
    : codes.some(code => ['authorization_required', 'access_denied', 'plan_restricted', 'subscription_required'].includes(code)) ? 'restricted'
      : entry.authorizationBasis === 'contract-required' ? 'contract-required'
        : entry.authorizationBasis === 'authorization-required' ? 'authorization-required'
          : entry.authorizationBasis === 'credential-required' ? configured === false ? 'not-configured' : 'entitlement-unverified'
            : entry.authorizationBasis;
  return { status, configuredAtCollection: configured, verifiedGrant: null, redistributionRights: 'not-established-by-this-audit',
    evidenceLevel: entry.reference ? 'repository-declaration' : 'no-grant-evidence',
    ...(entry.reference ? { reference: entry.reference } : {}), ...(entry.declaredLicense ? { declaredLicense: entry.declaredLicense } : {}) };
}

// Retained report quotes omit transport assertions (verified, fixtureSnapshot).
// Inspect their paired shape and expiry without reconstructing those assertions.
function retainedPairs(row, at) {
  const groups = new Map(), accepted = [], quotes = row.marketReadiness?.quotes || [];
  if (!Array.isArray(quotes) || quotes.length > 1000) throw new Error('SOURCE_AUDIT_INVALID_QUOTES');
  for (const q of quotes) {
    if (!Object.hasOwn(SOURCES, q?.sourceId) || q.market !== 'asian-handicap' || q.period !== 'full-time'
      || q.closed === true || q.inPlay === true
      || !['home', 'away'].includes(q.selection) || typeof q.bookmaker !== 'string' || typeof q.providerMatchId !== 'string'
      || !Number.isFinite(q.handicap) || !Number.isInteger(q.handicap * 4) || Math.abs(q.handicap) > 10
      || !Number.isFinite(q.decimalOdds) || q.decimalOdds <= 1 || q.decimalOdds > 21
      || !time(q.observedAt) || !time(q.validUntil) || Date.parse(q.observedAt) > at || Date.parse(q.validUntil) <= at) continue;
    const key = JSON.stringify([q.sourceId, q.bookmaker, q.providerMatchId, q.providerPoolId || null,
      q.selection === 'home' ? q.handicap : -q.handicap, q.observedAt, q.sourceAsOf || q.sourceUpdatedAt]);
    const items = groups.get(key) || []; items.push(q); groups.set(key, items);
  }
  for (const pair of groups.values()) if (pair.length === 2 && new Set(pair.map(q => q.selection)).size === 2) {
    accepted.push(...pair.map(q => ({ ...q, fixtureId: row.fixture.id, league: row.fixture.league,
      group: SOURCES[q.sourceId].group, kickoff: row.fixture.kickoff,
      openingVerified: validOpening(q, row.fixture, new Date(at).toISOString()),
      trajectoryVerified: validOpeningTrajectory(q, row.fixture, new Date(at).toISOString()) })));
  }
  return { quotes: accepted, rejected: quotes.length - accepted.length };
}

export function auditSourceReadiness({ report, bundle, sourcePolicy, providerPolicy, asOf = new Date().toISOString() }) {
  sourcePolicy = readSourcePolicy(sourcePolicy); providerPolicy = readProviderPolicy(providerPolicy);
  const { manifest, inputs } = verifyReplayBundle(bundle, { reportId: report?.publication?.reportId });
  const policy = readPolicy(inputs.policy), at = Date.parse(manifest.generatedAt), auditTime = Date.parse(asOf);
  if (!time(asOf) || auditTime < at || report?.simulated !== false || manifest.simulated !== false
    || report.completedAt !== manifest.generatedAt || report.publication?.reportId !== manifest.reportId
    || report.replay?.inputHash !== manifest.inputsHash || !Array.isArray(report.results)
    || report.results.length !== inputs.fixtures.length || !Array.isArray(report.diagnostics)) throw new Error('SOURCE_AUDIT_REPORT_MISMATCH');
  const originals = new Map(inputs.fixtures.map(fixture => [fixture.id, fixture])), seen = new Set();
  for (const row of report.results) {
    const fixture = originals.get(row?.fixture?.id);
    if (!fixture || seen.has(fixture.id) || ['id', 'source', 'league', 'home', 'away', 'kickoff', 'homeTeamId', 'awayTeamId', 'recordHash']
      .some(key => fixture[key] !== row.fixture[key])) throw new Error('SOURCE_AUDIT_REPORT_MISMATCH');
    seen.add(fixture.id);
  }
  const parsed = report.results.map(row => retainedPairs(row, at)), quotes = parsed.flatMap(row => row.quotes);
  const fresh = quotes.filter(q => Date.parse(q.validUntil) > auditTime && Date.parse(q.kickoff) > auditTime);
  const observations = [...report.diagnostics, ...(report.crawler?.events || [])];
  const sourceEntries = catalog(sourcePolicy, providerPolicy);
  const sources = sourceEntries.map(entry => {
    const diagnostics = observations.filter(row => sourceOf(row) === entry.id);
    const configuration = report.providers?.catalog?.find(row => row.id === entry.id);
    const attempt = report.providers?.attempts?.find(row => row.id === entry.id);
    const configured = typeof configuration?.configured === 'boolean' ? configuration.configured : attempt?.status === 'not_configured' ? false : null;
    const leagues = entry.leagues.map(league => {
      const fixtures = inputs.fixtures.filter(row => row.source === entry.id && row.league === league);
      const history = inputs.history.filter(row => row.source === entry.id && row.league === league);
      const visibleHistory = history.filter(row => Date.parse(row.kickoff) < Date.parse(manifest.cutoff)
        && time(row.resultObservedAt) && Date.parse(row.resultObservedAt) <= Date.parse(manifest.cutoff));
      const retained = quotes.filter(q => q.sourceId === entry.id && q.league === league);
      const unexpired = fresh.filter(q => q.sourceId === entry.id && q.league === league);
      const scoped = diagnostics.filter(row => row.league === league);
      return { league, network: networkEvidence(scoped), schedule: { boundFixtureCount: fixtures.length,
        prematchAtReportCount: fixtures.filter(row => ['SCHEDULED', 'TIMED'].includes(row.status) && Date.parse(row.kickoff) > at).length,
        completeness: 'not-established-by-record-count' },
        history: { boundRecordCount: history.length, visibleAtCutoffCount: visibleHistory.length,
          status: visibleHistory.length ? 'retained-data' : entry.capabilities.includes('history') ? 'missing' : 'not-supported-by-adapter',
          from: history.map(row => row.kickoff).sort()[0] || null, to: lastTime(history.map(row => row.kickoff)) },
        quotes: { retainedPairedCount: retained.length, matchedFixtureCount: countIds(retained), unexpiredAtAuditCount: unexpired.length },
        forecastsAtReport: report.results.filter(row => row.fixture.source === entry.id && row.fixture.league === league && row.forecast?.status === 'forecast').length };
    });
    return { id: entry.id, implemented: entry.implemented, capabilities: entry.capabilities,
      fixtureEnabled: entry.fixtureEnabled ?? null, evidenceEnabled: entry.evidenceEnabled ?? null,
      network: networkEvidence(diagnostics), authorization: authorizationEvidence(entry, diagnostics, configured), leagues };
  });
  const alignment = new Map();
  for (const q of quotes.filter(q => q.decimalOdds >= policy.priceMin && q.decimalOdds <= policy.priceMax && Math.abs(q.handicap) <= policy.maxAbsHandicap)) {
    const key = JSON.stringify([q.fixtureId, q.selection, q.handicap]), groups = alignment.get(key) || new Set();
    groups.add(q.group); alignment.set(key, groups);
  }
  const aligned = new Set([...alignment].filter(([, groups]) => groups.size >= policy.minimumQuoteGroups).map(([key]) => JSON.parse(key)[0]));
  const leagueCoverage = LEAGUES.map(league => ({ league,
    fixtures: inputs.fixtures.filter(row => row.league === league).length,
    history: inputs.history.filter(row => row.league === league).length,
    forecasts: report.results.filter(row => row.fixture.league === league && row.forecast?.status === 'forecast').length,
    quoteFixtures: countIds(quotes.filter(q => q.league === league)), quoteRows: quotes.filter(q => q.league === league).length }));
  const gaps = [];
  if (report.poolComplete !== true) gaps.push('FIVE_LEAGUE_SCHEDULE_COMPLETENESS_UNPROVEN');
  if (leagueCoverage.some(row => row.fixtures && !row.history)) gaps.push('HISTORY_MISSING_FOR_INPUT_LEAGUES');
  if (aligned.size < inputs.fixtures.length) gaps.push('SECOND_ALIGNED_INDEPENDENT_ASIAN_SOURCE_MISSING');
  if (!quotes.some(q => q.openingVerified)) gaps.push('TRUE_OPENING_EVIDENCE_MISSING');
  if (!fresh.length) gaps.push('NO_UNEXPIRED_RETAINED_QUOTES_AT_AUDIT');
  if (sources.some(row => row.authorization.status === 'blocked-by-robots')) gaps.push('SOURCE_BLOCKED_BY_ROBOTS');
  const body = { version: 1, kind: 'source-readiness-audit', auditedAt: time(asOf), reportId: manifest.reportId,
    reportGeneratedAt: manifest.generatedAt, reportCodeVersion: manifest.codeVersion, inputsHash: manifest.inputsHash,
    policyEvidence: { collectionPolicyHash: manifest.policyHash, currentSourcePolicyHash: dataHash(sourcePolicy),
      currentProviderPolicyHash: dataHash(providerPolicy), configurationScope: 'audit-repository-policies-not-live-credentials' },
    auditCompleted: true, releaseAuthorization: false, sourceReadiness: gaps.length ? 'limited' : 'evidence-present-not-release-approved',
    dataIntegrity: { replay: 'verified', reportFixtureBinding: 'verified', historyScope: 'bound-inputs-only' },
    scope: 'one-verified-report-and-its-bound-replay-inputs', summary: { fixtures: inputs.fixtures.length, history: inputs.history.length,
      forecastsAtReport: leagueCoverage.reduce((sum, row) => sum + row.forecasts, 0),
      retainedQuoteRows: quotes.length, retainedQuoteFixtures: countIds(quotes),
      independentQuoteGroupsAtReport: [...new Set(quotes.map(q => q.group))].sort(), requiredIndependentQuoteGroups: policy.minimumQuoteGroups,
      fixturesWithAlignedIndependentQuotes: aligned.size, openingQuoteRows: quotes.filter(q => q.openingVerified).length,
      unexpiredRetainedQuoteRowsAtAudit: fresh.length, rejectedRetainedQuoteRows: parsed.reduce((sum, row) => sum + row.rejected, 0) },
    leagueCoverage, sources, gaps, limitations: ['No network probe or credential inspection was performed.',
      'Retained report quote evidence and expiry are inspected; original network assertions are not reconstructed.',
      'HTTP response, repository policy declaration and provider configuration do not establish a verified authorization grant.',
      'Other reports, bridge caches and historical snapshots are not merged; this audit cannot authorize release.'] };
  return { ...body, auditHash: dataHash(body) };
}

export async function loadSourceReadiness({ reportDir, configDir = resolve(import.meta.dirname, '../config'), asOf } = {}) {
  if (typeof reportDir !== 'string' || !reportDir) throw new Error('SOURCE_AUDIT_DIRECTORY_REQUIRED');
  const receipt = await readJson(resolve(reportDir, 'publication.json'));
  const required = ['latest.json', 'run-manifest.json', 'run-inputs.json'];
  if (!required.every(name => receipt.files?.some(file => file.name === name))) throw new Error('SOURCE_AUDIT_MANIFEST_INCOMPLETE');
  await verifyPublication(reportDir, receipt);
  const [report, manifest, inputs, sourcePolicy, providerPolicy] = await Promise.all([
    readJson(resolve(reportDir, 'latest.json')), readJson(resolve(reportDir, 'run-manifest.json')),
    readJson(resolve(reportDir, 'run-inputs.json')), readJson(resolve(configDir, 'sources.json')), readJson(resolve(configDir, 'providers.json')),
  ]);
  if (report.publication?.reportId !== receipt.reportId) throw new Error('SOURCE_AUDIT_REPORT_MISMATCH');
  return auditSourceReadiness({ report, bundle: { manifest, inputs }, sourcePolicy, providerPolicy, asOf });
}

export async function runSourceReadiness(argv, { stdout = text => process.stdout.write(text) } = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout('node collector/source-readiness.mjs --report-dir DIR [--as-of ISO]\nRead-only, offline source evidence audit. Exit 0 means the audit completed, never release approval.\n');
    return { exitCode: 0 };
  }
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--report-dir', '--as-of'].includes(argv[i]) || options[argv[i]] || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('INVALID_SOURCE_AUDIT_ARGUMENT');
    options[argv[i]] = argv[i + 1];
  }
  const audit = await loadSourceReadiness({ reportDir: options['--report-dir'], asOf: options['--as-of'] });
  stdout(`${JSON.stringify(audit, null, 2)}\n`);
  return { exitCode: 0, audit };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await runSourceReadiness(process.argv.slice(2))).exitCode; }
  catch { console.error('SOURCE_READINESS_AUDIT_FAILED: verify the report directory, bound manifests and arguments.'); process.exitCode = 1; }
}
