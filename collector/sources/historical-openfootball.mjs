import { createHash } from 'node:crypto';
import { canonicalTimestamp, dataHash } from '../data/identity.mjs';

// The originally proposed CSV source prohibits this automated commercial/AI
// use. This module instead imports locally acquired, pinned Openfootball JSON.
// It deliberately has no downloader and does not return forecast history rows.
export const HISTORICAL_IMPORT_VERSION = 1;
export const OPENFOOTBALL_FILES = Object.freeze({ PL: 'en.1.json', BL1: 'de.1.json', PD: 'es.1.json', SA: 'it.1.json', FL1: 'fr.1.json' });
const OPENFOOTBALL_NAMES = Object.freeze({ PL: 'English Premier League', BL1: 'Deutsche Bundesliga', PD: 'Spain Primera División', SA: 'Italian Serie A', FL1: 'French Ligue 1' });
export const OPENFOOTBALL_SCORE_REFERENCE = 'https://github.com/sportdb/sport.db.v2/blob/10d06a9ffb01b4e8ef05b32dd5ce3f88dfdbfcd6/document/lib/fbtxt/document/models/score.rb';
export const HISTORICAL_SOURCE_POLICY = Object.freeze({
  openfootball: Object.freeze({
    repository: 'https://github.com/openfootball/football.json',
    license: 'CC0-1.0', licenseStatus: 'repository-declared',
    licenseUrl: 'https://github.com/openfootball/football.json/blob/master/LICENSE.md',
    thirdPartyRights: 'not-warranted', upstreamFreshness: 'not-guaranteed',
  }),
  footballDataCsv: Object.freeze({
    status: 'BLOCKED', reason: 'AUTOMATED_COMMERCIAL_AI_USE_PROHIBITED',
    termsUrl: 'https://www.football-data.co.uk/data.php', robotsUrl: 'https://www.football-data.co.uk/robots.txt',
  }),
});

const MAX_BYTES = 2_000_000, MAX_MATCHES = 3000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0
  && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const score = value => Array.isArray(value) && value.length === 2
  && value.every(item => Number.isSafeInteger(item) && item >= 0 && item <= 30);

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  // Calendar validation only; this is not a conversion of kick-off to UTC.
  const stamp = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === value;
}

export function openFootballHistoryUrl({ league, season, sourceCommit } = {}) {
  if (!Object.hasOwn(OPENFOOTBALL_FILES, league) || typeof season !== 'string'
    || !/^(?:19|20)\d{2}-\d{2}$/.test(season)
    || Number(season.slice(-2)) !== (Number(season.slice(0, 4)) + 1) % 100
    || typeof sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('INVALID_HISTORICAL_SOURCE');
  return `https://raw.githubusercontent.com/openfootball/football.json/${sourceCommit}/${season}/${OPENFOOTBALL_FILES[league]}`;
}

/**
 * Import an exact downloaded snapshot, with its acquisition timestamp and hash.
 * Results remain an isolated archive: source names are not provider team IDs,
 * date/localTime are not UTC, and acquisition is not historical publication.
 * Cross-source matching or model promotion requires a separately reviewed,
 * versioned identity/time mapping. No such mapping is inferred here.
 */
export function importOpenFootballHistory(rawBytes, options = {}) {
  const { league, season, sourceCommit, expectedSha256 } = options;
  const sourceUrl = openFootballHistoryUrl(options);
  // Preserve the acquisition string too; Python/downloaders can emit microseconds.
  const sourceFetchedAtRaw = options.sourceFetchedAt;
  const timestamp = typeof sourceFetchedAtRaw === 'string'
    ? sourceFetchedAtRaw.replace(/\.(\d{3})\d{1,6}(?=Z|[+-]\d{2}:\d{2}$)/, '.$1') : sourceFetchedAtRaw;
  const sourceFetchedAt = canonicalTimestamp(timestamp);
  if (!sourceFetchedAt || typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('INVALID_HISTORICAL_PROVENANCE');
  if (typeof rawBytes !== 'string' && !(rawBytes instanceof Uint8Array)) throw new Error('INVALID_HISTORICAL_BYTES');
  const bytes = typeof rawBytes === 'string' ? Buffer.from(rawBytes, 'utf8') : Buffer.from(rawBytes);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('HISTORICAL_SNAPSHOT_SIZE_LIMIT');
  const sourceSha256 = digest(bytes);
  if (sourceSha256 !== expectedSha256) throw new Error('HISTORICAL_SNAPSHOT_HASH_MISMATCH');
  let document;
  try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('INVALID_HISTORICAL_JSON'); }
  if (!isObject(document) || !text(document.name) || !Array.isArray(document.matches)
    || document.matches.length > MAX_MATCHES) throw new Error('INVALID_HISTORICAL_DOCUMENT');
  if (document.name !== `${OPENFOOTBALL_NAMES[league]} ${season.replace('-', '/')}`) throw new Error('HISTORICAL_COMPETITION_MISMATCH');
  const sourcePath = `${season}/${OPENFOOTBALL_FILES[league]}`;
  const quarantined = [], groups = new Map();
  const quarantine = (rowIndex, reason) => quarantined.push({ rowIndex, sourceRecordId: `${sourceSha256}:matches:${rowIndex}`,
    sourceRowHash: dataHash(document.matches[rowIndex]), reason, raw: document.matches[rowIndex] });
  let unscored = 0, unscoredPastDate = 0, duplicateCount = 0;
  for (const [rowIndex, row] of document.matches.entries()) {
    if (!isObject(row) || !text(row.team1) || !text(row.team2) || row.team1 === row.team2
      || !text(row.round, 120) || !validDate(row.date)
      || row.time !== undefined && (typeof row.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time))) {
      quarantine(rowIndex, 'INVALID_MATCH_FIELDS'); continue;
    }
    if (!row.date.startsWith(season.slice(0, 4)) && !row.date.startsWith(String(Number(season.slice(0, 4)) + 1))) {
      quarantine(rowIndex, 'MATCH_DATE_OUTSIDE_SEASON_YEARS'); continue;
    }
    if (row.score === undefined || row.score === null) {
      unscored += 1;
      if (row.date < sourceFetchedAt.slice(0, 10)) unscoredPastDate += 1;
      continue;
    }
    if (row.status !== undefined) { quarantine(rowIndex, 'RESULT_STATUS_UNPROVEN'); continue; }
    if (!isObject(row.score) || !score(row.score.ft)
      || row.score.ht !== undefined && !score(row.score.ht)
      || row.score.ht?.some((goals, index) => goals > row.score.ft[index])
      || Object.keys(row.score).some(key => !['ft', 'ht'].includes(key))) {
      // A bare score array, penalties or extra time do not prove full time.
      quarantine(rowIndex, 'FULL_TIME_SCORE_UNPROVEN'); continue;
    }
    if (row.date > sourceFetchedAt.slice(0, 10)) { quarantine(rowIndex, 'FUTURE_RESULT_DATE'); continue; }
    // These five first divisions play one home/away pairing per league season.
    // Round/date corrections revise that pairing instead of adding a result.
    // The name key remains explicitly derived; it is never a provider ID.
    const sourceMatchKey = `ofmatch_${dataHash([league, season, row.team1, row.team2])}`;
    const recordHash = dataHash([league, season, row.round, row.date, row.time ?? null, row.team1, row.team2, row.score]);
    const record = {
      source: 'openfootball', league, season, round: row.round, home: row.team1, away: row.team2,
      date: row.date, localTime: row.time ?? null, timePrecision: row.time ? 'local-minute' : 'date', timezone: null, kickoff: null,
      homeTeamId: null, awayTeamId: null, sourceFixtureId: null,
      sourceMatchKey, identityScope: 'derived-source-labels',
      sourceRecordId: `${sourceSha256}:matches:${rowIndex}`, rowIndex, recordHash, revisionId: recordHash,
      status: 'FINISHED', period: 'full-time', homeGoals: row.score.ft[0], awayGoals: row.score.ft[1],
      sourceUrl, sourcePath, sourceCommit, sourceSha256, sourceFetchedAt, sourceFetchedAtRaw,
      observedAt: sourceFetchedAt, resultObservedAt: sourceFetchedAt, sourceUpdatedAt: null,
      visibility: 'snapshot', modelReady: false,
      blockers: ['SOURCE_TEAM_IDENTITIES_UNMAPPED', 'KICKOFF_TIMEZONE_UNPROVEN', 'HISTORICAL_AVAILABILITY_UNPROVEN'],
    };
    const group = groups.get(sourceMatchKey) || []; group.push(record); groups.set(sourceMatchKey, group);
  }
  const records = [];
  for (const group of groups.values()) {
    if (new Set(group.map(row => row.recordHash)).size > 1) {
      for (const row of group) quarantine(row.rowIndex, 'SOURCE_MATCH_REVISION_CONFLICT');
    } else { records.push(group[0]); duplicateCount += group.length - 1; }
  }
  records.sort((a, b) => a.rowIndex - b.rowIndex);
  quarantined.sort((a, b) => a.rowIndex - b.rowIndex);
  const dates = records.map(row => row.date).sort();
  const reasons = Object.fromEntries([...new Set(quarantined.map(row => row.reason))].sort().map(reason => [reason, quarantined.filter(row => row.reason === reason).length]));
  const coverage = {
    received: document.matches.length, retainedResults: records.length, unscored, unscoredPastDate, quarantined: quarantined.length,
    duplicates: duplicateCount, modelReady: 0, earliestResultDate: dates[0] ?? null, latestResultDate: dates.at(-1) ?? null,
    incompleteResultSelection: quarantined.length > 0,
    quarantineReasons: reasons,
  };
  const manifest = {
    version: HISTORICAL_IMPORT_VERSION, kind: 'openfootball-history-import', releaseGate: 'BLOCKED',
    source: 'openfootball', league, season, sourceName: document.name, sourceUrl, sourcePath, sourceCommit,
    sourceFetchedAt, sourceFetchedAtRaw, sourceUpdatedAt: null, sourceSha256, sourceBytes: bytes.length,
    sourceGitBlobSha1: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    recordsHash: dataHash(records), quarantineHash: dataHash(quarantined), coverage,
    scoreSemanticsReference: OPENFOOTBALL_SCORE_REFERENCE,
    license: { ...HISTORICAL_SOURCE_POLICY.openfootball,
      licenseUrl: `https://github.com/openfootball/football.json/blob/${sourceCommit}/LICENSE.md` },
    limitations: ['SOURCE_TEAM_IDENTITIES_UNMAPPED', 'KICKOFF_TIMEZONE_UNPROVEN', 'HISTORICAL_AVAILABILITY_UNPROVEN',
      'UPSTREAM_FRESHNESS_NOT_GUARANTEED', 'LICENSE_DOES_NOT_VERIFY_THIRD_PARTY_RIGHTS',
      ...(quarantined.length ? ['QUARANTINED_RESULTS_CAN_BIAS_EVALUATION'] : [])],
  };
  return { version: HISTORICAL_IMPORT_VERSION, kind: 'isolated-historical-archive', releaseGate: 'BLOCKED',
    records, quarantined, coverage, manifest, manifestHash: dataHash(manifest) };
}

// A concrete, hash-bound work queue for completing the mapping. These entries
// are evidence requests, not guessed mappings, and cannot promote any record.
export function prepareOpenFootballMappingPlan(archive) {
  if (archive?.kind !== 'isolated-historical-archive' || archive.version !== HISTORICAL_IMPORT_VERSION
    || !Array.isArray(archive.records) || !Array.isArray(archive.quarantined)
    || dataHash(archive.manifest) !== archive.manifestHash
    || dataHash(archive.records) !== archive.manifest.recordsHash
    || dataHash(archive.quarantined) !== archive.manifest.quarantineHash) throw new Error('INVALID_HISTORICAL_ARCHIVE');
  const names = [...new Set(archive.records.flatMap(row => [row.home, row.away]))].sort();
  return {
    version: 1, kind: 'openfootball-mapping-work-queue', releaseGate: 'BLOCKED',
    sourceManifestHash: archive.manifestHash, sourceSha256: archive.manifest.sourceSha256,
    source: 'openfootball', league: archive.manifest.league, season: archive.manifest.season,
    requirements: {
      teams: 'Versioned registry: exact source name + season -> verified provider/team ID; evidence URL, retained evidence hash and reviewer. No automatic aliases.',
      events: 'Bind sourceRecordId and recordHash to a verified same-event provider ID and UTC kickoff, with evidence URL/hash; check date, venue and full-time result. Never apply one country timezone to undocumented times.',
      scores: 'Resolve every generic reported score or exclude the entire affected evaluation cohort with an explicit selection-bias warning. Bare arrays do not prove full-time.',
      visibility: 'Use acquisition-time snapshot visibility; mapping does not manufacture historical observedAt or prospective samples.',
      alternative: 'A separate same-source, date-precision research protocol can use a reviewed source-label registry without cross-provider matching. It must not claim exact hourly horizons or enter the existing UTC model unchanged.',
      promotion: 'Validate all bindings, one-to-one events, revisions, team coverage and DST/day-boundary cases before a separate model integration review; formal release remains BLOCKED.',
    },
    teams: names.map(sourceName => ({ sourceName, provider: null, providerTeamId: null, evidenceUrl: null, evidenceSha256: null })),
    events: archive.records.map(row => ({ sourceRecordId: row.sourceRecordId, recordHash: row.recordHash,
      date: row.date, localTime: row.localTime, home: row.home, away: row.away,
      provider: null, providerFixtureId: null, kickoff: null, evidenceUrl: null, evidenceSha256: null })),
    scoreReview: archive.quarantined.map(row => ({ sourceRecordId: row.sourceRecordId, sourceRowHash: row.sourceRowHash,
      reason: row.reason, evidenceUrl: null, evidenceSha256: null })),
  };
}
