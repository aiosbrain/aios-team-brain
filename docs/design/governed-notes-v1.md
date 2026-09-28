```yaml
eval_tier: full
spec_gate: block
safety: true
type: issue-spec
```

# Governed append-only notes

## What / why

Implement AIO-1115 under AIO-1108 through the existing governed action service.
The issue revision `2026-09-28T10:48:17.448Z` and parent revision
`2026-09-28T10:55:28.490Z` are the requirements authority. Pin Brain baseline
`5349496835cafa74be66e0591cf82452705044cf` and Workspace contract baseline
`606afeaed5a9612a7231a96f15a8b893f22ea9a4`. The independently reviewed specification
has SHA-256 `b992782b7354c386b8188fa58d3f91504b8b1103144d2129df3da6ba35569c6a`;
its shared persistence proposal has SHA-256
`974155cd65cbb3367ca25a5de5b31d0205ff7ff9e3dda2c387ab3b4f174f8be9`.
These hashes identify private evidence, not a second requirements register.

## Outcomes

- An authorized member submits title/body and receives durable note, revision,
  action and audit identity. The server supplies attribution and destination.
- Identical accepted content from the same member/team/project collapses across
  dates and retries. Edited title/body or another member/destination creates a note.
- Notes remain visible only through the authorized destination, including after
  context maintenance and graph projection. Team labels never grant project access.
- Existing item retrieval, evidence/query, dashboard and workspace pull retain
  exact content and recognize note provenance.

## Scope

In: note consumer, note-specific read rendering and spec-derived unit, real
Postgres and HTTP tests. Shared ingest, origin schema, context/graph isolation,
registry, contracts, migration and CI integration are coordinator-owned.

Deferred: final CLI/MCP operation projection and grants (AIO-1193), installed host
acceptance (AIO-1195), publication/enablement, updates/deletes, promotion, remote
writes, caller-selected access or attribution. No generic legacy action fallback.

## Dependencies

Depends on: completed AIO-1185 contracts and AIO-1186 durable action foundation.
Before dependent code ships, land the shared contract clarification for U+0000,
note read representation and legacy immutable-origin error, then its exact mirrors.
The shared helper/schema/context changes must be integrated before persistence
acceptance can pass. An isolated test database is required; no shared or production
database may be used for these fixtures.

## Interface / integration points

- New file: `lib/actions/governed/consumers/note.ts`: exports `noteConsumer` implementing the
  existing `GovernedConsumer` interface for `note.append`.
- New file: `lib/ingest/governed-item.ts`: shared owner exports
  `appendGovernedItem(ctx, {kind: 'note', title, body, identityKey})`, returning
  `{itemId, revision}`. Note entity ID is the generated item ID; no entityId input.
- `lib/actions/governed/contract.ts`: existing strict request parser and canonical
  `operationKey` are authoritative; no competing identity/normalization algorithm.
- `governed_item_origins`: shared durable provenance maps item to authenticated
  member/team/project/kind/entity/identity and stores the UUID revision once.
  Unique `(team, member, project, kind, identity_key)` and restrictive retention
  protect retries and immutable origin independently of caller frontmatter/path.
- `lib/projects/context/units.ts`, `lib/projects/context/memberships.ts`, `lib/projects/context/reconcile-item.ts` and graph
  projection: shared owner maintains destination-only placement with noWideningGate.
- `app/t/[team]/library/[itemId]/page.tsx`: display exact stored title/body using
  existing components after existing tier and item-membership authorization.
- Workspace new file: `scripts/pull-notes.mjs`: pure note rendering helper, coordinated in a
  separate workspace worktree; coordinator owns cmdPull integration and kind filter.

## Implementation approach

### Validation, identity and result

Params are strictly title/body. Reject unknown authority fields and operation IDs.
Title is nonblank, at most 200 Unicode code points; body is nonblank, at most
25,000 code points. Preserve accepted strings exactly, including whitespace, CRLF
and normalization form. Invalid UTF-8/unpaired surrogates and U+0000 in governed
textual inputs return422 invalid_payload before durable acceptance. The coordinator
lands that NUL contract clarification and canonical vectors/mirrors first; never
normalize, remove or replace content to fit storage.

Use the existing operationKey: SHA-256 of UTF-8 canonical JSON
`["note/1", member_id, team_id, project_id, title, body]`. No date, credential ID,
actor display name or transport enters identity. Pass authenticated context and
exact title/body plus this key to the shared helper. Return
`entity: {kind: 'note', id: itemId, revision}` and
`sync: {state: 'not_applicable', providers: []}`. Revision is the helper's stable
opaque UUID, never a timestamp or freshly generated on replay.

### Atomic persistence, visibility and immutability

Shared helper uses only transaction-bound ctx.db/query and an existing initialized
destination. It creates one item, version, origin and destination context, with
team access and exact body/frontmatter.title. No global pool, authority-table
upsert, network call or detached effect. Foundation commits these effects with
the governed action/result and strict audit. Errors roll back all domain effects.

Only authenticated destination receives include membership. No General fallback.
Reject an incompatible externally visible destination through noWideningGate.
Origin-aware reconciliation/backfill must never move the note into General;
initial and later graph projection use the destination's existing partition.
Existing unprotected item behavior is retained. Derived title search text may
combine title/body but must never rewrite accepted stored fields.

Persisted origin is the protection authority. Legacy ingress preflights the
affected item/batch before effects: changes, reclassification, source attachment
or deletion return409 immutable_origin with the approved recovery message.
Exact authorized semantic read-only mirrors are no-ops. Fresh reserved paths
cannot be squatted through another kind or legacy note.create. No caller marker
can create, remove or bypass protection. Rollback preserves origins and note data.

Existing foundation checks live authorization on replay/status and before execution,
including delayed approvals. Pending/denied/failed are not success. An unresolved
attempt resumes; denied/failed attempts proven effect-free may retry under fresh
authorization; successful content always returns original note/action/revision/audit.

## Acceptance criteria

### Automated

- Unit tests assert nonblank and Unicode boundaries (200/201 title, 25,000/25,001
  body), invalid scalar/NUL rejection, exact whitespace/newline preservation and
  safe note title display. Spec-derived boundary tests must fail on the baseline.
- Real Postgres tests execute the actual consumer/shared helper, inspect one
  item/version/origin/action success across sequential, concurrent, restarted and
  midnight retries, and inspect distinct entities for changed actor/destination/text.
- Pending approval has zero notes; human approval/duplicate/racing decisions yield
  one effect. Policy change, key/member/project revocation and external/delegated
  credentials cannot execute or disclose a prior result. Valid credential rotation
  for the same member preserves authorized history.
- Inject version/origin/context/audit faults, deadline/connection failure and
  timeout after committed HTTP response loss. No partial domain rows survive;
  same-content retry recovers one stable result. Foundation claim/fencing tests
  remain authoritative and must assert actual note effects after integration.
- Legacy changed mirrors/forged provenance/reserved-path squatting return the
  specified error without mutation; exact authorized echoes are no-ops. An affected
  batch cannot partly commit before immutable-origin rejection.
- Production HTTP tests use real Next start, bearer authentication and disposable
  Postgres. Exercise strict inputs, successful stored note, authorized item read,
  denial/revocation, concurrency and stable retry IDs with actual consumer enabled.
  Separate default-disabled checks preserve status/history while blocking new work.
- Item/list/evidence/query/dashboard display exact note kind/title/body. Title-only
  and body-only search terms retrieve it for an entitled member. A General-only
  member lacking destination access sees no note before or after maintenance.
- Graph tests cover initial projection with no General include and later sweeps;
  unauthorized/General-only groups never receive a note episode. Repeat submissions
  do not cause repeat extraction; maximum content remains bounded without lost tail.
- Existing CLI pull retains exact note body and safely encoded title/kind/item ID,
  skips unknown future kinds without blocking pagination, retains existing kinds,
  path safety and task/decision writeback. Re-push cannot mutate the protected source.
- Shared from-zero/populated migration replay, unit/data-mechanics/HTTP/graph tiers,
  lint/typecheck/build, contract mirrors, architecture drift, secret/NDA/provenance
  gates and independent exact-head review pass. Record dependency-blocked tests
  honestly; mocked storage is never database acceptance.

### Manual

- Disposable staging HTTP creation, real human approval when required, SQL/action/
  audit inspection, API/query/dashboard retrieval and existing CLI pull prove a
  durable note. Repeat later, revoke/retry and disable/re-enable with history intact.
- Assess extraction chunks/calls/cost for short/max notes and retry storms before
  broad activation. Existing budgets apply; no new telemetry program.
- Final release still requires installed Claude Desktop creation followed by later
  CLI retrieval; AIO-1193/AIO-1195 own this later host proof. This domain slice does
  not claim publication, global enablement or release completeness.

## Tier safety

Authenticated member/team and validated destination are the only authority.
Delegated reads never acquire writes; no privileged synthetic principal. Project
membership is checked at execution/read time, including successful duplicate
disclosure. General access alone cannot read destination-restricted notes. Full
title/body and credential material do not enter public audit/log metadata.

## Rollout and recovery

Keep capability disabled by default until shared integration and acceptance pass.
Disablement blocks new/resumed effects while authorized status and history remain.
Never delete note/origin/action/audit data to roll back. Retain governed approval
ownership/resolver or stop human approval writes before using older application
code. Existing persisted graph backlog remains recoverable separately from note
success. Root coordinates registry, migrations, CI, merge and deployment.

## Build-with

The approved lane owns note consumer, read formatting and named tests only.
Separate independent specification and exact-head implementation review are
required, with private substantive evidence and neutral public references.
No changes to shared ingest/schema/context/graph/registry/CI without coordinator
allocation. No push, PR, tracker mutation, release or production enablement in
this bounded implementation assignment.
