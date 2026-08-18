# Nothing enforces the invariant the two adoption fixes exist to protect — ADOPTINV-1

**Status:** spec, draft 1 · **Date:** 2026-08-18 · **Owner:** Chetan · **Task:** `ADOPTINV-1`
**Follows:** [`pm-sync-declared-issue-adoption.md`](./pm-sync-declared-issue-adoption.md) (`ADOPTDECL-1`,
#581) and [`pm-sync-footer-adoption-scope.md`](./pm-sync-footer-adoption-scope.md) (`ADOPTFOOT-1`, #588).
**Unblocks:** `ADOPTUNIQ-1` — proves the code cannot violate the constraint *before* the constraint is added.
**Code:** `test/datamechanics/` only. No production code changes are planned; see §4.

---

## 0. What is wrong

`ADOPTDECL-1` and `ADOPTFOOT-1` between them shipped nine tests across the unit and data-mechanics
tiers. Every one of them pins **a rung's decision**:

- `test/pm-sync-footer-adoption-scope.test.ts` — the adapter refuses an owned footer match when it is
  handed an owner set.
- `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts` — the orchestrator builds
  that set correctly from real rows (`a SAME-KEYED row in another project does not take the owner's
  issue`), and the recovery direction still works.
- `test/pm-sync-declared-adoption.test.ts`, `test/datamechanics/pm-sync-declared-adoption.datamechanics.test.ts`
  — a declaration is persisted, adopted, short-circuits on the second run, errors when unresolvable,
  and withdraws cleanly.
- `test/guards/declared-external-id-single-writer.test.ts` — only ingest writes the column.

**Not one of them asserts the outcome those rungs exist to produce:** that after a projection,
`task_pm_links` does not contain two rows in the same team pointing at the same
`provider_resource_id`. Every assertion is on a return value, a call, or one link's stored fields.

That is the difference CLAUDE.md §2.3 names — *"a claim isn't real until a red test reproduces the bad
outcome (wrong row in the DB…), not a name, a proxy, or a call-site reading."* The rungs are proxies
for the invariant. They are individually correct and the invariant can still break, because the rungs
are not the only writers of that column and no test looks at the table as a whole.

**And the DB cannot cover it either, today.** `ADOPTUNIQ-1` would add
`unique (team_id, provider, provider_resource_id) where provider_resource_id is not null`, but it
cannot ship: production currently holds exactly one violating group — three links on `AIO-444` — and
`npm run pg:schema` is Railway's `preDeployCommand`, so an index that fails to build takes the release
down with it. Reconciling those three rows is an outward-facing decision (detaching them mints new
issues on a colleague's board), and it is still open.

So the invariant is enforced by **nothing** in CI right now, and will stay that way until a decision
that has no deadline. That is the gap this slice closes.

## 1. The decision

Add a **data-mechanics** test that drives the real projector through the collision shapes that actually
occurred, and asserts the **table state** after each: no `(team_id, provider, provider_resource_id)`
group has more than one row.

The assertion is one SQL query, expressed once and reused:

```sql
select provider_resource_id, count(*) from task_pm_links
where team_id = $1 and provider_resource_id is not null
group by provider_resource_id having count(*) > 1
```

**Why data-mechanics and not unit** (CLAUDE.md §4): the invariant is a property of *stored rows across
projects*, and the legacy in-memory fake has no constraints and no real grouping. The live defect was
exactly a cross-project stored-state bug that an adapter-level assertion greened straight past.

**Why this is not a re-run of the existing tests.** Those assert one scenario each, in isolation, and
each asserts the rung. This asserts the *composition*: several rows projecting in one run, and paths
run back to back, which is the shape the incident actually had (three workspaces, months apart, each
individually behaving "correctly" by the rung's own lights).

## 2. Acceptance criteria

Spec-first: these are written from what the product must guarantee, not from what the code does. **If
any goes red it has found a live path the two previous fixes did not close, and that is a result, not a
setback** — see §4.

- `npm run test:datamechanics:iso test/datamechanics/pm-link-uniqueness.datamechanics.test.ts` passes,
  and every case ends with the no-duplicate-group query returning zero rows.
- The incident's exact shape: **three** rows keyed `TT1` in three different projects of one team, all
  projected in the same run against a Linear team whose existing issue carries `aios-ext: TT1` — one
  row keeps the issue, the other two do not share it.
- Rung 1 missing because the issue was **deleted** at the provider (the path `ADOPTFOOT-1` found its
  load-gate blind to), run twice in succession, still ends with no duplicate group.
- A row that **declares** an id already owned by another row's link does not end up sharing it, and the
  declaring row records an error rather than silently inventing a second issue (`ADOPTDECL-1`'s rule).
- The invariant query is **mutation-verified**: with the ownership refusal removed from
  `lib/pm-sync/project.ts`, the new test goes **red**, and it is the *invariant* assertion that fails,
  not an incidental one.
- A **negative control**: the same query returns zero rows on a team with no links at all, so a passing
  run cannot be explained by the query matching nothing. (`grep-before-claiming` / vacuity: a
  `having count(*) > 1` assertion is trivially satisfiable by an empty table.)
- `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run check:docs` all pass.

## 3. Scope

**In:** one new file, `test/datamechanics/pm-link-uniqueness.datamechanics.test.ts`, plus a line in
`docs/ARCHITECTURE.md` if the drift guard requires one.

**Deliberately out:**

- **The DB constraint itself** (`ADOPTUNIQ-1`) — blocked on the production reconciliation, which is a
  human, outward-facing call. This slice is explicitly the *interim* enforcement, and does not replace
  it: a test binds this repo's code paths, an index binds the data whatever writes it.
- **Repairing the three live links.** No production write happens here.
- **A runtime health signal for duplicate links.** Considered and rejected for now: it would go red
  immediately on the known violation and stay red until that decision is made, and this repo has been
  bitten six times by a banner that cries wolf (`docs/design/staleness-threshold-fit.md`). It belongs
  *with* the repair, not before it.
- **The Plane adapter's copy of the defect** (`ADOPTPLANE-1`). The invariant query is provider-scoped
  and would cover Plane if a case were added, but Plane's live status is itself an open question —
  the workspace CLI's `parsePmCell` already treats Plane as retired while the brain still ships an
  adapter.

## 4. What would falsify this

The spec claims the invariant is currently unenforced but *held* by the code. Two ways that is wrong,
both of which the slice is designed to surface rather than hide:

1. **The test goes red on first run.** Then a live path still produces duplicates, `ADOPTFOOT-1` is
   incomplete, and the fix belongs in `lib/pm-sync/` — the slice grows a production change and says so.
2. **The test is green for the wrong reason** — the scenarios never actually reach the adoption rungs
   (e.g. the fingerprint short-circuit skips the provider call, so nothing is ever at risk of
   adopting). The mutation criterion above exists precisely to detect this: if removing the ownership
   refusal does not redden the test, the test is not exercising the path it claims to.

## Dependencies

Depends on: `ADOPTFOOT-1` (#588, merged) for the ownership machinery being keyed correctly. Sequenced
before `ADOPTUNIQ-1`, which it de-risks but does not replace.

## Build-with

Build-with: Sonnet 5, medium effort. One test file against an existing dm harness
(`test/datamechanics/helpers.ts` + the Linear mock already used by the two adoption tests), with the
mutation check as the real work.

## Tier safety

No tier boundary moves; no read path changes. The test seeds its own team via `seedTeam()` and asserts
only within that `team_id`, so it cannot pass by observing another team's rows.
