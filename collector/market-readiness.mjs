import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, SOURCES, basicScreen, digest, fixtureKey, isoMillis, readPolicy, quoteSourceGroup, safeQuote, validOpeningTrajectory, openingIdentity } from './policy.mjs';

const CHANNELS = Object.freeze([
  { id: 'hkjc', group: SOURCES.hkjc.group, role: 'formal-market-adapter', bookmakers: ['HKJC'],
    origin: 'publisher-first-party', openingCapability: 'not-provided', timeMeaning: 'sourceAsOf is the publisher HTTP snapshot time; pool updateAt is neither opening time nor last trade time' },
  { id: 'titan007', group: SOURCES.titan007.group, role: 'formal-market-adapter', bookmakers: ['M88', '12Bet', 'SBOBET'],
    origin: 'one-shared-aggregator-channel', openingCapability: 'not-provided', timeMeaning: 'sourceUpdatedAt is feed Last-Modified, not an opening timestamp' },
  { id: 'macauslot', group: SOURCES.macauslot.group, role: 'formal-market-adapter', bookmakers: ['Macau SLOT'],
    origin: 'publisher-first-party', openingCapability: 'not-provided', timeMeaning: 'sourceUpdatedAt is the official odds JSON HTTP Last-Modified, not an opening or individual trade timestamp' },
  { id: 'sportmonks', group: null, role: 'auxiliary-model', openingCapability: 'not-provided' },
  { id: 'the-odds-api', group: null, role: 'market-reference-only', openingCapability: 'historical-snapshot-is-not-opening' },
  { id: 'isports', group: null, role: 'market-reference-only', openingCapability: 'initial-values-without-opening-time' },
]);
const formalSources = new Set(CHANNELS.filter(row => row.role === 'formal-market-adapter').map(row => row.id));
const token = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const code = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : 'UNKNOWN';
const unique = values => [...new Set(values)].sort();
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200) : '';
const isTime = value => Number.isFinite(isoMillis(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function configs(sourceConfig, providerConfig) {
  const fixtureSources = ['football-data.org', 'api-football', 'sportmonks'];
  const providers = ['sportmonks', 'the-odds-api', 'isports'];
  if (sourceConfig?.version !== 1 || !Array.isArray(sourceConfig.fixturePriority) || sourceConfig.fixturePriority.some(id => !fixtureSources.includes(id))
    || providerConfig?.version !== 1 || !Array.isArray(providerConfig.enabled) || providerConfig.enabled.some(id => !providers.includes(id))) throw new Error('INVALID_SOURCE_CONFIG');
  return { fixturePriority: [...sourceConfig.fixturePriority], enabledReferenceProviders: [...providerConfig.enabled] };
}

function quoteProblems(q, fixture, nowISO, policy) {
  const problems = [], now = isoMillis(nowISO), observed = isoMillis(q.observedAt), updated = isoMillis(q.sourceUpdatedAt);
  const asOf = isoMillis(q.sourceId === 'hkjc' ? q.sourceAsOf : q.sourceUpdatedAt);
  if (quoteSourceGroup(q) === null) problems.push('SOURCE_CHANNEL_IDENTITY_CONFLICT');
  if (!formalSources.has(q.sourceId)) problems.push('PRODUCTION_CHANNEL_NOT_IMPLEMENTED');
  if (q.verificationMethod !== 'automatic') problems.push('OWNER_IMPORT_IS_NOT_AUTOMATIC_PRODUCTION_EVIDENCE');
  if (!token(q.providerMatchId) || q.market !== 'asian-handicap' || q.period !== 'full-time') problems.push('MARKET_IDENTITY_UNVERIFIED');
  if (!['home', 'away'].includes(q.selection) || !Number.isFinite(q.handicap) || !Number.isInteger(q.handicap * 4)
    || !Number.isFinite(q.decimalOdds) || q.decimalOdds <= 1 || q.decimalOdds > 21) problems.push('QUOTE_FIELDS_INVALID');
  try {
    const url = new URL(q.evidenceUrl), source = SOURCES[q.sourceId];
    if (url.protocol !== 'https:' || url.username || url.password || !source?.hosts.includes(url.hostname)
      || [...url.searchParams.keys()].some(key => /token|secret|key|auth|password/i.test(key))) throw new Error();
  } catch { problems.push('EVIDENCE_URL_UNVERIFIED'); }
  if (![observed, updated, asOf].every(Number.isFinite) || asOf > observed || observed > now || updated > observed) problems.push('QUOTE_TIME_UNVERIFIED');
  if (Number.isFinite(observed) && now - observed > policy.maxQuoteAgeMs || Number.isFinite(asOf) && now - asOf > policy.maxQuoteAgeMs) problems.push('QUOTE_STALE');
  if (!isTime(q.validUntil) || isoMillis(q.validUntil) <= now) problems.push('QUOTE_EXPIRED');
  if (observed >= isoMillis(fixture.kickoff) || isoMillis(fixture.kickoff) <= now || !['SCHEDULED', 'TIMED'].includes(fixture.status)) problems.push('NOT_PREMATCH');
  if (q.sourceId === 'hkjc' && (q.bookmaker !== 'HKJC' || q.evidenceUrl !== 'https://bet.hkjc.com/en/football/hdc'
    || q.freshnessBasis !== 'publisher-live-snapshot' || q.providerPoolUpdatedAt !== q.sourceUpdatedAt || updated > asOf
    || !Number.isInteger(q.cacheMaxAgeSeconds) || q.cacheMaxAgeSeconds < 0 || q.cacheMaxAgeSeconds > 60)) problems.push('PUBLISHER_SNAPSHOT_PROOF_INVALID');
  return unique(problems);
}

function retainedMarket(quotes, fixture, nowISO, policy, records) {
  const screened = basicScreen(fixture, nowISO, policy);
  const rows = quotes.map(q => ({ quote: q, problems: quoteProblems(q, fixture, nowISO, policy) }));
  const channels = new Map(), complete = [], issues = [];
  for (const row of rows) {
    const key = digest([row.quote.sourceId, row.quote.bookmaker]);
    const group = channels.get(key) || []; group.push(row); channels.set(key, group);
  }
  for (const group of channels.values()) {
    if (group.some(row => !isTime(row.quote.observedAt))) { issues.push('QUOTE_TIME_UNVERIFIED'); continue; }
    const latest = Math.max(...group.map(row => isoMillis(row.quote.observedAt)));
    const snapshot = group.filter(row => isoMillis(row.quote.observedAt) === latest);
    if (snapshot.some(row => row.problems.length)) { issues.push(...snapshot.flatMap(row => row.problems)); continue; }
    const distinct = [...new Map(snapshot.map(row => [digest(safeQuote(row.quote)), row.quote])).values()];
    if (distinct.length !== 2) { issues.push('RETAINED_MARKET_INCOMPLETE_OR_AMBIGUOUS'); continue; }
    const [a, b] = distinct;
    if (a.selection === b.selection || a.handicap !== -b.handicap || a.providerMatchId !== b.providerMatchId || a.providerPoolId !== b.providerPoolId
      || a.observedAt !== b.observedAt || a.sourceUpdatedAt !== b.sourceUpdatedAt || a.sourceAsOf !== b.sourceAsOf) {
      issues.push('RETAINED_MARKET_INCOMPLETE_OR_AMBIGUOUS'); continue;
    }
    complete.push(...distinct);
  }
  if (screened) { complete.length = 0; issues.push(...screened.reasons); }
  const eligible = complete.filter(q => q.decimalOdds >= policy.priceMin && q.decimalOdds <= policy.priceMax && Math.abs(q.handicap) <= policy.maxAbsHandicap);
  const matching = new Map();
  for (const q of eligible) {
    const key = digest([q.selection, q.handicap]), group = matching.get(key) || []; group.push(q); matching.set(key, group);
  }
  const openingSupported = q => validOpeningTrajectory(q, fixture, nowISO, policy) && records.some(r => r?.archiveStatus === 'verified' && r.fixtureKey === fixtureKey(fixture) && !r.conflict
    && r.hash === digest(r.opening) && openingIdentity(r.opening) === openingIdentity(q.opening))
    && !records.some(r => r?.archiveStatus === 'capacity_exceeded' || r?.conflict && r.opening?.sourceId === q.sourceId && r.opening?.bookmaker === q.bookmaker && r.opening?.selection === q.selection);
  const markets = [...matching.values()].map(group => ({ selection: group[0].selection, handicap: group[0].handicap,
    groups: unique(group.map(quoteSourceGroup)), openingEvidenceCount: group.filter(openingSupported).length }));
  const blockers = [...issues];
  if (!complete.length) blockers.push('NO_FRESH_COMPLETE_ASIAN_MARKET');
  if (complete.length && !eligible.length) blockers.push('PRICE_OR_HANDICAP_OUTSIDE_POLICY');
  if (!markets.some(m => m.groups.length >= policy.minimumQuoteGroups)) blockers.push('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING');
  if (!complete.some(openingSupported)) blockers.push('TRUE_OPENING_RECORD_MISSING');
  else if (!markets.some(m => m.groups.length >= policy.minimumQuoteGroups && m.openingEvidenceCount)) blockers.push('OPENING_NOT_BOUND_TO_CROSS_CHECKED_MARKET');
  return { retainedQuoteCount: quotes.length, pairedQuoteCount: complete.length, groups: unique(complete.map(quoteSourceGroup)),
    openingEvidenceCount: complete.filter(openingSupported).length, staleQuoteCount: rows.filter(row => row.problems.some(p => ['QUOTE_STALE', 'QUOTE_EXPIRED'].includes(p))).length,
    matchingMarkets: markets, blockers: unique(blockers) };
}

/** Inspect retained output without inventing the source fields discarded by safeQuote. */
export function buildMarketReadinessAudit(report, { nowISO = new Date().toISOString(), policy = DEFAULT_POLICY,
  sourceConfig = { version: 1, fixturePriority: [] }, providerConfig = { version: 1, enabled: [] } } = {}) {
  policy = readPolicy(policy);
  const configuration = configs(sourceConfig, providerConfig), reportId = report?.publication?.reportId;
  if (!/^[a-f0-9]{64}$/.test(reportId || '') || !isTime(report?.completedAt) || !isTime(nowISO) || isoMillis(nowISO) < isoMillis(report.completedAt)
    || !report.policy || typeof report.policy !== 'object' || !Array.isArray(report?.results) || report.results.length > policy.maxFixtures || !Array.isArray(report.candidates)
    || !Number.isSafeInteger(report.summary?.candidates) || report.summary.candidates < 0) throw new Error('INVALID_READINESS_REPORT');
  const reportPolicy = readPolicy(report.policy), rows = [], diagnostics = Array.isArray(report.diagnostics) ? report.diagnostics : [];
  for (const entry of report.results) {
    const fixture = entry?.fixture;
    if (!fixture || !token(fixture.id) || !token(fixture.source) || !isTime(fixture.kickoff) || !Array.isArray(entry.lastEvidence?.quotes || [])) throw new Error('INVALID_READINESS_FIXTURE');
    const quotes = entry.lastEvidence?.quotes || [], records = Array.isArray(entry.openingRecords) ? entry.openingRecords : [];
    if (quotes.length > 30000 || records.length > 30000 || quotes.some(q => !q || typeof q !== 'object' || Array.isArray(q))) throw new Error('INVALID_READINESS_EVIDENCE');
    const atReport = retainedMarket(quotes, fixture, report.completedAt, reportPolicy, records);
    const atAudit = retainedMarket(quotes, fixture, nowISO, policy, records);
    const auxiliarySignalCount = Array.isArray(entry.lastEvidence?.signals) ? entry.lastEvidence.signals.length : 0;
    rows.push({ fixture: { id: fixture.id, source: fixture.source, league: text(fixture.league), home: text(fixture.home), away: text(fixture.away), kickoff: fixture.kickoff },
      reportedStatus: code(entry.result?.status), reportedReasons: (entry.result?.reasons || []).map(code),
      reportedMarketBlockers: (entry.marketReadiness?.blockers || []).map(code), atReport, atAudit,
      openingArchive: { total: records.length, conflicts: records.filter(r => r?.conflict).length,
        pendingVerification: records.filter(r => r?.archiveStatus === 'pending_verification').length,
        invalidHashes: records.filter(r => r?.opening && r.hash !== digest(r.opening)).length },
      auxiliarySignalCount, evidenceGaps: unique([...atAudit.blockers, ...(quotes.length ? ['QUOTE_FIXTURE_BINDING_NOT_RETAINED'] : []),
        ...(auxiliarySignalCount ? [] : ['INDEPENDENT_FORECAST_NOT_RETAINED'])]) });
  }
  const reportedCandidateRows = report.results.filter(row => row.result?.status === 'candidate').length;
  const integrityBlockers = [];
  if (report.summary.total !== report.results.length || report.summary.candidates !== report.candidates.length || report.summary.candidates !== reportedCandidateRows) integrityBlockers.push('REPORT_SUMMARY_MISMATCH');
  if (report.simulated !== false) integrityBlockers.push('NOT_A_PRODUCTION_REPORT');
  if (new Set(rows.map(row => row.fixture.id)).size !== rows.length) integrityBlockers.push('DUPLICATE_FIXTURE_ID');
  const gateKeys = new Set(['days', 'maxFixtureAgeMs', 'maxQuoteAgeMs', 'maxSignalAgeMs', 'priceMin', 'priceMax', 'maxAbsHandicap', 'maxPriceMovement', 'minimumQuoteGroups', 'requireOpening']);
  configuration.policyDifferences = Object.keys(policy).filter(key => reportPolicy[key] !== policy[key])
    .map(key => ({ key, reported: reportPolicy[key], configured: policy[key], scope: gateKeys.has(key) ? 'market-gate' : 'collection-operation' }));
  if (configuration.policyDifferences.some(row => row.scope === 'market-gate')) integrityBlockers.push('MARKET_POLICY_CHANGED_SINCE_REPORT');
  const count = (view, predicate) => rows.filter(row => predicate(row[view])).length;
  return { version: 1, kind: 'offline-market-readiness-audit', reportId, reportCompletedAt: report.completedAt, auditedAt: nowISO,
    releaseStatus: 'BLOCKED', releaseBlockers: ['R1_RELEASE_HELD', 'OFFLINE_AUDIT_ONLY', 'RETAINED_QUOTES_NOT_FORMALLY_REPLAYABLE'], recommendationsCreated: 0,
    formalRecommendation: { allowed: false, requiresExistingPolicyGate: true },
    evidenceBasis: { kind: 'retained-report-output', canReplayFormalGate: false,
      missingReplayFields: ['quote.fixtureId', 'quote.fixtureSnapshot', 'quote.verified', 'quote.inPlay', 'quote.closed'],
      meaning: 'Counts inspect retained metadata; no source request, refreshed timestamp or reconstructed quote is used.' },
    configuration, policy: { minimumQuoteGroups: policy.minimumQuoteGroups, requireOpening: policy.requireOpening, maxQuoteAgeMs: policy.maxQuoteAgeMs },
    summary: { fixtures: rows.length, reportedStrictCandidates: report.summary.candidates,
      retainedQuotes: rows.reduce((n, row) => n + row.atAudit.retainedQuoteCount, 0),
      pairedFixturesAtReport: count('atReport', row => row.pairedQuoteCount > 0), pairedFixturesAtAudit: count('atAudit', row => row.pairedQuoteCount > 0),
      secondSourceMissingAtReport: count('atReport', row => row.blockers.includes('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING')),
      secondSourceMissingAtAudit: count('atAudit', row => row.blockers.includes('SECOND_INDEPENDENT_ASIAN_SOURCE_MISSING')),
      trueOpeningMissingAtReport: count('atReport', row => row.blockers.includes('TRUE_OPENING_RECORD_MISSING')),
      trueOpeningMissingAtAudit: count('atAudit', row => row.blockers.includes('TRUE_OPENING_RECORD_MISSING')),
      staleQuotesAtAudit: rows.reduce((n, row) => n + row.atAudit.staleQuoteCount, 0), archivedOpenings: rows.reduce((n, row) => n + row.openingArchive.total, 0) },
    integrityBlockers,
    channels: CHANNELS.map(channel => ({ ...channel, ...(channel.bookmakers ? { bookmakers: [...channel.bookmakers] } : {}),
      configured: formalSources.has(channel.id) ? 'built-in' : configuration.enabledReferenceProviders.includes(channel.id),
      diagnostics: diagnostics.filter(d => d?.id === channel.id || channel.id === 'titan007' && ['m88', '12bet', 'sbobet'].includes(d?.id))
        .map(d => ({ id: code(d.id), status: code(d.status), code: code(d.code), checkedAt: isTime(d.checkedAt) ? d.checkedAt : null })) })),
    limitations: ['Bookmaker count is not independent production-channel count.',
      'A registered source name or enabled commercial provider is not evidence of a second implemented independent quote feed.',
      'First observation, pool updateAt and historical snapshots are not provider opening times.',
      'Opening counts check declared fields and archive hashes, not supplier authenticity; the implemented live quote adapters do not supply opening history.',
      'Event/source/kickoff changes require identity revalidation; source-scoped canonical IDs do not prove cross-provider mappings.',
      'This audit never authorizes R1 release, even if retained market metadata appears complete.'], rows };
}

const cell = value => String(value).replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\r\n]/g, ' ');
export function renderMarketReadiness(audit) {
  const s = audit.summary;
  return [`Market readiness — ${audit.releaseStatus}`, '', `Report: ${audit.reportId}`,
    `Report time: ${audit.reportCompletedAt}; audit time: ${audit.auditedAt}.`,
    `Reported strict candidates: ${s.reportedStrictCandidates}; recommendations created: 0.`,
    `Retained quotes: ${s.retainedQuotes}; paired fixtures at report/audit: ${s.pairedFixturesAtReport}/${s.pairedFixturesAtAudit}; stale quotes now: ${s.staleQuotesAtAudit}.`,
    `Missing second source at report/audit: ${s.secondSourceMissingAtReport}/${s.secondSourceMissingAtAudit}; missing true opening: ${s.trueOpeningMissingAtReport}/${s.trueOpeningMissingAtAudit}.`, '',
    '| Production channel | Group | Role | Observed blocker |', '| --- | --- | --- | --- |',
    ...audit.channels.map(c => `| ${cell(c.id)} | ${cell(c.group || 'none')} | ${cell(c.role)} | ${cell(c.diagnostics.map(d => d.code).join(', ') || 'No availability evidence in this report')} |`), '',
    '| Fixture | Groups at report | Fresh groups at audit | Current evidence gaps |', '| --- | --- | --- | --- |',
    ...audit.rows.map(row => `| ${cell(row.fixture.id)} | ${cell(row.atReport.groups.join(', ') || 'none')} | ${cell(row.atAudit.groups.join(', ') || 'none')} | ${cell(row.evidenceGaps.join(', '))} |`), '',
    ...audit.limitations.map(line => `- ${line}`), '', ...audit.integrityBlockers.map(line => `Integrity blocker: ${line}`), ''].join('\n');
}

export async function runMarketReadinessCli(argv, { nowISO = new Date().toISOString(), stdout = value => process.stdout.write(value) } = {}) {
  if (argv.length === 1 && argv[0] === '--help') {
    stdout('Usage: node collector/market-readiness.mjs --report PATH [--as-of ISO] [--format markdown|json] [--policy PATH] [--sources-config PATH] [--providers-config PATH]\nOffline evidence audit only; no network requests or release authorization.\n');
    return null;
  }
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i], value = argv[++i];
    if (!['--report', '--sources-config', '--providers-config', '--policy', '--as-of', '--format'].includes(key) || !value || value.startsWith('--') || Object.hasOwn(options, key)) throw new Error('INVALID_READINESS_ARGUMENT');
    options[key] = value;
  }
  if (!options['--report'] || !['json', 'markdown'].includes(options['--format'] || 'markdown')) throw new Error('INVALID_READINESS_ARGUMENT');
  const paths = { report: resolve(options['--report']), sources: options['--sources-config'] ? resolve(options['--sources-config']) : fileURLToPath(new URL('../config/sources.json', import.meta.url)),
    providers: options['--providers-config'] ? resolve(options['--providers-config']) : fileURLToPath(new URL('../config/providers.json', import.meta.url)),
    policy: options['--policy'] ? resolve(options['--policy']) : fileURLToPath(new URL('../config/collection.json', import.meta.url)) };
  const inputs = {};
  for (const [name, path] of Object.entries(paths)) {
    const bytes = await readFile(path);
    if (bytes.length > 64_000_000) throw new Error('READINESS_INPUT_TOO_LARGE');
    inputs[name] = { data: JSON.parse(bytes.toString('utf8')), sha256: sha256(bytes) };
  }
  const audit = buildMarketReadinessAudit(inputs.report.data, { nowISO: options['--as-of'] || nowISO,
    sourceConfig: inputs.sources.data, providerConfig: inputs.providers.data, policy: inputs.policy.data });
  audit.inputDigests = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, value.sha256]));
  stdout(options['--format'] === 'json' ? `${JSON.stringify(audit, null, 2)}\n` : renderMarketReadiness(audit));
  return audit;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMarketReadinessCli(process.argv.slice(2))
  .catch(() => { process.stderr.write('MARKET_READINESS_AUDIT_FAILED\n'); process.exitCode = 1; });
