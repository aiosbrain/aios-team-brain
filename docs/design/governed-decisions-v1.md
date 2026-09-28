---
access: team
---

# Governed decision recording v1

Authority: AIO-1187 revision 2026-09-28T10:47:50.564Z and AIO-1108 revision 2026-09-28T10:55:28.490Z; accepted AIO-1185/AIO-1186 contracts. Brain baseline 5349496835cafa74be66e0591cf82452705044cf; Workspace baseline 606afeaed5a9612a7231a96f15a8b893f22ea9a4. The canonical contract is the Workspace repository's docs/contract/mcp-next-v1 supplement (document revision 1.30). Independent specification readiness is retained through neutral evidence reference NW-DEC-SPEC-01. Runtime acceptance remains required.

## What and why

Record one durable attributable project decision through the governed lifecycle, with later query/display/graph and workspace pull compatibility.

## Scope

Implement only `decision.record` through `lib/actions/governed`, exposed by existing `POST /api/v1/actions/submit` and owner-authorized `GET /api/v1/actions/{action_id}`. The historical AIO-1187 reference to legacy `lib/actions/index.ts`/`lib/actions/handlers.ts` is superseded as an implementation seam by AIO-1186's current revision. Do not call session-authenticated dashboard actions from the external route. Root owns registry/auth and shared contract files.

Canonical `mcp-next/1` currently requires destination.project_id and params `{ operation_id, title, rationale, impact }`; title is nonblank <=500 Unicode code points, rationale nonblank <=25,000, impact may be empty <=5,000. `impact` is already in the approved AIO-1185 contract, not a new field proposed here. AIO-1187's shorter title/rationale description must not silently remove it. Root and independent reviewer confirmed this interpretation in the coordination record on 2026-09-28; it is resolved, and no schema change is requested. No caller actor, team, access, time, row_key, decided_by, created_by, policy resource, amendments, retractions, deletion or additional fields.

Canonical README explicitly preserves admin/lead domain authorization plus visible-project requirements. Policy's synthetic member role is not the stored member role and cannot confer this privilege. Consumer re-reads the live member using the transaction-bound context and enforces active eligible admin/lead; foundation separately rechecks original key/member/project/policy before execution and after approval delay. Attributed creator is `ctx.memberId`; decided_by comes from that member's actor handle (human-readable immutable snapshot), date/time from the server, audience `team`. Do not accept dashboard-supplied attribution in governed input.

## Baseline behavior and defects to address

1. `app/actions/decisions.ts:createDecisionAction` validates title/project, authorizes current session admin/lead + `canSeeProjectRow`, inserts a `decisions` row with `uiRowKey`, `created_by`, NULL source. Extract shared authorization/persistence primitives so role/project validation does not drift; retain established dashboard interface/behavior for its existing extra fields.
2. `lib/actions/governed` persists canonical operation bytes, identity, original credential, approval, entity result and audit. Its `GovernedConsumer.execute(ctx, request)` is awaited inside a fenced transaction and savepoint. Use only `ctx.db`/`ctx.query`; never global pools, separate transactions, provider calls, fire-and-forget work or authority-table writes inside the callback. Its production registry is empty and capability off by default.
3. `decisions` UUID is durable entity identity; `(team_id,project_id,row_key)` is the workspace identity. There is no decision revision column. Return a server-created opaque immutable revision persisted in the governed result; do not derive revisions from timestamps.
4. Dashboard decisions page/table already shows rationale and stamps provenance through `created_by`. SQL/TS provenance currently treats unsourced created_by rows as team-visible hand-authored records. Merely stamping created_by onto an agent insert would invoke that broad unsourced branch and would not satisfy project-bound provenance/graph requirements.
5. `lib/query/retrieve.ts` recency and `structured-extras.ts:matchingDecisions` filter provenance before limits, but select/render title and decided_by without rationale. Matching on rationale is not retrieving it. A successful action must provide rationale in later authorized query context, including the older-than-recency-window case.
6. `lib/graph/project.ts:projectItemsToGraph` projects items of kind `decision`, not bare `decisions` rows. A bare-row implementation cannot satisfy graph acceptance. It needs one canonical source item containing the decision and genuine project membership, with asynchronous graph processing through existing projector/ledger machinery.
7. `getDecisionWriteback` admits NULL-source UI rows or rows edited after source sync. A decision with a canonical source item therefore needs an explicit governed-origin writeback inclusion rule. Keep legacy response shape and row key.
8. `materializeDecisions` currently upserts all supplied row data/source identity and diff-deletes omitted sourced rows. After pull/re-push it can rewrite attribution/content or later delete the original row. Governed immutable decisions must be protected before this materialization; existing legacy rows retain existing semantics.
9. The Workspace repository’s scripts/aios-runtime.mjs decision pull interpolates raw cells into Markdown and advances the cursor. Valid new content can contain pipes, newlines and `$` replacement sequences. Literal replacement callbacks and shared reversible table-cell encoding/decoding are required for compatible pull; do not lower server content limits to hide the bug. This is pull compatibility, not the deferred CLI/MCP action projection.
10. `ingestItem` cannot be reused unchanged in the consumer: it upserts `projects` and calls `ensureProjectGraphPointer`, while the governed authority transaction holds SHARE locks and forbids authority mutations. Context-unit update paths also contain global `runSql`; a transaction-safe create path must not accidentally take those existing-row branches.

## Implementation approach

### Shared domain + canonical projection

Add `lib/decisions/service.ts` as the common authorization/decision persistence owner and `lib/actions/governed/consumers/decision.ts` as its thin transport adapter. The service takes an explicit authenticated member/team/project context plus a caller mode; external mode has exactly the canonical fields and derives all provenance. Dashboard mode preserves its established optional metadata while reusing role/project validation and insertion mechanics. Do not loosen dashboard role access or route external traffic through session auth.

For governed mode atomically create (a) one canonical `items(kind=decision,access=team)` source containing a lossless title/rationale/impact representation, (b) one `decisions` row citing that item, (c) an item context unit and include membership to the already-authorized project through the existing single writers, and (d) internal immutable-origin identity. Use existing source/time/hash/item-version conventions and a server-owned stable reserved path based on UUID, never caller-selected path or admin promotion. Return decision UUID, opaque revision and `sync:{state:'not_applicable',providers:[]}` (no PM provider delivery). The graph is eventually projected from its existing durable item scan/ledger; do not represent that eventual graph indexing as a provider synchronized outcome. Document/inspect graph processing state separately using existing graph health/ledger surfaces.

Root must provide a transaction-safe, create-only item helper under `lib/ingest/` for an existing validated project. It must not upsert projects, create/grant groups, or run global SQL/network work. Reuse existing single writers for item context membership and no-widening checks. If the destination cannot hold team content (external-visible project), refuse safely, with no effect. Do not force-place it in General or another project as a shortcut. The helper returns source item ID and immutable opaque revision; errors abort the consumer transaction.

Internal immutable origin is the root-owned `governed_item_origins` table specified by the shared governed-item design, not a decision-specific origin column. It maps canonical item to authenticated team/member/project/kind/entity/identity, with unique `(team_id, member_id, project_id, kind, identity_key)` and restrictive retention/same-team consistency. For a decision, entity_id is its server-preallocated decision UUID and identity_key is the validated `request.params.operation_id`. The action foundation still owns uniqueness across action types and canonical-byte conflicts; the helper's per-kind uniqueness does not replace that gate. No governed context identityId extension or decision revision column is needed. `decisions.source_item_id` cites the canonical item; origin joins through item_id or entity_id establish immutability. The helper-generated UUID revision is persisted once in the origin record, copied into the governed result and replays unchanged.

### Root-owned append-item interface request

Frozen normative shared seam: the shared governed-item design (SHA-256 `974155cd65cbb3367ca25a5de5b31d0205ff7ff9e3dda2c387ab3b4f174f8be9`). This specification adopts its discriminated helper input, persisted origin revision, immutable error and codec ownership. The matching interface is:

```ts
appendGovernedItem(
  ctx: GovernedContext,
  input:
    | { kind: "decision"; title: string; body: string;
        entityId: string; identityKey: string }
    | { kind: "note"; title: string; body: string; identityKey: string },
): Promise<{ itemId: string; revision: string }>;
```

Decision entityId is its server-preallocated UUID; note entityId is the generated itemId and is not passed by the caller. Decision identityKey is validated operation_id; notes use their canonical accepted-content hash.

Decision flow: reload actual domain role through ctx.db; validate exact canonical content and destination; allocate decision UUID and existing-style row key; render canonical body; await appendGovernedItem with kind=decision and validated operation_id; insert the canonical decision using returned itemId and preallocated decision UUID; return that UUID and helper revision in ConsumerResult. All steps stay in the existing governed transaction/savepoint, so any insertion/audit failure rolls back item, context, origin and decision together. Origin's entity reference must allow this insertion order (root owns constraint design); no intermediate state commits. No domain helper accepts a raw wire attribution or path field.

The helper derives team access, member attribution, reserved path and source metadata; callers cannot pass access/team/actor/path overrides. It validates that the already-authorized project exists in ctx.teamId without writing it. It creates item + initial version + item context unit + project membership within ctx's existing transaction and awaits all effects; it must use existing single writers, fail closed on any placement/no-widening error, and never add implicit General/external-shared membership. It returns only after the canonical source is readable by the creator's current project authority. It performs no embeddings, Graphiti/Neo4j calls, graph-pointer project update, global-pool SQL, network, independent transaction or background callback. Existing scheduler can discover a durable eligible item for later indexing; helper output does not mean indexing is complete. Unique source identity/path errors are surfaced to rollback, never silently adopted from an unrelated item. Root must ensure the scheduled reconciler does not later widen explicit placement. The decision lane consumes this frozen shared interface and does not own its implementation.

The original source item and decision remain canonical. Workspace roundtrip copies never replace their source identity. Before ingest side effects, compare any incoming row matching governed origin with canonical values. Exact semantic echo is ignored as a row write; attempted changes to title/rationale/impact/date/attribution/audience return HTTP409 `{error:{code:'immutable_origin',message:'This governed record is immutable; refresh the read-only mirror.'}}`; omission never deletes the governed row. No second decision is inserted. Guard existing dashboard validity toggle for governed rows so it cannot implement deferred retraction. Guard direct item-path overwrite/deletion routes for the server-owned canonical source; a reserved prefix alone is not authorization. The exact refusal response is frozen by the shared proposal; root documents it in the canonical legacy ingress contract before implementation. Preflight the entire affected item/batch before project/item/materialization changes, preserving unrelated legacy semantics.

### Retrieval and compatibility

Add rationale to both decision query paths, preserving pre-LIMIT authorization and bounded context formatting. Render rationale with decision identity/project attribution. The canonical item also provides evidence-search/full-item and graph visibility. Add no unfiltered global lookup. Existing dashboard sourced-row visibility automatically follows the canonical item's membership; verify it rather than loosening provenance admission.

Extend writeback selection with the governed-origin case while retaining current visible-source predicate, tier wall, column names and row_key. The pull output stays the existing eight-column decision table. Extract its inline renderer into decision-owned Workspace repository: scripts/pull-decisions.mjs, importing `encodeTableCell`/`decodeTableCell` through the root-owned package export for Workspace repository: packages/foundation/src/workspace-parse/table-cell.mjs; preserve multiline, pipe, backslash and literal replacement text semantically on pull→parse. No action CLI or MCP tool registration is included.

## Files to change

Coordinator serializes shared-file integration; the decision lane owns the files below.

Brain owned:
- NEW FILE: `lib/decisions/service.ts`
- NEW FILE: `lib/actions/governed/consumers/decision.ts`
- `app/actions/decisions.ts`
- `lib/ingest/decisions.ts` (immutable-origin row guard)
- `lib/sync/decisions.ts`
- `lib/query/structured-extras.ts`
- decision sections only in `lib/query/retrieve.ts` (root must serialize with other lanes)
- NEW FILE: `test/datamechanics/governed-decisions.datamechanics.test.ts`
- NEW FILE: `test/http/decisions-governed.http.test.ts`
- NEW FILE: `test/decisions/domain.test.ts` for pure validation/format rules only
- existing `test/datamechanics/decisions-writeback.datamechanics.test.ts` and `test/datamechanics/enfb-decision-create.datamechanics.test.ts` only when shared service extraction changes their setup

Cross-repo dependency: the companion Workspace repository supplies the pull helper and codec. Paths below are scoped to that external repository, not local Brain files.

Workspace companion (external repository):
- NEW FILE: Workspace repository: scripts/pull-decisions.mjs
- NEW FILE: Workspace repository: test/pull-decisions.test.mjs
- NEW FILE: Workspace repository: test/governed-decision-roundtrip.test.mjs

Root-owned integration (builder supplies patch requests, never simultaneous edits): production registry/context `lib/actions/governed/index.ts`; canonical contracts and mirrored JSON/manifests; transaction-safe item helper and shared ingest entrypoint; item overwrite/deletion preflight; `postgres/schema.sql` and migration allocation; Workspace repository: scripts/aios-runtime.mjs callsite; shared Workspace repository: packages/foundation/src/workspace-parse/table-cell.mjs codec exporting encodeTableCell/decodeTableCell, its package export and decision parser integration; Brain `docs/ARCHITECTURE.md`; executable CI/test harness/global setup; tracker/PR/merge/deploy. Root owns necessary context reconciliation/backfill and graph destination-binding changes under the frozen shared governed-item design: a subsequent sweep must preserve the explicit destination instead of adding/moving to General. The existing decision kind/projector and restrictedOutOfHome/fan-out branch are reused, including the first projection with no General include; decision lead supplies identity/isolation acceptance, never parallel edits to these shared files.

## Acceptance criteria

Use isolated real PostgreSQL for durable/access cases and production `next start` over a real socket for HTTP. No FakeSupabase outcome claims and no test-only fixture route. Production registry must genuinely include decision consumer in enabled acceptance build. Tests are written from the following expected outcomes before implementation.

- [ ] AC1: Durable success: authorized admin and lead each submit; HTTP200 succeeded; exactly one decision, canonical source item, context membership and final action/audit exist with expected project, title/rationale/impact, authenticated creator/actor, server time/team audience. Entity ID equals stored decision ID; audit target binds action. SQL rollback fault between any two effects leaves none committed and no succeeded result. Opaque revision and audit stable on read.

- [ ] AC2: Retry/concurrency: identical sequential and concurrent requests yield one item/decision/identity and the original action/entity/revision/audit; dropped response after confirmed commit then retry/status returns same result. Same operation changed rationale, title, impact or type returns 409 operation_id_conflict and preserves all original values. Same operation on another actor/destination uses its own authorized identity. Restart process and replay proves persistence. Retain foundation backend-termination/fencing regression suite.

- [ ] AC3: Authorization/validation: external member credential, delegated token, ordinary non-admin/lead member even with policy allow, wrong team, ungranted project, missing destination, revoked key/member/project membership, and forged fields produce contract-typed non-success without item/decision mutation. Unknown field/action and Unicode limit boundaries reject before side effects. Test original submitter demoted after approval request and before approved execution; approval cannot lend decider privilege.

- [ ] AC4: Approval: require_approval gives 202 action/audit/approval but zero decision/item; status never executes it. Real human approval channel executes once; duplicate/concurrent decisions return one entity. Denial creates no entity. Revoked key/project/policy/domain role before approval denies without effect. Changing require_approval to allow does not make pending retry bypass human approval. Pending/denied responses contain no entity success hint.

- [ ] AC5: Retrieval/display/graph: authorized later native query includes rationale and identity; seed >50 newer decisions and query a unique rationale token to prove older match. Excluded project member and external member see no canonical source/rationale in query, full item, decision feed or dashboard. Run the later context/backfill sweep and confirm a General-only member still cannot retrieve the source or decision. Graph fixture drives real existing projector with synthetic model output and verifies decision kind, source item identity, exact project group and no other-project serving; real Neo4j tier if graph serving changed. Dashboard browser opens decision detail showing same title/rationale/by/project; no display relabel to note/deliverable.

- [ ] AC6: Pull/re-push: real decision GET gives existing wire shape and row_key only to authorized readers; Workspace pull creates/updates one row preserving kind, all content and actor; second pull does not duplicate. Test pipes, multiline/CRLF, backslashes, Unicode, literal `$&`/`$1`, and blank impact. Re-push exact echo preserves decision ID/revision/created_by/source item; a later omission does not delete it. Altered echo/attribution/audience, dashboard validity change and canonical item overwrite/delete fail without canonical mutation. Legacy non-governed decisions still follow their existing diff-sync/writeback behavior. Private/admin rows remain redacted from outbound workspace body.

- [ ] AC7: Capability off: fresh submit returns capability_unavailable and creates no domain entity; old authorized status/history/retrieval persists; pending approval cannot execute while off. Re-enable resumes pending through the human channel, not retry self-approval. No product data cleanup as rollback.

- [ ] AC8: Atomic/migration/conformance: from-zero and populated upgrade schema retain legacy decisions, indexes, audit/history; replay migration is safe; fault in item/context/final audit rolls back all consumer effects. Cross-repo contracts/fixtures byte-match; required executable unit, HTTP, Postgres and any affected Neo4j jobs discover these files. Root records exact commands/CI workflow evidence, not a green shape-only fixture.

## Manual acceptance and evidence

The coordinator provisions disposable staging member/admin/lead/external identities, project, opt-in flag and safe policy. With actual HTTP transport: submit decision, capture action/entity/revision/audit, inspect SQL, submit same operation again, later query rationale, open dashboard detail, inspect graph processing/serving and pull into a disposable workspace. Exercise real human approval/denial and capability disablement; preserve previously committed history and report processing truthfully. Record fixture IDs, exact candidate commits, contract manifest digest, issue revisions, commands and cleanup in the private technical evidence register. Do not claim CLI/MCP journey completion; AIO-1193 owns the final projection.


## Testing

Run focused unit, isolated PostgreSQL and real-socket HTTP suites for AC1–AC8. Existing decision writeback and domain creation tests remain regression coverage. Run contract conformance, lint and typecheck. Coordinator runs cross-repository pull/graph acceptance and required executable CI before merge.

## Rollout and rollback

Additive persistence ships with governed capabilities disabled. Enable only in disposable acceptance environments for this increment. Disable the capability to stop new writes without deleting prior entities, status, origin rows or audit history. No CLI/MCP projection or public release is included.

## Build with

High effort implementation and independent review; exact technical routing is retained in the private evidence register.
