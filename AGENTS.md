# Dimension Football upgrade coordination

The original audit baseline is `028f43cdf63dff0b470e5288c9866f1463d14b29`. The 2026-11-01 role setup targets remote main `17931a231f6f11ccbf191fff855eae7930ad3466`; local `fd09d33` has the same source tree and is only the isolated setup base. Every implementation and review must name its actual candidate SHA.
The user authorized implementing the audit, preserving the current Site/login/Telegram target, and reusing the existing Alibaba ECS instance. Never infer deployed state from files or CI success.

## Required role loading

The project director is A1. Before working, read `docs/agents/COMMON.md`, `config/agent-team.json`, and your role's prompt file. A1 must load `docs/agents/A1-DIRECTOR.md` for its own responsibilities. The seven-layer architecture and per-module ownership are in `docs/PROJECT-FRAMEWORK.md` and the manifest's `architecture` field. The role prompts are operational instructions, not proof that agents are running or work is accepted.

From 2026-11-01 A6 owns both Web and Telegram implementation; A8 is independent quality/security/commercial acceptance. Historical records naming A8 as website implementer retain their historical meaning. Load the current mapping for new work. The team runs under session supervision with at most seven concurrent agents including A1; no resident/background execution is implied.

## Eight roles

| Role | Responsibility |
| --- | --- |
| A1 director | Project direction, contracts, dependencies, integration, evidence-based acceptance and release |
| A2 sources | Source reliability, robots, request budgets, cooldown, partial coverage |
| A3 data | Stable team/event identity, historical inputs, coverage and replay provenance |
| A4 models | Forecast horizons, immutable predictions, final-result scoring, evaluation |
| A5 markets | Latest market state, opening identity, conflicts and independent evidence |
| A6 product | Chinese Web and Telegram, atomic publication, same-report readback, durable notification outbox |
| A7 operations | ECS packaging, services, safe synchronization, health and recovery |
| A8 quality | Independent model/data/engineering/security acceptance and end-to-end regression |

Use separate worktrees and commits. The control role integrates shared entrypoints, package scripts, workflow files and hosting manifests. Do not edit another role's files without coordinating. Return commit SHA, changed contracts, actual test output and limitations. A submitted change is `review`, not `verified`, until integration evidence exists.

Every task has one accountable owner and a different reviewer. A4 produces model experiments; A8 independently reproduces their evidence; A1 makes the promotion decision. A8-authored critical changes need another qualified reviewer assigned by A1. Use `docs/agents/PROGRESS-TEMPLATE.md` for each completed stage. Report anomalies immediately and stop affected release steps. All real synchronization/merge/deployment must satisfy the candidate's required regression, frozen backtest and log review; required skips are not passes. Keep expected security-denial logs and distinguish execution success from commercial model eligibility.

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
The user requested autonomous completion without a manual Workbench handoff. Until an ECS command identity exists, the authorized interim production path is GitHub Actions with short-lived OIDC publishing into the existing Site's private R2 storage. The Site owns the shared notification claim/receipt ledger; runners must not send a second copy. Preserve Sites as the visitor entrypoint and preserve the prepared ECS deployment. GitHub Actions OIDC is valid only for Actions jobs, not a permanent ECS identity. Do not label the interim path as an ECS deployment or guarantee Actions schedule latency.

Progress states: pending -> active -> review -> verified; blocked requires an exact dependency and next action. All production claims require timestamped evidence.

## R1 production boundary

Formal forecast release is BLOCKED. The autonomous live Site path publishes only server-redacted collection observations (schedule, coverage, true timestamps), never probabilities or market candidates. Default scheduled collection must not append forecast ledgers/replays. Research and formal promotion are separate; independently verified release authority has not been provisioned. A successful observation readback is not commercial or model release acceptance.
