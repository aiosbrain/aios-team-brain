# Every new workspace's scaffold row hijacks someone else's issue — ADOPTFOOT-1

**Status:** spec, draft 1 · **Date:** 2026-08-17 · **Owner:** Chetan · **Task:** `ADOPTFOOT-1`
**Follows:** [`pm-sync-declared-issue-adoption.md`](./pm-sync-declared-issue-adoption.md) (`ADOPTDECL-1`,
merged as #581) — this reuses the ownership machinery that slice built, and fixes a hole in it.
**Blocks:** `ADOPTUNIQ-1` (the uniqueness constraint cannot ship while this mechanism keeps recreating
the violation).
**Code:** `lib/pm-sync/linear.ts`, `lib/pm-sync/project.ts`.

---

## 0. What is wrong

Three `task_pm_links` rows in production point at the **same** Linear issue, `AIO-444`
("Finish verified operator loop"). That is not a fluke — it is a mechanism that fires on every new
workspace, and it will fire again the next time one is created.

### 0a. The footer rung matches on `row_key` alone

`linear.ts:341` resolves the second adopt rung as `boot.issuesByExt.get(task.row_key)`, and the index it
reads is built from `parseExt(issue.description)` (`linear.ts:187`), which returns **only** the row key
from a footer that reads `aios-ext: <row_key> · source: <externalSource>`.

The footer does carry a source. It disambiguates nothing: `externalSource` is the per-integration
default for every project in this install — **940 of 944** Linear links carry `aios-backlog`, the other
4 carry `aios`. Two different workspaces both pushing a row keyed `TT1` therefore resolve to the same
issue.

### 0b. And the AIOS scaffold ships a `TT1` row

New workspaces are seeded with a task row keyed `TT1`, titled *"Example team task"*. So the sequence is
mechanical:

| project | row | created | what happened |
|---|---|---|---|
| `john-workspace` | `TT1` — "Finish verified operator loop…" | 2026-07-15 | legitimately declared `AIO-444` (`provider_external_id = AIO-444`) |
| `chetan` | `TT1` — "Example team task" | 2026-08-03 | footer rung matched `aios-ext: TT1` → **took `AIO-444`** |
| `acme-workspace` | `TT1` — "Example team task" | 2026-08-16 | same, again |

Two scaffold rows now co-own a real person's issue. Every projection of either one writes its title,
body and state over John's.

### 0c. Why data reconciliation alone cannot fix it

The obvious repair — null the two scaffold links' `provider_resource_id` — **does not hold**. On the
next push `byResourceId` misses, the footer rung runs, `aios-ext: TT1` still matches, and the same issue
is adopted again. The collision reforms. Any fix has to stop the rung, not clean up after it.

### 0d. `ADOPTDECL-1`'s ownership check has a hole that this case walks straight through

#581 added exactly the right machinery — `ownedResourceIds`, supplied by the orchestrator, refusing an
adoption of an issue another row's link already owns. But its owner set is filtered by row key alone
(`project.ts:306`):

```ts
.filter((o) => o.provider_resource_id && o.row_key !== row.row_key)
```

**All three colliding rows have `row_key = "TT1"`.** So when the scaffold row projects, John's link is
excluded from the owner set as "itself", and the refusal cannot fire for the one shape it most needs to.

A link's identity is `(team_id, project_id, row_key, provider)` — that is the table's own unique
constraint (`schema.sql`). Two projects' `TT1` are different rows, and the filter has to say so.

## 1. The decision

### 1a. Ownership is keyed on the LINK, not on the row key

The self-exclusion becomes `project_id` **and** `row_key`, matching the link's real identity. Nothing
else about `ownedResourceIds` changes.

This is a strict widening of the owner set, so it can only ever cause *more* refusals — never fewer.
§0d's case starts refusing; nothing that previously adopted stops.

### 1b. The FOOTER rung refuses an owned issue, exactly as the declared rung does

`byFooter` is currently taken unconditionally. It now passes through the same ownership check the
declared rung uses: if the matched issue's id is in `ownedResourceIds`, the row does **not** adopt it.

**What happens instead is the important half.** The row falls through to `create`, which is correct: a
scaffold `TT1` in a new workspace genuinely has no issue yet, and making it one is the honest outcome.
It stops silently editing someone else's.

### 1c. The owner set has to be loaded for footer candidates too

Today `project.ts:297` loads `ownedResourceIds` only when the row carries a declaration
(`declared_external_id` non-null and no resource id). The footer rung needs it whenever a row *could*
adopt — i.e. whenever the link has **no** `provider_resource_id` yet, declaration or not.

That widens the read to every not-yet-linked row on a board push. It is one indexed query per such row
against a table with ~950 rows in this install, and only for rows that have never been projected — a
settled row still pays nothing. Stated rather than hidden, because "one more query per row" is exactly
the kind of cost that should be visible in review.

### 1d. What this does NOT do

It does not change the footer format, and it does not make the footer project-aware. Putting the project
into `aios-ext:` would be the deeper fix, but it is a **format migration**: every issue already carrying
a footer would need rewriting, and until then old and new footers would have to be parsed side by side.
That is its own slice with its own backfill; this one closes the hole using machinery that already
exists and is already tested.

## Dependencies

**Deps: none.** Two files plus tests. No schema change — `ADOPTDECL-1` already shipped the column and
the plumbing this reuses. No new provider round-trip.

## Build-with

**Build-with tier: Fable / high effort.** This changes what an outward-facing projector does with an
issue a human is using, and its failure direction is silent (a row edits someone else's work). The
sibling slice needed four spec drafts and two code rounds before it was right, and its ownership check —
the thing being extended here — shipped with the hole this spec exists to close. Two adversarial spec
reviews (Fable + Codex) before code, two on the diff.

## Tier safety

No tier surface changes: an outbound projection path. No new API route, no schema, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`. The outward-facing behaviour change is deliberate and
named: a row whose footer match is already owned now creates its own issue instead of adopting.

## 2. Acceptance criteria

- `test/pm-sync-footer-adoption-scope.test.ts` — a row whose `row_key` footer matches an issue ALREADY owned by another link does NOT adopt it: no `issueUpdate` against that issue, and an `issueCreate` instead, driven through `upsertWorkItem` against a fake `fetch`.
- `test/pm-sync-footer-adoption-scope.test.ts` — the SAME-ROW-KEY case explicitly: the owner link and the projecting row share `row_key` and differ only by `project_id`, which is the shape that walks through `ADOPTDECL-1`'s filter today.
- `test/pm-sync-footer-adoption-scope.test.ts` — a row whose footer match is NOT owned still adopts, so the widening cannot swallow the ordinary re-resolution the footer rung exists for.
- `test/pm-sync-footer-adoption-scope.test.ts` — a row that already has `provider_resource_id` is unaffected: rung 1 wins and no ownership read is consulted.
- `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts` — with a real link owned by project A, projecting project B's same-keyed row leaves A's `provider_resource_id` untouched and gives B its own, asserted as stored state across two projections.
- `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts` — the owner set excludes only the projecting link itself, keyed on `(project_id, row_key)`: a second project's same-keyed link IS in the set.
- `lib/pm-sync/project.ts` — `ownedResourceIds` is loaded whenever the link has no `provider_resource_id`, not only when a declaration is present, and is still NOT loaded for a settled row.

## 3. Scope

**In:** the owner-set identity fix, the footer rung's ownership refusal, the widened load condition, and
their tests.

**Deferred, each with its reason:**

- **Reconciling the three live `TT1` rows.** Once this ships the mechanism stops, but the two scaffold
  links still hold `AIO-444`. Detaching them means those rows create their own issues on the next push —
  junk in someone else's Linear team — so which rows survive is a human call, tracked as `ADOPTUNIQ-1`.
- **The uniqueness constraint** (`ADOPTUNIQ-1`), which stays blocked until the above is reconciled.
- **Making the footer project-aware** (§1d) — a format migration with a backfill, not this slice.
- **The scaffold shipping a colliding `TT1` at all.** Arguably the workspace template should not seed a
  row whose key is guaranteed to collide across workspaces. That is a change in another repo
  (`aios-workspace`), and it is a mitigation rather than a fix: the projector must be safe regardless of
  what any template does.

## 4. What would falsify this

Wrong if a row whose footer match is already owned still adopts after this ships — that would mean the
rung is not reading the owner set, or the set is still excluding the owner as "itself".

Wrong in the more dangerous direction if the widened owner set makes a row that legitimately owns its
issue stop adopting — a row re-resolving its own issue by footer after losing its `provider_resource_id`
must still succeed, because that is the recovery path the footer rung was built for. The self-exclusion
is what protects it, which is why §2 pins both directions.
