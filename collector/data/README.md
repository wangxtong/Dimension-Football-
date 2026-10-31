# Data contracts

`identity.mjs` creates a **source-scoped** `canonicalMatchId` from the provider and
its `sourceFixtureId`. It is not a cross-provider mapping. `identityRevision`
changes with league, season, ordered team IDs or kickoff; `revisionId` also binds
status and the full-time result. Names affect `recordHash`, not event identity.
`partitionLogicalMatches` quarantines different IDs describing the same source,
league, ordered team IDs and UTC kickoff. Unknown identity stays unverified.

`normalizeHistoryRecord` accepts finished full-time results, validates metadata,
and strips arbitrary response fields. `observedAt` and `resultObservedAt` mean
actual acquisition of that result version, never the original publication time.
Legacy rows can omit these fields. `withHistoryCache` preserves first observation
for an unchanged version, refreshes `fetchedAt` only on an actual fetch, and keeps
only the current seasonal snapshot. It is a cache, not a permanent archive.

Public acquisition accepts `historyCachePath`, `cooldownStatePath` and
`historyCacheMaxAgeMs` (default one day, maximum seven days). Only history-only
prior-season requests may use the cache; fixtures always require fresh retrieval.
Paths must be separate and stored outside immutable application release folders.
Without paths, guards apply only within the acquisition round. A corrupt stored
state fails closed. There is no automatic stale-cache fallback.

`publicInputMetadata(manifest)` returns safe `fixtureDiagnostics` and recomputed
per-league `coverage`. Keep those fields when passing public inputs into the CLI
and reports. Coverage distinguishes unavailable, unsupported and unrequested
history. It never supplies a guessed expected match count or complete coverage.

`createReplayBundle` returns `{manifest, inputs}` bound to a report ID, hashes,
prediction cutoff, model, policy and optional source commit. Store the pair as
`run-manifest.json` and `run-inputs.json` in the immutable report bundle and include
both in its publication hash list. Pass validated fixtures and normalized history;
retain normalization rejection/conflict counts in the enclosing report. Run the
model with these same normalized inputs to reproduce preprocessing consistently.

`verifyReplayBundle` rejects modifications, report mismatches and source-version
mismatches. `replayForecasts` invokes only the supplied pure model function and
requires the caller's matching code version. Unknown code versions require an
explicit override and remain labelled `inputs-only-code-version-unknown`.
Replaying today's historical snapshot does not reconstruct what was visible
before its first retained observation. Inputs, code and record versions must all
be retained for a version-bound replay.

No additional league or history source is implied by these interfaces. Current
public coverage remains OpenLigaDB Bundesliga plus TheSportsDB's limited next
fixture sample for the other four leagues, without their historical results.

## Scheduled orchestration

`collector/orchestrate.mjs --lane fixtures|markets|delivery|results --state FILE
--out DIR --budget-minutes N` serializes lanes on the same state root. Its default
output is `/var/lib/vantis/reports`; help performs no reads, writes or requests.

- `fixtures` refreshes public schedules/history and builds ordinary forecasts.
  Configured fixture credentials retain the managed-source route; `HISTORY_FILE`
  or the prior validated replay input retains available same-source history.
  Public-only data is never substituted for a different provider's history.
- `markets` verifies `public-fixtures.json` as a hashed acquisition snapshot,
  blocks it after twenty minutes, and skips markets when no fixture starts in
  the next twenty-four hours. It never renews fixture acquisition timestamps.
- `delivery` resumes `publishAll` from the stable report directory. Failed or
  unknown channel outcomes remain partial, even if the sequence returns normally.
- `results` refreshes only OpenLigaDB's current season, registers actual result
  versions and writes `prospective-evaluation.json` by source, league and horizon.
  Other sources need verified normalized inputs; result publication times are
  never invented. A subsequent generated report includes the evaluation snapshot.

Every generated report registers its published prediction document in
`forecast-ledger/` before files become ready for external publication. Replay
inputs are additionally retained under `replays/<reportId>/`; preserve both
directories, `.delivery/`, and all state sidecars when backing up persistent
data. `public-source-fixtures.json` preserves the public acquisition manifest;
`public-fixtures.json` contains the final selected pool and can therefore use
authorized source identities. Its historical rows and fixture timestamps remain
bound to the acquisition snapshot rather than the next market collection time.
