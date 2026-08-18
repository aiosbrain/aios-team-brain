# Every new workspace's scaffold row hijacks someone else's issue — ADOPTFOOT-1

**Status:** spec, draft 3. Draft 1 was CLEAR to Codex and BLOCKED by Fable — the two disagreed, and
Fable was right: draft 1's load condition guarded the wrong predicate, so the hijack re-fired through a
path its own acceptance criteria blessed. · **Date:** 2026-08-17 · **Owner:** Chetan · **Task:** `ADOPTFOOT-1`
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
default for every project in this install — **945 of 949** Linear links carry `aios-backlog`, the other
4 carry `aios` (prod query, 2026-08-17; draft 1 said 940/944, which was the same query a day earlier —
these are point-in-time observations and are dated for that reason). Two different workspaces both
pushing a row keyed `TT1` therefore resolve to the same issue.

### 0b. And the AIOS scaffold ships a `TT1` row

New workspaces are seeded with a task row keyed `TT1`, titled *"Example team task"* — emitted literally
by `aios-workspace/scripts/scaffold-project.sh:372`
(`| TT1 | Example team task | $OWNER | ready | — | — | — |`) and pinned by that repo's own
`test/scaffold-push-item-validation.test.mjs:191`. **That file is in a different repo**, so a reviewer
working only from this one cannot check it; the claim is also corroborated here by two independent prod
instances. So the sequence is mechanical:

| project | row | created | what happened |
|---|---|---|---|
| `john-workspace` | `TT1` — "Finish verified operator loop…" | 2026-07-15 | legitimately declared `AIO-444` (`provider_external_id = AIO-444`) |
| `chetan` | `TT1` — "Example team task" | 2026-08-03 | footer rung matched `aios-ext: TT1` → **took `AIO-444`** |
| `acme-workspace` | `TT1` — "Example team task" | 2026-08-16 | same, again |

Two scaffold rows now co-own a real person's issue. Every projection of either one writes its title,
body and state over John's.

**The hijack has already renamed his issue.** Its prod URL slug is
`…/AIO-444/example-team-task` — the scaffold row's title has been written over John's.

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

### 0e. What this slice does NOT repair, stated before the decision

All three colliding links already hold `provider_resource_id`, so they resolve at rung 1 and this slice
does not stop them. **It prevents new and re-formed hijacks; it does not undo the two live ones.**
Detaching those is `ADOPTUNIQ-1`, which needs a human call because detaching means those rows create
their own issues on the next push. Draft 1 implied the problem was fixed; it is not, and §2 says so now.

## 1. The decision

### 1a. Ownership is keyed on the LINK, not on the row key

The self-exclusion becomes `project_id` **and** `row_key`, matching the link's real identity.

**And under today's gate that filter is not merely mis-keyed — it is the bug and nothing else.** The
owner query requires `provider_resource_id` to be non-null (`project.ts:303`) while the load gate
requires the *projecting* link's to be null, so the projecting link can never appear in the result set.
The `row_key !== row.row_key` term therefore excludes only OTHER links sharing the key — precisely the
true owner. Once §1c widens the gate the projecting link CAN appear in the result set — but **the self-exclusion
still never changes an outcome, and saying it does was wrong twice.** Every adoption candidate comes from
the bootstrap indexes; if a candidate's id equalled the projecting link's own resource id, rung 1
(`issuesById.get`, `linear.ts:340`) would already have resolved it and no adoption rung would run. Even on
the deleted-issue path the dangling id cannot match a candidate, because it is absent from the listing
candidates are drawn from. So the exclusion only ever removes an id no candidate can match: keyed on
`(project_id, row_key)` it is correct and harmless defence, and **no test should be written to "protect"
an unreachable scenario.** The real defect is the old `row_key !== row.row_key` term, which removed the
true owner.

Draft 1 claimed this was "a strict widening… nothing that previously adopted stops". **That is false**,
and §3 now names the loss: a legitimate cross-project move — the same `row_key` migrating from project A's
board to project B — previously adopted through this very hole and will now be refused.

### 1b. A refused footer match falls to the DECLARED rung, not straight to create

`byFooter` is currently taken unconditionally. It now passes the same ownership check the declared rung
uses, and — this is the part draft 1 got wrong — **the candidate itself must be dropped, not merely
flagged**: `existing = byResourceId || byFooter || adopted` (`linear.ts:387`) will still update an owned
issue if `byFooter` stays populated. The rung yields an *unowned* footer candidate or nothing.

**Ordering after a refusal matters, and draft 1 broke a sibling invariant.** The declared rung today runs
only when `!byFooter` (`linear.ts:343`), and its contract is explicit: *"A declared key we cannot honour
is an ERROR, not a licence to invent a second issue"* (`linear.ts:346-353`). Draft 1 sent every refused
footer straight to `create` — so a row that had *also* declared an issue would silently create a
duplicate and discard the declaration, which is exactly what `ADOPTDECL-1` forbids.

The order is therefore: **rung 1 → unowned footer → declared rung (with its own error semantics) →
create only when the row declared nothing.**

For an undeclared scaffold `TT1`, create is still the right outcome: it genuinely has no issue yet, and
making it one stops it editing someone else's.

### 1c. The owner set must be loaded whenever the FOOTER RUNG CAN FIRE — not when the link looks unlinked

Draft 1 gated the load on "the link has no `provider_resource_id`". **That guards the wrong predicate,
and the hijack re-fires straight through it.** The footer rung fires whenever *rung 1 misses*, and rung 1
misses for a non-null resource id whose issue no longer exists:
`byResourceId = link.provider_resource_id ? boot.issuesById.get(...) : undefined` (`linear.ts:340`)
returns `undefined` for a deleted issue.

The sequence is the one this slice itself creates: scaffold `TT1` is refused → creates a junk issue → a
human deletes the junk (the natural reaction, which §3 predicts) → a later edit breaks the fingerprint
short-circuit → next push: rung 1 misses, `byFooter` matches `AIO-444`, the owner set was **never
loaded**, `ownedResourceIds?.has(...)` is `undefined` and falsy — **hijack re-fires**. Draft 1's
criterion 4 ("a row that already has `provider_resource_id` is unaffected… no ownership read is
consulted") wrote that hole into the acceptance set.

`project.ts` cannot see the bootstrap, so it cannot know whether rung 1 will resolve. Two layers, each
with its own property:

1. **Load whenever the adapter could adopt at all** — i.e. for every non-`statusOnly` projection that
   actually REACHES the adapter, not only for links that look unlinked. It sits where the current load
   sits: inside the `try`, *after* the fingerprint short-circuit (`project.ts:284-287`), so a settled
   board pays nothing. One indexed query (`task_pm_links_team_provider_idx`, `schema.sql:1283`) against
   ~950 rows, on a sequential per-row loop.
2. **Fail closed in the adapter, for BOTH adoption rungs and regardless of the link's shape.** If
   `ownedResourceIds` is `undefined`, neither the footer rung nor the declared rung adopts an issue it
   cannot prove is unowned. Stated universally on purpose: a version conditioned on "the link claimed a
   resource id" would pass every criterion while a FRESH link — the scaffold shape this slice exists for —
   still adopted an owned match. The declared rung's current `ownedResourceIds?.has(...)`
   (`linear.ts:365`) carries exactly that optional-chain hole today and is part of this change.

**The per-row load must stay per-row.** It runs after the previous row's `persistSuccess` in the
sequential loop (`project.ts:400-412`), which is what makes row 2 see row 1's claim. Batching it once per
run would introduce exactly the staleness this design avoids. Concurrent pushes remain a race only
`ADOPTUNIQ-1`'s unique index can close.

### 1d. What this does NOT do

It does not change the footer format, and it does not make the footer project-aware. Putting the project
into `aios-ext:` would be the deeper fix, but it is a **format migration**: every issue already carrying
a footer would need rewriting, and until then old and new footers would have to be parsed side by side.
That is its own slice; this one closes the hole using machinery that already exists and is already
tested. (Honest correction to draft 1's framing: a big-bang backfill is not forced. `EXT_RE`'s charset
already admits a qualified key like `chetan.TT1`, so a LAZY migration — parse both shapes, rewrite each
footer on its next ordinary `issueUpdate` — is available. The deferral stands on scope, not on cost.)

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
- `test/pm-sync-footer-adoption-scope.test.ts` — the SAME-ROW-KEY case explicitly: the owner link and the projecting row share `row_key` and differ only by `project_id`, the shape that walks through `ADOPTDECL-1`'s filter today.
- `test/pm-sync-footer-adoption-scope.test.ts` — THE DELETED-ISSUE PATH: a link whose `provider_resource_id` is non-null but resolves to nothing (rung 1 misses) still consults the owner set, and still refuses an owned footer match. Draft 1's criterion blessed this path; it is the one that re-fires the hijack.
- `test/pm-sync-footer-adoption-scope.test.ts` — FAIL CLOSED, UNIVERSALLY: when `ownedResourceIds` is `undefined`, NEITHER the footer rung nor the declared rung adopts — including for a FRESH link with no resource id, which is the scaffold shape. A version conditioned on "the link claimed a resource id" must fail this.
- `test/pm-sync-footer-adoption-scope.test.ts` — a REFUSED footer match on a row that ALSO carries a declaration falls to the declared rung and takes its error semantics — it does NOT create, which would discard the declaration and mint the duplicate `ADOPTDECL-1` forbids.
- `test/pm-sync-footer-adoption-scope.test.ts` — a row whose footer match is NOT owned still adopts — asserted with a DISTRACTOR: at least one unrelated owned link is seeded so the owner set is non-empty but does not contain the candidate. Without it, a mutant refusing whenever the set is merely non-empty stays green while recovery is broken on every real board.
- `test/pm-sync-footer-adoption-scope.test.ts` — a row whose rung 1 RESOLVES is unaffected: it updates its own issue and never consults the footer rung. Phrased on rung-1 resolution, not on "has a resource id", because those differ exactly where the bug lives.
- `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts` — with a real link owned by project A, projecting project B's same-keyed row leaves A's `provider_resource_id` untouched and gives B its own, asserted as stored state across two projections.
- `test/datamechanics/pm-sync-footer-adoption-scope.datamechanics.test.ts` — RECOVERY, as an outcome rather than an internal: a link whose `provider_resource_id` is nulled, and whose issue no other link owns, re-adopts that issue by footer rather than creating a second one — again with an unrelated owned link present, so the owner set is non-empty.
- `lib/pm-sync/project.ts` — the owner set is loaded for every non-`statusOnly` projection, and the load stays PER ROW inside the sequential loop so row 2 sees row 1's claim; a batched-once load must fail a test.

## 3. Scope

**In:** the owner-set identity fix, the footer rung's ownership refusal, the widened load condition, and
their tests.

**Accepted losses, named rather than discovered:**

- **A legitimate cross-project move is now refused.** The same `row_key` migrating from project A's board
  to project B previously adopted through the very hole this closes. At the data level that is
  indistinguishable from the hijack, so refusing is the defensible default — but the repair has to be
  documented rather than left for the first person it bites: delete or null project A's link, **remove the
  row from A's board**, and push B *before* A pushes again. The order matters: if A pushes in between it
  re-adopts by footer (the issue is unowned again) and B is refused anew; and if the row stays on A's
  board, A's next push mints junk.
- **The footer becomes permanently ambiguous for a colliding key.** Every refused row creates an issue
  carrying an IDENTICAL footer (`withFooter(body, task.row_key, source)`, `linear.ts:385`), and
  `issuesByExt` is last-write-wins (`linear.ts:187`). So with N same-key footers, recovery for any `TT1`
  resolves to an arbitrary winner — usually owned, hence refused, hence another duplicate. The recovery
  path the footer rung exists for is effectively disabled for colliding keys until §1d lands. This slice
  trades a silent hijack for a loud duplicate, which is the right trade, but it is a trade.

**Deferred, each with its reason:**

- **Reconciling the three live `TT1` rows.** Once this ships the mechanism stops, but the two scaffold
  links still hold `AIO-444`. Detaching them means those rows create their own issues on the next push —
  junk in someone else's Linear team — so which rows survive is a human call, tracked as `ADOPTUNIQ-1`.
- **The uniqueness constraint** (`ADOPTUNIQ-1`), which stays blocked until the above is reconciled.
- **The identical rung in the Plane adapter.** `plane.ts:220-222` resolves
  `itemsByExt.get(extKey(source, task.row_key))` with no ownership check, and `ownedResourceIds` is not
  even among its destructured params (`plane.ts:196`) — so a Plane-primary install hijacks exactly the
  same way, and every criterion here would still pass. Deferred because this install's primary is Linear
  and Plane holds 1 link against 949 (`ADOPTPLANE-1` tracks the sibling declared-rung defect in the same
  file), but named here rather than discovered later.
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
must still succeed, because that is the recovery path the footer rung was built for.

Draft 1 said "the self-exclusion is what protects it". **That was wrong.** Recovery is protected because
a lost link's resource id is absent from every *other* link's non-null column, so the issue is simply not
owned. The self-exclusion matters only once §1c's widened load lets the projecting link into the result
set at all. §2 pins the recovery outcome directly rather than relying on that reasoning.
