# A7 commercial source admission gate (not wired into production)
The admission checks in `collector/sources/commercial-feed-admission.mjs` are isolated and do **not** initiate collection. They are available for A2/A3/A5 review, and A1 must integrate them into the actual collection+release entrypoint with tests before treating them as enforced production policy.

## Real-time source plan
- OpticOdds: proposed streaming odds source, pending enterprise credentials, documented market/fixture mapping and licensed redistribution.
- The Odds API: existing provider in `collector/sources/providers.mjs`; verify rights, timestamp semantics, coverage and update intervals for each market.
- Sportmonks: existing fixture/prediction provider; odds, injuries, lineups require feature entitlements and independent validation.
- iSports: existing Asian-handicap reference; original opening timestamp and distinct bookmaker source identity must be verified.
- API-Football: proposed fixtures/lineups/injuries complement; pre-match odds approximately three-hour update and must not pass five-minute latest-price requirement without actual fresh upstream data.
- Sportradar, Opta, Nami: enterprise sales / contract candidate, **not connected**.
All commercial use and redistribution must be explicitly authorized; open endpoints alone are insufficient.

## A1 integration requirements
- The existing provider engine already implements credentialed provider calls, request budgets, cooldown and a state file; extend that machinery rather than adding a second scheduler.
- Map provider fixture ID and bookmaker identity consistently. Store actual quote update timestamp separately from HTTP fetch time. Do not infer an opening tick from first observation.
- Quote admission requires verified rights and bookmaker, real upstream timestamp no older than 5 minutes, pre-match active state, and matching selection and line from independent upstream groups. This is only a necessary guard, not a sufficient release gate: require 1X2/O-U/AH available as appropriate, signed immutable report, model forward-validation, QA and release authority.
- On 401/403/429/5xx, provider failure or missing timestamp, apply existing cooldown and stop source promotion. Backup may be selected only if independently eligible. No cached price should be relabelled LIVE.
- Add automated stateful 1–5min polling *only with rate-limit and entitlement evidence*, separate from GitHub Actions cron which cannot guarantee this latency. Prove actual p95 data age and source coverage for each league.
- No production modification, merge, ECS changes or real API requests performed by this branch. Formal release remains BLOCKED.

Run `node --test collector/sources/test/commercial-feed-admission.test.mjs` after review.
