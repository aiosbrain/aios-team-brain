```yaml
eval_tier: full
spec_gate: block
safety: true
type: issue-spec
```

# Durable governed action foundation

## What / why

Implement AIO-1186 under AIO-1108. Linear issue revision 2026-09-28T01:49:53.667Z
is the requirements authority. Pin Workspace contract commit
`606afeaed5a9612a7231a96f15a8b893f22ea9a4`, supplement `mcp-next/1`,
and Brain baseline `548d6b62a4f65f7ef1ffb4fa938c89bbc8344e1d`.
Legacy `lib/actions/index.ts` records and executes separately, has no operation
identity, and reconstructs a principal during approval. It cannot guarantee a
single committed effect. Reuse policy semantics and the human approval channel,
not the legacy generic handler registry.

## Outcomes

- Authenticated requests have durable identities, truthful status, strict audit
  references, and recoverable transaction outcomes.
- Concurrent submissions and human decisions cannot commit duplicate effects.
- Revocation, changed policy, destination membership and capability disablement
  are rechecked before execution; status never grants approval.

## Scope

In: foundational member submit/status routes, closed validation, durable records,
transaction-only handler interface, existing human approval integration, migration
and failure tests. New capabilities remain disabled by default.

Deferred: note/task/decision domain handlers (AIO-1115/1187/1188), task reconciliation,
CLI/MCP clients, remote writes, arbitrary execution, provider delivery and public
enablement. The production handler registry starts empty. Enabling the foundation
alone must never advertise or execute an unimplemented domain capability.

## Dependencies

Depends on: AIO-1185, merged in both repositories at the commits pinned above.
Consumers AIO-1115, AIO-1187, AIO-1188 and AIO-1193 remain separate work items.

## Interface / integration points

- `lib/actions/`: add a separate governed service; preserve legacy wire contracts.
- `lib/policy/evaluate.ts`: reuse default-deny and priority semantics with live,
  transaction-bound reads. API policy role remains member; domain roles are separately
  revalidated by consumers and cannot be elevated by a policy allow.
- `lib/api/auth.ts`: member-key authentication; delegated read credentials remain
  rejected. Current external posture cannot perform the new actions.
  Add an error-preserving opt-in for these routes: invalid credentials stay401;
  key lookup, team lookup and posture database failures throw a typed unavailable
  error mapped to retryable503. Existing callers retain their current defaults.
- `lib/access/oracle.ts` and `lib/access/posture.ts`: use the shared eligibility and
  membership semantics with transaction-bound reads, never a cached authorization.
  Use `visibleProjectsWithError`; a substrate failure is503, never an empty grant
  set interpreted as durable denial.
- `lib/db/pg/tx.ts`: dedicated connection for all authoritative reads/writes.
  If the compatibility query builder is used, add an explicit executor binding so
  its reads cannot escape to the global pool. Existing default behavior stays intact.
- `app/t/[team]/admin/approvals/actions.ts`: route new approval records to a scoped
  resolver. The legacy resolver must not decide governed approvals by accident.
- `postgres/schema.sql`: additive durable tables with restrictive retention links;
  existing approval queue and append-only audit store remain canonical.
- `test/fixtures/mcp-next-v1/`: verify runtime validation and responses against the
  pinned contract; do not reinterpret its wire shape.

## Implementation approach

### Validation and live authority

Serve `POST /api/v1/actions/submit` and `GET /api/v1/actions/[action_id]` using
the exact pinned schema. Reject unknown keys, unknown actions, invalid scalar
Unicode and impossible dates, bounded request bodies and invalid UTF-8. No caller
actor/team/resource/access/credential fields. Resolve destination inside the
authenticated team and verify live project access; task updates also resolve their
task in that destination before deriving the policy resource. Missing and
inaccessible entities return the same safe404. Never expose raw database errors.

Persist original member and credential ID plus credential fingerprint (never the
secret). At acceptance, replay, execution and status, authenticate the current
key/member/team and live membership. New execution and delayed execution also require
the original credential still valid and unchanged. A terminal replay/status may use
another valid key belonging to the initiating member after credential rotation;
rotation does not erase readable history. Status requires the initiating member
and live project access; it remains available with capability disabled. Capability advertisements list only
registered, enabled consumers; this increment advertises no domain actions.

### Durable identity and transaction claims

Use a governed action table separate from legacy actions; unique identity is
`(team, member, destination project, operation key)` across action types. Store
canonical request bytes/hash and original credential identity. Task/decision keys
come from the operation ID. Notes use the specified canonical content hash and an
identity/attempt relationship: successful and unresolved attempts are reused;
only denied/failed attempts with no committed effect permit a new attempt.
Retain terminal history and identity tombstones; no retention deletion is added.

Acceptance is a short transaction creating requested action and required audit
reference together. Replay reauthorizes before comparing or returning records.
Changed canonical input conflicts without mutating the original result.

Execution obtains a database transaction-scoped exclusive claim on the action;
an already-held claim returns202 requested/running without blocking indefinitely.
The claim remains held through live authorization, policy evaluation, consumer
mutation, outbox/audit writes, result validation and commit. A crash rolls back
that transaction, leaving the durable request recoverable; an old connection
cannot settle after its transaction has lost the claim. Re-entry after committed
success returns the stored result. No lease-time guess permits a second executor.

Consumer callbacks receive only the transaction-bound DB context and resolved
principal/destination, and must perform database effects only. Provider work is
enqueued transactionally, never sent inline. A typed domain conflict or failure
rolls back all callback writes before recording a terminal non-success result;
use a savepoint established after acquiring the claim, retain the same claim and
transaction through failure settlement, and never settle in a second unguarded
transaction. Lock ordering is identity then action then approval then authority
rows, consistent across submit and human decision; bound waits to avoid a
request hanging indefinitely. Infrastructure failure rolls back the entire
execution transaction and leaves the accepted requested record recoverable.
unexpected database/audit/outbox failure leaves the request retryable and returns
safe503 unavailable. The stored outcome is validated before commit. Sync state is
separate; queued provider work never means synchronized.

### Human approval

Create the existing approval queue row and pending action/audit atomically.
Approval decision checks team, active human decider and current permitted role,
locks the action/approval in a consistent order, and admits one decision only.
No API/MCP self-approval route is added. Scope checks occur inside the service,
not just the dashboard wrapper. Recheck original principal/credential/project and
policy immediately before executing: deny cancels; unchanged require-approval is
satisfied only by its matching recorded human decision; a materially changed
policy must not reuse an old approval. Concurrent approve/deny cannot overwrite
the winner. Capability-off prevents approval execution while retaining history.

Persist an authorization fingerprint with pending approval: SHA-256 over canonical
JSON of the live policy principal (role/member posture/actor), action, derived
resource and the full enabled team policy set sorted by ID (all evaluator fields,
including rule ID, priority, subjects, action/resource patterns and effect).
Recompute it before applying human approval. An in-place edit, new/replacement
winner or changed principal yields durable denied `revoked_authorization`, no
consumer effect, and an audit of the stale approval. The human decision remains
recorded, but is not execution authority. Replays retain that terminal denial;
task/decision recovery requires a new operation ID. Notes may make a fresh attempt
only under the pinned no-committed-effect exception. This deliberately conservative
whole-policy-set comparison may require re-request after unrelated policy changes.

### Rollout and recovery

New tables are additive and included in canonical from-zero schema. Verify schema
replay against the previous baseline with existing rows and twice on the new
schema. Add a migration where required by the repository migration mirror check.
An explicit server setting defaults off; missing tables fail closed. Rollback
disables the capability without dropping action, approval, audit, or outbox data.
Once governed approvals exist, the rollback application must retain the governed
approval ownership guard and resolver. Older applications are safe only while all
human approval writes are stopped; their legacy resolver cannot process these rows.
If an older resolver already decided a governed approval without settling its action,
the governed resolver records a terminal authorization denial, never executes that
decision, and preserves its history. A fresh operation requires fresh authorization.
The human queue shows the validated proposed values behind a current team-admin
check; unavailable proposals cannot be approved through the UI.
Interrupted database execution resumes through
the same operation identity; future provider consumers own delivery receipts.

## Acceptance criteria

### Automated

- Unit tests in `test/` validate the pinned request/response schema, semantic
  Unicode/date boundaries, canonical identity, unknown/forged fields and safe errors.
- Real PostgreSQL tests in `test/datamechanics/` assert one stored fixture domain
  mutation, stable result and required audit for sequential/concurrent submissions,
  same-ID changed data/type conflicts, and response loss after commit.
- Real PostgreSQL tests in `test/datamechanics/` assert zero committed callback
  effects after domain conflict, audit/outbox failure and interrupted execution;
  reconstruct the service and retry to prove recovery and claim fencing.
- Real PostgreSQL tests in `test/datamechanics/` cover human approval, duplicate and
  racing decisions, wrong-team deciders, self-approval prevention at machine routes,
  credential/member/project revocation, changed policy, capability disablement and
  owner-only status with uniform inaccessible404 responses.
  Include same-ID/same-effect policy edits, replacement winners, stable denied
  replays/new-operation recovery, key-rotation history and contention during failure
  settlement under the retained claim.
- Real HTTP tests in `test/http/` exercise real bearer authentication, bounded
  transport validation, disabled/unimplemented capability behavior and legacy reads.
  Inject disposable database faults for key lookup and posture/oracle reads; assert
  retryable503 rather than401/denied, no durable denial, and same-operation recovery.
  A test-only harness may compose a fixture consumer with the production service
  for enabled mutation and approval scenarios; no test action ships in the registry.
- Migration tests in `test/datamechanics/` preserve baseline rows and verify replay,
  identity uniqueness, retained history and audit rollback with real PostgreSQL.
- Existing executable CI, docs drift, security/confidentiality and API compatibility
  guards remain enabled and pass; add the tests to their actual CI tiers.

### Manual

- Disposable local staging harness: sign in through the real human approval channel,
  inspect a pending fixture request, approve, and read stored mutation/action/audit.
  Record exact commands/artifacts and clearly identify the test-only consumer.
- Disable the capability after acceptance: new/resumed execution stops, authenticated
  history remains readable, and committed fixture data remains intact.

## Tier safety

No privileged synthetic principal, generic legacy handler fallback, delegated-token
writes, hidden domain enablement or best-effort authoritative audit. Content stays in
the private durable request, not public logs or audit metadata. Project visibility
errors fail closed; database failures must not be mistaken for genuine denial.

## Build-with

Approved program routing: implementation and a separate independent
specification/diff review. Private provenance register uses neutral public review
IDs. Review before push, required executable CI, exact-head MERGE_READY, normal
protected merge and verified Linear closeout. This spec supplements interface
details; Linear remains the operational requirements authority.
