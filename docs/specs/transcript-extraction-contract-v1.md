---
eval_tier: full
spec_gate: block
---

# End-to-end transcript extraction contract V1 — Team Brain

## Why

Team Brain cannot currently accept or materialize the workspace client's approved facts and
stakeholder mentions. Adding only item kinds would leave malformed-row partial writes, schema drift,
and an unsafe temptation to treat model-extracted people as canonical company identities. This
increment adds a strict Brain API 1.12 boundary and separate evidence tables while preserving old
clients and the company-graph single-writer invariant.

## What

Accept strict `fact` and `stakeholder_mention` items at `POST /api/v1/items`, validate the entire
payload before item/version mutation, and materialize their rows through `lib/ingest` into dedicated
Postgres tables with inherited audience and source-item-scoped diff sync.

This is one reviewable Team Brain PR; follow-ups are deferred to the paired workspace spec or the
explicit out-of-scope list below. It must deploy, migrate, and report Brain API 1.12 before the
paired workspace client is released. This spec is the self-contained parent plan for the Brain
increment; there is no separate Linear dependency.

## Interfaces and contracts

### Brain API 1.12 payload

Vendor the canonical workspace artifact as
`test/fixtures/contract/item-payload-1.12.schema.json`, with canonical valid and invalid fixtures.
Update `lib/api/version.ts`, `lib/api/schemas.ts`, `docs/ARCHITECTURE.md`, and
`test/fixtures/contract/brain-contract.json` to 1.12.

The new item kinds and exact strict row shapes are:

- `fact`: `row_key`, `title`, optional `occurred_at`, `fact_type` (`fact` or `event`),
  `source_path`, `source_quote`;
- `stakeholder_mention`: `row_key`, `name`, optional `role`, optional `context`, `source_path`,
  `source_quote`.

All required strings are non-empty and bounded; optional strings, when present, are non-empty and
bounded; dates use the contract format; unknown keys are rejected. Rows are kind-discriminated, so
wrong-kind rows and rows on unsupported kinds are rejected. A malformed row fails the complete
request with HTTP 422 before project, item, item-version, materialized-row, or audit writes.

Existing item kinds and old clients remain valid. Existing server-side meeting action-item
extraction is a separate producer and remains unchanged; it does not authorize raw local transcript
uploads.

### Postgres persistence

Extend the Postgres `item_kind` enum/check definition with `fact` and `stakeholder_mention` through
an idempotent additive migration and the canonical `postgres/schema.sql`.

Add canonical, idempotent table definitions for `extracted_facts` and `stakeholder_mentions`.
Both tables include:

- primary key and timestamps;
- `team_id`, `project_id`, `source_item_id`, `row_key`;
- inherited `audience`;
- every field from the corresponding 1.12 row;
- unique `(team_id, project_id, row_key)`;
- foreign keys consistent with existing item materializers.

Add team/project, source-item, audience, and `occurred_at` or normalized-name indexes appropriate to
the specified reads. Fresh schema replay and migration of an existing populated 1.11-compatible
database must both succeed idempotently.

### Materialization

Only `lib/ingest` writes the two tables. After boundary parsing and before item mutation, ingestion
receives typed rows. On changed content it upserts rows by `(team_id, project_id, row_key)`, sets
`source_item_id` to the containing item, inherits normalized item access as `audience`, and
diff-deletes absent rows only where `source_item_id` is that same synced item. An unchanged retry
does not duplicate or delete rows.

The existing admin/private boundary remains a 422. Stakeholder mentions never write `members`,
`graph_entities`, or `graph_relationships`, and no company-graph writer guard is weakened.

## Implementation tasks

1. Add failing schema/Zod parity tests using shared valid/invalid fixtures, then vendor the 1.12
   contract and implement a strict discriminated payload parser.
2. Add failing fresh-schema and populated-schema migration tests, then add the idempotent item-kind
   migration, tables, constraints, and indexes to migration and canonical schema surfaces.
3. Add failing real-Postgres tests for create, update, unchanged retry, diff deletion,
   source-item isolation, malformed-row atomicity, inherited audience, and company-graph
   non-mutation; then implement typed row materializers owned by `lib/ingest`.
4. Add failing live-socket HTTP tests for authentication, both kinds, forbidden tiers, malformed
   rows, audit attribution, and old-client payloads; then wire the route.
5. Update `docs/ARCHITECTURE.md`, every affected drift block, the pinned contract references, and
   release evidence with the shared schema SHA-256.

## Acceptance criteria

- `POST /api/v1/items` accepts valid `fact` and `stakeholder_mention` payloads and returns existing
  `{status,id}` semantics.
- Any malformed or unknown row field returns 422 before any project/item/version/materialized/audit
  mutation.
- Fresh and populated Postgres schemas accept the idempotent migration, contain the exact
  constraints/indexes, and support reapplication.
- Real-Postgres tests prove create, update, unchanged retry, same-item diff deletion, cross-item
  isolation, and audience inheritance.
- Stakeholder ingestion leaves `members`, `graph_entities`, and `graph_relationships` unchanged and
  their single-writer guards still pass.
- Admin/private items remain rejected; external items materialize only external audience and team
  items materialize team audience.
- Existing decision/task materialization, meeting-task extraction, and old-client item kinds remain
  compatible.
- JSON Schema, strict Zod parser, fixtures, API version, documentation, and workspace schema copy
  agree; release evidence records the same SHA-256 in both repositories.
- Architecture docs and drift blocks enumerate both new tables and ingestion sources.
- Every verification command below passes.

## Integration points

- `app/api/v1/items/route.ts` — authenticated HTTP boundary and 422 behavior.
- `lib/api/schemas.ts` and `lib/api/version.ts` — runtime parser and declared contract version.
- `lib/ingest/index.ts` — sole item and row write path.
- `postgres/schema.sql` and `postgres/migrations/` — canonical fresh schema and additive production
  migration.
- `test/fixtures/contract/brain-contract.json` and
  `test/guards/contract-conformance.test.ts` — vendored contract and drift guard.
- `test/datamechanics/` — real-Postgres persistence and tier outcomes.
- `test/http/items.http.test.ts` — live-socket request behavior.
- `test/guards/single-writer-items.test.ts` and company-graph writer guards — ownership invariants.
- `lib/meetings/extract-todos.ts` — existing independent meeting-task producer, behavior unchanged.
- `docs/ARCHITECTURE.md` and `scripts/check-docs-drift.mjs` — required architecture-map loop.

## Dependencies

- The canonical 1.12 schema and fixtures originate in the paired `aios-workspace` PR and are copied
  byte-for-byte here. Both worktrees are local siblings; if the canonical workspace artifact is
  absent, stop before runtime changes and create/evaluate the workspace artifact first. The Brain
  copy is never independently invented.
- Use existing Zod, Postgres adapter, Vitest, HTTP, and data-mechanics infrastructure. Add no new
  runtime dependency.
- The shared test Postgres must be available for data-mechanics and migration verification; unit
  contract tests must run without a database.

## Scope

In scope: strict API acceptance, version/schema conformance, additive persistence, ingest-owned
materialization, access inheritance, atomic malformed-row rejection, architecture documentation,
and database/socket verification.

Out of scope: a new dashboard or read endpoint, canonical member/company-graph updates, changes to
meeting extraction, raw transcript upload, RLS, and consolidation of extraction producers.

## Build-with

Build-with: GPT-5.6 high effort. This change crosses an authenticated wire boundary, schema
migration, idempotent row mechanics, access control, and cross-repository release compatibility.

## Tier-safety

The route continues to reject admin/private at 422 and accepts only normalized team/external
access. Every materialized row inherits the containing item's access; the wire cannot override
audience. External callers cannot create team-visible evidence. Stakeholder mentions remain
unverified evidence rows and never mutate canonical identities or graph relationships.

## Testability

Evaluate this file with the workspace toolkit while the current directory is the Team Brain
worktree, then run the remaining commands there:

```bash
dotenvx run -f ../aios-workspace-worktrees/feat-transcript-contract-v1/.env -- \
  node ../aios-workspace-worktrees/feat-transcript-contract-v1/scripts/aios.mjs \
  spec eval docs/specs/transcript-extraction-contract-v1.md
npm run typecheck
npm run lint
npm test
npm run check:docs
npm run db:test:up
npm run test:datamechanics
npm run test:http
npm run build
```

The HTTP suite must exercise a real server socket and Postgres. Migration verification must cover a
fresh schema and an existing populated schema, including a second application. The release record
must include the 1.12 schema SHA-256 and matching workspace hash.
