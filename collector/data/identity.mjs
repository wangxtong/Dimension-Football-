import { createHash } from 'node:crypto';

export const DATA_SCHEMA_VERSION = 2;
export const validDataToken = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
export const validDataHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const leagues = new Set(['PL', 'PD', 'SA', 'BL1', 'FL1']);

export function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const [hour, minute, second] = value.slice(11, 19).split(':').map(Number);
  const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59 || zone && (+zone[2] > 14 || +zone[3] > 59 || +zone[2] === 14 && +zone[3] !== 0)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value) || value === undefined) throw new Error('INVALID_DATA_VALUE');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
}
export const dataHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
export function normalizeSeason(value) {
  if (value === undefined || value === null) return null;
  const season = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof season !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ./_-]{0,79}$/.test(season)) throw new Error('INVALID_SEASON');
  return season;
}

// Source-scoped identity is deliberately not a claim that two providers describe
// the same event. Cross-source mappings require separate reviewed evidence.
export function eventIdentity(row) {
  const sourceFixtureId = String(row?.sourceFixtureId ?? row?.providerMatchId ?? row?.id ?? '');
  const kickoff = canonicalTimestamp(row?.kickoff), season = normalizeSeason(row?.season);
  if (!validDataToken(row?.id) || !validDataToken(row?.source) || !validDataToken(sourceFixtureId) || !leagues.has(row?.league) || !kickoff
    || !validDataToken(row?.homeTeamId) || !validDataToken(row?.awayTeamId) || row.homeTeamId === row.awayTeamId) throw new Error('INVALID_EVENT_IDENTITY');
  const canonicalMatchId = `evt_${dataHash([row.source, sourceFixtureId])}`;
  const identityRevision = dataHash([canonicalMatchId, row.league, season, row.homeTeamId, row.awayTeamId, kickoff]);
  const revisionId = dataHash([identityRevision, row.status ?? null, row.period ?? null, row.homeGoals ?? null, row.awayGoals ?? null]);
  const recordHash = dataHash([revisionId, row.home ?? null, row.away ?? null]);
  return { sourceFixtureId, canonicalMatchId, identityScope: 'source', identityRevision, revisionId, recordHash };
}

export function withEventIdentity(row) {
  const identity = eventIdentity(row), season = normalizeSeason(row.season);
  return { ...row, ...(season === null ? {} : { season }), kickoff: canonicalTimestamp(row.kickoff), ...identity };
}

export function logicalMatchKey(row) {
  if (!validDataToken(row?.source) || !leagues.has(row?.league) || !validDataToken(row?.homeTeamId)
    || !validDataToken(row?.awayTeamId) || row.homeTeamId === row.awayTeamId || !canonicalTimestamp(row?.kickoff)) return null;
  return dataHash([row.source, row.league, row.homeTeamId, row.awayTeamId, canonicalTimestamp(row.kickoff)]);
}

// Conflicting logical rows are all quarantined. Never choose a preferred ID or
// merge across names, providers, reschedules, reversed venues, or second legs.
export function partitionLogicalMatches(rows) {
  if (!Array.isArray(rows) || rows.length > 10000) throw new Error('INVALID_DATA_ROWS');
  const groups = new Map(), conflicts = [], records = []; let duplicates = 0;
  for (const row of rows) {
    const key = logicalMatchKey(row);
    let verified = false;
    try { eventIdentity(row); verified = true; } catch { /* Quarantine unknown identity rather than guessing it. */ }
    if (!key || !verified) { conflicts.push({ code: 'identity_unverified', ids: [validDataToken(row?.id) ? row.id : null] }); continue; }
    const group = groups.get(key) || []; group.push(row); groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const identities = group.map(eventIdentity);
    if (new Set(identities.map(row => row.canonicalMatchId)).size !== 1
      || new Set(identities.map(row => row.recordHash)).size !== 1) {
      conflicts.push({ code: 'logical_fixture_conflict', key, ids: group.map(row => row.id) }); continue;
    }
    records.push(group[0]); duplicates += group.length - 1;
  }
  return { records, duplicates, conflicts };
}
