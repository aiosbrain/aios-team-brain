# AIOS Team Brain — Engineering Constitution

> The pinned engineering contract for the Team Brain — sibling to
> `aios-workspace/docs/ENGINEERING-CONSTITUTION.md`. The fenced digest below is
> machine-read (same `agent-digest` markers) and injected into agent build/review/
> simplify prompts. Change a principle here **first**, then build.

## 1. The brain is the ONE shared hub

One deployment serves the whole team. Workspaces push tier-tagged content to it;
it never reaches into a workspace. Everything it accepts, stores, and serves is
governed by the sync contract and the tier model — there is no side channel.

## 2. The sync contract is law

`aios-workspace/docs/brain-api.md` (currently v1.7, major `/api/v1`) is the single
pinned contract. Any protocol change is a versioned change in that file first, with
matching changes on both sides. Clients must ignore unknown item kinds
(forward-compat); the brain must never silently change response shapes.

## 3. Tier enforcement at the boundary

`admin`-tier content is rejected with **422 at the API boundary** — a hard
invariant, not middleware convention. Every stored item carries its tier; every
query path filters by it. No handler, migration, or "quick fix" may weaken this.

## 4. Schema changes are migrations

`npm run pg:schema` creates missing tables but cannot alter existing ones — any
column/index change on an existing table is a numbered file in
`postgres/migrations/`. Never hand-edit production schema.

## 5. Module boundaries

Dashboard (Next.js app), API routes (the contract surface), data layer (Postgres
access), and the Python ingestion sidecar (`ingestion/aios_ingest/`) are separate
concerns. API routes validate + enforce tier, then delegate; the data layer never
imports UI; the sidecar talks to the brain only through the public API.

## 6. Verification bars

Lint + typecheck + vitest with the coverage gate + data-mechanics tests (real
Postgres) + HTTP integration tests are the definition of green. New behavior lands
with tests at the same layer it lives in.

## 7. Agent digest

Machine-read by agent tooling; keep it a faithful distillation of §1–6 (≤40 lines)
and update it in the same commit as any principle change.

<!-- agent-digest:start -->
- The brain is the ONE shared hub: workspaces push to it; it never reaches into a
  workspace; no side channels around the sync contract.
- `brain-api.md` (v1.7, `/api/v1`) is law: protocol changes are versioned there
  FIRST with matching changes on both sides; never silently change a response
  shape; ignore-unknown-kinds stays intact.
- Tier enforcement is a hard boundary: `admin`-tier content → 422 at the API
  boundary; every stored item carries a tier; every query filters by it; never
  weaken this to make something work.
- Schema changes to existing tables are numbered files in `postgres/migrations/`
  (`pg:schema` only creates missing tables). No hand-edited production schema.
- Boundaries: API routes validate + enforce tier then delegate; the data layer
  never imports UI; the Python ingestion sidecar uses only the public API.
- Green = lint + typecheck + vitest (coverage gate) + data-mechanics + HTTP
  integration tests; new behavior ships with tests at its own layer.
- Simplification bar: prefer deleting code to adding it; no new dependency without
  a stated reason; no abstraction before the second concrete use; cleanup passes
  are behavior-preserving and stay inside the changed hunks.
<!-- agent-digest:end -->
