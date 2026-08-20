# The backfill sweep is O(corpus) when it should be O(backlog) (TICKSTALL-2, slice A)

Status: **approved for build** — two independent cold reads, both BLOCKED, both folded. Codex: the
predicate missed reconcile's MOVE case and the `include`/target-project distinction; the convergence
short-circuit made the speed criterion vacuous. Fable: the predicate was ambiguous about WHICH audience
(keying on the stale `unit.audience` mirror instead of `items.access` would have been a permanent tier
leak), and my livelock argument was false against the code — `drained` means "short page", not "empty
candidate set". · Owner: chetan
· Tier build-with: data-mechanics (the candidate predicate against real Postgres) + unit (the SQL shape guard)

**Deps:** TICKSTALL-1 (#593, merged) — this builds on its budget and durable cursor and must not break either.

**Increment:** ONE PR = give the sweep a NEEDS-WORK predicate so it selects only unpartitioned items
instead of re-walking the whole corpus. No schema change, no new surface, no change to the budget,
cursor or rotation TICKSTALL-1 added. ONE metrics change, stated because the Increment used to claim
none: removing the convergence short-circuit (Decision 3) retires `shortCircuit`, which
`TeamBackfillOutcome` carries and `lib/ingest/scheduler.ts` records per team. It is REMOVED, not
pinned false — a flag frozen at one value is a dead signal readers may still trust.

## Problem

`backfillTeamContext` (`lib/projects/context/backfill.ts`) pages `items` by `id` keyset with **no
predicate on whether the item needs anything done**. Every pass therefore visits every item and calls
`reconcileItemContext` on each — idempotent, so the already-partitioned ones are two no-op ensures
apiece, at a measured ~1.3 s/item.

Measured on prod (3 days, `trigger='scheduler'`, `finished_at - started_at`):

| stage | runs | avg min | max min |
|---|---|---|---|
| `context_backfill` | 114 | **13.5** | **60.6** |
| `github` | 135 | 18.6 | 40.1 |
| `graph_project` | 82 | 9.9 | 12.2 |

And the backlog it is actually working through, measured the same day: **2678 items, 2672 context
units, 2672 active memberships.** So the sweep re-walks 2678 items to partition the **6** that lack a
unit. That is the whole 13.5-minute average.

**What this supersedes.** The TICKSTALL-2 originally sketched in
`docs/design/tick-stall-backfill-budget.md` aimed at the convergence heuristic's grain mismatch plus a
"drained but still unconverged → `ok:false`" alarm. The measurement above **refutes both**: active
memberships (2672) equal distinct units (2672) exactly, so the multi-membership overcount that could
make the predicate unsatisfiable is **not occurring**, the predicate is reporting real work, and that
alarm would fire on a healthy state. Recorded here so it is not rebuilt from the older spec.

## Decision

**1. Define "needs work" as EXACTLY the states `reconcileItemContext` can repair, keyed on the
item's CURRENT `items.access`.** Which audience is load-bearing, and getting it wrong is a permanent
tier leak. There are two: `items.access` (fresh) and `project_context_units.audience` (a mirror, stale
until reconcile re-mirrors it — `lib/projects/context/units.ts`). The precise state this sweep exists
to back up is a tier flip whose `settleReclassification` fan-out failed — and that fan-out is
**best-effort by design** (`lib/ingest/reclassify.ts`) — which leaves `items.access` flipped,
`unit.audience` stale, and the membership in the old project. A predicate keyed on `unit.audience`
sees unit-exists, include-in-(stale)target, nothing-in-(stale)opposite and **never selects it**: for
external→team, team content is served through `external-shared` forever. So: **audience := the item's
current `items.access`, joined in the candidate SQL.**

Re-derived from `lib/projects/context/reconcile-item.ts`, reconcile creates the unit, ensures a
current **include** membership in the **target** system project (`general` for team, `external-shared`
for external), and **closes the membership in the opposite** system project. An item needs work when:

- it has no item-grain `project_context_units` row (`unit_kind='item'`, matching
  `reconcileItemUnit`'s own lookup); **or**
- its unit has no current `include` membership in the target project for its current `items.access`;
  **or**
- its unit still has a current membership (of ANY `decision` — `closeMembershipInto` closes
  regardless) in the **opposite** system project.

"Has a current membership" is not sufficient and neither is "in any project": the enforced read
filters `decision = 'include'` (`lib/access/enforce.ts`), so an `exclude`, or a membership in the
wrong system project, is invisible to readers while looking done to a naive predicate.

**2. The EXCLUDE-SHADOW state is NOT a candidate — and the reason is a poisoned convergence signal,
not a livelock.** An earlier draft of this spec argued that selecting an unrepairable state would make
the candidate set never empty so `drained` would never become true, and the sweep would starve the
chain forever. **That argument is false against the code and is corrected here rather than quietly
dropped**: `drained` means "the page came back short" (`lib/projects/context/backfill.ts`), not "the
candidate set is empty", so N shadows below `batchSize` still yield a short page and `drained: true`
every tick.

The real harm is smaller but still disqualifying: every tick would re-run ~1.3 s of reconcile per
shadow to no effect, and `scanned` would never reach 0 — poisoning the one signal that says the sweep
has caught up, and breaking criterion 4 in prod. So the state stays out of the candidate set.

**Detection instead of repair (the third option, adopted).** Rather than leaving the hole unwatched,
the stage records `meta.excludeShadows` and `meta.retractedUnits` — **null when the count could not be
taken**, because "unreadable" must not be indistinguishable from "none" for a metric whose only job is
making an invisible hole visible.

**A SECOND unrepairable state, found in code review: a RETRACTED unit.** Enforced reads require
`state='active'` (`lib/access/enforce`), but `reconcileItemUnit` only updates audience/sha/occurred_at
on an existing row — it never writes `state`. So a retracted item unit is invisible to readers AND
unfixable by the sweep, exactly like the exclude-shadow, and gets the same treatment: excluded from
candidates, counted, repair carried by EXCLSHADOW-1. Also latent — nothing writes `retracted` today. Detection without
the per-tick cost. Repair is **`EXCLSHADOW-1`** (filed): `ensureIncludeMembership` no-ops on a current
`exclude`, and fixing it is not one line — the partial unique index on
`(team_id, project_id, context_unit_id) where valid_to is null` blocks inserting an include alongside
the exclude, so the exclude must be closed first, which decides whether an operator's explicit
exclusion outranks the system partition. Mitigating and worth stating plainly: **`decision='exclude'`
is currently unwritable** — `lib/projects/context/memberships.ts` is the single writer and only ever
inserts `include` — so this is a latent hole to close before exclusions ship, not a live incident.

**3. REMOVE the convergence short-circuit.** It compares a global `items` count to a global count of
all current memberships, with no `decision`, no target project and no per-item grain, while the schema
permits multiple current memberships per unit across projects and existing tests deliberately preserve
initiative memberships across a move. So `memberships >= items` can be **true while a real candidate
exists** — a pre-existing path that SKIPS work. It also made the speed criterion vacuous.

**Cost, stated correctly** (an earlier draft claimed "one indexed query returning zero rows", which is
wrong): a converged team still costs an O(items) anti-join walk — ~2678 rows plus index probes, using
`items_team_id_id_idx`, `pcu_item_key_idx` and the partial `pcm_current_idx`/`pcm_unit_idx`. That is
milliseconds, and it is **cost-parity with the two exact `count(*)`s it replaces**, which were
themselves O(N). Removal is safe on those grounds, not on the ones first written. Corollary: this
slice's title is honest about reconcile work only — the QUERY work stays O(corpus); what collapses
from ~13.5 minutes to milliseconds is the ~1.3 s-per-item reconcile loop.

`drainTeamContext` never had the short-circuit, so the enforcement flip is unaffected.

**4. The candidate query is raw SQL via `runSql`, and the TEST SEAM is named, not waved at.**
`NOT EXISTS` is not expressible through the `lib/db/pg` builder, and `runSql` bypasses the injected
`DbClient` for the singleton pool, so `.from()`-only fakes cannot exercise the sweep.
`test/context-backfill-cursor.test.ts` is the ONE unit casualty (`test/context-backfill-budget.test.ts`
is pure and survives) — and it exists specifically to pin the error-path cursor ("cursor = last FULLY
succeeded item, so a resume RETRIES rather than skips", the visible-to-nobody guard) **because dm
cannot easily force a mid-batch failure.** Moving it without saying how loses that property silently.
Decision: **keep a unit seam by mocking the `runSql` module** rather than the `.from()` fake
(precedent: `lib/projects/context/fanout-targets.ts` already uses `runSql`), so the error-path
property keeps a home. If that proves impractical during build, the fallback is a dm test with an
injected failing reconcile, named in the PR — never a silent deletion.

**5. The LEGACY CURSOR is bounded by the first DRAIN, not by one tick.** A cursor written by the old
full-corpus walk still filters `id > afterId`, so a candidate whose id sorts below it is invisible
until a pass drains and resets. That is one tick only when the above-cursor candidates fit in a single
short page; a full page advances the cursor instead, a budget truncation persists it, and an
`ok:false` pins it at `lastGood` — each extending the exposure. With today's ~6-item backlog it is one
tick; on a fresh enforcement flip or bulk import it is not. Criterion 6 pins the bound as stated.

**6. Selection-implies-repairable makes fail-stop containment load-bearing** (pre-existing, named).
On `ok:false` the team's turn ends and every candidate above the failed id waits — e.g. a no-widening
refusal surfaced as a failure. That is deliberate (retry-not-skip), but this slice's predicate leans on
"everything selected is repairable", so a persistently-failing candidate is a head-of-line blocker.
Not changed here; named so a reviewer does not have to rediscover it.

## Scope

**In:** the corrected candidate predicate keyed on `items.access` and its `runSql` query; the
`meta.excludeShadows` count; removal of the convergence short-circuit and its `shortCircuit` metric;
tests proving both selection directions plus the shadow, transition and error-path properties; a guard
on the SQL shape.

**Cut, each with the reason:**
- **The exclude-shadow REPAIR → `EXCLSHADOW-1`** (filed; **since BUILT** —
  `docs/design/exclshadow1-repair.md`: auto excludes repair close-first, explicit excludes
  outrank the substrate per classification invariant 3, and this spec's carve-out narrowed to
  explicit shadows only). Detection shipped here; the fix decided the product question.
- **The chain-level problem — `github` at 18.6 min average, and the tick's ~42 min of total average
  work against a 30-minute interval.** This slice removes ~13.5 average minutes of reconcile and still
  does not make the chain fit. Named, measured, left to its own spec.
- **The grain-mismatch fix and the `ok:false` alarm** from the older TICKSTALL-2 sketch — refuted by
  measurement (active memberships equal distinct units exactly).

## Acceptance criteria

1. **data-mechanics** — an item with NO context unit IS selected and ends the pass with a unit plus a
   current `include` membership in the correct target project.
2. **data-mechanics** — a STALE-AUDIENCE tier flip IS selected and moved. The fixture must flip
   `items.access` by raw update and deliberately LEAVE `project_context_units.audience` stale, because
   a fixture that tidies the unit first lets a predicate keyed on the wrong audience pass — the
   permanent-tier-leak state, and the one my first two drafts would have skipped.
3. **data-mechanics** — an item whose only current membership in the target project is
   `decision = 'exclude'` is NOT selected: `scanned === 0` and the shadow item is untouched. The
   load-bearing assertion is `scanned`/no-side-effects, NOT `drained`, which is true either way
   because it only means "the page came back short".
4. **data-mechanics** — a converged corpus reports `scanned: 0` **with the convergence short-circuit
   removed**, so the result is attributable to the predicate rather than to a heuristic that never ran.
5. **data-mechanics** — the TICKSTALL-1 contract survives: a candidate set larger than one batch
   truncates on an expired budget, records a resumable `meta.cursor`, and resumes past the first batch.
6. **data-mechanics** — a candidate whose id sorts BELOW a pre-existing legacy cursor stays unselected
   until the first DRAIN, and is covered on the pass after it — including when a truncation intervenes,
   so the bound is the stated one and not an artefact of a small fixture.
7. **data-mechanics** — the `createdBefore` cutoff still bounds the pass: an item created AFTER the
   cutoff is not selected even when it needs work.
8. **unit** — a guard pins the candidate SQL's shape and is proven non-vacuous: the audience-source
   join on `items.access`, the unit-missing arm ignoring `state`, `decision = 'include'` on the target
   arm, NO decision filter on the opposite arm, `kind = 'system'` on both project resolutions, and
   `team_id` + the cutoff parameterised.
9. **unit** — the error-path cursor property still has a home: a failing reconcile mid-batch leaves the
   cursor at the last FULLY succeeded item so a resume retries rather than skips.

## What would falsify this

- **An item that needs partitioning and is never selected** — the silent, dangerous direction. Watch
  `lib/projects/context/coverage.ts`'s `findUnpartitionedItems`, NOT `items` minus
  `project_context_units`: the naive count is blind to the exclude-shadow and to a wrong-project
  membership by construction, because in both the item HAS a unit. Coverage requires a current
  `include` into a granted project, so it sees all three arms.
- **`meta.excludeShadows` climbing** — the state `EXCLSHADOW-1` owns, now visible instead of silent.
- The measured `context_backfill` stage duration NOT collapsing from ~13.5 average minutes to seconds
  once deployed, which would mean the no-op visits were not the cost after all.
- `drained` never becoming true on a converged corpus, which would mean the candidate query never
  returns empty and the sweep still has no end.
- A TICKSTALL-1 property regressing: a cursor that repeats across passes, or truncation entering the
  failure path.
- The chain still not fitting inside its tick after this ships — **expected**, not a falsifier of this
  slice: `github` alone averages 18.6 minutes. It falsifies only the claim that this slice is
  sufficient, which is why the cut above says so explicitly.
