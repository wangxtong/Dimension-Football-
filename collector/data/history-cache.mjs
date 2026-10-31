import { acquireLock, atomicJson, readJson } from '../storage.mjs';
import { canonicalTimestamp, dataHash, normalizeSeason, validDataToken, withEventIdentity } from './identity.mjs';

const keyOf = ({ source, league, season }) => dataHash([source, league, normalizeSeason(season)]);
const validScore = value => Number.isInteger(value) && value >= 0 && value <= 20;

export function normalizeHistoryRecord(row) {
  if (!row || !validDataToken(row.id) || row.status !== 'FINISHED' || row.period !== 'full-time'
    || !validScore(row.homeGoals) || !validScore(row.awayGoals)
    || typeof row.home !== 'string' || !row.home.trim() || row.home.length > 200 || /[\x00-\x1f\x7f]/u.test(row.home)
    || typeof row.away !== 'string' || !row.away.trim() || row.away.length > 200 || /[\x00-\x1f\x7f]/u.test(row.away)
    || row.home === row.away) throw new Error('INVALID_HISTORY_RECORD');
  const clean = Object.fromEntries(['id', 'source', 'sourceFixtureId', 'league', 'season', 'kickoff', 'home', 'away', 'homeTeamId',
    'awayTeamId', 'homeGoals', 'awayGoals', 'status', 'period'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
  for (const key of ['observedAt', 'resultObservedAt', 'fetchedAt', 'sourceUpdatedAt']) {
    if (row[key] === null && key === 'sourceUpdatedAt') clean[key] = null;
    else if (row[key] !== undefined) {
      const time = canonicalTimestamp(row[key]);
      if (!time) throw new Error('INVALID_HISTORY_PROVENANCE');
      clean[key] = time;
    }
  }
  const normalized = withEventIdentity(clean);
  // These times document a completed result version, not the original fixture
  // announcement. A full-time score cannot have been seen before kickoff.
  if (['fetchedAt', 'observedAt', 'resultObservedAt'].some(key => clean[key] && clean[key] <= normalized.kickoff)
    || clean.observedAt && clean.fetchedAt && clean.observedAt > clean.fetchedAt
    || clean.resultObservedAt && clean.fetchedAt && clean.resultObservedAt > clean.fetchedAt) throw new Error('INVALID_HISTORY_PROVENANCE');
  for (const key of ['canonicalMatchId', 'identityRevision', 'revisionId', 'recordHash']) {
    if (row[key] !== undefined && row[key] !== normalized[key]) throw new Error('HISTORY_IDENTITY_MISMATCH');
  }
  return normalized;
}

async function load(path) {
  if (!path) return { version: 1, entries: {} };
  let state;
  try { state = await readJson(path, 32_000_000); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, entries: {} }; throw new Error('HISTORY_CACHE_UNREADABLE'); }
  if (state?.version !== 1 || !state.entries || typeof state.entries !== 'object' || Array.isArray(state.entries)
    || Object.keys(state.entries).length > 40) throw new Error('HISTORY_CACHE_INVALID');
  const clean = { version: 1, entries: {} };
  for (const [key, entry] of Object.entries(state.entries)) {
    if (!entry || key !== keyOf(entry) || !canonicalTimestamp(entry.fetchedAt) || !Array.isArray(entry.records) || entry.records.length > 3000
      || !Number.isSafeInteger(entry.receivedCount) || entry.receivedCount < 0 || !Number.isSafeInteger(entry.rejectedCount) || entry.rejectedCount < 0) throw new Error('HISTORY_CACHE_INVALID');
    const records = entry.records.map(normalizeHistoryRecord);
    if (records.some(row => row.source !== entry.source || row.league !== entry.league || row.season !== entry.season)
      || entry.snapshotHash !== dataHash(records)) throw new Error('HISTORY_CACHE_INVALID');
    clean.entries[key] = { source: entry.source, league: entry.league, season: entry.season, fetchedAt: entry.fetchedAt,
      records, snapshotHash: entry.snapshotHash, receivedCount: entry.receivedCount, rejectedCount: entry.rejectedCount };
  }
  return clean;
}

// A cache is a current snapshot, not a permanent archive. Run manifests retain
// immutable inputs separately. Cached history never refreshes fixture timestamps.
export async function withHistoryCache({ statePath } = {}, operation) {
  const release = statePath ? await acquireLock(statePath) : async () => {};
  try {
    const state = await load(statePath);
    const get = (identity, { nowISO, maxAgeMs }) => {
      const entry = state.entries[keyOf(identity)], now = canonicalTimestamp(nowISO);
      if (!now || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) throw new Error('INVALID_HISTORY_CACHE_WINDOW');
      if (!entry || entry.fetchedAt > now || Date.parse(now) - Date.parse(entry.fetchedAt) > maxAgeMs) return null;
      return structuredClone(entry);
    };
    const put = async (identity, rows, { fetchedAt, receivedCount, rejectedCount = 0 }) => {
      const time = canonicalTimestamp(fetchedAt), season = normalizeSeason(identity.season), key = keyOf(identity);
      if (!time || !Array.isArray(rows) || rows.length > 3000 || !Number.isSafeInteger(receivedCount) || receivedCount < rows.length
        || !Number.isSafeInteger(rejectedCount) || rejectedCount < 0) throw new Error('INVALID_HISTORY_CACHE_SNAPSHOT');
      const previous = state.entries[key], prior = new Map((previous?.records || []).map(row => [row.canonicalMatchId, row]));
      if (previous && time < previous.fetchedAt) throw new Error('HISTORY_CACHE_CLOCK_REVERSED');
      const records = rows.map(row => {
        const clean = normalizeHistoryRecord({ ...row, fetchedAt: time });
        if (clean.source !== identity.source || clean.league !== identity.league || clean.season !== season) throw new Error('HISTORY_CACHE_IDENTITY_MISMATCH');
        const old = prior.get(clean.canonicalMatchId), unchanged = old?.revisionId === clean.revisionId;
        return { ...clean, observedAt: unchanged ? old.observedAt || time : time,
          resultObservedAt: unchanged ? old.resultObservedAt || time : time };
      });
      if (new Set(records.map(row => row.canonicalMatchId)).size !== records.length) throw new Error('DUPLICATE_HISTORY_ID');
      const entry = { source: identity.source, league: identity.league, season, fetchedAt: time,
        receivedCount, rejectedCount, records, snapshotHash: dataHash(records) };
      state.entries[key] = entry;
      if (Object.keys(state.entries).length > 40) throw new Error('HISTORY_CACHE_CAPACITY_EXCEEDED');
      if (statePath) await atomicJson(statePath, state);
      return structuredClone(entry);
    };
    return await operation({ get, put });
  } finally { await release(); }
}
