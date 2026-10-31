# A1 staged activation: run research pipeline without weakening forecast release gate

Status: **DRAFT / NOT DEPLOYED**. This runbook proposes a strictly non-public research-mode activation using the **already present** public fixture collector. This is not a claim of production-grade licensed odds coverage.

## Stage R0 — actual fixture collection smoke on authorized runner

Use an isolated disposable directory on an approved test runner with Node >=24; install dependencies according to repository lockfiles. Do **not** set Telegram credentials, production publish approvals or ECS deployment credentials.

```bash
set -euo pipefail
git rev-parse HEAD
node --version
npm test
npm run site:build
npm run fixtures:public -- --out reports/research-smoke --budget-minutes 3
```

Record stdout **and stderr**, exact runner identity, process exit codes, `reports/research-smoke/public-fixtures.json`, `reports/research-smoke/public-sources.md`, timestamp and source diagnostics. No fixtures / failed or skipped required tests = BLOCKED. This is an **observability smoke**, not a market data production acceptance.

If R0 passes, run authorized historical research collection in a **separate** nonproduction workspace:

```bash
npm run collect:public -- --out reports/research-replay --state .collection-state/research-replay/state.json --budget-minutes 5
```

Inspect full diagnostics and produced report counts. Do not interpret exit 0, HTTP 200 or a fixture count as evidence that odds markets were verified. Do not use simulated results as live predictions.

## Stage R1 — licensed provider intake

A2 owns provider-specific API setup, consent, authorization evidence, quota and retry tests. A3 owns fixture identity, source-observedAt and kickoff cutoff. A5 owns 1X2/O-U/Asian opening-to-latest market time series and independent upstream groups. Cross-review required. Candidate providers already referenced in existing registry: Sportmonks, The Odds API, API-Football; until credentials AND commercial redistribution rights are evidenced, mark `not_configured`/BLOCKED and do not claim they are connected.

Per provider and match, persist **actual API response** hashes, HTTP code, source server timestamp if present, observation time, fixture mapping, provider/bookmaker upstream group, market/line/selection and commercial use entitlement. Missing true opening quote must remain `opening_unknown`; first observed price is not a sportsbook opening quote.

## Stage R2 — gate / environment boundaries

- R0/R1 may operate in research-only isolated infrastructure. Production predictions, website/TG delivery and ECS switches must remain disabled.
- Leave `BACKTEST_ALL_GREEN_ONLY` and `RELEASE_GATE` fail-closed. Do not modify `/etc/vantis/publish-approvals`, ECS Secrets or existing private message bridge.
- Before **any** production deployment, A1/A10 must verify exact main/PR/CI/deployment SHA match; every required CI job and log; sufficient genuine prospective five-league walk-forward samples; contractual rights; a production read-only smoke; rollback and old-version regression.
- This note **does not authorize deployment**, does not merge in-flight PRs and does not grant missing commercial APIs. It only defines a reproducible staged path to getting the existing collector running in research mode.

## Handoff

A2/A3 execute R0 on an authorized runner and link the raw logs/artifact hash to #22/#23. A4/A5 can consume only clearly marked research outputs; A7/A10 own isolated runtime and negative tests; A1 reviews all output. Blockers and unresolved APIs go to #27.