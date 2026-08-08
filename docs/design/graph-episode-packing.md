# Packing small items into shared graph episodes — PIPEFF-4 / AIO-845

**Status:** spec, pre-review. No code written.
**Parent:** `docs/design/graph-ingestion-efficiency.md` §3 ("lever 3 — deepest blast radius, built last").
**Siblings shipped:** PIPEFF-2 (predecessor filter, −25.5% measured) · PIPEFF-3 (content-defined chunking).

---

## 0. The finding that should decide this before anything else

The parent spec proposed this lever from a count: *"898 items under 600 characters each occupy their
own episode at full fixed-overhead price."* I measured the actual payload before designing against
it, and two numbers arrived that the parent never had.

**Measured on prod, 2026-08-08, items synced in the last 30 days:**

| source | items | est. episodes | of which are small (<600 chars) |
|---|---|---|---|
| `github/` | 674 | 2,298 | 50 |
| `linear/` | 593 | 975 | 109 |
| `2-work/` | 148 | 778 | 4 |
| **`commits/`** | **570** | **570** | **570 — 100%** |
| everything else | ~130 | ~550 | ~50 |
| **total** | | **~5,170** | |

**The lever is a commits lever.** 570 of ~5,170 episodes — **11.0%** — are commit items, every one of
them under 600 chars, averaging **197 characters**, each paying the same ~30,000-token extraction
overhead as a full 2,500-char chunk. Nothing else in the corpus has this shape: the other sources'
small items are a rounding error against their own episode counts.

They also pack cleanly. Small commit artifacts concentrate on **two humans** (John Ellison 338,
Chetan Nandakumar 314) across ~37 active days each, so a same-author same-day pack averages **~9
commits**. Packing commits alone: 570 → ~63 episodes, **a ~9.8% cut in total episodes.**

### And the number that cuts the other way

Arc evidence citations, all arcs currently in `arc_cache`, by the source of the cited item:

| source | citations | distinct items |
|---|---|---|
| **`commits/`** | **16** | **15** |
| `github/` | 10 | 10 |
| `linear/` | 6 | 2 |
| `2-work/` | 2 | 2 |
| `slack/` | 1 | 1 |

**Commits are the single most-cited arc evidence source — 16 of 35 citations, 46%.** The entire
saving and the most-used evidence channel are *the same items*. That is not a coincidence to design
around; it is the lever's defining property, and the parent spec did not know it.

### What that means, stated plainly before any design

The episode **name** is the only structured per-item provenance that reaches the graph
(`graphiti-client.ts:168` sends `role: null` — authorship never enters the payload). So
`episodeUuid → ONE itemId` (`learning.ts:156`) is the hinge the entire arc chain hangs off:
`actorOfFact` takes the first human (`arcs.ts:766`), `ArcEvidence.itemId` links a citation to its
library page (`arcs.ts:352`), arc *identity* is item-set overlap (`arc-continuity.ts:38`), and
eligibility keeps a fact if **any** of its items is eligible (`arcs.ts:817`).

Pack nine commits into one episode and, with no further change, an arc citation that today points at
*the commit that actually motivated it* points instead at an arbitrary one of nine. **That is a
functionality regression on the surface this lever's own savings come from**, and the standing
instruction on this workstream is that cost may not be bought with graph quality or functionality.

So this spec's first job is not the packing algorithm. It is to answer: **is the saving worth what it
costs, and can the cost be designed to zero?**

---

## 1. What the saving is actually worth

Measured, not estimated, using PIPEFF-2's verified post-deploy cost:

```
~5,170 episodes / 30 days  ×  $0.0110 per episode   =   ~$57 / month   (current total)
~507 episodes eliminated   ×  $0.0110               =   ~$5.6 / month  (this lever)
```

**~$5.60 per month at today's volume.** That is the honest size. It scales with headcount and commit
volume — at 5–10 active engineers it is $15–30/month — but the decision has to be taken on what is
true now plus a stated growth assumption, not on the growth assumption alone.

Against that: this lever touches the **sole tier-isolation boundary** (`episodeGroupId`, no RLS
backstop), the **arc evidence surface**, **reconcile**, the **`entitiesPerEpisode` sensor shipped
yesterday**, and requires a **new table**. Every other lever in this workstream was cheap to build
and impossible to get catastrophically wrong. This one is the inverse.

**I am specifying it fully anyway**, because "it's only $5.60" is an argument that must survive
review rather than a conclusion I take alone — and because the design below turns the attribution
cost to zero rather than accepting it. But §7 records the conditions under which the right answer is
to decline, and I want the reviewer to rule on that first.

---

## 2. Constraints the terrain imposes (all verified, with call sites)

| # | Constraint | Where | Failure if violated |
|---|---|---|---|
| C1 | `group_id` is derived **per item** from `item.access` and is the only tier enforcement — no RLS | `project.ts:612`, `group.ts:20-26`, CLAUDE.md §5 | A mixed-tier pack is a **permanent, unrecoverable external leak**. Graphiti `/search` returns everything in a group; there is no post-hoc filter anywhere. |
| C2 | The ledger is keyed `unique (team_id, source_table, source_id)` — **one row per item** | `schema.sql:2231` | A packed episode covers N items; either the ledger grows a many-to-one shape or packing hides inside a synthetic item. |
| C3 | `itemIdFromEpisodeName` is **pure and single-valued** (`string \| undefined`) | `episode-name.ts:21-26` | Every consumer is typed on a scalar. A multi-item episode has no representation. |
| C4 | `deleteItemEpisodes` deletes every episode whose parsed id matches — **silently** | `project.ts:527-541` | Deleting one item would delete its pack-mates' content. Purge, retraction and tier-flip all route through it. |
| C5 | Reconcile confirms a row if **any** chunk landed | `reconcile.ts:270-278` | One landed packed episode confirms **every** member, including members whose text never arrived. |
| C6 | `toPush` filters by **positional index** into one item's chunk array | `project.ts:842` | A pack's chunk shas span several items; positional delta is meaningless across a pack. |
| C7 | The PIPEFF-2 graphiti patch groups predecessor context by `name.split('#')[0]` | `graphiti/patch-same-item.py:21,25` | "Same document" silently becomes "same **pack**" — a behaviour change to a shipped, sha-pinned patch. |
| C8 | `entitiesPerEpisode` divides entities by **episodes** | `extraction-health.ts:561-571` | Packing changes the denominator's meaning; the sensor shipped yesterday would step-change for a non-quality reason. |
| C9 | Eligibility keeps a fact if **any** of its items is eligible | `arcs.ts:817-822` | An ineligible item rides along on an eligible pack-mate. |
| C10 | Arc identity is item-set overlap, `MIN_SHARED_ITEMS = 2` | `arc-continuity.ts:29,38` | Changing which items a fact resolves to perturbs day-to-day arc identity. |

---

## 3. The design

### 3.1 The pack key — bounded so C1, C9 and attribution cannot bite

An item is packable only if it is **small** (`length(body) < PACK_MAX_ITEM_CHARS`, 600) and it joins a
pack whose key matches on **all five** of:

```
(group_id, kind, source, author, day)
```

- **`group_id`** — closes C1 by construction, not by check. Two items of different `access` can never
  share a key, because `group_id` *is* part of the key.
- **`author`** — this is what makes the attribution cost zero rather than bounded. Every fact from a
  pack has exactly one human behind it, so `actorOfFact` returning "the first human" is **correct**,
  not approximately correct.
- **`kind` + `source`** — closes C9: pack-mates are the same class of thing, so eligibility is
  uniform across the pack.
- **`day`** — the natural bucket for commits and what makes a pack legible as a unit of evidence.

An item with no resolvable author is **never packed**. Not "packed into a `(none)` bucket" — never
packed. An unattributed pack is exactly the failure this key exists to prevent.

**Expected effect at today's payload:** commits pack ~9:1; `linear/`, `plane/` and `slack/` smalls
(109 + 33 + 13) pack far more weakly because they spread across more authors and days. The spec
targets commits and takes the rest as whatever falls out — it does **not** widen the key to chase
them.

### 3.2 Episode identity — a `pack:` grammar and a join table

`itemIdFromEpisodeName` stays pure and unchanged for `items:` names (C3). Packed episodes take a new
prefix:

```
pack:<packId>          or   pack:<packId>#k   for a multi-chunk pack
```

`packId` is the deterministic sha of the pack key, so it is reproducible from the inputs and carries
no ordering.

The episode → items relation becomes **data, in a new table**, rather than something parsed out of a
string:

```sql
create table if not exists graph_episode_items (
  team_id     uuid not null references teams(id) on delete cascade,
  episode_name text not null,
  item_id     uuid not null,
  ordinal     int  not null,
  primary key (team_id, episode_name, item_id)
);
```

This is deliberate and follows the standing design principle: **attribution belongs at the lowest
shared layer**, readable identically by arcs, the timeline, the dashboard and any future surface —
not re-derived by each of them from a name. A name-encoded list (`items:<id1>+<id2>+…`) was rejected:
nine UUIDs is a 340-character episode name, and it would put a variable-length parse in the hot path
of ten call sites.

`resolveEpisodeItems` (`learning.ts:137-168`) becomes the single reader of that table, returning
`itemIds: string[]` where it returns a scalar today. **It is the one choke point**, which is why the
table is worth its cost: every downstream consumer keeps reading `epToItem` and gets the right answer
without knowing packs exist.

### 3.3 The ledger — C2 without changing its key

`graph_episodes` keeps `unique (team_id, source_table, source_id)`. Each packed item keeps **its own
row**, and gains:

- `pack_name text not null default ''` — the `pack:<id>` episode this item's text was pushed inside,
  `''` for unpacked items.
- `chunk_shas` stores the sha of **this item's own slice** of the packed body, not the packed
  episode's chunks. That keeps the delta predicate per-item and closes C6: an edit to one member
  invalidates that member, and re-packing the day re-pushes the pack.

**Consequence, recorded as accepted:** editing one commit in a nine-commit pack re-extracts the whole
pack. For commits — immutable once pushed — this is close to never. If a source with mutable small
items is added to the pack set later, this cost must be re-derived, not inherited.

### 3.4 Deletion, purge, tier flip — C4

`deleteItemEpisodes(client, groupId, itemId)` currently deletes by parsed name. For a packed item it
must instead:

1. Look up the item's `pack_name`.
2. **Never delete the pack episode** while other members remain — that would silently destroy their
   content, which is C4's failure exactly.
3. Remove the item's row from `graph_episode_items`, mark the item's ledger row for re-pack, and
   **re-push the pack without the removed member** on the next projection pass.
4. Delete the pack episode only when its last member leaves.

Tier reclassification of one member is the sharp case: the item must leave the pack (its `group_id`
changed, so it can no longer satisfy the pack key) **and** the pack must be re-pushed without it, in
the same pass. Until the re-push lands, the removed item's text is still inside an episode in the old
group. **That is a real, time-bounded tier exposure**, and it is the single most dangerous property of
this design. §5's acceptance criteria treat it as a blocking requirement, not a caveat.

### 3.5 Reconcile — C5, and it fixes RECONCILE-1's class for packs

The landed-check must confirm a packed item only when **its pack episode is present**, and must not
let one pack episode confirm members that were dropped from it. Concretely: build the map from
`graph_episode_items` rather than from parsed names, and require the member row to appear there.
`RECONCILE-1` (AIO-824) is the general form of this bug for chunks; this spec fixes it only for
packs, and says so rather than claiming the ticket.

### 3.6 The sensors — C7, C8

- **C8:** `entitiesPerEpisode` will step-change downward when packs land, for a purely structural
  reason. The sensor must record the discontinuity — an annotation at the deploy instant — or its
  "week-over-week move > 25% ⇒ investigate" falsifier will fire on this change and teach everyone to
  ignore it. **A sensor that cries wolf once gets switched off**, and this one is two days old.
- **C7:** `name.split('#')[0]` makes a pack its own predecessor group, which is the *correct*
  analogue of "the document's own chunks". It must be **verified, not assumed** — the patch is
  sha-pinned by `test/guards/graphiti-patch-same-item.test.ts`, and a `pack:` name must be added to
  that test's cases.

---

## 4. What this spec explicitly does not do

- **It does not widen packing beyond the measured shape.** No packing of `linear/`, `github/` or
  `slack/` smalls as a goal; they fall out of the same rule or they don't.
- **It does not change `ArcEvidence`'s rendering.** With the author bound into the pack key, a
  citation still resolves to a correct human and a correct set of items. Whether the UI should say
  "9 commits by John on Aug 3" instead of linking one of them is a **product** question, filed
  separately, not smuggled in as a cost change.
- **It does not touch the chunker.** Packs are chunked by the same CDC path as any other body.
- **It does not claim RECONCILE-1.** See §3.5.

---

## 5. Acceptance — what must be true, and what would falsify it

Every criterion below is a test, not a judgement. The tier ones are data-mechanics (real Postgres);
the arithmetic ones are unit.

| # | Criterion | Tier | Falsifier |
|---|---|---|---|
| A1 | **No pack ever spans two `group_id`s.** Mutation: force two tiers into one key; the guard must redden. | data-mechanics | any pack whose members disagree on `access` |
| A2 | **A tier flip of one member removes it from the pack AND re-pushes the pack without it, in the same projection pass.** Assert on the *episode body*, not on a ledger flag. | data-mechanics | the removed member's text still readable in the old group after the pass |
| A3 | **Deleting/purging one member never deletes another member's content.** | data-mechanics | any surviving member's text absent after a co-member purge |
| A4 | **Every fact from a pack attributes to exactly one human**, and it is the pack's author. | data-mechanics | any pack-derived fact resolving to ≥2 humans, or to the wrong one |
| A5 | **Arc evidence for a packed item resolves to a real, eligible item of the same author.** | data-mechanics | evidence resolving to an item outside the pack, or to an ineligible one (C9) |
| A6 | **Reconcile confirms a packed member only if it is in `graph_episode_items` for a present episode.** Mutation: drop one member; only that member must re-queue. | data-mechanics | a dropped member reading as confirmed (C5) |
| A7 | **Episode count on a replayed real commit day falls ≥ 5×**, measured by arithmetic on the real projector, no LLM call. | unit | a fall under 5× — the lever isn't paying for its blast radius |
| A8 | **No item is ever in two packs, and no item's text is pushed twice in one pass.** | data-mechanics | duplicate `graph_episode_items` rows, or duplicate content across episodes |
| A9 | **An item with no resolvable author is never packed.** | unit | any pack containing an author-less item |
| A10 | **`itemIdFromEpisodeName` still returns `undefined` for a `pack:` name**, and every one of the ten call sites in §2 either reads the table or is proven not to need to. | unit + guard | any consumer silently reading a scalar and getting `undefined` where it used to get an id |
| A11 | **The `pack:` name behaves in `patch-same-item.py`** — a pack's own chunks are its predecessors and nothing else's are. | unit (runs the real Python) | a pack chunk receiving another pack's episodes |

**The falsifier for the whole lever:** if A7's measured fall on real commit days is under 5×, or if
A2 cannot be made to hold without a window in which a reclassified item's text is readable in the
wrong group, **this lever does not ship.** Those are the two conditions under which the saving stops
covering the risk.

---

## 6. Rollout

Packing is **forward-only and lazy**, exactly as CDC was. Already-projected items keep their existing
per-item episodes forever; only items projected *after* the change are eligible to pack. A
backfill would re-extract the entire commit history for zero new information — the $76 mistake
PIPEFF-3 explicitly avoided.

**Consequence, stated rather than discovered:** the saving arrives at the rate new commits arrive,
not at deploy. The measured ~9.8% is a steady-state figure reached over weeks. Any post-deploy
verification must be windowed on new content only, or it will read as a no-op and be misdiagnosed as
a broken patch — the failure PIPEFF-2's verification table exists to prevent.

---

## 7. The case for declining, stated so the reviewer can rule on it

I want this ruled on before build, not discovered at review of the diff:

1. **The saving is ~$5.60/month today.** The build is a schema change, a new table, a rewrite of the
   episode→item resolution that the entire arc chain depends on, and changes to purge, reclassification
   and reconcile.
2. **It is the only lever in this workstream that can cause an unrecoverable failure.** A mixed-tier
   pack cannot be cleaned up after the fact — the content has already been extracted into a group an
   external principal can read.
3. **§3.4's tier-flip window is a genuine exposure**, not a theoretical one, and A2 is the criterion I
   am least confident can be met without a projector restructure.
4. **The cheaper alternative exists and is unbuilt:** `use_combined_extraction` (parent spec §4)
   collapses `extract_nodes` + `extract_edges` into one call — an estimated ~15%, *larger* than this
   lever, as a vendored patch of the shape we have now shipped twice, with no schema change, no
   attribution surface and no tier surface.

**My recommendation to the reviewer:** attack §3.4 and A2 first. If the tier-flip window cannot be
closed, this lever should be declined in favour of `use_combined_extraction`, and this document should
stand as the record of why — which is worth more than the $5.60.

---

## 8. Open questions for plan review

1. Is the five-part pack key sufficient to make attribution loss **zero** rather than bounded, or is
   there a path by which a fact from a pack resolves to a human who did not write it?
2. Does `graph_episode_items` belong in the ledger table as an array column instead? I chose a table
   because the relation is many-to-many-ish over time (an item leaves a pack) and an array makes
   "which items are in this episode" unqueryable from the episode side.
3. Is A2 satisfiable within the current projector's per-item loop (`project.ts:607`), or does it need
   a two-phase pass (plan packs, then push)? I suspect the latter and have not specified it.
4. Is C8's discontinuity annotation enough, or should packed episodes be excluded from the
   `entitiesPerEpisode` denominator entirely?
5. Given §7, should this be built at all right now?
