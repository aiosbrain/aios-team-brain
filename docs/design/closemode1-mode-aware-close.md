---
access: team
---

# CLOSEMODE-1 — the audience flip stops erasing human decisions: a mode-aware opposite-close

Deps: EXCLSHADOW-1 (merged #626 — `ensureIncludeMembership`'s decision-aware branch and invariant 3
are the return leg this slice relies on; its D4 recorded this exact asymmetry as the follow-up).
Build-with: fable / high (access substrate; membership is the sole access model, no RLS backstop).
Reviewers: Codex gpt-5.6-sol on the spec and the diff; Fable on the diff.

## 0. What and why

**The defect (recorded, then re-derived as worse than recorded).** `closeMembershipInto`
(`lib/projects/context/memberships.ts:203`, called from `reconcile-item.ts:92` on every audience
flip) closes ALL current rows in the opposite system project **decision- and mode-blind**.
EXCLSHADOW-1 D4 accepted this as "benign for visibility (closing an exclude serves nothing) but it
erases a recorded manual decision's row". The round trip shows it is not benign: flip
external→team and a human's `force_exclude` on external-shared is closed (the record erased); flip
back team→external and the reconciler re-includes the unit into external-shared as a plain
`auto` include — **content a human explicitly excluded from the external tier is externally
visible again, with no trace that the decision ever existed.** The return leg itself is already
safe: `ensureIncludeMembership` refuses to auto-repair any non-auto exclude (invariant 3,
`memberships.ts:86`) — but only if the row is still there to refuse over. The outbound leg deletes
the evidence the return leg's guard needs.

**Measured (prod, read-only, 2026-08-21).** All 2,891 current memberships are
`include / auto / ingestion_project`; zero forced rows, zero excludes, zero closed rows. The
defect is **latent**: the pen that writes forced decisions is Phase D's curation UI (plus the
`force_include` shape EXCLSHADOW-1 made representable). Same class as EXCLSHADOW-1 itself
("unwritable today"), and the same argument applies: make the substrate safe before Phase D hands
humans the pen — after which every erased decision is a real person's recorded intent.

**The visibility split that decides the rule.** Enforced reads serve `decision='include'` rows
only (`lib/access/enforce.ts`); an absent row and a current exclude row are visibility-identical
(nothing served). So:
- Sparing a **non-auto exclude** on the opposite side is visibility-NEUTRAL and preserves the
  record — and the return leg's invariant-3 refusal then does exactly what the human asked.
- Sparing a **non-auto include** is visibility-safe in one direction only: on the widening flip
  (team→external, opposite = General) a surviving forced include on General serves the now-external
  unit to team members — who may see external content anyway; no widening. On the NARROWING flip
  (external→team, opposite = external-shared) a surviving forced include on external-shared would
  keep serving a now-team-audience unit to the external tier — the exact leak the no-widening gate
  exists to prevent. There, visibility wins over the record: the row still closes, and LOUDLY.

## 0b. Decidables — defaults stated for the design round to attack

- **D1 — the rule.** `closeMembershipInto` closes: every `mode='auto'` row (today's behaviour for
  the substrate's own writes), and a non-auto INCLUDE **only when the target of the flip is the
  non-external project** (i.e. the opposite being closed is external-visible and the unit's
  audience is now team — the narrowing case), counted and logged as `overriddenForcedIncludes`
  (a recorded human decision was overridden by the tier wall — that must never be silent).
  Non-auto EXCLUDES always survive. Non-auto includes on the widening flip survive. The function
  gains the caller's context (`{ closingExternalVisible: boolean }` derived in `reconcile-item`
  from which system project is being closed), so the rule lives at the close, not in the caller.
- **D2 — the surviving rows change NOTHING for enforced reads by construction.** A surviving
  forced exclude serves nothing (visibility-identical to absence). A surviving forced include on
  General serves the unit to team members — stated, and pinned by a dm arm against the enforced
  read itself, not just the rows.
- **D3 — the return leg is the EXISTING guard.** On the flip back, `ensureIncludeMembership`
  meets the surviving forced exclude and refuses (invariant 3, already pinned by EXCLSHADOW-1's
  suite); the refusal's `excludeShadows`-style visibility is unchanged. This slice adds no new
  return-leg behaviour — the dm round-trip arm proves the two legs compose: flip out, flip back,
  the human's exclusion still governs and the content is NOT externally served.
- **D4 — counters.** `closed` (as today), `spared` (non-auto rows left standing),
  `overriddenForcedIncludes` (D1's loud case) ride the reconcile-item result → the ingest
  summary's meta the same way the substrate's other counters do; `overriddenForcedIncludes` is a
  recording-gate signal on the ingest side (its analogue of no-silent-caps). Zero new schema.
- **D5 — out of scope: the curation UI's own close path** (Phase D writes and closes forced rows
  with its own audit); **any change to `ensureIncludeMembership`**; the backfill (it writes only
  `auto`); initiative projects (`closeMembershipInto` is already scoped to the one opposite
  system project — unchanged).

## 1. The surface table

| Surface | Change |
|---|---|
| `lib/projects/context/memberships.ts` `closeMembershipInto` | selects `id, decision, mode`; the D1 rule; returns `{ closed, spared, overriddenForcedIncludes }` |
| `lib/projects/context/reconcile-item.ts` | passes `closingExternalVisible`; threads the counters |
| the ingest summary / meta plumbing for reconcile-item's counters | `spared` / `overriddenForcedIncludes` (when non-zero); the latter gates |
| `test/datamechanics/closemode-flip.datamechanics.test.ts` (new) | the arms in §3 |
| `docs/ARCHITECTURE.md` | the context-substrate row's flip prose |
| Schema | **NONE** |

## 2. Mechanism notes

- The close keeps its single-statement shape per class: one update for the auto ids (+ the
  narrowing forced-include ids), none for spared rows. The partial unique index (one current row
  per (team, project, unit)) is untouched — a spared exclude occupies the slot, which is exactly
  what makes the return leg's refusal fire instead of a duplicate insert.
- `closingExternalVisible` is derived from project identity (`other === projects.externalShared`),
  not from a kind read — the caller already holds both system ids.
- EXCLSHADOW-1's repair path (`exclude_shadow_repair`) operates on `mode='auto'` rows only and is
  unaffected — its carve-out already names non-auto rows as out of reach.

## 3. Acceptance criteria (spec-first; exact commands)

1. `npm run test:datamechanics:iso test/datamechanics/closemode-flip.datamechanics.test.ts`
   exits 0 — real Postgres: (a) THE ROUND TRIP: a human `force_exclude` on external-shared
   (`mode='force_exclude'`, `method='manual'`); flip the item external→team → the exclude row
   SURVIVES (`spared 1`, still current), General gains its include; flip back team→external →
   `ensureIncludeMembership` REFUSES (invariant 3), the unit has NO current include in
   external-shared, and the ENFORCED READ for an external principal does not serve the item —
   asserted against `lib/access/enforce`'s read, not just the rows; (b) an `auto` exclude (the
   shadow-repair class) on the opposite side still closes exactly as today; (c) NARROWING with a
   forced INCLUDE on external-shared: the row closes, `overriddenForcedIncludes 1`, loud; the
   external principal stops seeing the item; (d) WIDENING with a forced include on General: the
   row survives (`spared 1`) and team members still see the unit through it; (e) plain flips with
   only auto rows are byte-identical to today (`closed 1, spared 0`, counters zero); (f) the
   counters reach the ingest meta and `overriddenForcedIncludes 1` alone records.
2. Existing dm suites green UNCHANGED (`exclshadow*`, `context-reconcile-item`, backfill,
   enforcement suites) — D5.
3. Mutations, verdicts verbatim in the PR: (a) close forced excludes again (drop the mode filter)
   → AC1(a) reddens; (b) spare the narrowing forced include → AC1(c)'s enforced-read arm reddens;
   (c) close the widening forced include → AC1(d) reddens; (d) drop the
   `overriddenForcedIncludes` gate signal → AC1(f) reddens.
4. Full tiers green (`npm test`, dm iso, `npm run test:http:local`, `npm run check:docs`);
   ARCHITECTURE updated.

## 4. Out of scope, named

- Phase D's curation UI (the writer of forced rows) and its own audited close path.
- Any change to `ensureIncludeMembership` (the return leg is EXCLSHADOW-1's shipped contract).
- Restoring already-erased decisions (prod has none — measured zero non-auto rows ever).
- Initiative-project closes (out of `closeMembershipInto`'s scope by prior ruling).
