---
access: team
---

# EXCLSHADOW-1 — close the exclude-shadow before exclusions ship

## 0. What and why

**What:** an item can be permanently INVISIBLE to every enforced read and unrepairable by any
sweep: a current `decision='exclude'` membership in the item's target SYSTEM project makes
`ensureIncludeMembership` a silent no-op (its existence probe has NO decision filter,
`lib/projects/context/memberships.ts:71-78`) while `lib/access/enforce.ts:66` serves only
`decision='include'`. This slice makes the state (1) impossible to mistake for convergence and
(2) repairable by the sweep — before any Phase-D exclusion feature can ever write it.

**Why now (recorded):** the EXCLSHADOW-1 row was filed BY NAME from TICKSTALL-2 slice A
(`docs/design/backfill-sweep-o-backlog.md` — "Cut, each with the reason"), which shipped the
DETECTOR (`meta.excludeShadows`) and deliberately carved the state OUT of its candidate set
because selecting something reconcile cannot repair burns a tick forever. The product
question the row names — does an operator's exclusion outrank the system partition? — has a
principled answer that makes the repair safe to build now (D1).

**Measured terrain (prod, read-only, 2026-08-20):** 2,816 current memberships — ALL
`decision='include'`; 2,816 units — ALL `state='active'`; zero exclude-shadows, zero
retracted units. The state is UNWRITABLE today (`memberships.ts` is the single writer and
only ever inserts `'include'` — verified by the row's own grep and re-verified): reachable
only by raw SQL or a future exclusion feature. **Blast radius: zero rows change on deploy.**
This is latent-hole closure, not incident response.

**Ticketing:** row `EXCLSHADOW-1`; PR carries `AIOS-Work: EXCLSHADOW-1`.
**Governing records:** the TICKSTALL-2 slice-A spec (the carve-out + counters);
`docs/specs/project-context-classification-v1.md` §11 (the system partition is the access
substrate). **Deps:** none. **Schema: NONE** (the partial unique index
`(team_id, project_id, context_unit_id) where valid_to is null` is the mechanism, untouched).
**Build with:** fable / high. **Review adaptation, named:** Codex is unavailable until
Aug 22 (usage window, its own error output) — the spec's adversarial cold read falls to
FABLE (the CLAUDE.md plan review), and the diff gets the Fable adversarial review; the PR
records exactly this.

## 0b. Decidables — defaults stated for the design review to attack

- **D1 — the RULING: nothing may exclude an item from its audience's SYSTEM project; a
  current exclude there is an ILLEGAL state that reconcile REPAIRS.** The system partition
  (general/external-shared) is the access substrate — a current include there is what makes
  an item readable by ANYONE (`enforce.ts`); "excluded from the substrate" does not mean
  "curated out of a collection", it means invisible-to-everyone-forever. Phase-D exclusion
  semantics, whenever they ship, operate on INITIATIVE projects (curation); the substrate is
  not a curation surface. So `ensureIncludeMembership` repairs: on finding a current
  EXCLUDE for `(project, unit)` where the target project is `kind='system'`, it CLOSES the
  exclude (`valid_to = now` — the partial unique index forces exactly this close-first
  order) and inserts the include with `method: 'exclude_shadow_repair'` (the repair is
  legible in the table's own history — no separate audit write, matching reconcile's
  existing behavior). An exclude in a NON-system project is NOT touched (D1c).
- **D1b — the probe stops lying regardless: the existence check gains
  `.eq("decision", "include")`.** Two distinct properties, deliberately separate: the probe
  filter makes an exclude UNABLE to masquerade as convergence (even if the repair leg were
  deleted, reconcile would now attempt the insert and FAIL LOUDLY on the partial index
  instead of reporting `created:false` success — a red error beats a silent hole); the
  repair leg (D1) then makes the loud failure unnecessary. Each layer gets its own pin and
  its own mutation.
- **D1c — the repair is writer-held and KIND-scoped:** the `kind='system'` condition lives
  INSIDE `ensureIncludeMembership` (one bounded read of `projects.kind` — the sole caller
  today targets system projects, but the invariant must not depend on caller discipline;
  the REVOKE-1 precedent). A future initiative-targeting caller finding an initiative
  exclude gets today's behavior — probe-filtered, so a loud index failure, never a silent
  success and never an uninvited repair of a deliberate curation decision.
- **D2 — RETRACTED units are NOT repaired, stated:** `state != 'active'` units stay
  invisible AND unrepaired by this slice — the removal path (`lib/ingest/purge` + the
  rules layer) owns `state`, and auto-reactivating a retracted unit would resurrect removed
  content (the recorded tombstones-are-alive asymmetry). Still counted
  (`meta.retractedUnits`), still EXCLSHADOW-class in the ledger, its repair belongs to the
  removal path's own story.
- **D3 — the candidate carve-out INVERTS for the exclude-shadow:** now that reconcile can
  repair it, the shadow becomes SELECTABLE (the slice-A carve-out existed precisely because
  it was not). The retracted-unit carve-out STAYS (D2 — still unrepairable by design). The
  `excludeShadows` counter keeps counting at detection (pre-repair), so the healthy
  end-state is: a planted shadow is counted once, repaired in the same pass, and the next
  pass counts zero — the counter's drain IS the observable convergence.
- **D4 — order of gates inside `ensureIncludeMembership` is contract:** (1) the no-widening
  tier gate (unchanged, FIRST — a repair must never widen a team-audience unit into an
  external-visible project; the repair leg sits behind it), (2) the include-filtered probe,
  (3) the kind-scoped exclude repair (close, then insert), (4) the plain insert + the
  existing race-loser convergence. The race-loser probe (the pcm_current_idx catch) also
  gains the include filter — a racing exclude must not read as a satisfied include.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| `ensureIncludeMembership` (lib/projects/context/memberships.ts:55-95) | probe has no decision filter → a current exclude reads as `created:false` convergence | D4's gate order: include-filtered probe; kind-scoped close-then-insert repair (`method: 'exclude_shadow_repair'`); race-loser probe include-filtered too |
| the candidate predicate (lib/projects/context/backfill-candidates.ts, `CANDIDATE_SQL`) | the exclude-shadow is carved OUT (+ counted) | the carve-out INVERTS — the shadow is selected; the retracted carve-out stays; counters unchanged at detection |
| `meta.excludeShadows` / `meta.retractedUnits` | detection only | unchanged meaning; the shadow count now DRAINS (counted → repaired same pass → zero next pass) |
| enforced reads (`lib/access/enforce.ts`) | `decision='include'` only | UNCHANGED — the repair makes the substrate satisfy the read, never the reverse |

## 2. Mechanism notes

- **Close-first is index-forced, not convention:** the partial unique index on
  `(team_id, project_id, context_unit_id) where valid_to is null` refuses a second current
  row — the repair MUST stamp `valid_to` on the exclude before inserting the include, and a
  test proves the index refuses the wrong order (the mechanism, not just the outcome).
- **History preserved:** the closed exclude row stays (with its `valid_to`), the repair
  include carries its own `method` — the table is its own audit trail, consistent with every
  other membership transition.
- **Fail directions:** `projects.kind` read error → no repair, the plain insert path runs
  and fails loudly on the index (never a silent skip); close succeeds but insert fails → the
  exclude is gone and the include is absent — the item is now ARM-2-selectable by the
  candidate predicate (no current include in target), so the next pass completes the repair;
  stated, not silent.
- **No cascade, no backfill:** prod has zero rows in the state; nothing retro-changes.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/exclude-shadow-repair.datamechanics.test.ts`
   exits 0 — real Postgres, raw-SQL-planted shadows (legal from tests; the writer cannot mint
   them): the ROUND TRIP — an item whose target-system-project membership is a current
   exclude is ABSENT from `visibleItemIds` for a team member (the observable hole), one
   `reconcileItemContext` pass repairs it (exclude closed with `valid_to` set, a current
   include with `method='exclude_shadow_repair'` exists, the partial index holds exactly one
   current row), and the item RETURNS to the enforced read (grant → dark → repair → visible);
   idempotency — a second pass changes nothing; the INITIATIVE arm — a planted exclude on an
   initiative-project membership is NOT repaired and NOT closed by a reconcile of the same
   item; the ORDER arm — inserting an include while the exclude is current violates the
   partial index (the close-first mechanism proven, not assumed); the no-widening gate still
   refuses BEFORE any repair (a team-audience unit + external-visible target).
2. Same file — the SWEEP: the candidate predicate SELECTS the planted shadow (it was carved
   out before); `countUnrepairable`/`meta.excludeShadows` counts it at detection and counts
   ZERO on the pass after the repair (the drain); a retracted unit is still NOT selected and
   still counted.
3. Mutations, verdicts verbatim in the PR: (a) drop the probe's new `decision:'include'`
   filter → the round-trip dm arm reddens (the exclude reads as convergence again); (b) drop
   the repair leg (keep the filter) → the round-trip arm reddens differently (the loud index
   failure — D1b's layer proven distinct); (c) widen the repair past `kind='system'` → the
   initiative arm reddens.
4. Full tiers green: `npm test` · dm iso (tolerated: the pre-named TZ artifact + the known
   timeout-flake class, standalone-probed) · `npm run test:http:local` · `npm run check:docs`
   · lint · tsc; ARCHITECTURE's context-partition row gains the repair sentence; the
   TICKSTALL-2 slice-A spec's carve-out paragraph gains a pointer to this slice.

## 4. Out of scope, named

Phase-D exclusion semantics themselves (initiative-project curation — this slice only
guarantees they can never brick the substrate when they arrive); retracted-unit repair (D2 —
the removal path owns `state`); the head-of-line `ok:false` blocker the slice-A spec named
(retry-not-skip is deliberate; a permanently-failing candidate is its recorded shape); any
UI; ADOPTUNIQ-1/ADOPTPLANE-1 and the stale-row hygiene pass (separate records).
