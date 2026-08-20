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
substrate). **Deps:** none. **Schema: ONE constraint-widening migration** (design round B1: the
`method` CHECK on `project_context_memberships` must admit `'exclude_shadow_repair'` — a
named drop-and-re-add migration + the `schema.sql` mirror + the `MembershipMethod` union;
WIDENING, so the #251 replay-narrowing class does not apply. The partial unique index stays
untouched — it is the close-first mechanism).
**Build with:** fable / high. **Review adaptation, named:** Codex is unavailable until
Aug 22 (usage window, its own error output) — the spec's adversarial cold read falls to
FABLE (the CLAUDE.md plan review), and the diff gets the Fable adversarial review; the PR
records exactly this.

## 0b. Decidables — defaults stated for the design review to attack

- **D1 — the RULING (SCOPED at the design round's B2 — the draft violated classification
  invariant 3): an AUTOMATIC (`mode='auto'`) current exclude in the item's target SYSTEM
  project is an ILLEGAL state that reconcile REPAIRS; an EXPLICIT (any force/manual mode)
  exclude is an operator's recorded decision and is NEVER auto-repaired.** The governing
  spec's own words decide the row's product question: "Manual include/exclude decisions are
  never overwritten by an automatic run" (invariant 3) and "deliberate invisibility exists
  but only as an explicit act" — Phase D's recorded restricted-content intent (force-exclude
  from General + include in a restricted project) MUST survive this sweep; the draft's
  unscoped repair would have silently re-published restricted content team-wide (the
  widening direction, no DB backstop). So: explicit exclusion OUTRANKS the system partition;
  an automatic/orphan exclude — which no automatic writer can legitimately produce (the
  single writer only inserts includes) — does not, and is repaired close-first
  (`valid_to = now`, index-forced order) with `method: 'exclude_shadow_repair'` (the table
  is its own audit trail — no separate audit write). Force excludes stay CARVED OUT of the
  candidate set and COUNTED (selecting an unrepairable state is the slice-A
  burn-a-tick-forever failure). An exclude in a NON-system project is NOT touched (D1c).
- **D1b — the probe stops lying, at hot-path-neutral cost (RESHAPED at the round's M1):**
  the existence probe selects `id, decision, mode` WITHOUT a decision filter (safe: the
  partial index guarantees ≤1 current row per pair) and BRANCHES — `include` → converged
  (today's cost, unchanged); an exclude is explicitly branched, NEVER returned as
  convergence. The rare exclude branch then reads `projects.kind` (+ the mode test) and
  either repairs (D1) or returns a LOUD `ok:false` refusal — no per-call kind read taxes
  the hot path the TICKSTALL work just bounded. Two distinct layers, each with its own pin
  and mutation: the branch (an exclude can never masquerade as convergence) and the repair.
- **D1c — the repair is writer-held, KIND- and MODE-scoped:** both conditions live INSIDE
  `ensureIncludeMembership` (the sole caller targets system projects, but the invariant
  must not depend on caller discipline — the REVOKE-1 precedent). A non-system or non-auto
  exclude gets the loud `ok:false`, never a silent success and never an uninvited repair of
  a deliberate curation decision. THE RACE-LOSER PROBE takes the same branch discipline
  (the round's H2 — an unfiltered re-probe after an index collision would resurrect the
  silent masquerade through the back door for exactly the scoped-out states): the loser
  returns converged ONLY on a current INCLUDE; a current exclude there is the same loud
  refusal. Pinned + mutated in its own right.
- **D2 — RETRACTED units are NOT repaired, stated:** `state != 'active'` units stay
  invisible AND unrepaired by this slice — the removal path WILL own `state` (nothing writes `retracted` today — verified; the
  deferral is latent-class bookkeeping, not a pointer to an existing owner), and auto-reactivating a retracted unit would resurrect removed
  content (the recorded tombstones-are-alive asymmetry). Still counted
  (`meta.retractedUnits`), still EXCLSHADOW-class in the ledger, its repair belongs to the
  removal path's own story.
- **D3 — the carve-out inverts for AUTO shadows only, and the observable is stated
  HONESTLY (the round's H3 corrected the draft):** the candidate SQL selects `mode='auto'`
  target-system excludes; force excludes and retracted units stay carved out and counted.
  The scheduler counts AFTER the pass, so prod never renders a "counted once then drained"
  blip — the honest observables are: (1) `meta.excludeShadows` holds at 0 in the healthy
  state and counts only UNREPAIRABLE (force / retracted-overlap) shadows, and (2) repairs
  are legible as `method='exclude_shadow_repair'` rows in the table itself. A
  retracted∧shadowed item stays in the count indefinitely (unrepairable by design — the
  caveat stated, D2).
- **D4 — order of gates inside `ensureIncludeMembership` is contract:** (1) the
  no-widening tier gate (unchanged, FIRST — a repair must never widen a team-audience unit
  into an external-visible project), (2) the unfiltered probe + BRANCH (D1b), (3) the
  kind+mode scoped repair (close, then insert) or the loud refusal, (4) the plain insert +
  the race-loser convergence with the same branch discipline (D1c). RECORDED ASYMMETRY
  (the round's M3): the pre-existing `closeMembershipInto` opposite-project close is
  decision- and mode-blind — a tier flip already auto-closes even a force exclude on the
  OPPOSITE side. Benign for visibility (closing an exclude serves nothing) but it erases a
  recorded manual decision's row; ACCEPTED here as pre-existing behavior, named as a
  follow-up candidate rather than silently grazed.

## 1. The surface table

| Surface | Today (file:line) | This slice |
|---|---|---|
| `ensureIncludeMembership` (lib/projects/context/memberships.ts:55-95) | probe has no decision filter → a current exclude reads as `created:false` convergence | D4's gate order: unfiltered probe + BRANCH (include → converged; exclude → the rare branch reads `projects.kind` + tests `mode`); auto+system → close-then-insert repair (`method: 'exclude_shadow_repair'`); anything else → loud `ok:false`; the race-loser probe converges ONLY on a current include |
| the candidate predicate (lib/projects/context/backfill-candidates.ts, `CANDIDATE_SQL`) | the exclude-shadow is carved OUT (+ counted) | the carve-out narrows to `mode='auto'` target-system excludes (now selected); force excludes + retracted units stay carved out; counters count only what stays UNREPAIRABLE |
| `meta.excludeShadows` / `meta.retractedUnits` | detection only | unchanged null-when-unreadable contract; healthy prod value is 0 (the scheduler counts post-pass — no "drain blip" is rendered); repairs legible as `method` rows |
| enforced reads (`lib/access/enforce.ts`) | `decision='include'` only | UNCHANGED — the repair makes the substrate satisfy the read, never the reverse |
| schema | the `method` CHECK rejects the repair value | a named drop-and-re-add WIDENING migration + schema.sql mirror + the `MembershipMethod` union |

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
   exits 0 — real Postgres, raw-SQL-planted shadows (the writer cannot mint them): the ROUND
   TRIP — an item whose target-system-project membership is a current `mode='auto'` exclude
   is ABSENT from `visibleItemIds` for a team member, one `reconcileItemContext` pass repairs
   it (exclude closed with `valid_to` set; a current include with
   `method='exclude_shadow_repair'`; exactly one current row on the pair), and the item
   RETURNS to the enforced read (grant → dark → repair → visible); idempotency — a second
   pass changes nothing; the FORCE arm — a planted `mode='force_exclude'`-style exclude in
   the SAME position is NOT repaired, stays counted, and the reconcile returns a loud
   `ok:false` (never `created:false` success — classification invariant 3 honored); the
   ORDER arm — inserting an include while the exclude is current violates the partial index
   (close-first proven, not assumed); the no-widening gate still refuses BEFORE any repair.
2. Same file — the WRITER-DIRECT arms (the round's H1 — through `reconcileItemContext` the
   target is always a system project, so the kind scope is unreachable and its mutation
   would be vacuous): `ensureIncludeMembership` called DIRECTLY with an initiative-project
   target holding a current exclude → no repair, no close, loud `ok:false`; and the
   RACE-LOSER arm (H2): with a current exclude planted and the plain-insert path forced into
   the index collision, the loser returns the loud refusal — never `created:false`
   convergence.
3. Same file — the SWEEP: the candidate predicate SELECTS the planted auto shadow and does
   NOT select the force shadow or a retracted unit; `countUnrepairable` counts the force
   shadow and the retracted unit, reports STRICTLY `{ excludeShadows: 0 }` (exact zero,
   never an error-null satisfying the assertion) once only repairable-and-repaired states
   remain.
4. Mutations, verdicts verbatim in the PR: (a) revert the probe branch (restore the
   unfiltered converged-on-any-row return) → the round-trip arm reddens (the exclude reads
   as convergence again); (b) drop the repair leg (keep the branch) → the round-trip arm
   reddens differently (the loud failure instead of the repair — D1b's layer distinct);
   (c) drop the `kind='system'` condition → the writer-direct initiative arm reddens;
   (d) drop the `mode='auto'` condition → the FORCE arm reddens; (e) revert the race-loser
   branch → the race-loser arm reddens.
5. Full tiers green: `npm test` · dm iso (tolerated: the pre-named TZ artifact + the known
   timeout-flake class, standalone-probed) · `npm run test:http:local` · `npm run check:docs`
   · lint · tsc; migration replay proven by `npm run db:test:up` (the CHECK widened in both
   paths, from-zero + replay); ARCHITECTURE's context-partition row gains the repair
   sentence; the TICKSTALL-2 slice-A spec's carve-out paragraph gains a pointer here.

## 4. Out of scope, named

Phase-D exclusion semantics themselves (this slice guarantees an AUTOMATIC/orphan exclude
can never brick the substrate, and that an EXPLICIT one survives every automatic run —
invariant 3); the `closeMembershipInto` opposite-close mode-blindness (pre-existing,
RECORDED in D4 as an accepted asymmetry — a follow-up candidate); retracted-unit repair (D2 —
the removal path owns `state`); the head-of-line `ok:false` blocker the slice-A spec named
(retry-not-skip is deliberate; a permanently-failing candidate is its recorded shape); any
UI; ADOPTUNIQ-1/ADOPTPLANE-1 and the stale-row hygiene pass (separate records).
