import { canonicalTimestamp, normalizeSeason } from './identity.mjs';

const sourceLeagues = { BL1: 'openligadb', PL: 'thesportsdb-free', PD: 'thesportsdb-free', SA: 'thesportsdb-free', FL1: 'thesportsdb-free' };
const codes = new Set(['community_schedule_unverified', 'free_tier_limited', 'history_cache_hit', 'authorization_required',
  'rate_limited', 'source_cooldown', 'redirect_blocked', 'http_unavailable', 'stale_response', 'response_too_large',
  'invalid_response', 'invalid_json', 'timeout', 'network_unavailable', 'cancelled', 'budget_exhausted', 'duplicate_fixture_id', 'logical_fixture_conflict',
  'history_cache_unavailable']);
const stages = new Set(['transport', 'fixtures', 'history', 'history-cache']);

export function sanitizePublicDiagnostics(rows) {
  if (!Array.isArray(rows) || rows.length > 20) throw new Error('INVALID_PUBLIC_DIAGNOSTICS');
  return rows.map(row => {
    if (!row || sourceLeagues[row.league] !== row.id || !codes.has(row.code)
      || !['partial', 'unavailable', 'pending'].includes(row.status) || !canonicalTimestamp(row.checkedAt)) throw new Error('INVALID_PUBLIC_DIAGNOSTICS');
    const clean = { id: row.id, league: row.league, code: row.code, status: row.status, checkedAt: canonicalTimestamp(row.checkedAt),
      purpose: row.purpose === 'history' ? 'history' : 'fixtures', historyRequested: row.historyRequested === true,
      season: normalizeSeason(row.season), cacheHit: row.cacheHit === true, matchedCount: 0 };
    if (row.stage !== undefined) {
      if (!stages.has(row.stage)) throw new Error('INVALID_PUBLIC_DIAGNOSTICS');
      clean.stage = row.stage;
    }
    for (const key of ['inputCount', 'receivedCount', 'matchedCount', 'rejectedCount', 'historyCount', 'historyRejectedCount']) {
      if (row[key] !== undefined && (!Number.isSafeInteger(row[key]) || row[key] < 0 || row[key] > 10000)) throw new Error('INVALID_PUBLIC_DIAGNOSTICS');
      if (row[key] !== undefined) clean[key] = row[key];
    }
    for (const key of ['responseAt', 'fetchedAt', 'nextProbeAt']) clean[key] = canonicalTimestamp(row[key]);
    clean.httpStatus = Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599 ? row.httpStatus : null;
    clean.retryAfterMs = Number.isSafeInteger(row.retryAfterMs) && row.retryAfterMs >= 0 ? row.retryAfterMs : null;
    return clean;
  });
}

export function buildPublicCoverage({ diagnostics = [], fixtures = [], history = [], window = null, includeHistory = false }) {
  const safe = sanitizePublicDiagnostics(diagnostics);
  return Object.entries(sourceLeagues).map(([league, source]) => {
    const rows = safe.filter(row => row.league === league), schedule = rows.filter(row => row.purpose === 'fixtures');
    const historyRows = rows.filter(row => row.historyRequested), accepted = history.filter(row => row.league === league && row.source === source);
    const available = rows => rows.some(row => row.status === 'partial');
    const failed = rows => rows.some(row => row.status === 'unavailable' || row.status === 'pending');
    const times = accepted.map(row => canonicalTimestamp(row.kickoff)).filter(Boolean).sort();
    return { source, league, complete: false, expectedFixtureCount: null,
      fixtureStatus: !schedule.length ? 'not-requested' : available(schedule) ? 'sample' : 'unavailable',
      historyStatus: source !== 'openligadb' ? 'not-supported' : !includeHistory ? 'not-requested'
        : !historyRows.length ? 'not-requested' : available(historyRows) ? failed(historyRows) ? 'partial' : 'available' : 'unavailable',
      fixtureCount: fixtures.filter(row => row.league === league && row.source === source).length, historyCount: accepted.length,
      receivedCount: rows.reduce((sum, row) => sum + (row.receivedCount || 0), 0),
      rejectedCount: rows.reduce((sum, row) => sum + (row.rejectedCount || 0) + (row.historyRejectedCount || 0), 0),
      historyFrom: times[0] || null, historyTo: times.at(-1) || null,
      window: window && canonicalTimestamp(window.from) && canonicalTimestamp(window.to)
        ? { from: canonicalTimestamp(window.from), to: canonicalTimestamp(window.to) } : null,
      diagnostics: rows, limitation: source === 'openligadb' ? 'community_schedule_unverified' : 'one_fixture_per_league_without_history' };
  });
}

// The root CLI can use this instead of replacing public diagnostics with
// INPUT_POOL_ONLY. Recompute coverage; never trust supplied aggregate totals.
export function publicInputMetadata(input) {
  if (input?.kind !== 'public-fixture-sample' || input.version !== 1 || input.simulated !== false || input.poolComplete !== false
    || !Array.isArray(input.fixtures) || !Array.isArray(input.history)) throw new Error('INVALID_PUBLIC_INPUT_MANIFEST');
  const fixtureDiagnostics = sanitizePublicDiagnostics(input.diagnostics);
  return { poolComplete: false, fixtureDiagnostics, coverage: buildPublicCoverage({ ...input, diagnostics: fixtureDiagnostics,
    includeHistory: fixtureDiagnostics.some(row => row.historyRequested) }) };
}
