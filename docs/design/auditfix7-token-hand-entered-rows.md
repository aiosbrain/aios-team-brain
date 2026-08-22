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

⚠️ **The measurements changed what this slice can honestly claim. Leading with them.**

| | |
|---|---|
| hand-entered **tasks** (`source_item_id is null`) | **136 of 1,254 (11 %)** |
| hand-entered **decisions** | **0 of 83** |
| do hand-entered tasks carry a `project_id`? | **yes — 136/136**, the premise the design rests on |
| how many distinct projects hold them? | **1** — `aios-team-brain`, `kind='source'` |
| is that project **granted** to any group? | **NO** |
| projects on the fleet | **19** total, **2 granted** (`general`, `external-shared` — both system) |
| **delegated tokens in existence** | **0** |

**Three consequences, stated rather than discovered in review:**

1. **The decision case is theoretical.** The New Decision button exists
   (`components/decisions/new-decision-button.tsx`, Decisions page, admins/leads only) but nobody uses
   it; decisions are curated through the CLI (`decision-log.md` → `aios push`), which gives them a
   `source_item_id` and so they were never blocked. **The live class is tasks from the Kanban board**
   (`components/kanban/new-task-dialog.tsx`). Neither surface is Pulse; there is no third-party create
   path (`/api/v1/tasks` and `/api/v1/decisions` are GET-only).
2. **This fix will admit ZERO additional rows on this fleet, and that is CORRECT.** The 136 rows live
   in a project no group is granted, so no token's authority covers it — under the ruling, an agent
   without access to `aios-team-brain` *should not* see tasks typed into it. The inertness is the rule
   working, not the fix failing. **Nobody should expect a behaviour change from merging this.**
3. **The defect is fully latent: there are no delegated tokens.** So this is closing a class before
   agents are used, plus correcting a false justification in the code — not repairing a live
   complaint. Said plainly because the ticket's framing implied otherwise.

## 1. The false claim this slice removes

`lib/access/provenance-sql.ts:42-44` justifies the exclusion:

> *"A delegated token's authority is its attenuated scope; a row with no `source_item_id` cannot be
> tested against that scope, so it can never be shown to one."*

**"Cannot be tested" is false.** Hand-entered rows carry a project:
`app/actions/tasks.ts:98` (`project_id: input.projectId`), `app/actions/decisions.ts:57` — written in
the same insert as `created_by`. Both token-reachable leg queries already `left join projects`
(`lib/query/retrieve.ts:668`, `:691`).

And the plumbing is **half-built**: `visibleItemIds` already returns `projectIds` alongside the ids
(`lib/access/enforce.ts:128-135`, added because "recomputing the oracle a second time would be a
disagreement surface"), while the token path `delegatedVisibleItemIds` (`:145-151`) computes
`effectiveVisibleProjects` and **discards it**.

Whatever is decided, that docstring must stop asserting something untrue — a posture defended by a
false argument will not survive the next reviewer, and this program has now been bitten three times by
prose nobody re-derived.

## 2. The rule

> **The unsourced arm admits a row for a MEMBER at team posture (unchanged), and for a TOKEN when the
> row's `project_id` is in that token's EFFECTIVE project set. Everything else closes.**

Expressed **positively**, for the reason AUDITFIX-1 records: `principal !== "token"` would admit
`undefined`, `null` and any foreign value, and those are real runtime states because `tsconfig.json`
excludes `test/`.

**The member arm is NOT narrowed.** Members today see every hand-entered row at team posture; adding a
project conjunct there would be a silent regression, and the ruling is about agents.

### 2a. Why `project_id` is a sound access input HERE and not in general

⚠️ `lib/access/enforce.ts:179` states, deliberately: *"`tasks.project_id` is the INGEST project, not
an access-control project."* That is true **for ingested rows**, where the column records which
connector project the content arrived through and nothing re-points it when content is re-partitioned.

**For an unsourced row it is a different fact**: there is no ingest, so `project_id` is exactly the box
a human chose in the UI at creation. The conjunct is therefore scoped to the arm where the column means
what the rule needs it to mean, and the sourced arm keeps gating on item membership.

**The residual, named:** nothing re-points a hand-entered row's `project_id` afterwards, and there is no
UI to move one. If a curation surface ever ships, this becomes a column that must be kept honest — that
obligation belongs to the curation slice and is recorded here, not silently inherited.

## 3. The design

`ProvenancePrincipal` stays a two-value discriminator. What changes is that the policy needs a project
set for the token case, so `admitsUnsourced` is replaced by a function returning the **SQL fragment**
for the unsourced arm, or `null` when the arm closes:

```ts
unsourcedArmSql(alias, p, ctx): string | null
//  member + teamPosture     -> "<alias>.source_item_id is null and <alias>.created_by is not null"
//  token  + tokenProjectIds -> the same, AND "<alias>.project_id = any($n::uuid[])"
//  anything else            -> null
```

- **An empty token project set closes the arm** — `= any('{}')` is false for every row, which is the
  correct fail-closed outcome, but the function returns `null` explicitly rather than relying on that,
  so the closed case is a decision rather than an emergent property of SQL.
- `delegatedVisibleItemIds` returns `projectIds` alongside the id set, exactly as `visibleItemIds`
  already does — the same one-substrate-read reason.
- `app/api/v1/query/route.ts:141` forwards it into `enforce` beside `principal`.

### 3a. The guard must move with it

`test/guards/provenance-principal-callsites.test.ts` is an AST walk that pins "every object literal
carrying `visibleItemIds` also carries `principal`" — the M13 property, added because deleting a
forward reddened nothing. **A token project set is now equally load-bearing and equally deletable**:
drop the forward and the arm silently closes for every token, which looks exactly like today's
behaviour and no token test would notice. The guard gains the same carry-it requirement for the new
field, with the historical evasions kept as negative controls.

## 4. Scope

**In:** `lib/access/provenance-sql.ts` (the policy + the arm) · `lib/access/enforce.ts`
(`delegatedVisibleItemIds` returns the project set) · `lib/query/retrieve.ts` +
`lib/query/structured-extras.ts` (forward it) · `app/api/v1/query/route.ts` (supply it) ·
`test/guards/provenance-principal-callsites.test.ts` · `docs/ARCHITECTURE.md`.

**Out:** narrowing the member arm (§2) · moving hand-entered rows into the unit/membership substrate
(the durable answer, and a different slice — it would make this predicate unnecessary rather than
correct) · granting any project (an operator action; it is what would make this fix observable).

## 5. Acceptance

⚠️ **AUDITFIX-1's scar governs this list: an empty-scope test passes trivially.** Every criterion below
uses a **non-empty** token scope, and the pair that matters asserts both directions.

- **AC1 — a hand-entered row in an IN-SCOPE project is VISIBLE to a token (dm):** token scoped to
  project P; a task with `source_item_id is null`, `created_by` set, `project_id = P`. It appears in
  the token's structured results. *This is the behaviour the ruling asks for.*
- **AC2 — a hand-entered row in an OUT-OF-SCOPE project stays INVISIBLE (dm):** same token, same
  shape, `project_id = Q ∉ scope`. Absent. **Without AC2, AC1 is satisfied by deleting the arm's
  gate entirely** — which is the AUDITFIX-1 failure repeated.
- **AC3 — an EMPTY-scope token sees no hand-entered rows (dm):** the fail-closed floor, and the
  criterion that must NOT be the only one.
- **AC4 — a row with `created_by` null stays invisible to a token even in scope (dm):** the existing
  authorship conjunct is not weakened by the new one.
- **AC5 — MEMBER behaviour is unchanged (dm):** a member at team posture still sees a hand-entered row
  whose project is in NO granted set — the exact rows prod holds today (136 in an ungranted project).
  *This is the regression this slice is most likely to cause.*
- **AC6 — the SOURCED arm is untouched (dm):** a token still sees an ingested row via `visibleItemIds`
  and still cannot see one outside its item set, with the new field present.
- **AC7 — the forward is CARRIED, not merely available (unit guard):** deleting the token project set
  from a ctx literal fails the build. Mutation-verified, because the M13 lesson is that an absent
  forward closes the arm and therefore reddens nothing.
- **AC8 — the arm closes on an absent/foreign principal (unit):** `undefined`, `null` and a foreign
  string each yield `null` from `unsourcedArmSql`. The positive-policy property AUDITFIX-1 shipped.

**What no criterion claims:** that any row becomes visible on this fleet. §0 measures why none will.

## 6. Risks

| risk | direction | mitigation |
|---|---|---|
| The member arm is narrowed by accident | 136 rows vanish for every human | AC5 asserts it directly, on the real shape |
| The new forward is added but not carried | every token silently keeps today's behaviour | AC7 + the AST guard; an absent forward reddens nothing on its own |
| `project_id` drifts from what a human chose | a stale row becomes visible or invisible | §2a: no writer re-points it today, and the obligation is recorded for the curation slice |
| Someone reads this as fixing a live complaint | wasted expectation | §0 states there are zero tokens and zero in-scope rows |
