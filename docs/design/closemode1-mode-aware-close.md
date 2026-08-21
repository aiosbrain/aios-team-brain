---
access: team
---

# CLOSEMODE-1 — the audience flip stops erasing a human's exclusion (re-scoped at design review: forced-include survival was DECLINED)

Deps: EXCLSHADOW-1 (merged #626 — invariant 3 and the decision-aware return leg; its D4 recorded
this asymmetry as the follow-up). Build-with: fable / high (access substrate; membership is the
sole access model, no RLS backstop). Reviewers: Codex gpt-5.6-sol on the spec and the diff; Fable
on the diff.

## 0. What and why

**The defect.** `closeMembershipInto` (`lib/projects/context/memberships.ts:203`, called from
`reconcile-item.ts:92` on every audience flip) closes ALL current rows in the opposite system
project decision- and mode-blind. The round trip makes it an access defect: flip external→team and
a human's `force_exclude` on external-shared is closed — its **continuing authority ends** (the
row survives historically under `valid_to`, but nothing enforces it any more — the round-1 H3
correction to this spec's own "record erased" wording); flip back team→external and the
reconciler re-includes the unit as a plain `auto` include: **content a human explicitly excluded
from the external tier is served externally again.** The return leg is already safe —
`ensureIncludeMembership` refuses to auto-repair any non-auto exclude (invariant 3,
`memberships.ts:86`) — but only if the row is still current to refuse over. The outbound leg ends
the authority the return leg's guard needs.

**Measured (prod, read-only, 2026-08-21).** All 2,891 current memberships are
`include / auto / ingestion_project`; zero non-auto rows. Latent until Phase D's curation UI hands
humans the pen — the EXCLSHADOW-1 precedent ("unwritable today") for fixing the substrate first.

**What the design round DECLINED, and why (recorded so it is not re-proposed).** The draft also
spared non-auto INCLUDES (on the widening flip) and closed them "loudly" on the narrowing one.
Codex round 1 killed both halves: (1) a surviving opposite-project row becomes a PERMANENT
backfill candidate (`backfill-candidates.ts:75` selects any opposite membership; only a
target-project forced exclude is carved out at `:94`) — reconcile re-visits it every pass, the
"burn a tick forever" class EXCLSHADOW-1 explicitly rejected; (2) a surviving General forced
include IS a widening for a General-scoped delegated token (`oracle.ts:106` intersects scope with
project ids) and diverges from the graph's single-system-home model (`project.ts:866`,
`fanout-targets.ts:68` — no dual-system projection exists); (3) the promised "loud override" has
no durable recording path on the immediate reclassify route (`reclassify.ts:114` and the items
route discard reconcile detail; only the scheduler backfill has meta plumbing; the audit write is
best-effort by design). Force-mode semantics on SYSTEM projects, dual-system graph projection and
a durable override event are Phase D design work. **This slice ships the one direction that is
sound today: non-auto EXCLUDES survive the flip.** Sparing an exclude is visibility-NEUTRAL by
the serving readers' own shape (every one filters `decision='include'`: `enforce.ts:61,:368`,
`provenance-sql.ts:58`, `inspect.ts:82`, `fanout-targets.ts:57`, `coverage.ts:88` — verified in
round 1), preserves the human's authority, and makes the round trip compose with invariant 3.

## 0b. Decidables — defaults stated for the design round to attack

- **D1 — the rule.** `closeMembershipInto` closes every current row in the opposite system project
  EXCEPT `decision='exclude' AND mode <> 'auto'` (a human's standing exclusion). No direction
  parameter, no caller context: includes of any mode close exactly as today (force-include
  semantics on system projects are undefined until Phase D — closing one is today's shipped
  behaviour, kept); auto excludes (the shadow-repair class) close as today. Returns
  `{ ok, closed, spared }`.
- **D2 — a spared exclude is NOT a candidate-maker, scoped to ARM 3 (round 1 BLOCKER 1; round 2
  H1).** The exception narrows exactly the arm that fires on "an opposite-project membership
  exists" (ARM 3) — never a global per-item exclusion, which would suppress ARM 2 when the TARGET
  include is genuinely missing. One shared SQL expression `is_protected_exclude`
  (`decision='exclude' and mode <> 'auto'`) is defined once and used twice: ARM 3 becomes
  `opposite AND NOT is_protected_exclude`; the existing target-project carve-out is the same
  expression on the target side. The two cannot match the same row (different project ids); a
  missing target include still activates ARM 2 (pinned). Survivor→not-a-candidate is pinned by
  two consecutive `backfillTeamContext` passes both returning `scanned: 0` for the settled unit
  (round 2 L: deleting the ARM-3 exception makes both return `scanned: 1` — reconcile succeeds
  while re-sparing forever, the burn-a-tick shape).
- **D3 — the return leg is the EXISTING guard, and the STANDING-REFUSAL state it produces is
  intended and pinned (round 2 H2).** Target placement precedes the opposite close
  (`reconcile-item.ts:87`), so on the flip back `ensureIncludeMembership(external-shared)` meets
  the spared exclude and invariant 3 refuses → `reconcileItemContext` returns `ok:false` — and
  that is the DESIGNED terminal state, not an error to converge away: the human said no; the unit
  keeps its (now team-only) General include from the outbound leg; the immediate reclassify path
  warns best-effort; the backfill does NOT retry (the existing target-exclude carve-out). The dm
  round-trip arm pins all four: `ok:false` on the return flip, the surviving General include, no
  repeated backfill visit, and `canSeeItem` for an external principal NOT serving the item.
  ACKNOWLEDGED (round 2 M2): after the flip back the survivor is a TARGET-project explicit
  exclusion and counts in `excludeShadows` every pass — consistent with EXCLSHADOW-1's
  operator-attention semantics ("a human decision is standing here"), pinned so a permanently
  non-zero count is not misread as a failed repair.
- **D4 — counters, honestly plumbed (round 2 M1 corrected the carriers).** `spared` rides
  `closeMembershipInto` → `reconcileItemContext`'s result → `BackfillResult` →
  `TeamBackfillOutcome` → the scheduler backfill's existing meta (when non-zero); the backfill
  DOES exercise the close (it reconciles every selected candidate — `backfill.ts:81`), so the
  plumbing is real, not decorative. The immediate path's log lives in `settleReclassification`
  (`lib/ingest/reclassify.ts`), the reclassify-specific caller — not inside the shared
  `reconcileItemContext`. dm pins the first two hops; the scheduler's nested meta writer is
  pinned by a source-shape assertion (it is not callable from dm). NO recording-gate claim:
  sparing is the quiet, correct direction. Zero new schema.
- **D5 — out of scope, named:** force-include semantics on system projects (reject / suspend /
  override-event — a Phase D design decision, recorded in round 1's terms); dual-system graph
  projection; the curation UI's own audited close; restoring already-ended authority (prod has
  none); initiative projects (unchanged scope).

## 1. The surface table

| Surface | Change |
|---|---|
| `lib/projects/context/memberships.ts` `closeMembershipInto` | selects `id, decision, mode`; spares non-auto excludes; returns `{ ok, closed, spared, error? }` |
| `lib/projects/context/backfill-candidates.ts` | ARM 3 gains `NOT is_protected_exclude` via one shared expression (D2) |
| `lib/projects/context/reconcile-item.ts` | threads `spared` |
| `lib/projects/context/backfill.ts` | `spared` summed into `BackfillResult`/`TeamBackfillOutcome` |
| `lib/ingest/reclassify.ts` `settleReclassification` | logs `spared` non-zero on the immediate path |
| `lib/ingest/scheduler.ts` (backfill leg) | `spared` into its existing meta (when non-zero); source-shape pinned |
| `test/datamechanics/closemode-flip.datamechanics.test.ts` (new) | §3 arms |
| `docs/ARCHITECTURE.md` | the context-substrate row's flip prose |
| Schema | **NONE** |

## 2. Mechanism notes

- The close stays one select + one update; the spared ids are simply omitted from the update's
  id list. The partial unique index is untouched — the spared exclude occupies the
  (team, project, unit) slot, which is exactly what makes the return leg's refusal fire instead
  of a fresh insert.
- The candidate predicate's new exception mirrors the close rule textually in ONE place each
  (SQL and TS) with a shared comment naming the other — the drift hazard is stated; a dm arm
  covers the pair (a spared row is neither closed nor visited).
- EXCLSHADOW-1's repair path cannot touch a spared row (invariant 3 refuses non-auto before
  repair — `memberships.ts:140`; the target-shadow carve-out matches `mode <> 'auto'`).

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/closemode-flip.datamechanics.test.ts`
   exits 0 — real Postgres (forced rows planted by raw SQL, the EXCLSHADOW suite's sanctioned
   pattern): (a) THE ROUND TRIP: `force_exclude` (`method='manual'`) on external-shared; flip
   external→team → `spared 1`, the exclude still CURRENT, General gains its include; flip back
   team→external → invariant 3 refuses, no current include in external-shared, and `canSeeItem`
   for an external principal does NOT serve the item (the enforced read, not just rows);
   (b) an `auto` exclude on the opposite side closes exactly as today (`closed 1, spared 0`);
   (c) a forced INCLUDE on the opposite side closes exactly as today (`closed 1` — kept
   behaviour, Phase D owns its semantics); (d) plain auto flips behave exactly as today — this
   fence excludes nothing: the auto path is already shipped and pinned by the exclshadow and
   reconcile-item suites; (e) D2: with the spared exclude standing, TWO consecutive
   `backfillTeamContext` passes both return `scanned: 0` for the settled unit and the spared row
   stays current; a unit with a genuinely MISSING target include still gets visited (ARM 2 not
   suppressed); (e2) D3: the return flip returns `ok:false` (the standing refusal), the General
   include survives, and `excludeShadows` counts the standing target-side exclusion (pinned as
   intended, not a failed repair); (f) `spared` reaches `reconcileItemContext`'s result and
   `BackfillResult`/`TeamBackfillOutcome` (dm), and the scheduler's meta writer names it
   (source-shape assertion).
2. Existing dm suites green UNCHANGED (`exclude-shadow-repair`, `context-reconcile-item`,
   backfill, enforcement suites).
3. Mutations, verdicts verbatim in the PR: (a) close spared excludes again (drop the mode/decision
   exception) → AC1(a) reddens; (b) spare auto excludes too → AC1(b) reddens; (c) spare forced
   includes → AC1(c) reddens; (d) drop the candidate-predicate exception → AC1(e) reddens.
4. Full tiers green (`npm test`, dm iso, `npm run test:http:local`, `npm run check:docs`);
   ARCHITECTURE updated.

## 4. Out of scope, named

- Force-include semantics on system projects, dual-system graph projection, a durable override
  event — Phase D design (round 1's H1/H2/H3 name the constraints it must satisfy).
- The curation UI's own audited close path.
- Any change to `ensureIncludeMembership`.
- Initiative-project closes (prior ruling; unchanged).
