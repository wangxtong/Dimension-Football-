# Dimension Football upgrade coordination

The implementation baseline is `028f43cdf63dff0b470e5288c9866f1463d14b29`.
The user authorized implementing the audit, preserving the current Site/login/Telegram target, and reusing the existing Alibaba ECS instance. Never infer deployed state from files or CI success.

## Eight roles

| Role | Responsibility |
| --- | --- |
| A1 control | Contracts, audit ledger, integration, evidence-based acceptance and release |
| A2 sources | Source reliability, robots, request budgets, cooldown, partial coverage |
| A3 data | Stable team/event identity, historical inputs, coverage and replay provenance |
| A4 models | Forecast horizons, immutable predictions, final-result scoring, evaluation |
| A5 markets | Latest market state, opening identity, conflicts and independent evidence |
| A6 delivery | Atomic publication, same-report readback, durable notification outbox |
| A7 operations | ECS packaging, services, safe synchronization, health and recovery |
| A8 website | Dashboard validation, authentication, refresh behavior, browser acceptance |

Use separate worktrees and commits. The control role integrates shared entrypoints, package scripts, workflow files and hosting manifests. Do not edit another role's files without coordinating. Return commit SHA, changed contracts, actual test output and limitations. A submitted change is `review`, not `verified`, until integration evidence exists.

## Invariants

- Ordinary 1X2 forecasts are independent of Asian-market eligibility. Never invent data or positive candidates.
- Preserve source/market identity and genuine observation times. First observed is not provider opening.
- All network paths honor authorization, robots, request budgets and Retry-After. Login/paywall challenges are not data.
- Reports, raw input references and receipts bind to one reportId. Unknown Telegram delivery is not automatically resent.
- Keep secrets outside source, artifacts, command arguments and logs. Never print credentials.
- Preserve the existing Site identity and audience. Use Sites skill for hosting work and Cloud Environment skill for environment/network work; do not install unrelated skills.
- Test meaningful failure modes. Do not execute real collection, notifications, deployment or remote mutations from an agent worktree; the control role owns integration and production operations.

## Production target

Existing ECS: instance `i-j6c4g9s2y6b5irl5gcr9`, public address `8.218.6.246`. Access identity and live service state are not yet verified. Do not modify security groups or assert SSH connectivity.
ECS will own persistent collection, reporting and notification. Preserve Sites as the visitor entrypoint. GitHub Actions OIDC is valid only for Actions jobs, not a permanent ECS identity.

Progress states: pending -> active -> review -> verified; blocked requires an exact dependency and next action. All production claims require timestamped evidence.
