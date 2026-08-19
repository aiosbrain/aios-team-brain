# A team slug rename must not orphan the knowledge graph

**Status:** as-built · **Date:** 2026-08-18

## The problem

Renaming a team's slug disconnected every graph-backed surface from the graph — permanently, and
silently.

Observed on a real rename: within minutes the arcs panel's "What's happening" went empty, while
**every diagnostic reported the graph as healthy**. Admin → Integrations said "Graph memory: on ·
28 items · last projected just now", the episode count was right, and Neo4j held 120 facts. The
panel's own copy blamed the model — *"The graph has facts but synthesis returned nothing this time
— this is usually transient; try again shortly."* It was not transient and it never recovered.

The two sides of the seam disagreed about what a group id **is**:

- **The write path pins it.** `projects.graph_group_id` is immutable for the §11 built-ins, and
  `lib/graph/project-pointer.ts` explicitly tolerates a stale one — its own comment reads *"a frozen
  legacy id (possibly under an old slug — the rename doctrine); final"*. The projector follows it.
- **The read paths recomputed it.** `visibleGroupIds(teamSlug, tier)` spelled
  `episodeGroupId(<live-slug>, tier)`. After a rename that names `<new-slug>_team` — a group that
  has never been written to.

Neither side was wrong on its own. The doctrine simply was not carried through to the readers.

**Why it is worth a slice rather than a note.** The failure is invisible in exactly the way that
costs the most time. There is no error and no empty-graph banner, because the `graphHasFacts`
diagnostic counts episodes **team-wide** and unscoped — so it correctly reports that facts exist
while the panel reading a different group shows none. The operator is told to wait.

## What was actually still broken (re-derived, not assumed)

The originating report predates several upstream slices. On `main` at the time of this change the
arcs leg was **already fixed** — PRET-3 routes every arcs reader through `resolveArcScope`, whose
permissive branch reads the stored pointers and cites the rename doctrine by name. Re-deriving the
defect against current code found the surviving half:

| Leg | Kind | Status before |
|---|---|---|
| `lib/query/retrieve.ts` (the Q&A graph blend) | read | slug-derived |
| `app/api/brain/facts/route.ts` (Brain-Learning L1) | read | slug-derived |
| `app/api/brain/events/route.ts` (Brain-Learning L2) | read | slug-derived |
| `app/api/v1/graph-query/route.ts` (public API) | read | slug-derived |
| `lib/cache/tier-invalidation.ts` external arc-cache key | purge | slug-derived |
| `lib/graph/arcs.ts` correction write-back, tier branch | write | slug-derived, **unreachable** |
| `app/api/brain/arcs/*`, `app/t/[team]/social/actions.ts` | read | already pointer-resolved |

"Already pointer-resolved" was, at first, a **code reading** of `resolveArcScope` — and the arcs
panel is the one surface the operator actually watched go empty, so leaving that unverified was the
wrong asymmetry (the nearest existing test covers the reclassification purge door on a renamed team,
not the arcs read). It is now pinned in the data-mechanics tier: project, rename, resolve the arc
scope, and assert the scope is unchanged **and** still addresses the episodes. It passes without any
change to the arcs leg — so the claim is confirmed rather than assumed.

The **query blend** is the one the originating spec flagged as "check before assuming — bigger than
the panel", and it was correct to: a renamed team lost graph facts from every *answer*, with no
panel to look empty. The arcs correction write-back was named too; it is slug-derived but the branch
is unreachable in production (PRET-3 made `scopeKey` a required `g:` key), so it was a latent
hazard, not a live defect. Said plainly here because the PR should not claim to have fixed a
user-visible bug that the code could not reach.

## Decision

**Approach 1 of the two candidates: the reader follows the pointer.**

`lib/graph/tier-groups.ts` is the one authority that maps `access tier → built-in project → its
stored partition`, keyed by **team id**. Every leg above resolves through it.
`lib/graph/group.visibleGroupIds` is **deleted**, not deprecated.

**Why 1 over 2 (re-mint on rename).** Re-minting keeps ids human-readable and slug-matching, but it
is a write against Graphiti's group ids and would re-key an existing graph. It needs a data
migration; it risks re-extraction, which on a large graph is a real LLM bill; and
`project-pointer.ts` carries a FOREIGN-HISTORY REFUSAL that exists precisely because a new team can
inherit an old team's group after slug reuse. Approach 1 needs no migration, keeps all history
reachable, and honours the immutability doctrine that is already written down. Approach 2 is what
the affected instance did **by hand** — pointers updated by SQL, graph wiped and re-projected —
which is fine for 28 synthetic records and is not a product fix.

**Why delete rather than deprecate.** A helper that still exists is a helper the next read leg
imports. Deleting it makes the fix structural: tsc refuses the mistake at the point it is made,
instead of a guard noticing it afterwards. `episodeGroupId` survives — it is the **mint** (what a
pointer is minted from, and the projector's documented fallback), not a read authority.

## Tier safety

`group_id` is the sole tier fence for the graph (CLAUDE.md §5 — no RLS backstop), so this is a
change to the isolation mechanism and gets stated explicitly.

The fence moves from a **string suffix** (`…_team` / `…_external`) to **project identity**: the
pointer read is scoped `team_id = <this team>` and selects the built-in by slug (`general` → team,
`external-shared` → external). That is strictly stronger — a renamed slug cannot spell it wrong, and
no team can resolve another team's pointer regardless of what any slug says. The suffix is now
merely what the mint happens to produce, never what is trusted.
`project-pointer.ts`'s foreign-history refusal is the matching write-side guard and is **unchanged**.

**The fallback is the exception, and it is fenced.** A team with no pointer is still on a
slug-derived id, and one real state reaches it: team A renames off `acme`, team B is **created on**
`acme`, and B's bootstrap hits the write-side foreign-history refusal — which returns *before*
filling, so B's built-ins keep `graph_group_id = NULL` permanently (`lib/admin/teams.ts` swallows
the bootstrap result, and every scheduler tick re-refuses). Unfenced, B's readers resolve
`acme_team` — team A's live partition — and are served it with no error anywhere. That predates
this change (the deleted `visibleGroupIds` resolved the same group), but this module is now the read
authority and its guarantee has to be true, so it **mirrors the writer's refusal**: a fallback id
whose `graph_episodes` history belongs to another team throws. Found in review; the case is pinned
in the data-mechanics tier with the exact ordering that produces it.

**Direction check.** `project-pointer.ts` verifies a set built-in pointer's *shape* only
(`LEGACY_SHAPE`), so an external-shared pointer holding a `_team`-suffixed id passes verification.
Before this change that corruption was inert on reads; now it would not be, so the external
resolution refuses an unmistakably team-suffixed id. Deliberately narrow — it does **not** demand an
`_external` suffix, because a built-in transiently holding its `g_…_p_…` mint is legitimate and must
not throw.

## The unbootstrapped fallback

A team with no pointer rows falls back to `episodeGroupId(teamSlug, …)` — deliberately the **same**
quiet fallback `lib/graph/project.ts` already takes. Reader and writer therefore agree in *both*
states. Returning `[]` instead would have made the readers disagree with the projector for exactly
the teams that have never bootstrapped. (The arcs leg is deliberately different: `resolveArcScope`
returns `[]` and logs, per its own spec's SR15 ruling. Not changed here.)

Pointer **read failures** throw rather than falling back — a swallowed error that degraded to the
slug-derived id would silently reinstate this exact defect on the one team most likely to hit it.
Callers that can degrade catch and say so honestly (`degraded: true`, a logged error); none guess.

## What would falsify this

- A team created on a freed slug reading the previous occupant's graph. _Verified:_ the
  created-on-freed-slug case in the data-mechanics file asserts the write side refuses to mint AND
  the read side refuses to fall back.
- A graph read leg that resolves a group id without a pointer read. _Guarded:_
  `test/guards/graph-group-slug-derivation.test.ts` allowlists every `episodeGroupId` caller and
  names why each is not a read leg.
- A renamed team whose read set stops addressing its own episodes. _Verified on real Postgres:_
  `test/datamechanics/graph-rename-read-pointer.datamechanics.test.ts` projects a team, renames the
  slug by direct SQL (which is how the rename actually happened — there is no product flow for it),
  and asserts the read set is unchanged **and** that the episodes are in it. Confirmed **red**
  against the pre-fix reader on all five cases.
- An `external` principal resolving the team group, or a team resolving another team's partition
  after slug reuse. Both are cases in that file.

## Known residuals, named rather than left implicit

- **`evictArcMemoryCache(teamSlug)` cannot match a legacy tier mem-cache key after a rename** —
  `arcKeyBelongsToTeam` prefix-tests `<slug>_`, so entries written under the old slug survive in
  that process. **Dormant, and provably so:** the only writer is `writeArcCache` via the arcs
  `scopeKey`, which PRET-3 made a required `g:` key, so no legacy tier entry is created at all any
  more — and the `g:` half (`evictTeamPartitionArcMemory`) resolves the pointers and is correct
  across a rename. Left alone deliberately: changing an unreachable branch to chase a
  theoretically-stale entry is churn, not a fix.
- **`graphHasFacts` remains team-wide and unscoped**, so it will keep reporting `true` while a
  scoped surface is empty. That is what MASKED this bug for a day. Not fixed here — per-team fact
  scoping is its own slice (AIO-912), and conflating the two would hide this change's own
  regression signal. It is why the tests assert on resolved groups and the episodes in them, never
  on the diagnostic.
- **A rename changes `/t/<slug>/…` URLs.** Expected product behaviour, not a defect.

## Deliberately out of scope

- **A "rename a team" product flow.** There is no UI for it today.
- **Re-extraction.** The graph is already correct; only the pointer to it was wrong. Episode names
  are `items:<id>`, independent of group id, so history was never lost — just unaddressed.
- **`graphHasFacts` being team-wide and unscoped.** It will keep reporting `true` while a scoped
  panel is empty. That is why the regression test asserts on the resolved groups and the episodes in
  them, never on the diagnostic.

## Operational gotcha (cost an hour on the day)

There is an **in-process memory cache** in front of `arc_cache`. Deleting the Postgres rows does not
clear it, so the endpoint keeps serving the pre-rename empty result with its old `as_of` — a fix can
look like it did not work when it did. Restart the app, or assert against a freshly started process.
