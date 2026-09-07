# AUDITFIX-13 — serialize item access and its context move

Date: 2026-09-07. Brain task: **AUDITFIX-13**, projected Linear **AIO-1134**. Merged scope: remediation
items **13 + 12**, Lane A only. Governing spec: [Project partitioning and permissioning V2](../specs/project-context-classification-v1.md),
especially §11 and Part II invariant 3. Contribution/review/merge base is **staging**, never main.
Baseline examined: `385b060d0fffb6507a2574e4ed83e0b74af3e7fc`.

## What/why

Implementation result: prevent a completed access-changing ingest from leaving its automatic system
membership move based on a different item version. This is Wave 1 Lane A, preparing for TIERRET-1;
it does not implement initial-placement trigger admission across connectors.

## Build-with

Astra specification/decision ownership; **Sol high through the Codex CLI** implementation. Opus 5
through the Claude CLI is an implementation fallback **only if Sol hits a usage limit**. Fable 5.1
spec and code reviews, independent Codex spec review, and a fresh Astra high code review are required.
No implementation before the actual `aios spec eval` verdict is `SPEC_READY`.

## Dependencies

The V2 governing spec, Phase A remediation plan, and EXCLSHADOW-1/CLOSEMODE-1/AUDITFIX-4 shipped
contracts are normative. PostgreSQL and the existing pg adapter are runtime dependencies; no package,
model call or schema addition. Lane C/AUDITFIX-3 is parallel work, so correct General grants cannot
be assumed. Lane A and item 3 both precede TIERRET-1. No dependency on Lane B implementation.

## Tier safety

The item oracle is already membership-only. An item access change alone does not revoke a current
external-shared include. This slice never removes `noWideningGate`, changes grants, or bypasses the
oracle. Atomic failure does not claim a restriction completed: old committed access remains until a
successful retry. Human exclusion standing states remain authoritative. New-item placement retains
its existing hook/backfill latency; no expanded inline connector admission is smuggled into Lane A.
An item with no current system-project include has no read path through those system projects,
even if General itself is externally granted; absence is not visibility-equivalent to a General
include. Other initiative memberships, if any, retain their separate visibility semantics.

## 1. Re-derived evidence

The desired user outcome is that a completed ingest reclassification and its automatic system
project move describe the same committed item state, even when pushes and backfill overlap.
A membership operation must not erase a human exclusion or report success after a failed read.

This is a coordination defect, not evidence that every current race discloses content:

- `lib/ingest/index.ts` reads an existing item by `(team_id, project_id, path)`, derives
  `existingAccess`, `effectiveAccess`, authorization and `accessChanged` without locking, then
  writes access in the unchanged heal and changed-body paths. New rows also write access.
- `lib/ingest/reclassify.ts: settleReclassification` invokes reconcile after the item write,
  best-effort, after cache handling. Another item write may occur before or during that move.
- `lib/projects/context/reconcile-item.ts` reads/mirrors audience and issues several separate
  membership statements. Its comment explicitly says AUDITFIX-4 did not close concurrency.
- `lib/projects/context/units.ts` uses pool-bound raw SQL in the drift branch; its no-drift return and insert-loser
  return can route on an older read. An unconditional mirror alone still leaves a gap between
  the mirror and membership writes.
- `noWideningGate` can reject a stale placement, leaving denial or the previous placement.
  It is a remaining backstop, not a serialization protocol. TIERRET-1 proposes deleting it;
  Lane A must establish coordination first and **does not delete or weaken this gate**.
- `lib/db/pg/tx.ts` already has `withTransaction`, but the builder and RPC client call `runSql`
  against the pool. Putting the existing helpers inside its callback today does not enlist
  their writes. Item 12's alleged “293-line SQL rewrite” is not a requirement; preserve those
  helpers and inject the executor instead.

The failed designs in [AUDITFIX-4 §10–11](auditfix4-membership-close-read-errors.md) are rejected:
unit CAS binds to the mirror, conditional mirror leaves bypasses, reconciler-only advisory locks
omit ingest, and pool-bound calls inside a transaction escape its atomicity. No new claim here
relies on the sweep running automatically as an access-health detector.

Evidence above is source inspection, not a reproduced database result. The real-Postgres
acceptance cases below must reproduce the relevant baseline failures before implementation.

## 2. Decision and invariants

Use the existing query-builder logic with a **dedicated-connection executor**, and one shared
item-row lock protocol for automatic item-context writes. Ingest's item write and required
access-changing context transition commit together. Separate public reconcile calls take the
same row lock and perform the whole move in one transaction. `READ COMMITTED` is sufficient:
a locking item read happens before dependent reads, and all compliant item-context writers
hold that row lock until commit. No serializable-isolation claim is needed.

**INV1:** routing and item-dependent pusher authorization use the current item read after lock acquisition,
using the request's already established authentication/pusher-tier snapshot. This is not transactional
reauthentication or a change to token/group revocation semantics.
Never use a pre-lock `existingAccess`, stored body-hash comparison, unit audience, `accessChanged`, or lock-wait
snapshot to authorize or route a write. An operation serializes when its transaction commits.

**INV2:** a successful ordinary, bootstrapped **existing-item access-changing ingest** commits
the item access, mirrored item unit and exactly the matching system-project include together.
A successful standalone reconcile atomically mirrors/routes the currently locked item. Initial
placement of newly inserted content remains governed by the existing caller hooks and backfill.
For each successful move, opposite system-project includes close; initiative memberships stay unchanged. A protected opposite exclusion may remain current.

**INV3:** a database/transport failure outside the narrowly isolated optional audit scope (§3b) commits none of that transaction's writes and cannot be
reported as convergence. A deliberate human-exclusion refusal is a distinct, typed terminal
outcome, preserving the existing standing states in §5; it is not a database failure.

**INV4:** `items.project_id` remains ingestion ownership. Units and memberships retain their
existing sole writer modules. Raw SQL is permitted for lock acquisition and the existing unit
mirror; membership policy is not duplicated in SQL.

**INV5:** atomicity is PostgreSQL item/context state, not graph, cache or external PM delivery.
Post-commit invalidation/graph behavior remains the existing eventual contract.

## 3. Executor and transaction boundary

Add an executor dependency to `PgClient` and `PgQuery` with `runSql` as the unchanged default.
All execution legs use it: select, count/head, second count query, mutations/RETURNING, and
supported RPCs. Transaction-bound clients use only the passed PoolClient's query function.
The raw unit mirror uses that same executor, never an independent pool connection.

Keep public builder result envelopes (`data`, `error`, `count`) and standalone helper contracts.
Do not change every caller into exception-based control flow. At the transaction boundary,
however, a returned failure must cause rollback before the existing outward result is returned.
Track every non-optional executor SQL failure (with only §3b's recovered audit exception) so a helper that swallows an error and returns `ok:true` cannot
cause a false successful commit. Explicitly inspect callback domain results too: a policy
refusal may not throw, yet must be classified according to §5. Do not treat arbitrary
`ok:false` as either automatic commit or automatic success.

A SQL error aborts a PostgreSQL transaction. Existing insert-race “read winner” branches cannot
recover inside that aborted transaction. Do not blindly preserve their old pooled behavior:
roll back the attempt; if retry is appropriate, retry the entire transaction using fresh reads.
No general per-query savepoint machinery is allowed; §3b defines the only optional audit scope. Preserve error SQLSTATE internally if needed to
classify retry; outward strings remain compatible and non-empty. Connection acquisition, BEGIN,
lock, raw mirror, COMMIT and ROLLBACK failures are also accounted for. Reconcile returns
`ok:false` rather than throwing through backfill; ingest retains its existing throwing failure
contract. Dispose of the dedicated client on all paths. Normal `release()` is allowed only after
confirmed COMMIT or confirmed full ROLLBACK on a healthy connection. A failed BEGIN, COMMIT, ROLLBACK,
unrecoverable savepoint/session-control operation or connection/protocol failure requires destroying
release (`client.release(cause)`), even if later cleanup is attempted. Unknown COMMIT outcome is an
error with no replay. Preserve primary and cleanup failure in diagnostics; never pool a session whose
transaction state is uncertain. Reject use of an escaped completed
transaction client. Do not silently fall back to the pool for unsupported transaction clients.

### 3a. Structural capability, locked context and executable test seam

Define a structural `TransactionCapableDbClient extends DbClient` with one required method:
`transaction<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T>`.
`TransactionSession` exposes the connection-bound `db`, `executeSql`, and the narrow optional-audit
scope of §3b. The callback never receives a second pool client. `PgClient` implements the capability;
`adminClient()` may keep its `DbClient` return type, but the entry boundary checks that the required
method exists and delegates to it. No `instanceof` test, private-field reconstruction or implicit
pool singleton lookup may discard the caller's transaction factory. A plain wrapper lacking the
method fails with **`transaction-capability-required`**, not a nontransactional fallback.
A supported wrapper explicitly delegates `transaction` and preserves its instrumentation.

A bound `session.db` is marked by factory-owned metadata, scoped to that exact live session; it
cannot begin another transaction or silently become the singleton. Internal item-context helpers
receive a `LockedItemContext` constructed only after acquiring the item lock and validating team/id.
The context contains the live session, item identity and freshly read authority. Its constructor is
module-private; no public `alreadyLocked` boolean can substitute. Public unit/membership APIs retain
their signatures for existing direct callers/tests, acquire a session/row lock when called alone,
and reuse a verified locked context when called by the reconcile core. No recursive checkout.
Generic DbClient consumers remain unchanged; unsupported public context/ingest clients fail closed.

FakeSupabase orchestration tests keep their real public ingest/action entry points. Give
`lib/ingest/fake-supabase.ts` an explicit structural fake `transaction` implementation and session
factory in test support: fake row locking is a no-op and documented as having NO concurrency or
PostgreSQL atomicity proof. Its executor handles only the concrete lock/mirror/session operations
these orchestration tests exercise and rejects unsupported SQL; do not build a generic SQL engine.
Tests may mock that transaction helper/factory explicitly for a focused backfill error-path test.
Session construction stays factory-owned in either case; runtime exports never choose fake behavior
because capability is absent or because an environment flag is set. An action test can therefore run
`runAction → ingestItem` without editing the production action handler. Existing fake and minimal
from-only cursor fixtures must be updated explicitly, not left to silently fail at capability check.
Real-Postgres tests use the SAME exported
entry points and capability as production, with a factory-injected decorator around the bound
executor and adapter-envelope boundary. The decorator is per operation, not a global mutable hook.
It supports barriers before/after selected SQL, stale-result replacement, actual SQL errors/throws,
and synthetic returned `{error}` envelopes. Both the executor and envelope boundary record failure;
a synthetic returned error cannot bypass the rollback tracker. Raw mirror executes through the same
instrumented session executor. Every injection asserts it fired at the intended statement/session.

Migrate existing `db.from` proxy tests to this seam: constructing a new bound client must not quietly
bypass their fault. Prove the fault is discriminating by running the healthy counterpart and by
removing the injection. Actual PostgreSQL aborted-state tests use actual SQL failure; a synthesized
error envelope alone proves only the envelope contract. Public unsupported-client and supported-
delegating-wrapper tests pin backward compatibility rather than relying on `instanceof PgClient`.

### 3b. Optional audit statements: preserve best-effort semantics

`audit()` promises that audit failure does not fail ingestion. `recordReassignment` shares that
promise, and `ownerWindowStart` returns null when its optional audit lookup fails. Keep these
semantics, including inside a transaction, through a deliberately narrow savepoint helper used
only by `lib/api/audit.ts` and `ownerWindowStart` in `lib/ingest/reassignment-log.ts`.

For a live bound session, the helper creates a uniquely named SAVEPOINT, executes exactly the
optional audit statement/read, and inspects returned errors and the scope's executor failure state.
On an optional SQL/envelope failure it ROLLBACKs TO that savepoint and RELEASEs it, restores only
failure state introduced in that scope, and returns the existing best-effort fallback (void/null).
Prior transaction failure cannot be cleared. SAVEPOINT/ROLLBACK TO/RELEASE failure or connection
loss is fatal to the whole attempt and destroys the session as above. An audit-statement error with
SQLSTATE 40P01/40001 is still OPTIONAL if ROLLBACK TO and RELEASE succeed on the healthy connection:
do not force whole-ingest retry/failure solely because of that recovered audit SQLSTATE. If recovery
cannot be confirmed, fail the attempt. This is an error-versus-recovery distinction, not a promise
that every SQLSTATE is recoverable. PostgreSQL documents that rollback-to restores the saved
transaction state and starts a new subtransaction at the same level ([ROLLBACK TO SAVEPOINT](https://www.postgresql.org/docs/current/sql-rollback-to.html)).
A PostgreSQL 16 diagnostic observed an actual two-session 40P01 inside a savepoint,
successful ROLLBACK TO/RELEASE, subsequent SELECT and confirmed COMMIT; this validates that case,
not all connection/control failures or every 40001 recovery. All other statements and returned/swallowed errors remain fatal.
No table-name magic in the generic executor, no arbitrary caller opt-out and no automatic savepoint
around every query. On a normal nontransactional client the existing audit/optional-read behavior
continues unchanged. The helper capability is supplied by the live session, never by an ambient pool.

Item created/updated, attribution-healed, and reassignment audits remain in the transaction with
metadata derived from locked state. Social `tier_narrowed` audit remains before its cascade writes:
a healthy audit and healthy cascade commit together; a later failed ingest transaction rolls both
back, so retry still sees an external opportunity and records the attempt again. No narrowed chain
is committed without an attempted trail. This is different from the helper's standalone autocommit
case, where the early audit must survive partial writes; that public helper/test stays unchanged.
Document both contexts in `lib/social/store.ts`, without changing cascade policy. An audit-only SQL
failure remains best-effort in both contexts. `item.access_healed` stays best-effort after commit
with cache invalidation; it is not an in-transaction success signal. Post-commit loss/ordering of
that existing event remains outside the atomic item/context guarantee.

## 4. Locking and ingest sequence

For an existing item, `SELECT ... FROM items WHERE team_id=$1 AND id=$2 FOR UPDATE` is the
shared lock. All production item-grain unit and membership mutations join this protocol;
public membership calls resolve the unit's item, lock that item, then re-read/revalidate the
unit-to-item relationship before changing membership. Missing/cascade-deleted units must not
be treated as successfully placed. Standalone reconcile retains documented skip semantics for
an item disappearing; this does not implement AUDITFIX-11's drain skip counter.

Ingest also needs to serialize absence: after source-project resolution, acquire a transaction
advisory lock over a namespaced deterministic `(team, source project, path)` key before looking
up the existing item. Use parameterized `pg_advisory_xact_lock(namespace::int, hashtext(identity::text))` with
a fixed namespace distinct from `GRAPH_PROJECTION_LOCK_NS=7341002`, and canonical unambiguous identity
encoding (e.g. JSON tuple), not JavaScript's process-dependent hash. Collisions may serialize unrelated paths but cannot authorize a wrong item. Every ingest
uses this identity lock, then locks the existing item if present. Inserts are invisible before
commit; the identity lock prevents two concurrent ingests both deciding that this path is new.
Reconcile needs only the row lock because it operates on committed item IDs. The existing unique item key already prevents duplicates; the identity lock
serializes absence/authorization decisions and makes ordinary losers observe the winner.

Lock order is identity lock (ingest only) → item row → unit/membership work. Never acquire an
identity lock after an item lock; never hold two item locks in one context operation. Shared
inherited/social tables can still cause ordinary database deadlocks between different items.
In particular task-kind ingestion upserts/deletes project-wide task rows and task PM links, so
oppositely ordered rows in two task pushes can deadlock while holding different item locks; inbound
PM-sync also writes those rows transactionally. No claim is made to eliminate those cycles. A large
task push holds its item lock and one connection for the whole materialization sweep.
The inbound apply path's task-then-link order is not a proof that all PM interactions share that
order: inbound adoption writes a link before updating its task. Do not assume task/PM cycles are
impossible merely because one inbound path matches the materializer's order.

The ingest transaction begins after payload parsing/hash calculation and source-project setup.
Within it, read the item after locking, re-run all existing authorization and attribution
choices against that read. For an existing-item narrowing, perform the shared pure no-widening
preflight BEFORE cascade/item/context mutations, using the desired effective audience derived from
that locked item plus the request snapshot, never a stale unit audience. Resolve/validate system
projects through the existing owner; missing bootstrap retains skip semantics, read error/refusal
fails before destructive work. Retain the authoritative gate checks in reconcile/membership writers:
the early preflight reduces needless cascade-and-rollback work, it is not a cached authorization
answer or a replacement for those checks. Then use the bound client for the existing
item/version/materialization/hash-write work, preserving the cascade-before-access-write ordering
through the existing inherited-audience writer, and invoke
the in-transaction context core for an **existing-item access change**. First insertion does
not add an inline reconciliation trigger: it keeps existing route/meeting hooks and sweep coverage.
This is a deliberate Lane A boundary, preserving Lane B's admission/trigger ownership. All ordinary existing item updates retain the row lock even when access
does not change: a stale unchanged patch must not overwrite a concurrent tier correction.

Keep DB-only helpers in this bounded transaction; source-project creation/pointer setup may
remain outside. Cache invalidation, graph/external effects and access-healed audit follow commit
using the ordinary client. Remove the reconcile invocation from `settleReclassification`; its responsibilities become
post-commit cache invalidation and access-healed audit only. After CONFIRMED COMMIT, retain the
committed successful IngestResult: catch the entire post-commit phase, including prerequisites such
as teamSlug lookup and returned/thrown helper errors, and diagnose failures without rejecting ingest
or replaying its transaction. Directly owned lookups must inspect error envelopes; logging a failed
effect is not claiming it was delivered. This does not guarantee cache/audit delivery or add a retry
queue; a same-payload push with accessChanged=false is not assumed to retry missed one-shot effects.
Unknown COMMIT outcome remains an error/no replay; only confirmed commit gets this success boundary. The in-transaction context core owns the
access-changing move. This prevents a third redundant reconcile and any recursive checkout. Existing route/meeting/backfill hooks may still reconcile idempotently after commit.
Retain inherited audience ordering and cache invalidation behavior; do not modify their policies.
If a helper in this transaction has hidden pool/raw/external effects, remove that escape by
threading the executor through the existing owner or stop for a scope amendment before coding it.

System project IDs passed by backfill are hints: validate team, kind and expected slug inside
the operation before using them. Missing system topology preserves the existing explicit
`skipped` bootstrap contract, including ingest before bootstrap; a failed topology read is a
failure, not a skip. Newly created/changed unbootstrapped content is therefore explicitly outside
INV2's bootstrapped guarantee and stays eligible for existing backfill.

Stale read/retry policy: waiters re-read after locking, including no-drift and unit-create paths.
A known transaction rollback SQLSTATE 40001/40P01 gets at most **one whole-operation retry**, with
fresh locks/reads and no post-commit effects from the failed attempt. A first-create unique conflict
may likewise receive at most one whole retry. A typed `membership-state-changed` restart (§5)
and a context-current-key unique conflict also share that same budget. There are at most two attempts TOTAL, even when error classes differ; second failure returns the existing failure contract.
Never retry validation errors, explicit exclusions, lock timeout, unknown COMMIT outcome or permanent
DB errors. Recovered optional audit statements never trigger whole-ingest retry solely for their SQLSTATE;
a failed recovery fails the attempt and destroys its session. Preserve last-good backfill cursor.

Scope an explicit **10-second lock-acquisition timeout** to the identity advisory and item row
acquisition statements, restoring the prior transaction-local setting immediately after acquiring
those locks, before materialization and context writes. One ingest can acquire both locks, so this
is per-lock, not a 10-second end-to-end SLA. Ten seconds matches the existing default connection
checkout budget; it is a bounded admission choice, not a claim that every task push finishes within
it. Keep other statement/idle settings unchanged. No new environment variable or performance benchmark prerequisite is introduced.

A 55P03 during acquisition is a retryable operation failure to the caller/sweep, but gets no immediate
internal whole-operation retry that would double contention. Standalone reconcile returns `ok:false`
with a named lock-timeout reason; backfill retains last-good cursor so the next pass retries the item.
Ingest throws under its existing failure contract; a later source push can retry. Long legitimate
holders can cause these bounded transient failures. One in-flight transaction consumes one pooled
connection, including while waiting; default pool max is 10 and checkout timeout 10s, so bursts can
still saturate it. Report observed test hold/wait durations; no fairness/unlimited-load promise.

New ingest context failures, including settled gate refusal and exhausted retries/lock timeout,
use the route's existing HTTP **500 `internal`** mapping with a nonempty diagnostic reason. They are
server/configuration/coordination failures, not new invalid-payload 422 or forbidden-tier 403 cases.
Keep wire envelope and the existing validation/tier mappings unchanged. No new API status contract.

## 5. Existing policy outcomes, including human overrides

Keep EXCLSHADOW-1 and CLOSEMODE-1 in `lib/projects/context/memberships.ts`, including the gate, its preflight,
direction-aware order, protected-row predicate, and measured close counts. Extend the internal
result with a machine-readable protected-exclusion reason rather than matching error strings.
A typed terminal refusal is committed deliberately with its existing directional outcome and
is returned as the same public `ok:false` membership refusal. Ingest retains its current behavior
of accepting the item update while reporting/logging that standing context refusal. It must not
label the move converged. The explicit result is needed so database failure cannot masquerade as
this exception. Do not commit a transaction with an executor SQL failure under this exception.

| Situation | Committed item/context outcome |
|---|---|
| Ordinary external→team or team→external | Item access and mirror agree; target include current; opposite include closed |
| Auto exclude in target system project | Close auto exclude and open `exclude_shadow_repair` include atomically; retry sees one include |
| Non-auto exclusion in opposite system project | Preserve exclusion, report spared, create valid target include |
| Non-auto target exclusion on team→external | Commit external access/mirror, retain General include, preserve external exclusion; public reconcile refusal; external-only viewer cannot see item |
| Non-auto target exclusion on external→team | Commit team access/mirror, close external include first, preserve General exclusion; no system include; public refusal and existing unrepairable classification |
| Exclusion in an initiative | Never auto-repair or close it as a system move |
| Include of any mode in opposite system project | Close it under existing CLOSEMODE-1 ruling; new force-include semantics remain Phase D |
| Settled `noWideningGate` refusal (e.g. General granted externally) | Roll back attempted item/cascade/context change; ingest throws named context gate refusal; reconcile returns `ok:false` with refusal distinguishable from read error. Old access, body, inherited task/fact/mention audiences and social-chain access remain, including pre-existing external derived visibility/publishability, until a later push succeeds; narrowing is not claimed |
| Undetermined gate read | Roll back/fail; no `refused:true` semantic result |
| Missing item/unit after locked revalidation | Ingest fails/rolls back; standalone context returns documented deletion skip only when disappearance is established, otherwise missing/stale failure, never placement success |
| Optional audit-only failure recovered by §3b | Continue valid item/context transaction; keep best-effort audit contract |
| Actual DB error outside optional audit scope during any move | Roll back all transaction writes; report failure; retry from current stored state |

The human-exclusion terminal states above are already specified/tested:
`test/datamechanics/closemode-flip.datamechanics.test.ts` AC1(a) and its directional cases keep changed
access on refused return (the graph case separately plants that state; it is not independent proof), and AUDITFIX-4's shipped narrowing comment
accepts permanent neither-project denial when the target is explicitly excluded. This is a
preservation of those states, not a new product ruling. The atomic rollback of **DB failures**
is the intentional behavior change from AUDITFIX-4's half-write repair: an ingest failure leaves
the previously committed access/placement together and does not claim narrowing completed.
A settled gate refusal is intentionally NOT the human-exclusion exception: preserving the
old best-effort commit here would accept a new team access while an external include survives. The
ruling preserves human vetoes, not successful narrowing under invalid destination grants. The new
explicit ingest failure is deliberate and tested for both body paths, even before Lane C lands.
This retains not only the old item visibility but also pre-existing external derived/social exposure,
where those surfaces filter their own audience/access rather than General membership. The failed
source push is reported through existing errors/logs (HTTP500 on that caller); an otherwise-converged
old item is not made a backfill candidate solely by an upstream update that was rejected. A subsequent
successful push is required after the bad destination configuration is corrected. No automatic repair
or health detector for that refused source transition is introduced in Lane A.
A standalone backfill repairing pre-existing inconsistent data can fail and leave that old
inconsistency; no claim is made that a failed repair retroactively fixes it.

There is no shipped manual curation writer outside these single writer modules in the inspected
production call graph. Future manual APIs must join the item protocol. Still preserve the existing
predicate-reassertion defense against a raw concurrent human override, and add equivalent
conditional protection to auto-exclude repair (mode/decision rechecked in UPDATE/RETURNING).
If an excluded row changed into a protected exclusion before our update, do not replace it with
an include. Resolve a zero-row conditional auto-exclude close with one authoritative same-transaction
reread before deciding the outcome: a current non-auto exclusion produces the typed protected-target
refusal and commits §5's directional standing state; a current include is already converged and
continues; no current row permits one ordinary insert through the owner. An unexplained remaining
auto row or repeated predicate conflict raises `membership-state-changed` and rolls back/restarts
the WHOLE operation once, under the shared maximum-two-attempt budget. A current-key unique SQL
conflict aborts PostgreSQL, so do not reread in that poisoned attempt; restart under that same budget.
Second unexplained/conflicting state returns explicit failure without partial writes. Existing
opposite-project close reread still reports protected rows as `spared`, or fails if a closable row
remains; it must not be conflated with the target auto-exclude-repair outcome. Tests may
use direct SQL to simulate human curation, but that is not license for a new production writer.

## Scope

### Bounded ownership and implementation scope

Primary owners: `lib/db/pg/query-builder.ts`, `lib/db/pg/client.ts`, `lib/db/pg/tx.ts`, optional
new executor type/helper in `lib/db/pg/`; `lib/ingest/index.ts`, `lib/ingest/reclassify.ts`;
`lib/projects/context/units.ts`, `lib/projects/context/memberships.ts`, `lib/projects/context/reconcile-item.ts`, and one new shared
transaction/locking helper under `lib/projects/context/`. `lib/db/types.ts` may gain a narrow
capability type without broadening generic consumer contracts. Update relevant transaction,
single-writer and architecture docs, this spec, and existing/new targeted tests.

Required tests: NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`,
executor tests, existing closemode/exclude-shadow/membership-close/reclassification suites;
`test/guards/access-single-writer.test.ts` must detect raw TypeScript SQL DML against both context
tables outside their owners, with negative fixtures for static, indented and tagged-template SQL.
This is required by the existing raw mirror, not a general parser project. Connection enlistment is
separately mandatory via runtime executor/pool-query traces and a narrow protocol wiring assertion;
no reverse caller-closure framework is added. Run existing `context-hook-callsites` and
`dynamic-table-writes` guards; preserve classifications because creation triggers remain unchanged.
A narrowly justified read-only exemption/shared-core assertion adjustment is allowed if the actual
split requires it, not as a blanket weakening.

Directly affected maintenance includes `lib/api/audit.ts`, `lib/ingest/reassignment-log.ts` (§3b),
`lib/social/store.ts` comments describing both autocommit and bound usage, and
`test/datamechanics/social-tier-cascade.datamechanics.test.ts`. Add new atomic-ingest assertions while
retaining that suite's standalone helper audit-survives-partial-write assertion. Update the existing
`ingest-atomicity` first-failure expectation deliberately: failed first ingest now leaves NO item,
version or task, and retry creates/materializes successfully. Existing test invariants otherwise
remain; proxy instrumentation may migrate as specified in §3a. The protocol proxy migration list is
exactly `test/datamechanics/membership-move-soundness.datamechanics.test.ts`,
`test/datamechanics/ingest-atomicity.datamechanics.test.ts`, and
`test/datamechanics/exclude-shadow-repair.datamechanics.test.ts`; unrelated proxy suites need no rewrite.

Also maintain `test/datamechanics/context-reconcile-item.datamechanics.test.ts`: replace its direct
`items.access` UPDATE + settleReclassification fixture with real `ingestItem` reclassification through
the new owner, retaining its assertion that a NON-HTTP caller re-partitions the item. Do not delete
that coverage or preserve the retired settlement-owned reconciliation merely to satisfy its setup.

Maintenance also includes `lib/ingest/fake-supabase.ts`, `lib/ingest/ingest.test.ts`,
`lib/actions/actions.test.ts` and `test/context-backfill-cursor.test.ts` for the explicit fake
transaction capability/fixtures above; no production `lib/actions` handler changes.

`app/api/v1/items/route.ts` and `lib/meetings/notes.ts` may receive comment-only clarification:
initial context hooks retain their behavior; existing-item reclassification is now transaction-owned.
`lib/meetings/merge.ts` ordering remains correct and unchanged. Existing inventory reasons may receive only the
same first-create versus reclassification qualifier; no caller count/class/admission changes.

Enlistment test coverage must name the invoked DB closure: `ingest/index`, tasks/decisions/evidence
materializers, forget-bodies, reassignment-log, `reclassify` cascade, social store plus its approvals,
media, publications and analytics narrowing owners, audit, and context writers. These owners already
accept the passed db; coverage does not authorize changing their policies. Hidden executor escapes
must be fixed narrowly with a reviewed scope amendment.

No Lane B ingestion-trigger inventory/call-graph guard, connector admission limits, or Lane C
bootstrap/group grants/drain counters/health scheduling. No `lib/projects/context/backfill-candidates.ts` predicate
change, no read-filter removal, no classifier/curation capability, and no SQL schema migration.
Changes to other owners beyond the narrowly enumerated maintenance above require an explicit reviewed scope amendment. In particular, finding a
hidden executor escape is evidence to resolve, not permission to modify unrelated policies.

## Acceptance criteria

### Evidence plan

Every concurrency test uses at least two dedicated real-Postgres connections, explicit barriers
and bounded deadlines; no sleep-only scheduling and no FakeSupabase authorization proof. Read
committed results from a third connection and assert oracle visibility using positive-control
principals who could read before the tested restriction. Test locks via observed blocked work,
then release and assert final outcomes. Test hooks must run the actual exported production path.

- **A13-01** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Pause a real reconcile after locked authority read; start both unchanged-body and changed-body ingest narrowing cases. Ingest waits; after release its committed access/unit/system include set is team/General only, and external-only oracle visibility is false. Reverse acquisition order too.

- **A13-02** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Two opposite access pushes to the same item and a backfill reconcile: final item access, mirror audience and placement equal the last successful serialized push. Exercise exact matching real hash/timestamp no-drift branch and initially missing unit; no fixture forces drift.

- **A13-03** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Untrusted external pusher starts before a trusted narrowing but obtains lock after it. Different-body push is rejected and stored team body/access survive; identical-body push stays unchanged/team without restoring external access.

- **A13-04** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Two first ingests of the same path: one item, clamped access and no partial version/materialization writes; the ordinary loser waits and then observes the winner via the existing-item path. A deliberately injected timeout/rollback conflict may instead give the separately specified bounded failure/retry. Initial unit creation remains the existing hook/backfill responsibility. Different item operations can progress concurrently. Task-kind pushes on DIFFERENT paths in the SAME project with the SAME incoming row-key set in opposite task-row order exercise real 40P01, whole-attempt retry and bounded second failure without partial task/PM-link commits.

- **A13-05** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Inject non-audit actual SQL failures into item write, unit read/mirror/insert, target lookup, gate read, close read/update/reread and include insertion. Ordinary ingest aborts with pre-attempt rows/access preserved; reconcile returns nonempty failure, not throw/success. New-item materialization failure leaves no item/version/task; context creation is not newly triggered on first insert. Include returned-error injection, not only thrown errors.

- **A13-06** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Force a non-policy callback `ok:false` after a successful mutation: rollback occurs. Force an executor error swallowed by a helper into `ok:true`: success is rejected and rows roll back. Acquiring connection, lock timeout and COMMIT failure release clients; unknown COMMIT outcome is not replayed. Hold a real item/identity lock to verify the explicit 10s acquisition timeout fails and disposes of its client, while the prior lock_timeout setting is restored before ordinary DML; unsupported DbClient fails with transaction-capability-required; a delegating capable wrapper retains the same transaction/fault seam. Instrument control failures to prove failed BEGIN/COMMIT/ROLLBACK and unrecoverable savepoint controls call destroying release(cause), while healthy COMMIT/full ROLLBACK call normal release.

- **A13-07** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: From a second connection while a successful transaction is paused between close/open, only pre-commit placement is visible; after commit only complete final placement is visible. Insert failure after closing an auto exclude restores the prior exclude, never a committed half-repair.

- **A13-08** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Real `ingestItem` round trips for all policy rows in §5 pin the expected ingest success/failure, stored access, unit audience, current membership set, refusal/spared logging and external-only oracle visibility; separate exported `reconcileItemContext` calls pin its public typed refusal/spared result. Do not add refusal/spared fields to IngestResult or the HTTP wire envelope. Existing EXCLSHADOW/CLOSEMODE tests remain green, including graph-standing-state coverage. Include General externally granted: settled gate refusal on both changed/unchanged narrowing paths leaves old item and cascades unchanged with explicit failure, distinct from a project_groups read outage. Seed an external social chain and assert it remains external after refusal; early preflight must issue no cascade mutations, and writer gate checks remain authoritative. Include missing locked unit/item handling.

- **A13-09** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Manual non-auto exclude wins before automatic lock: auto run preserves it and refuses appropriately. Direct-SQL override between auto-exclude probe and conditional close also survives; no auto include replaces it. For both access directions assert stored access, mirror audience, both system membership sets and typed refusal match §5, and attempt count is one when the reread resolves a protected row. Repeated unexplained state/current-key collision consumes at most two attempts and ends in explicit failure with no partial writes. Existing replacement-row and protected-close race tests still verify measured `closed`/`spared`.

- **A13-10** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Transaction executor covers builder select/count/head/mutation/RETURNING/RPC and raw mirror. Rollback an inserted sentinel and all helper writes; a separate connection never observes it. Trace pool query/connect versus the dedicated session while bound helpers run to prove no hidden pool escape. Default client behavior remains unchanged.

- **A13-11** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Standalone public membership/unit/reconcile entry points obey the lock without nested-client deadlock. Delete cascade while waiting produces explicit missing/skip behavior, never phantom placement. Stale supplied system IDs cannot place into another team, wrong kind or wrong slug.

- **A13-12** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Persistent failure leaves backfill cursor at last-good item and reports failure; later retry converges. Missing bootstrap still skips with candidate eligible later; topology read error is not skipped. No drain-counter behavior change.

- **A13-13** — data-mechanics; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts`: Existing reclassification propagation proves inherited task/fact/stakeholder audiences, narrowing social behavior, access-healed audit and post-commit cache invalidation remain correct on changed and unchanged paths. Faulted transaction emits no success audit or post-commit invalidation. Actual item/social audit INSERT and ownerWindowStart SELECT failure alone is recovered by the optional savepoint scope and ingest still commits; repeated audit-local SQLSTATE 40P01/40001 is still optional when rollback-to/release succeeds and must not cause an ingest retry; savepoint recovery failure or non-audit SQL failure aborts. Direct social helper still retains its pre-write audit on later autocommit failure; ingest-bound cascade failure rolls back chain and its audit, and retry records the healthy transition. After confirmed COMMIT, returned/thrown teamSlug lookup and postcommit helper faults must retain committed rows and successful ingest result on both body paths, emit a diagnostic, and show exactly one transaction attempt/no replay. Existing HTTP/action success mapping follows that returned success; do not assert guaranteed effect delivery or retry of missed effects.

- **A13-14** — data-mechanics + unit/guards; NEW file to create: `test/datamechanics/item-context-serialization.datamechanics.test.ts` / `test/guards/access-single-writer.test.ts`: Mutation checks: bypass ingest lock/re-read reddens A13-01/03; pool-bind mirror reddens A13-10; remove rollback-on-returned-error reddens A13-05/06; ignore repair mode predicate reddens A13-09; remove ingest's inline context move reddens A13-01/07. Each is a demonstrated failing outcome, not a source-text assertion alone. Each migrated injection must demonstrably fire and change the expected outcome versus healthy execution. Raw-DML single-writer guard negative controls reject unauthorized static/indented/tagged-template writes.

Run targeted unit/guards, TypeScript/lint and docs drift checks, then isolated real PostgreSQL
`npm run test:datamechanics:iso` for new and affected suites. Do not use shared or production
DBs. Record baseline red, fixed green and mutation failures with commands and relevant outputs
in the PR/evidence notes. A missing DB runtime is **NOT RUN**, not green. No external model call
is introduced; no product LLM cost/latency eval is needed. Concurrency outcomes and bounded
rollback/wait behavior are the runtime eval for this slice.

## 8. Rollout, migration and rollback

No schema/data migration and no new environment variables. Keep existing indexes and history.
Update the architecture source-of-truth rows to describe row-lock coordination, bound executor,
atomic transitions, policy refusal exceptions and post-commit effects in the same PR.

Mixed old/new processes do not satisfy the protocol: old ingest bypasses the item-context atomic
boundary. For staging verification, wait until all active writer processes run the new artifact
and old in-flight work drains before claiming the invariant. Thereafter run the existing candidate
backfill through its supported entry point to reconcile pre-existing drift; do not bulk-delete
memberships or invent health-monitor automation here. Existing explicit exclusions remain operator
attention, not auto-repair work. Preserve `noWideningGate` until separately reviewed TIERRET-1.

Rollback is a code revert through a PR targeting staging; no destructive schema rollback is
needed. It restores the known concurrency gap, so TIERRET-1 cannot proceed on a reverted Lane A.
No production deploy, merge, Railway mutation, or database operation is authorized by this spec.

## 9. Falsifiers, risks and completion gates

Reject the implementation if any SQL escapes to the pool inside the claimed transaction, any
current source access read happens before lock yet governs a later write, a swallowed non-optional
error can commit, or any protected-exclusion state changes from §5. Long transactions hold one connection
and lock per item; the risk is ingest latency under contention. Keep network/cache work outside,
use the explicit acquisition-only 10s lock timeout plus existing database timeout limits, and report actual targeted concurrency test durations.
Do not replace bounded failure with an unbounded retry loop. A lock timeout is not a permanent
non-retryable task state: the existing caller/sweep retry contract remains live.

Rejected alternatives: reconciler-only advisory lock; per-unit CAS; retyping membership SQL;
transaction around only the UPDATE with later best-effort move; broad serializable isolation
without enlisted executor; rolling back every domain refusal (breaks CLOSEMODE standing state).

No open product-policy choices are delegated to the implementer. §4 fixes retry once for the named
whole-transaction conflicts and no retry for lock timeouts/unknown commit outcomes.
Reviewer disagreement about terminal-refusal atomic semantics or a discovered required file
outside Lane A blocks SPEC_READY until adjudicated and this spec is amended.

Required execution order: canonical ticket/readback → this spec → Fable 5.1 spec review and
independent Codex spec review → adjudicate/amend → actual `aios spec eval` SPEC_READY → spec-first
red tests → **Sol high via Codex CLI** implementation (Opus 5 CLI fallback only on Sol usage
limit) → Fable 5.1 code review → fold → fresh Astra high independent code review → fold/verify →
review attestation and PR targeting staging. Never claim a review or eval ran without its result.
Merging requires the user's merge word and is not part of this authoring task.
