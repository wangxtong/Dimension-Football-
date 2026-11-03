# Temporary private research worker (Railway or compatible container host)

## Scope and verification
- **Research only.** This branch is a standalone deployment candidate, not a production release.
- Never connect to the existing public Site, original ECS, or Telegram Bot. No public domain or commercial pick publication is configured.
- Source branch is independent from main. Only merge or publish after exact-HEAD mandatory CI and independent audit pass.
- As of 2026-11-03, Railway's new-account trial creation returns "Trials are temporarily paused for new accounts. Upgrade to a paid plan to start deploying." This document **does not claim any Railway deployment**.
- The Dockerfile is intentionally auto-detected. New Railway services cannot adopt the deprecated railway.json config-as-code mechanism; do not add one.

## Prerequisites before live connection
1. A Railway account with resource creation enabled by Railway (no fee or plan change without the owner's approval).
2. An isolated, non-production project environment named **research**. One replica only. Do not connect the prior football-prediction service or existing website.
3. A persistent volume mounted to **/data**; Railway injects RAILWAY_VOLUME_MOUNT_PATH automatically. The worker refuses to start without the matching mount variable. Verify the actual volume mount separately in Railway environment inventory.
4. Source: private repository wangxtong/Dimension-Football- on this exact feature branch. The repository must be separately authorized for Railway GitHub deploys; ChatGPT's own GitHub authorization does not transfer automatically.
5. Railway GitHub-sourced deploy sets RAILWAY_GIT_COMMIT_SHA. For audited CLI upload deployments set COLLECTOR_COMMIT to the actual 40-character source commit SHA through a secure runtime variable.
6. Configure source provider keys **only if actually licensed and available**. Never copy secrets into GitHub commits, logs, chats or Dockerfiles.

## Runtime
- Dockerfile uses Node 24 and starts collector/research-cloud-worker.mjs, not the ECS systemd entrypoint.
- The runner calls collector/orchestrate.mjs ONLY with mode=private-research.
- Lanes: fixtures every 15 minutes, markets every 2 minutes, results every 60 minutes (single serial loop; intervals are goals, not freshness guarantees).
- State at /data/state; research reports and immutable ledger at /data/reports; scheduler heartbeat at /data/operations/research-cloud-scheduler.json.
- If a source is unavailable or a lane is blocked, log the real status; do not generate synthetic "today" matches or mark it green.
- No delivery lane, no external Site/TG notification, and no commercial release. Presence of the service is NOT evidence of verified source or predictive accuracy.

## Validation and migration
- Local isolated contract test: node --test collector/test/research-cloud-worker.test.mjs
- Validate the full repository test suite and same-HEAD mandatory GitHub Actions before attaching a deployed source. CI jobs that fail without executing any steps are **NOT VERIFIED**, not green.
- Once a real environment exists, verify the volume, deployed SHA, real upstream GET/RAW digest, prematch freeze, FT result, scored record and report IDs. Preserve rejection reasons, sample denominators and source coverage.
- For moving back to the ECS: archive /data/state, /data/reports and /data/operations with a manifest and SHA-256; verify restore in an isolated target. Do not automatically overwrite existing ECS state or restart the old Site.
- A Railway volume alone is not an independent disaster backup; configure an authorized external backup before treating it as durable production history.
