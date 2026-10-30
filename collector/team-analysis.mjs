import { isoMillis } from './policy.mjs';

const DAY = 86_400_000;
const idOK = value => Number.isSafeInteger(value) && value > 0;
const scoreOK = value => Number.isSafeInteger(value) && value >= 0;
const canonicalTime = value => Number.isFinite(isoMillis(value)) ? new Date(isoMillis(value)).toISOString() : null;

function targetDetails(fixture, teamIds) {
  const raw = fixture?.fixture;
  const rawIds = raw ? { home: fixture?.teams?.home?.id, away: fixture?.teams?.away?.id } : null;
  return {
    id: raw?.id ?? fixture?.id ?? null,
    kickoff: canonicalTime(raw?.date ?? fixture?.kickoff),
    leagueId: raw ? fixture?.league?.id : fixture?.leagueId ?? fixture?.league?.id,
    homeName: raw ? fixture?.teams?.home?.name ?? null : fixture?.home ?? null,
    awayName: raw ? fixture?.teams?.away?.name ?? null : fixture?.away ?? null,
    ids: teamIds ?? rawIds ?? {},
    idsMismatch: !!(rawIds && teamIds && (rawIds.home !== teamIds.home || rawIds.away !== teamIds.away)),
  };
}

function historyRows(history) {
  if (Array.isArray(history)) return { rows: history, issue: null };
  if (!history || !Array.isArray(history.response) || history.get !== 'fixtures'
    || !history.errors || typeof history.errors !== 'object') return { rows: [], issue: 'HISTORY_UNAVAILABLE' };
  if (Object.keys(history.errors).length) return { rows: [], issue: 'HISTORY_SOURCE_ERROR' };
  if (history.results !== undefined && history.results !== history.response.length) return { rows: [], issue: 'HISTORY_RESPONSE_COUNT_MISMATCH' };
  return { rows: history.response, issue: history.paging?.total > 1 ? 'HISTORY_PAGINATION_INCOMPLETE' : null };
}

function normalizedRows(rows, cutoff, targetId) {
  const unique = new Map(), conflicts = new Set();
  const excluded = { notFinished: 0, atOrAfterCutoff: 0, invalidIdentity: 0, invalidTime: 0,
    invalidScore: 0, targetFixture: 0, duplicate: 0, conflictingIds: 0 };
  for (const row of rows) {
    if (row?.fixture?.status?.short !== 'FT') { excluded.notFinished++; continue; }
    const id = row?.fixture?.id, homeId = row?.teams?.home?.id, awayId = row?.teams?.away?.id;
    if (!idOK(id) || !idOK(homeId) || !idOK(awayId) || homeId === awayId || !idOK(row?.league?.id)) {
      excluded.invalidIdentity++; continue;
    }
    if (String(id) === String(targetId) || `af-${id}` === targetId) { excluded.targetFixture++; continue; }
    const ms = isoMillis(row.fixture.date);
    if (!Number.isFinite(ms) || !Number.isSafeInteger(row.fixture.timestamp) || row.fixture.timestamp * 1000 !== ms) {
      excluded.invalidTime++; continue;
    }
    if (ms >= cutoff) { excluded.atOrAfterCutoff++; continue; }
    if (!scoreOK(row?.goals?.home) || !scoreOK(row?.goals?.away)) { excluded.invalidScore++; continue; }
    const match = { id, kickoff: new Date(ms).toISOString(), leagueId: row.league.id,
      homeId, awayId, homeName: row.teams.home.name ?? null, awayName: row.teams.away.name ?? null,
      homeGoals: row.goals.home, awayGoals: row.goals.away };
    if (conflicts.has(id)) { excluded.duplicate++; continue; }
    const previous = unique.get(id);
    if (previous) {
      excluded.duplicate++;
      // Names are display labels; identity, date, competition and score decide
      // whether overlapping endpoint responses describe the same match.
      const fields = ['kickoff', 'leagueId', 'homeId', 'awayId', 'homeGoals', 'awayGoals'];
      if (fields.some(key => previous[key] !== match[key])) {
        unique.delete(id); conflicts.add(id); excluded.conflictingIds++;
      }
    } else unique.set(id, match);
  }
  return { matches: [...unique.values()].sort((a, b) => b.kickoff.localeCompare(a.kickoff) || b.id - a.id), excluded };
}

function teamMatch(match, teamId) {
  const home = match.homeId === teamId;
  const goalsFor = home ? match.homeGoals : match.awayGoals, goalsAgainst = home ? match.awayGoals : match.homeGoals;
  return { fixtureId: match.id, kickoff: match.kickoff, leagueId: match.leagueId, venue: home ? 'home' : 'away',
    opponentId: home ? match.awayId : match.homeId, opponent: home ? match.awayName : match.homeName,
    goalsFor, goalsAgainst, result: goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D' };
}

function summarize(matches, teamId) {
  const sample = matches.slice(0, 5).map(match => teamMatch(match, teamId));
  return { sampleCount: sample.length, limited: sample.length < 5, order: 'newest-first',
    form: sample.map(match => match.result),
    wins: sample.length ? sample.filter(match => match.result === 'W').length : null,
    draws: sample.length ? sample.filter(match => match.result === 'D').length : null,
    losses: sample.length ? sample.filter(match => match.result === 'L').length : null,
    goalsFor: sample.length ? sample.reduce((sum, match) => sum + match.goalsFor, 0) : null,
    goalsAgainst: sample.length ? sample.reduce((sum, match) => sum + match.goalsAgainst, 0) : null,
    matches: sample };
}

function analyzeTeam(matches, teamId, name, venue, targetMs) {
  const relevant = idOK(teamId) ? matches.filter(match => match.homeId === teamId || match.awayId === teamId) : [];
  const last5 = summarize(relevant, teamId);
  const venueLast5 = summarize(relevant.filter(match => (venue === 'home' ? match.homeId : match.awayId) === teamId), teamId);
  const missing = [];
  if (last5.limited) missing.push('RECENT_FINISHED_MATCHES_LT_5');
  if (venueLast5.limited) missing.push(venue === 'home' ? 'HOME_FINISHED_MATCHES_LT_5' : 'AWAY_FINISHED_MATCHES_LT_5');
  if (!relevant.length) missing.push('REST_INTERVAL_UNAVAILABLE');
  return { teamId: idOK(teamId) ? teamId : null, name, last5, venueLast5, venue,
    restDays: relevant.length && Number.isFinite(targetMs) ? Number(((targetMs - isoMillis(relevant[0].kickoff)) / DAY).toFixed(3)) : null,
    restBasis: 'kickoff-to-kickoff', previousMatchKickoff: relevant[0]?.kickoff ?? null, missing };
}

/**
 * Pure historical summary, with no odds or prediction inference.
 * fixture: normalized {id, home, away, kickoff, leagueId}, or a raw API fixture row.
 * teamIds: {home, away}; optional only for a raw target row containing teams IDs.
 * history: API /fixtures response array, or its {get, errors, response, ...} envelope.
 * FT status is supplied by the caller's snapshot. API rows lack an exact final-
 * whistle timestamp; dates are kickoff cutoffs and rest is kickoff-to-kickoff.
 */
export function analyzeFixtureHistory({ fixture, history, teamIds, nowISO } = {}) {
  const target = targetDetails(fixture, teamIds), now = isoMillis(nowISO), targetMs = isoMillis(target.kickoff);
  const source = historyRows(history), missing = [];
  if (!Number.isFinite(now)) missing.push('REFERENCE_TIME_UNAVAILABLE');
  if (!Number.isFinite(targetMs)) missing.push('TARGET_KICKOFF_UNAVAILABLE');
  if (!idOK(target.ids.home) || !idOK(target.ids.away) || target.ids.home === target.ids.away) missing.push('TARGET_TEAM_IDS_UNAVAILABLE');
  if (target.idsMismatch) missing.push('TARGET_TEAM_IDS_MISMATCH');
  if (!idOK(target.leagueId)) missing.push('TARGET_LEAGUE_ID_UNAVAILABLE');
  if (source.issue) missing.push(source.issue);
  const critical = missing.some(code => ['REFERENCE_TIME_UNAVAILABLE', 'TARGET_KICKOFF_UNAVAILABLE',
    'TARGET_TEAM_IDS_UNAVAILABLE', 'TARGET_TEAM_IDS_MISMATCH', 'HISTORY_UNAVAILABLE', 'HISTORY_SOURCE_ERROR', 'HISTORY_RESPONSE_COUNT_MISMATCH'].includes(code));
  const cutoff = Number.isFinite(now) && Number.isFinite(targetMs) ? Math.min(now, targetMs) : NaN;
  const normalized = normalizedRows(critical ? [] : source.rows, cutoff, target.id);
  if (normalized.excluded.invalidIdentity || normalized.excluded.invalidTime || normalized.excluded.invalidScore) {
    missing.push('HISTORY_INVALID_ROWS_REJECTED');
  }
  if (normalized.excluded.conflictingIds) missing.push('HISTORY_CONFLICTING_FIXTURES_EXCLUDED');
  const home = analyzeTeam(normalized.matches, target.ids.home, target.homeName, 'home', targetMs);
  const away = analyzeTeam(normalized.matches, target.ids.away, target.awayName, 'away', targetMs);
  const meetings = idOK(target.leagueId) ? normalized.matches.filter(match => match.leagueId === target.leagueId
    && (match.homeId === target.ids.home && match.awayId === target.ids.away || match.homeId === target.ids.away && match.awayId === target.ids.home)) : [];
  const headToHead = { ...summarize(meetings, target.ids.home), leagueId: idOK(target.leagueId) ? target.leagueId : null,
    perspectiveTeamId: idOK(target.ids.home) ? target.ids.home : null, missing: [] };
  if (!idOK(target.leagueId)) headToHead.missing.push('TARGET_LEAGUE_ID_UNAVAILABLE');
  else if (headToHead.limited) headToHead.missing.push('SAME_LEAGUE_HEAD_TO_HEAD_LT_5');
  if (!home.last5.sampleCount) missing.push('HOME_HISTORY_UNAVAILABLE');
  if (!away.last5.sampleCount) missing.push('AWAY_HISTORY_UNAVAILABLE');
  return { version: 1, fixtureId: target.id, targetKickoff: target.kickoff,
    asOf: Number.isFinite(now) ? new Date(now).toISOString() : null,
    cutoff: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null,
    status: critical || !home.last5.sampleCount && !away.last5.sampleCount ? 'unavailable'
      : missing.length || home.last5.limited || away.last5.limited || home.venueLast5.limited || away.venueLast5.limited || headToHead.limited ? 'limited' : 'available',
    home, away, headToHead, missing,
    dataQuality: { receivedRows: source.rows.length, eligibleUniqueRows: normalized.matches.length, excluded: normalized.excluded },
    notes: ['ONLY_FT_MATCHES_AET_PEN_EXCLUDED', 'FORM_COVERS_ALL_SUPPLIED_COMPETITIONS', 'HEAD_TO_HEAD_SAME_LEAGUE_ONLY',
      'FT_STATUS_FROM_SUPPLIED_SNAPSHOT_NO_EXACT_FINISH_TIMESTAMP', 'REST_IS_KICKOFF_TO_KICKOFF_NOT_FINAL_WHISTLE_RECOVERY'] };
}
