export const ORIGIN = 'https://dashboard.example';
export const NOW = Date.parse('2026-10-31T12:00:00Z');
const at = offset => new Date(NOW + offset).toISOString();
export function sampleReport(letter = 'a', offset = 0) {
  const forecast = () => ({ status: 'forecast', reasons: [], selection: 'home',
    probabilities: { home: .5, draw: .3, away: .2 }, expectedGoals: { home: 1.5, away: .8 },
    sample: { home: 10, away: 11 }, topScores: [{ home: 1, away: 0, probability: .2 }],
    freshness: { validUntil: at(3600000) }, completeness: { passed: 8, total: 8 },
    strength: { homeAttack: 1.2, awayAttack: .9 }, validation: { evaluated: 40, skipped: 3 } });
  const row = (key, home) => ({ fixture: { id: key, league: 'BL1', home, away: '客队', kickoff: at(7200000), status: 'SCHEDULED' },
    forecast: forecast(), marketCandidate: { status: 'source_insufficient', reasons: ['NO_FRESH_COMPLETE_ASIAN_MARKET'], candidate: null,
      readiness: { quoteGroups: [], verifiedOpeningCount: 0, blockers: ['NO_FRESH_COMPLETE_ASIAN_MARKET'] } } });
  const analysis = row('analysis', '普通主队'), strict = row('strict', '严格主队'), missing = row('missing', '缺项主队');
  missing.forecast = { status: 'unavailable', reasons: ['HOME_HISTORY_INSUFFICIENT'] };
  const quotes = ['source-a', 'source-b'].map(sourceId => ({ sourceId, bookmaker: sourceId, selection: 'home', handicap: -.25,
    decimalOdds: 1.85, observedAt: at(-60000), sourceUpdatedAt: at(-60000), validUntil: at(240000), evidenceUrl: 'https://example.test/quote' }));
  strict.marketCandidate = { status: 'candidate', reasons: [], readiness: null, candidate: { selection: 'home', handicap: -.25,
    decimalOdds: 1.85, quotes, quoteGroups: ['group-a', 'group-b'], requiresReview: true,
    opening: { basis: 'provider-opening', sourceId: 'source-a', bookmaker: 'source-a', fixtureId: 'strict', selection: 'home',
      handicap: -.25, decimalOdds: 1.85, observedAt: at(-3600000), recordedAt: at(-60000), evidenceUrl: 'https://example.test/opening' } } };
  return { version: 1, kind: 'prematch-forecast-report', generatedAt: at(offset), simulated: false,
    publication: { reportId: letter.repeat(64) }, summary: { fixtures: 3, forecasts: 2, unavailable: 1, strictCandidates: 1 },
    fixtures: [analysis, strict, missing], backtests: [{ league: 'BL1', evaluated: 40, skipped: 3,
      metrics: { brier: .6, baselineBrier: .7, logLoss: 1.1 } }], attribution: [{ name: 'Test provider', license: 'Test license', url: 'https://example.test/data' }] };
}
export function sampleReceipt(report = sampleReport(), run = '111') {
  return { version: 1, reportId: report.publication.reportId, generatedAt: report.generatedAt, simulated: false,
    channels: { files: { status: 'published' }, githubArtifact: { status: 'published', url: `https://github.com/wangxtong/Dimension-Football-/actions/runs/${run}` },
      externalWebsite: { status: 'published' }, notifications: { status: 'not_configured' } } };
}
export const sampleBundle = (report = sampleReport()) => ({ version: 1, reportId: report.publication.reportId, report, receipt: sampleReceipt(report) });
