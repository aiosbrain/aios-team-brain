# A delegated token sees hand-entered rows in projects it holds — AUDITFIX-7

**Status:** spec, round 0. No code written.
**Build with:** opus / high — it changes what a delegated agent may read, on the access path.

**Deps:** none. **Sequence it BEFORE TIERRET-1**, which rewrites the same function
(`admitsUnsourced`'s `teamPosture` conjunct is a tier input and dies with it), so the predicate is
rewritten once rather than twice.

---

## What and why

**What:** a delegated `aiosd_` token may read a task or decision a human typed by hand, when that row
sits in a project the token's own authority covers. Member behaviour is unchanged.

**Why:** today it may read **none of them**. `admitsUnsourced` (`lib/access/provenance-sql.ts:56-58`)
omits the unsourced arm entirely for a token, so an agent gets everything synced from
Linear/meetings/pushes and nothing hand-typed — a confidently incomplete answer with no error.

**RULING (Chetan, 2026-08-22):** an agent granted a project *should* be able to read what a person
typed into it by hand.

## 0. Terrain, measured on production before designing (read-only, 2026-08-22)

⚠️ **Round 1 showed my first measurement was the wrong predicate, and the corrected number is 136×
smaller. Leading with that.**

I counted `source_item_id is null` and called it "hand-entered". The arm the code actually admits is
`source_item_id is null` **AND `created_by is not null`** (`lib/access/provenance.ts:28`), and
"unsourced" does not imply "typed by a human":

- **`ON DELETE SET NULL`** turns a formerly-sourced row back into a null-source row when its item is
  purged (`lib/ingest/purge.ts:25`) — deliberately, so "a UI-authored task must not vanish because its
  evidence was purged".
- **`scripts/brain-tasks.ts:143`** inserts unsourced rows with no `created_by` at all.

| | first count (wrong predicate) | **corrected** |
|---|---|---|
| tasks, `source_item_id is null` | 136 | 136 |
| **tasks, unsourced AND authored** — the population the arm admits | *(claimed 136)* | **1** |
| decisions, unsourced AND authored | 0 | **0** |

**The rest of the 136, broken down (`origin`):** 69 are `sync` — the purge lifecycle above. **66 are
`ui`** but carry no `created_by`, all created in a single historical window (2026-06-28 → 07-01);
`createTaskAction` sets `created_by: me.id` today (`app/actions/tasks.ts:106`), so this is legacy data,
not a live writer defect. ⚠️ **Those 66 fail the authorship conjunct and are therefore invisible to
EVERY principal — member and token alike — on provenance-gated surfaces.** That is a real finding, it
is **not** this slice's, and it is recorded here rather than folded in silently.

| | |
|---|---|
| does the one authored row carry a `project_id`? | **yes** — the premise holds |
| which project? | `aios-team-brain`, `kind='source'` |
| is it **granted** to any group? | **NO** |
| projects on the fleet | **19** total, **2 granted** (`general`, `external-shared` — both system) |
| **delegated tokens in existence** | **0** |

**What this slice can honestly claim:**

1. **It admits ZERO additional rows on this fleet, and that is faithful to the ruling.**
   `effectiveVisibleProjects` is the delegated authority — launcher grants ∩ represented-member grants
   ∩ token scope (`lib/access/oracle.ts:127-143`). No token's authority covers `aios-team-brain`, so an
   agent should not see what was typed into it. **Making that project useful to an agent requires an
   OPERATOR GRANT, not a code change.** Round 1 confirmed this independently.
2. **The defect is fully latent** — zero tokens exist. This closes a class before agents are used.
3. **The live class is tasks, not decisions.** The New Decision button exists
   (`components/decisions/new-decision-button.tsx`, Decisions page, admins/leads only) but decisions
   are curated through the CLI, which gives them a `source_item_id`. The task surface is
   `components/kanban/new-task-dialog.tsx`. Neither is Pulse; `/api/v1/tasks` and `/api/v1/decisions`
   are GET-only, so there is no third-party create path.

## 1. The false claim this slice removes

`lib/access/provenance-sql.ts:42-44` justifies the exclusion:

> *"A delegated token's authority is its attenuated scope; a row with no `source_item_id` cannot be
> tested against that scope, so it can never be shown to one."*

**"Cannot be tested" is false.** Hand-entered rows carry a project: `app/actions/tasks.ts:98`
(`project_id: input.projectId`), `app/actions/decisions.ts:57` — written in the same insert as
`created_by`. Both token-reachable leg queries already `left join projects`
(`lib/query/retrieve.ts:668`, `:691`).

And the plumbing is **half-built**: `visibleItemIds` already returns `projectIds` alongside the ids
(`lib/access/enforce.ts:128-135`), while `delegatedVisibleItemIds` (`:145-151`) computes
`effectiveVisibleProjects` and **discards it**.

## 2. The rule

> **The unsourced arm admits a row when it is AUTHORED (`created_by is not null`) and either the
> principal is a MEMBER at team posture (unchanged), or the principal is a TOKEN whose EFFECTIVE
> project set contains the row's `project_id`. Everything else closes.**

Expressed **positively**, for AUDITFIX-1's reason: `principal !== "token"` would admit `undefined`,
`null` and any foreign value, and those are real runtime states because `tsconfig.json` excludes
`test/`.

**The member arm is NOT narrowed.** Adding a project conjunct there would be a silent regression.

### 2a. Why `project_id` is a sound access input on THIS arm

⚠️ **Round 1 broke my first argument and round 2 broke my second. This is the third, and both
corrections are recorded rather than quietly replaced.**

**v1 (wrong):** *"unsourced means exactly the box a human chose in the UI."* False — the purge
lifecycle (`ON DELETE SET NULL`, `lib/ingest/purge.ts:25`) and the task CLI
(`scripts/brain-tasks.ts:143`) both produce unsourced rows no human typed.

**v2 (also wrong):** *"the authorship conjunct excludes purged-source rows, so they never reach the
project test — the ordering is load-bearing."* Also false, and round 2 showed why: a dashboard row
retains `created_by`, and a later **sync upsert sets `source_item_id` while omitting `created_by`**
(`lib/ingest/tasks.ts:161`, `lib/ingest/decisions.ts:15` — verified: neither upsert row includes the
column, so the original value survives). If that item is later purged, `source_item_id` returns to
`null` while `created_by` is still set. **Such a row DOES reach the project test.**

**v3, which survives:** the combined predicate (`source_item_id is null AND created_by is not null`)
proves **dashboard authorship** — not that the row was never subsequently sourced. The full lifecycle
is *dashboard create → writeback/sync → purge*, and the project it carries at the end is **still the
human's**: the sync upsert conflicts on `(team_id, project_id, row_key)`, so it cannot move the row to
a different project — it can only rewrite the row that already sits in that one.

That is what makes `project_id` an access input here while `lib/access/enforce.ts:179` (*"`tasks.project_id`
is the INGEST project, not an access-control project"*) remains true of genuinely sourced rows.

**The residual, named:** nothing re-points a hand-entered row's `project_id` afterwards, and there is
no UI to move one. If a curation surface ships, keeping that column honest becomes its obligation.

## 3. The design

### 3a. THREE owners, and the union must be exhaustively consumed

AUDITFIX-1 established *"one contract, three owners"*. Round 1 found my scope listed two — the third
is `lib/access/provenance.ts`, which imports `admitsUnsourced` (`:2`) and calls it (`:28`), and whose
row type carries no `project_id`.

The policy stays **one function** returning a discriminated union:

```ts
type UnsourcedAdmission =
  | { kind: "closed" }
  | { kind: "all" }                                       // member @ team posture
  | { kind: "projects"; projectIds: readonly string[] };  // token, gated on its effective set
```

⚠️ **Round 2's HIGH 1: a union alone does not prevent the widening it was chosen to prevent.** A
consumer can treat every non-`closed` result as the bare arm, silently reading `"projects"` as
`"all"`. So all three consumers **must `switch` exhaustively with a `never` check** — the compiler,
not a convention, is what makes a missed branch impossible.

| owner | consumes |
|---|---|
| `provenanceRowSqlFromIds` (id-array SQL) | `"all"` → bare arm · `"projects"` → arm `AND <alias>.project_id = any($n)` · `"closed"` → omit |
| `provenanceRowSql` (semijoin SQL) | same |
| `rowVisibleByProvenance` (TS) | `"all"` → true · `"projects"` → `projectIds.includes(row.project_id)` · `"closed"` → false |

**An empty `tokenProjectIds` returns `{kind:"closed"}` explicitly**, rather than relying on
`= any('{}')` being false — the closed case is a decision, not an emergent property of SQL.

### 3b. SQL aliases vs materialised rows — a distinction round 2 forced

The two are **not** the same obligation, and conflating them is how a caller silently drops rows:

- **SQL owners** need only that the alias exposes the column. `tasks.project_id` and
  `decisions.project_id` are `not null` in the schema (`postgres/schema.sql:1068,1187`), so
  `<alias>.project_id` always resolves. **No SQL caller needs to change.**
- **The TS owner** operates on a materialised row, so the column must have been **selected**. Two
  production callers do not select it — the project-detail decisions query
  (`app/t/[team]/projects/[project]/page.tsx:77`) and the timeline decisions query
  (`lib/dashboard/work-timeline.ts:372`). Both are member-only today, so `"all"` never needs the
  column; a future token reuse would compile and silently drop rows.

**So the fail-closed rule needs a static partner (round 2's HIGH 2).** Because `project_id` is
`NOT NULL` in the database, a missing field on a materialised row means *the caller forgot to select
it* — never *the record has no project*. Returning `false` quietly turns a wiring defect into an
apparently legitimate empty result, which is data-loss-shaped.

Therefore: **the `"projects"` path requires `project_id: string` STATICALLY** (an overload, or a
row/context pair that only type-checks when the column is present), **and** a runtime absence still
denies **and emits a loud diagnostic**. Security direction unchanged; the programmer error stops being
silent.

### 3c. The full caller inventory

Recorded because §3a claimed one and did not contain it.

| owner | production callers |
|---|---|
| `provenanceRowSql` (semijoin) | `lib/access/enforce.ts:281`, `:351` (project rows + card counts) |
| `provenanceRowSqlFromIds` | `lib/query/retrieve.ts:670` · `lib/query/structured-extras.ts:75` · `lib/access/structured-windows.ts:30` · `lib/sync/decisions.ts:53` · `lib/identity/context.ts:223` · `lib/metrics/pulse.ts:221` · `lib/dashboard/work-timeline.ts:376` |
| `rowVisibleByProvenance` (TS) | `app/t/[team]/decisions/page.tsx:70` · `app/t/[team]/tasks/page.tsx:93` · `app/t/[team]/projects/[project]/page.tsx:97` · `lib/dashboard/work-timeline.ts:670` |

### 3d. The route carry, pinned where it happens

`app/api/v1/query/route.ts:138` destructures the delegated result to `{ ids }`, and the AST guard
analyses only `lib/query/retrieve.ts` and `lib/query/structured-extras.ts`
(`test/guards/provenance-principal-callsites.test.ts:47`). So a dm test calling retrieval directly can
pass **while the real route omits the project set entirely**. `delegatedVisibleItemIds` returns
`projectIds` (as `visibleItemIds` already does), the route forwards it, and both a **minted-token HTTP
test** and a **structural guard on the route file** pin that it forwards what that function returned
rather than a same-named property.

## 4. Scope

**In:** `lib/access/provenance-sql.ts` · **`lib/access/provenance.ts`** · `lib/access/enforce.ts`
(`delegatedVisibleItemIds` returns the project set) · `lib/query/retrieve.ts` +
`lib/query/structured-extras.ts` · `app/api/v1/query/route.ts` ·
`test/guards/provenance-principal-callsites.test.ts` · `docs/ARCHITECTURE.md`.

**Not split.** Round 2: *"the slice is cohesive enough not to split — policy, authority carry, both
token query legs, route wiring, and guards form one authorization change."*

**Out:** narrowing the member arm · the **66 author-less UI tasks** (§0 — invisible to everyone, a
data/backfill question; AC5 pins that this slice neither repairs nor worsens them) · moving
hand-entered rows into the unit/membership substrate (the durable answer; a different slice) ·
**requiring an explicit scope at mint (AUDITFIX-19)** and **the agents admin page (AUDITFIX-20)** —
both filed, and together they are what make scoping usable rather than merely enforceable.

## 5. Acceptance

⚠️ **Three scars govern this list.** AUDITFIX-1's: an empty-scope test passes trivially. Round 1's: I
seeded only a **task**, so an implementation could gate tasks and leave decisions open. Round 2's:
every positive used an **explicit non-empty scope**, so an implementation that returns `[]` for a
`null` scope passes everything while silently blinding every unscoped token.

- **AC1 — in-scope authored rows are VISIBLE to a token, BOTH row types (dm):** one non-empty-scope
  invocation; an authored task **and** an authored decision with `project_id ∈ scope` both appear.
- **AC2 — out-of-scope authored rows stay INVISIBLE, BOTH row types (dm):** same invocation, same
  shapes, `project_id ∉ scope`. **Without AC2, AC1 is satisfied by deleting the gate.**
- **AC3 — an UNSCOPED token (`projectScope: null`) sees its launcher's projects, not nothing (dm):**
  launcher granted P; authored task and decision in P and in Q. **P appears, Q does not.** Explicitly
  asserts `null → the launcher/represented intersection` while `[] → closed`. *Round 2's BLOCKER: the
  implementation that returns `[]` for a null scope passes AC1–AC2 and silently narrows every
  unscoped token.*
- **AC4 — an EMPTY scope (`[]`) closes (unit + dm, piecewise):** the unit tier proves `[] → closed`
  from the policy; the dm leak suite independently proves an empty effective set. ⚠️ *Labelled "dm"
  before the diff review; it is proven in two places, not one end-to-end fixture.*
- **AC5 — `created_by` null closes even in scope (unit):** ⚠️ *labelled "dm" before the diff review;
  it is asserted on the TS owner, not seeded through the route.* Shaped as `origin='ui'`,
  `source_item_id=null`, `created_by=null`, project **in scope** — the exact shape of the 66 legacy
  rows, making it explicit that project scope alone does not rehabilitate them.
- **AC6 — the SOURCED arm is a positive control in the same invocation (dm).**
- **AC7 — MEMBER behaviour is unchanged across ALL THREE owners (dm + unit):** a member at team
  posture still sees an authored row in an **ungranted** project — through the id-array SQL owner, the
  **semijoin** owner (`lib/access/enforce.ts:281,351`), and `rowVisibleByProvenance`.
- **AC8 — the three owners agree on ONE truth table, EXECUTABLY (unit + dm):** ⚠️ *Round 2's HIGH 1:
  the owners return different types, so "compare their outputs" is not a mechanism.* Three parts:
  (i) the policy function's exact union result is unit-asserted for every (principal, posture, scope)
  input; (ii) all three consumers `switch` exhaustively with a `never` check, so a missed branch is a
  compile error; (iii) each SQL form is asserted SEPARATELY with its OWN mutation, so a shared fixture
  cannot mask either owner. ⚠️ *Corrected after the diff review: I had written "both SQL forms are
  EXECUTED against the same dm fixture truth table". Only the id-array form is — the semijoin form's
  `"projects"` branch is production-dead (all three callers are `MemberPrincipal`-typed, so no token
  reaches it) and is string-asserted plus mutation-pinned rather than executed. Claiming coverage the
  tests do not contain is the exact failure this slice has now been caught by three times.*
- **AC9 — the route forwards the real project set (in-process route + unit guard):** ⚠️ *labelled
  "http" before the diff review; the test imports the route handler and calls `POST` directly with
  `streamAnswer` mocked — the real enforcement path, but not the wire tier.* a minted-token
  `POST /api/v1/query` returns an in-scope authored row and not an out-of-scope one; a structural
  guard asserts the route forwards what `delegatedVisibleItemIds` returned.
- **AC10 — the forward is CARRIED, not merely available (unit guard):** deleting the project set from
  a ctx literal fails the build. The M13 lesson: an absent forward closes the arm and reddens nothing.
- **AC11 — the arm closes on an absent/foreign principal (unit):** `undefined`, `null` and a foreign
  string each yield `{kind:"closed"}`.
- **AC12 — a missing `project_id` DENIES and is LOUD, and cannot compile on the token path (unit +
  types):** runtime absence denies **and** emits a diagnostic; and a `"projects"` admission against a
  row type without `project_id: string` **fails typecheck**. Pins both *no leak* and *not silent*.

**Mutations required** (round 2): flipping the `"projects"` branch to the bare arm **independently in
each SQL owner** must redden — one mutation per owner, so a shared fixture cannot mask either.

**What no criterion claims:** that any row becomes visible on this fleet. §0 measures why none will.

## 6. Risks

| risk | direction | mitigation |
|---|---|---|
| An unscoped token is silently blinded | every `null`-scope agent loses authored rows | AC3 — the round-2 BLOCKER |
| A consumer reads `"projects"` as `"all"` | a token sees out-of-scope rows | exhaustive `switch` + `never` (§3a); per-owner mutations |
| A TS caller does not select `project_id` | rows silently dropped | AC12: static requirement + loud runtime denial |
| The member arm is narrowed on an untested owner | authored rows vanish for humans | AC7 across all three owners |
| The route never forwards the set | every token keeps today's behaviour, invisibly | AC9 + AC10 |
| Someone reads the merge as fixing a live complaint | wasted expectation | §0: zero tokens, one qualifying row, ungranted project |

---

## 7. Round 1 — BLOCKED: a missed owner, and a measurement wrong by 136×

| # | finding | outcome |
|---|---|---|
| **B1** | `lib/access/provenance.ts` is a THIRD owner that imports and calls the function being replaced | **CONFIRMED.** In scope; policy became a union; §3c inventories every caller |
| **H1** | acceptance seeded only a task — an implementation could gate `t` and leave `d` open | **CONFIRMED.** AC1/AC2 assert both row types in one invocation |
| **H2** | AC5 could pass while members were narrowed on the **semijoin** owner | **CONFIRMED.** AC7 covers all three |
| **H3** | the route destructures to `{ ids }` and the AST guard does not analyse it | **CONFIRMED.** AC9 |
| **M1** | the central inference is right — `effectiveVisibleProjects` IS the delegated authority | **CONFIRMED**; an operator grant is what makes it useful (§0) |
| **M2** | the 136 figure was the wrong predicate | **CONFIRMED.** Qualifying population is **1** |
| **M3** | `string \| null` invites "null = no filter" | **CONFIRMED.** Discriminated union |
| **M4** | build it, do not decline | **ACCEPTED** |

## 8. Round 2 — BLOCKED: the unscoped token, and a union that does not enforce itself

| # | finding | outcome |
|---|---|---|
| **B1** | **no criterion pinned `projectScope: null`.** An implementation returning `[]` for a null scope passes every folded positive and silently blinds every unscoped token — the exact narrowing the ruling forbids | **CONFIRMED. AC3 added**, asserting `null → launcher/represented intersection` and `[] → closed` as distinct outcomes |
| **H1** | AC7 claimed three-owner parity with **no executable mechanism** — the owners return different types, and `{kind:"all"}` stays vulnerable to a consumer treating every non-closed result as the bare arm | **CONFIRMED.** AC8 is now three parts (union unit-asserted · exhaustive `switch` + `never` · both SQL forms executed against the TS owner's fixture table), plus per-owner mutations |
| **H2** | AC11's fail-closed was right on security but data-loss-shaped: `project_id` is `NOT NULL`, so a missing field means the CALLER forgot to select it. Two TS callers omit it today | **CONFIRMED.** AC12 requires it **statically** on the token path and makes the runtime denial loud |
| **M1** | the caller inventory was claimed but absent; and "SQL alias exposes a column" ≠ "TS row selected it" | **CONFIRMED.** §3b draws the distinction, §3c is the inventory. **No SQL caller needs to change** |
| **M2** | §2a's residual was **false** — a sync upsert preserves `created_by`, so a dashboard→sync→purge row DOES reach the project test | **CONFIRMED**, verified in `lib/ingest/tasks.ts:161`. §2a v3 rests on dashboard authorship, and on the upsert conflicting on `(team_id, project_id, row_key)` so the project stays the human's |
| **M3** | the 66 legacy rows are separable, but acceptance should say so | **CONFIRMED.** AC5 seeds their exact shape |
| — | the slice is cohesive enough not to split | **ACCEPTED** |

**Nothing is built. No code exists for this slice.**
