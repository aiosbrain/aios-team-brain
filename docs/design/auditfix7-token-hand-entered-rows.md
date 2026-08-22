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

### 2a. Why `project_id` is a sound access input on THIS arm — restated, because round 1 broke my first version

⚠️ My first argument was *"unsourced means exactly the box a human chose in the UI"*. **That is false**
(§0): the purge lifecycle and the task CLI both produce unsourced rows that no human typed.

The argument that survives rests on the **combined** predicate. A row that is `source_item_id is null`
**and** `created_by is not null` was written by a dashboard create action — the only writer that sets
`created_by` (`lib/access/provenance.ts:8-10` states this, and `app/actions/tasks.ts:105-106` /
`app/actions/decisions.ts:57` are the writers). For exactly that row, `project_id` is the box a person
chose, not an ingest artifact — which is what makes `lib/access/enforce.ts:179` (*"`tasks.project_id`
is the INGEST project, not an access-control project"*) true of sourced rows and inapplicable here.

**Two residuals, named rather than buried.** A purged-source row keeps whatever `project_id` the
ingest gave it — it is excluded by the authorship conjunct, so it never reaches the project test, and
that ordering is load-bearing. And nothing re-points a hand-entered row's `project_id` afterwards; if
a curation surface ships, keeping that column honest becomes its obligation.

## 3. The design

### 3a. THREE owners, not two — the BLOCKER round 1 found

AUDITFIX-1 established *"one contract, three owners"*. My scope listed two. The third is
**`lib/access/provenance.ts`**, which imports `admitsUnsourced` (`:2`) and calls it (`:28`) — and whose
row type does not carry `project_id` at all. Implementing this spec literally would either fail
compilation or leave the TS owner enforcing a different policy than the SQL owners, which is precisely
the divergence AUDITFIX-1 exists to prevent.

So the policy stays **one function**, in a form both a SQL builder and a TS row-check can consume:

```ts
type UnsourcedAdmission =
  | { kind: "closed" }
  | { kind: "all" }                                  // member @ team posture
  | { kind: "projects"; projectIds: readonly string[] }; // token, scoped

export function unsourcedAdmission(ctx: {
  principal?: ProvenancePrincipal;
  teamPosture: boolean;
  tokenProjectIds?: readonly string[];
}): UnsourcedAdmission;
```

A **discriminated union, not `string | null`** — round 1's point that a nullable SQL fragment invites a
caller to read `null` as "no filter". Each owner consumes it in its own idiom:

| owner | consumes |
|---|---|
| `provenanceRowSqlFromIds` (id-array SQL) | `"all"` → the bare arm; `"projects"` → the arm `AND project_id = any($n)`; `"closed"` → omit |
| `provenanceRowSql` (semijoin SQL) | same |
| `rowVisibleByProvenance` (TS) | `"all"` → true; `"projects"` → `projectIds.includes(row.project_id)`; `"closed"` → false |

`rowVisibleByProvenance`'s row type gains `project_id?: string | null`, and **its callers are
inventoried in the spec and asserted by the guard** — a `"projects"` admission against a row whose
`project_id` was never selected must **close**, not silently pass, so an un-updated caller fails
closed rather than leaking.

An **empty** `tokenProjectIds` returns `{kind:"closed"}` explicitly, rather than relying on
`= any('{}')` being false — the closed case is a decision, not an emergent property of SQL.

### 3b. The route carry, pinned where it actually happens

`app/api/v1/query/route.ts:138` destructures the delegated result to `{ ids }`, and the existing AST
guard analyses only `lib/query/retrieve.ts` and `lib/query/structured-extras.ts`
(`test/guards/provenance-principal-callsites.test.ts:47`). So a dm test that calls retrieval directly
can pass **while the real route omits the project set entirely**. `delegatedVisibleItemIds` returns
`projectIds` (as `visibleItemIds` already does), the route forwards it, and both a **minted-token HTTP
test** and a **structural guard on the route file** pin that it forwards the value that function
returned rather than a same-named property.

## 4. Scope

**In:** `lib/access/provenance-sql.ts` (the policy + both SQL owners) · **`lib/access/provenance.ts`
(the TS owner + its row type)** · `lib/access/enforce.ts` (`delegatedVisibleItemIds` returns the
project set) · `lib/query/retrieve.ts` + `lib/query/structured-extras.ts` ·
`app/api/v1/query/route.ts` · `test/guards/provenance-principal-callsites.test.ts` ·
`docs/ARCHITECTURE.md`.

**Out:** narrowing the member arm (§2) · **the 66 author-less UI tasks** (§0 — real, invisible to
everyone, and a data/backfill question, not this predicate's) · moving hand-entered rows into the
unit/membership substrate (the durable answer; it would make this predicate unnecessary rather than
correct) · granting `aios-team-brain` (an **operator action**, and the thing that would make this fix
observable).

## 5. Acceptance

⚠️ **Two scars govern this list.** AUDITFIX-1's: an empty-scope test passes trivially, so every
criterion uses a **non-empty** scope. And round 1's: my first draft seeded only a **task**, so an
implementation could gate alias `t` and leave alias `d` open and still pass everything.

- **AC1 — in-scope authored rows are VISIBLE to a token, BOTH row types (dm):** in one non-empty-scope
  invocation, an authored task **and** an authored decision with `project_id ∈ scope` both appear.
- **AC2 — out-of-scope authored rows stay INVISIBLE, BOTH row types (dm):** same invocation, same
  shapes, `project_id ∉ scope`. Absent. **Without AC2, AC1 is satisfied by deleting the gate.**
- **AC3 — the SOURCED arm is a positive control in the same invocation (dm):** an ingested row inside
  `visibleItemIds` is still visible, and one outside it still is not.
- **AC4 — an EMPTY-scope token sees no unsourced rows (dm):** the fail-closed floor, never the only
  criterion.
- **AC5 — `created_by` null closes even in scope (dm):** the authorship conjunct is not weakened by the
  project conjunct, and the ordering in §2a holds.
- **AC6 — MEMBER behaviour is unchanged across ALL THREE owners (dm + unit):** a member at team
  posture still sees an authored row in an **ungranted** project — asserted through the id-array SQL
  owner, the **semijoin** owner (`visibleProjectRows` / project-card counts,
  `lib/access/enforce.ts:281,351`), **and** `rowVisibleByProvenance`. *Round 1: a retrieval-only
  fixture passes while the semijoin owner silently narrows members.*
- **AC7 — the three owners agree on ONE truth table (unit):** every (principal, posture, scope, row)
  combination yields the same admit/deny from all three. This is what makes "one contract, three
  owners" a fact rather than a claim.
- **AC8 — the route forwards the real project set (http + unit guard):** a minted-token
  `POST /api/v1/query` returns an in-scope authored row and not an out-of-scope one; and a structural
  guard asserts `app/api/v1/query/route.ts` forwards what `delegatedVisibleItemIds` returned.
- **AC9 — the forward is CARRIED, not merely available (unit guard):** deleting the project set from a
  ctx literal fails the build. Mutation-verified — the M13 lesson is that an absent forward closes the
  arm and therefore reddens nothing on its own.
- **AC10 — the arm closes on an absent/foreign principal (unit):** `undefined`, `null` and a foreign
  string each yield `{kind:"closed"}`.
- **AC11 — a `"projects"` admission with no `project_id` on the row CLOSES (unit):** the fail-closed
  behaviour for a TS caller that has not been updated to select the column.

**What no criterion claims:** that any row becomes visible on this fleet. §0 measures why none will.

## 6. Risks

| risk | direction | mitigation |
|---|---|---|
| The member arm is narrowed on an owner the tests do not cover | authored rows vanish for humans | AC6 asserts all three owners explicitly |
| A TS caller is not updated to select `project_id` | a token sees an out-of-scope row | AC11 — the missing column CLOSES |
| The route never forwards the set | every token keeps today's behaviour, invisibly | AC8 + AC9; an absent forward reddens nothing on its own |
| Someone reads the merge as fixing a live complaint | wasted expectation | §0: zero tokens, one qualifying row, in an ungranted project |
| `project_id` drifts from the human's choice | a stale row becomes visible | §2a; the obligation is recorded for the curation slice |

---

## 7. Round 1 — BLOCKED, and it corrected my measurement by 136×

| # | finding | outcome |
|---|---|---|
| **B1** | the design removes `admitsUnsourced`, but **`lib/access/provenance.ts` is a third owner** that imports and calls it, and its row type has no `project_id` — literal implementation fails compilation or forks the policy | **CONFIRMED.** The third owner is in scope; the policy became a discriminated union both idioms consume; AC7 asserts one truth table (§3a) |
| **H1** | acceptance seeded only a **task**, so an implementation could gate alias `t` and leave alias `d` open and pass everything — leaking an out-of-scope decision through both legs | **CONFIRMED.** AC1/AC2 now assert both row types in one invocation, plus a sourced positive control |
| **H2** | AC5 could pass while members were narrowed on the **semijoin** owner (`visibleProjectRows`, project-card counts) | **CONFIRMED.** AC6 covers all three owners |
| **H3** | the route destructures to `{ ids }` and the AST guard does not analyse it, so a direct-retrieval test passes while the real route omits the set | **CONFIRMED.** AC8 adds a minted-token HTTP test and a structural guard on the route |
| **M1** | the central inference is right: `effectiveVisibleProjects` IS the delegated authority, and gating on `visibleProjectRows` would let visible content bootstrap access to an ungranted container | **CONFIRMED** — and it says plainly what §0 now says: an operator grant is what makes this useful |
| **M2** | §2a overstated — `source_item_id is null` does not mean "typed by a human" (purge `SET NULL`; the task CLI writes no `created_by`), so the 136 figure was unproven | **CONFIRMED, and the correction is large:** the qualifying population is **1**, not 136. §2a now rests on the combined predicate |
| **M3** | `string \| null` invites a caller to read `null` as "no filter" | **CONFIRMED.** Discriminated union |
| **M4** | build it, do not decline — it establishes correct latent behaviour before tokens exist, and sequencing before TIERRET-1 avoids touching the policy twice | **ACCEPTED** |

**Nothing is built. No code exists for this slice.**
