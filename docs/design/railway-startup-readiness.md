---
eval_tier: full
spec_gate: block
safety: true
type: issue-spec
---

# Restore production Brain and prevent startup migration outages

## What / why

On 2026-09-28, AIO-1186 PR729 deployed commit 4bc3754e049f138e401c100729970dec7c73c1a4. Railway pre-deploy schema succeeded, then runtime bootstrap reran schema and hit a lock held by a task reader. Repeated startup failures exhausted the restart budget while no application readiness gate protected traffic cutover. The original database session ended without intervention; the owner authorized application recovery and prevention.

## Outcomes

- Production dashboard/API recover, verified by real HTTP responses and deployment identity.
- Railway schema runs before deployment, once per deployment rather than on every application startup. Runtime startup preserves provisioning and self-host behavior.
- Railway promotes a candidate only after bounded, uncached application/database readiness succeeds; failures disclose no database internals.

## Interface / integration points

- `railway.json`: retain preDeployCommand; add readiness gate.
- `scripts/railway-start.sh`, `docker/bootstrap.mjs`, `docker/entrypoint.sh`: single migration owner with existing bootstrap responsibilities preserved.
- `lib/db/pg/client.ts`: existing application database connection behavior; do not weaken production timeouts.
- New file: `app/api/health/route.ts`; readiness helper and focused tests may be created.
- `docs/ARCHITECTURE.md` and `docs/RAILWAY-TEMPLATE.md`: operational contract and recovery guidance.
- Reuse relevant staging health work from PR701 selectively; preserve staging-only diagnostics and avoid unrelated startup-fence dependencies.

## Dependencies

Depends on: none. Incident follows AIO-1186 under AIO-1108. Related AIO-940 covers broader migration-ledger/re-key semantics, which are distinct from this runtime migration replay incident.

## Scope

**In:** authorized application restart, duplicate runtime migration removal for Railway, bounded readiness endpoint, health-gated cutover configuration, regression tests and recovery evidence.

**Deferred:** migration ledger and historical data re-key changes remain AIO-940. No new action enablement, database restart, blanket session termination, or unrelated staging feature rollout.

## Implementation approach

Keep pg:schema as the pre-deploy owner. Explicit runtime bootstrap mode omits only schema work; default Docker retains migrations. Preserve secret sourcing and team/demo provisioning. Use a non-sensitive readiness response with a deadline covering connection acquisition and query, releasing/destroying connections correctly. Prove failed readiness cannot be cached as healthy. Preserve migration lock timeout and database safety guards.

## Acceptance criteria

### Automated

- Tests show Railway startup never invokes schema loader, default self-host startup still does, bootstrap errors stop startup, and provisioning/secret propagation remain correct.
- Readiness returns uncached 200 for reachable database and non-sensitive 503 for connection/query failure or timeout, including late connection cleanup.
- Meaningful HTTP and PostgreSQL tests verify healthy/unavailable behavior and lock-safe runtime startup. Required CI, typecheck, build, lint, docs drift and NDA pass.
- Independent exact-base/head review resolves blocking findings and records MERGE_READY before protected merge.

### Manual

- Verify production recovery and deployment commit, then final healthcheck configuration plus /login and /api/health responses after merged prevention changes.
- Record incident timeline, limits of cause attribution, rollback/recovery, exact commits/PR, and cleanup in Resume here.

## Build-with

Implementation and separate independent review; coordinator serializes tracker and production mutations. Private technical evidence references neutral review identifiers.

## Tier safety

Public readiness returns only service health, never credentials, database errors, team/member identifiers, or private staging journals. Production diagnostic access remains read-only; owner authorized application recovery on 2026-09-28. No database session cancellation is currently needed.

## Resume here

Owner: coordinating implementation session. Base: Brain main 4bc3754e049f138e401c100729970dec7c73c1a4. Production recovery verified by the coordinator at 07:39 UTC via application redeploy of the same base: /login 200 and unauthenticated governed status 401; no database restart or session cancellation. Prevention implementation is isolated in remediation/aio1206-startup-readiness. Next: independent review, CI, protected merge and deployed readiness verification. Linear is authoritative; local incident snapshots are evidence only.
