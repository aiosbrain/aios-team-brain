# Nothing enforces the invariant the two adoption fixes exist to protect — ADOPTINV-1

**Status:** spec, draft 3 (built). Draft 1 was BLOCKED by both reviewers. The sharpest finding was that draft 1's
own mutation criterion **could not go red** — it named the wrong file, and the mutant it described makes
the adapter refuse *everything*, so no duplicate forms and the test stays green. · **Date:** 2026-08-18 ·
**Owner:** Chetan · **Task:** `ADOPTINV-1`
**Follows:** [`pm-sync-declared-issue-adoption.md`](./pm-sync-declared-issue-adoption.md) (`ADOPTDECL-1`,
#581) and [`pm-sync-footer-adoption-scope.md`](./pm-sync-footer-adoption-scope.md) (`ADOPTFOOT-1`, #588).
**Unblocks:** `ADOPTUNIQ-1` — proves the code cannot violate the constraint *before* the constraint is added.
**Code:** `test/datamechanics/` only, unless §4.1 fires.

---

## 0. What is wrong

`ADOPTDECL-1` and `ADOPTFOOT-1` between them shipped their tests across the unit and data-mechanics
tiers. Every one of them pins **a rung's decision** — the footer rung's scope, the declared rung's
error, the ownership refusal, the single-writer guard on the declared column.

**Not one of them asserts the outcome those rungs exist to produce:** that after a projection,
`task_pm_links` does not contain two rows in one team, for one provider, pointing at the same
`provider_resource_id`. Both reviewers went looking for a counter-example and neither found one. Two
specifics worth recording, because they show how close the existing tests get without arriving:

- `test/datamechanics/pm-sync-inbound.datamechanics.test.ts:554` asserts `toHaveLength(1)` for links
  filtered `.eq("row_key", "ENG-1")` — keyed on **row_key**, so two links with *different* row keys
  sharing one `provider_resource_id`, which is the incident's exact shape, pass it.
- `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts:146` asserts the **mock's**
  recorded calls, never the scaffold row's stored id. A `persistSuccess` bug writing `issue-444` into
  the scaffold's link while the adapter dutifully created a new issue would stay green today.

**And the DB cannot cover it either.** `postgres/schema.sql:1280` carries only
`unique (team_id, project_id, row_key, provider)`; lines 1282-1283 add plain, non-unique indexes, and
no migration adds more. `ADOPTUNIQ-1` would add
`unique (team_id, provider, provider_resource_id) where provider_resource_id is not null`, but it
cannot ship: a prod query on **2026-08-18** found exactly one violating group — three links on
`AIO-444` — and `npm run pg:schema` is Railway's `preDeployCommand`, so an index that fails to build
takes the release down. (That count is a dated measurement taken outside this repo and is not
verifiable from it.) Reconciling those rows is an outward-facing decision that is still open.

So the invariant is enforced by **nothing** in CI, and will stay that way until a decision with no
deadline. That is the gap this slice closes.

## 1. The decision

Add a **data-mechanics** test that drives the real projector through the collision shapes that actually
occurred, and asserts the **table state** after each.

The invariant, expressed once and reused — note the `provider` term, which draft 1 omitted from the SQL
while claiming it in prose:

```sql
select provider, provider_resource_id, count(*) from task_pm_links
where team_id = $1 and provider_resource_id is not null
group by provider, provider_resource_id having count(*) > 1
```

It must match `ADOPTUNIQ-1`'s index exactly, or it does not pre-verify it. Without `provider`, a Plane
link and a Linear link sharing an id string are a false positive against a constraint that would
permit them.

**Team-wide is the right scope, verified rather than assumed:** both owner sets in production code —
the projector's (`lib/pm-sync/project.ts:312-317`) and the inbound path's (`lib/pm-sync/inbound.ts:402-412`)
— are already team-wide across projects, including the `linear-*` mirror project. The code already
treats team-wide uniqueness as intended, so the test is not inventing a rule the product does not want.

**Why data-mechanics and not unit** (CLAUDE.md §4): the invariant is a property of *stored rows across
projects*, and the in-memory fake has no constraints and no real grouping.

## 2. Acceptance criteria

Spec-first: written from what the product must guarantee. **If any goes red it has found a live path
the two previous fixes did not close, which is a result, not a setback** — see §4.

### The invariant holds

- `npm run test:datamechanics:iso test/datamechanics/pm-link-uniqueness.datamechanics.test.ts` passes,
  and every scenario ends with the §1 query returning **zero rows**.
- **The incident's shape:** three rows keyed `TT1` in three different projects of one team, projected in
  **three back-to-back per-project runs** — not one run. `projectAllTasks` is `(team, project)`-scoped
  (`lib/pm-sync/project.ts:432-437`), so a single run cannot span three projects; draft 1's "all
  projected in the same run" was impossible. Each run's bootstrap listing must reflect the previous
  run's state. Only the first row ends up owning the issue.
- **Rung 1 missing because the issue was deleted** at the provider, run twice in succession, ends with
  no duplicate group.
- **A declared id already owned by another row's link** does not end up shared, and the declaring row
  records an error (`persistError`, `lib/pm-sync/project.ts:354-357`) rather than inventing a second
  issue. The owned issue in this fixture **must carry no `aios-ext` footer**: `linear.ts:381-386`
  throws on a footer naming another row *before* the `ownedResourceIds` check at `:388-395` is reached,
  so a footered fixture would prove the wrong path — and the prod shape is footerless, which
  `linear.ts:377-379` says in as many words.
- **The inbound writer is covered too** (§3 explains why it is in): a mirror-adopt of an issue a
  workspace link already owns does not produce a second link. The insert at
  `lib/pm-sync/inbound.ts:448-457` conflicts on **row identity only**, so the conflict clause is not
  what protects the invariant — the team-wide candidate filter at `inbound.ts:405-414`
  (`!ownedIds.has(it.id)`) is. That filter is the mutation target for this scenario. (Draft 2 named the
  conflict clause as the protection, which was wrong; round-2 review caught it.)
  **Two fixture preconditions, both learned by a SURVIVING mutation rather than by reading:** the
  integration config must set `inboundApply: true` or `runInboundForTeam` returns an empty result at
  `inbound.ts:526` before reading an issue, and a **mirror task** must exist under the
  `linear-<teamKey>` project or the candidate is skipped as "no mirror task yet" (`:416-428`). Missing
  either, the scenario is green and proves nothing.

### The test is not green by construction

- **Positive anchor per scenario:** each scenario asserts that the projection actually *reached the
  adapter for the row under test* — a recorded issue mutation/update for that row, and its report
  status not `skipped`. "The fetch mock was called" is **not** sufficient: `projectRows` calls the
  adapter's `prepare` before any row projects (`lib/pm-sync/project.ts:401`), so bootstrap alone
  satisfies it even when every row short-circuits at `:284`.
- **Count anchor:** each scenario asserts the expected number of links with a non-null
  `provider_resource_id` exists, so a scenario that silently projected nothing cannot pass.
- **The inverse control:** insert two links that deliberately share `(team_id, provider,
  provider_resource_id)` and assert the §1 query **returns** that group. **Note for whoever lands
  `ADOPTUNIQ-1`:** this control deliberately writes the exact state that index forbids, so the insert
  will start failing the day the index ships. That is expected, not a regression — convert it then to
  asserting a unique-violation error. Draft 1's "the query returns
  zero rows on a team with no links" proved the opposite of what it claimed — that the query passes on
  nothing, which is the vacuity, not a control against it. The surviving mutant it missed is any query
  typo that matches nothing at all.
- **Mutation — the right mutant, and why the obvious one is wrong.** Re-key the self-exclusion at
  `lib/pm-sync/project.ts:320` to `row_key` alone (drop the `o.project_id === row.project_id &&` term):
  that is the live bug's exact shape, it drops the true owner from the owner set, and all three `TT1`
  rows adopt `issue-444`. The **invariant assertion specifically** must be the one that reddens.
  Do **not** use draft 1's mutant ("remove the ownership refusal from `project.ts`"): the refusal is not
  in that file, and both refusals (`linear.ts:360-362`, `:389-395`) **fail closed** on
  `ownedResourceIds === undefined`, so removing the owner set makes the adapter refuse *everything* —
  every row creates its own issue, no duplicate forms, and the test stays green.
- **What the deleted-issue scenario does NOT guard, stated so nobody deletes its sibling.**
  Reintroducing `ADOPTFOOT-1`'s original load gate (owner set loaded only when a declaration exists and
  the resource id is null) survives this whole file: the refusals fail CLOSED, so an unloaded set means
  over-refusal, and over-refusal preserves the invariant. What kills that mutant is the RECOVERY case in
  `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts`. This file does not replace it.
- **A mutation per scenario, not one for the suite.** The mutant above only exercises the footer path,
  so a deleted-issue scenario seeded with an unchanged `projection_fingerprint` would short-circuit and
  be silently vacuous while the suite still reddens elsewhere. Each scenario carries its own positive
  anchor for this reason.

### Fixture hygiene

- **The create mock must mint unique ids.** The two adoption dm tests' mock returns a constant
  `id: "brand-new"` for every `issueCreate`. In the three-`TT1` scenario two rows are refused and each
  mints its own issue, so that mock makes both links persist the same id and the invariant query flags
  a duplicate that is a **pure fixture artifact**. Use the `li-${++n}` pattern already in
  `test/datamechanics/pm-sync-refusal.datamechanics.test.ts:48`.
- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run check:docs` all pass.

## 3. Scope

**In:** one new file, `test/datamechanics/pm-link-uniqueness.datamechanics.test.ts`, plus an
`docs/ARCHITECTURE.md` line if the drift guard requires one.

**The inbound writer is IN, not fenced out.** Draft 1 justified the slice with "the rungs are not the
only writers of that column" and then tested only the outbound projector — fencing out the second
writer with no stated destination. `adoptInbound` (`lib/pm-sync/inbound.ts:448`) writes the column
directly under its own ownership logic, so one inbound scenario is part of this slice.

**Deliberately out, each with a destination:**

- **The DB constraint itself** (`ADOPTUNIQ-1`) — blocked on the production reconciliation, a human,
  outward-facing call. This slice is the *interim* enforcement and does not replace it: a test binds
  this repo's code paths, an index binds the data whatever writes it.
- **Repairing the three live links.** No production write happens here. `ADOPTUNIQ-1`.
- **A runtime health signal for duplicate links.** It would go red immediately on the known violation
  and stay red until that decision is made, and this repo has been bitten six times by a banner that
  cries wolf (`docs/design/staleness-threshold-fit.md`). The obvious middle option — baseline or
  allowlist the one known group — is real, and is deliberately deferred with the repair rather than
  rejected: allowlisting a violation before anyone has decided to fix it is how a known-issue
  suppression becomes permanent. Revisit as part of `ADOPTUNIQ-1`.
- **The Plane adapter's copy of the defect** (`ADOPTPLANE-1`). The §1 query is provider-scoped and
  would cover Plane if a case were added, but Plane's live status is itself open — the workspace CLI's
  `parsePmCell` already treats Plane as retired while the brain still ships an adapter.

## 4. What would falsify this

1. **The test goes red on first run.** Then a live path still produces duplicates and the fix belongs in
   `lib/pm-sync/`. Decision rule, pre-committed: if the failing path is the **outbound** projector the
   fix lands in this slice; if it is the **inbound** writer it becomes its own ticket (`ADOPTINB-1`)
   unless the fix is a one-line conflict-target change, because inbound has its own echo-loop contract
   that a hurried fix would break.
2. **The test is green for the wrong reason** — the scenarios never reach the adoption rungs because the
   fingerprint short-circuit fires. The per-scenario positive anchors above exist to detect exactly
   this, and the mutation criterion is deliberately not relied on alone for it.

## Dependencies

Depends on `ADOPTFOOT-1` (#588, merged) for the ownership machinery being keyed correctly. Sequenced
before `ADOPTUNIQ-1`, which it de-risks but does not replace.

## Build-with

Build-with: Sonnet 5, medium effort. One test file against the existing dm harness
(`test/datamechanics/helpers.ts`), copying the mock shape from
`test/datamechanics/pm-sync-refusal.datamechanics.test.ts` (unique create ids) rather than from the two
adoption tests (constant id). The real work is the anchors and the mutation, not the scenarios.

## Tier safety

No tier boundary moves; no read path changes. The test seeds its own team via `seedTeam()` and every
assertion is scoped to that `team_id`, so it cannot pass by observing another team's rows.
