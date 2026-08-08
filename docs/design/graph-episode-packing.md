# Packing small items into shared graph episodes — PIPEFF-4 / AIO-845

**Status: DECLINED, on evidence, after plan review. Not built.**
This document is the record of why, and of what would have to change for the answer to flip.

**Parent:** `docs/design/graph-ingestion-efficiency.md` §3 ("lever 3 — deepest blast radius, built last").
**Siblings shipped:** PIPEFF-2 (predecessor filter, −25.5% verified in prod) · PIPEFF-3 (content-defined chunking).

---

## 0. The verdict, and the two things that produced it

I specified this lever in full, then Fable plan-reviewed it. The review returned **BLOCKED** on two
counts: **a fact about the payload that makes the lever smaller than the parent spec assumed**, and
**a defect in my design that makes it more dangerous** — I originally wrote that the findings "were
not defects in the design", which is self-flattering and wrong: §3 is a defect, and it is mine.

1. **The saving is smaller than §1 first priced**, because PIPEFF-2 — which we shipped *yesterday* —
   removed the predecessor block, which is proportionally the largest cost of exactly these episodes.
   **How much smaller is an inference, not a measurement** (§2), and it is labelled as one throughout.
2. **The design as I wrote it specified an indefinite tier leak**, and the fix for it erodes the
   saving further.

**The decline does not hinge on that inference, and this is the point to check before reading further.**
Three findings carry it on their own, every one of them measured or quoted from code:

- **accretion** halves the episode cut (§2, measured: 4.47 sync-hours/author-day against an hourly
  projector);
- **the §3 leak**, quoted verbatim from `project.ts:752`;
- **the §4/§5 quality regressions**, which are volume-independent and arguably worsen as commit share
  grows.

Even if a commit episode cost the **full** fleet average, those three still decline the lever. The
pricing inference makes it more obviously not worth building; it is not what makes it not worth
building. I state that explicitly because I have an incentive to make the case airtight, and the
reviewer said so.

The lever is declined in favour of `use_combined_extraction`, with that alternative re-costed rather
than inherited from the parent spec's note.

---

## 1. What the payload actually is (measured, prod, 2026-08-08)

Items synced in the last 30 days, estimated episodes:

| source | items | est. episodes | of which small (<600 chars) |
|---|---|---|---|
| `github/` | 674 | 2,298 | 50 |
| `linear/` | 593 | 975 | 109 |
| `2-work/` | 148 | 778 | 4 |
| **`commits/`** | **570** | **570** | **570 — 100%** |
| everything else | ~130 | ~550 | ~50 |
| **total** | | **~5,170** (ledger: 5,068) | |

**The lever is a commits lever.** 570 of ~5,170 episodes — 11.0% — are commit items, every one under
600 chars, averaging **198**. Nothing else in the corpus has this shape.

**Author distribution, corrected.** My first pass reported John 338 / Chetan 314 — from *git-author
frontmatter*. Those sum to 652 against a population of 570, which should have stopped me and didn't.
Resolved through `items.member_id`, the resolver arc credit actually uses:

| who | commits (30d) |
|---|---|
| John Ellison | 296 |
| Chetan | 257 |
| (null `member_id`) | 17 |
| | **570** ✓ |

**That the two resolvers disagree is itself a finding** — see §4.3.

### Arc evidence: heavily used, but I over-read the rank

Citations across all arcs currently in `arc_cache`, by source of the cited item:

| source | citations | distinct items |
|---|---|---|
| `commits/` | 16 | 15 |
| `github/` | 10 | 10 |
| `linear/` | 6 | 2 |
| `2-work/` | 2 | 2 |
| `slack/` | 1 | 1 |

I originally wrote "**the single most-cited** arc evidence source". That is not supportable: this is
**one `arc_cache` row, 6 arcs, one snapshot day, n=35 clustered citations**. 16-vs-10 is p≈0.16 by
sign test. The supportable claim — and all the argument needs — is that **commits are a heavily-used
evidence channel, cited by 5 of the 6 current arcs** (spread 4/4/4/2/2/0, so not one arc's artifact).

This is the second time this week I have ranked on a sample too small to rank. Recorded here rather
than quietly softened.

---

## 2. Why the saving is smaller than it looks — the PIPEFF-2 interaction

§1's episode count is real. Pricing it at the fleet average is not.

**PIPEFF-2's patch gives a single-chunk item ZERO predecessors** — `graphiti/patch-same-item.py:12`,
verbatim: *"A single-chunk item gets ZERO predecessors; a multi-chunk item keeps all of…"*. Every
commit is single-chunk by definition (198 chars against a 1,250-char minimum). So **commit episodes
already carry no predecessor block at all**, and their bodies are ~50 tokens.

The fleet average of **$0.0110/episode** (PIPEFF-2's verified post-deploy figure) is dominated by
multi-chunk episodes that *do* carry a predecessor block. Commit episodes therefore sit **below** it —
by how much is the open question of this section. Pricing 507 eliminated commit episodes at the fleet
average — which §1 of the original draft did — **credits this lever with some of the saving PIPEFF-2
banked yesterday.**

I have **not** measured the marginal cost of a commit episode, and this section's central claim is
therefore an **inference** — from the zero-predecessor rule plus a ~50-token body — not a
measurement. It is labelled as one deliberately, because it is the load-bearing fact of the decline.

**I tried to measure it and it is not obtainable from existing data.** Querying every projection hour
since the PIPEFF-2 deploy (2026-08-07 07:08:24Z) for an hour whose episodes were *all* commits
returns **nothing** — post-deploy volume is 24 episodes across 6 hours, every one of them mixed:

```
07:00 → 3 eps (1 commit)   08:00 → 7 (2)   09:00 → 7 (0)
10:00 → 1 (0)              16:00 → 3 (1)   00:00 → 3 (1)
```

So the number needs a **deliberately constructed** commits-only drain-clean window, not a lucky one.
That is cheap and it has not been done. Until it exists, treat every figure in this section as a
ceiling.

What is not in doubt is the *direction*, and it can be **bounded** without guessing at magnitude: the
marginal saving per eliminated episode sits between a floor (the fixed prompt boilerplate a commit
episode still pays across its ~4–10 calls, plus its **output** tokens, which the predecessor cut never
touched) and a ceiling (the $0.0110 fleet average). So the pre-accretion saving is **≤ $5.60/month by
construction**, and accretion halves whatever it actually is.

I deliberately do not say "the cut is large". A commit episode plausibly still costs one-third to
two-thirds of fleet average — at two-thirds, PIPEFF-2 banked about a third of this lever's saving, not
most of it. **The bound is what the decline uses; the magnitude is unmeasured and stays unmeasured in
this document.**

### And accretion halves the episode count too

A pack must be re-pushed as its day accretes. Measured: a `(member, work-day)`'s commits arrive
across **4.47 distinct sync hours on average (median 3, max 16)**, and the projector runs hourly
(`project.ts:233`). So under the replace semantics §3 shows are mandatory, each author-day pack is
deleted and re-pushed **3–5 times**:

- episodes pushed per author-day ≈ **3–5, not 1** → the ~9.8% episode cut becomes **~5%**
- each re-push **re-extracts the whole accumulated pack** — repeated extraction of identical text,
  which is pressure on the dedupe-pollution alarm re-armed two days ago
- every delete+re-add **churns episode UUIDs** that cached arcs' `episodeUuids` still reference,
  blanking evidence resolution mid-day

**Combined: roughly half the episode saving, on episodes that were already cheaper than average by
an unmeasured margin.** The honest
figure is low single-digit dollars per month at today's volume, and I decline to state it more
precisely than that without the commits-only cost window.

---

## 3. The design as specified contained a leak

The original §3.4 said: *"**Never** delete the pack episode while other members remain"* and *"delete
the pack episode only when its last member leaves."*

**`addEpisodes` does not overwrite by name** — `project.ts:752`, verbatim: *"`addEpisodes` does not
overwrite by name — Graphiti keeps the old episode and the facts extracted from it."*

So "re-push the pack without the removed member" **adds a second episode**. The old one — containing
a reclassified or purged member's text *and its extracted facts* — stays readable in the old group
until the last member leaves, i.e. for a 9-commit day pack, effectively forever.

That is:
- the falsifier of my own A2 (tier-flip exposure), verbatim;
- a violation of the `lib/ingest/purge` contract — a purged commit's text stays extracted;
- **covered by no acceptance criterion I wrote.** A3 asserted survivors keep their content; nothing
  asserted the removed member's content is *gone*. The criterion set had a hole exactly where the
  danger was.

**The fix is replace semantics** — delete the old pack episode(s) by name, *then* push the remainder,
in that order (safe precisely because the survivors are re-pushed). That requires the two-phase
projector §8 Q3 suspected, because the per-item loop at `project.ts:607` cannot assemble a pack body.
With it, the residual window is the same class as today's per-item tier flip — no new exposure class.
But the price is that **every membership change becomes "delete 9, re-extract 8"**, which is the
accretion cost in §2.

---

## 4. The central claim did not survive: attribution loss is bounded, not zero

The design's justification was that binding `author` into the pack key makes attribution loss **zero**
rather than bounded. Three live paths say otherwise.

**4.1 Pack-time binding vs live credit resolution.** The pack key freezes `author` at pack time.
`resolveItemCredit` (`lib/attribution/contributor-credit.ts`) resolves **live** — from
`items.member_id`, `member_id_locked` admin corrections, `item_versions`, and `member_identities`
remaps. An identity remap or an admin correction on one of nine members *after* the pack is pushed
makes the pack retroactively mixed-credit, and **nothing re-packs on a credit change** (the delta is
content-sha keyed; `member_id` is not in it). `actorOfFact` (`arcs.ts:802`) then assigns "the first
item that resolves a human" to *every* fact from the pack, and `attributedFactTexts`
(`arc-attribution.ts:118-135`) unions humans across the pack's item set. Per-item episodes stay
correct through exactly the same correction today.

**4.2 The pack-key author resolver was never specified** — and §1 shows the two candidate resolvers
disagree *today* (frontmatter 338/314 vs `member_id` 296/257/17-null). If the pack key uses one and
arc credit uses the other, mixed-credit packs exist from day one, no drift required. My A4 test, with
a clean fixture where both resolvers agree, would have been **green by construction** against both
this and 4.1.

**4.3 Item-level provenance loss is attribution loss on this codebase's own terms.**
`ArcEvidence.itemId` (`arcs.ts:38`) becomes arbitrary-of-nine. I filed that as "a product question".
That undercounts it: item ids are also the only channel by which graph payoff can be priced at all,
and the anchor of arc identity (§5).

---

## 5. Two functionality regressions the criteria never covered

**5.1 Arc identity (C10 had no design answer and no criterion).** With `resolveEpisodeItems` returning
`itemIds: string[]`, either:
- fact→item collapses to one representative (`actorOfFact` first-match), shrinking a commit-heavy
  arc's evidence anchors from ~9/day to 1 and starving `MIN_SHARED_ITEMS = 2`
  (`arc-continuity.ts:29`) — **arcs on this evidence source get reborn daily**, the exact churn
  `arc-continuity` exists to stop; or
- evidence fans out to all nine, and two unrelated arcs each citing one fact from the same pack now
  share ≥2 items, `isSameArc` binds them, and one is absorbed into the other.

The spec specified neither. Either is a functionality loss.

**5.2 Prompt representation collapse.** All facts from a pack resolve to one item for balancing
(`itemOfFact` → same first item), so `PER_ITEM_CAP = 20` (`arcs.ts:86`, applied `arcs.ts:863`) caps an
author's **entire commit day** as one item, where today it is ~9 items each with their own cap.
Commit work's share of the synthesis prompt shrinks. This is the narrative-arcs representation-skew
class — the failure the per-contributor round-robin fix was built for — reintroduced through a
different door. No criterion covered it.

---

## 6. Corrections to my own analysis, recorded

| what I wrote | what is true |
|---|---|
| "the single most-cited arc evidence source" | heavily cited (5 of 6 arcs); n=35 from one snapshot is too small to rank |
| authors 338 / 314 | 296 / 257 / 17-null via `items.member_id`; my figures came from frontmatter and summed to more than the population |
| "~$5.60/month" | priced at the fleet average; commit episodes carry **zero** predecessors post-PIPEFF-2 and are the cheapest in the fleet. Low single digits, and unmeasured |
| "~9.8% episode cut" | ~5% after accretion re-pushes (4.47 sync-hours/author-day, hourly projector) |
| "attribution cost is zero" | **bounded**, not zero — §4 |
| `entitiesPerEpisode` "steps downward" | steps **up** (fewer episodes, ~constant entities); direction is genuinely ambiguous once accretion re-pushes are counted, which is itself the point — I stated a hypothesis as a prediction |
| anchors `arcs.ts:766 / 352 / 817` | `802` (`actorOfFact`) / `38` (`ArcEvidence`) / `849-856` (eligibility). Taken from a subagent's map and not read |

**On the sensor (C8), the review's ruling stands and I accept it:** an annotation is sufficient;
excluding packs from the `entitiesPerEpisode` denominator would blind it to pack-extraction failures.
Do not exclude.

---

## 7. What to do instead — `use_combined_extraction`, re-costed honestly

Verified in the actual `graphiti_core` 0.29.3 wheel rather than trusted from the parent spec:

- It **exists** — `utils/maintenance/combined_extraction.py`, referenced at `utils/bulk_utils.py:271`.
- The parent's "unreachable from the public API" note is **accurate**: it lives only on the
  `add_episode_bulk` path, and even there the sole internal caller (`graphiti.py:798`) does not pass
  it, so it defaults `False`. The single-episode `add_episode` path the REST server uses calls
  `extract_nodes` (`graphiti.py:617`) and `extract_edges` (`graphiti.py:656`) separately.

**Correction to my own §7.4 in the first draft:** I called it "a patch of the shape we have shipped
twice". It is not. `extract_nodes_and_edges` is single-episode-shaped and returns exactly the
`(nodes, edges, index_map)` the pipeline needs, but installing it means **rerouting control flow
across `_extract_and_resolve_nodes` / `_extract_and_resolve_edges`** — materially deeper than
patch-same-item's 17-line filter insert. And it **changes the extraction prompt**, so it needs its own
quality battery (~4 reps, given the measured ~7% run-to-run noise at temperature 0).

In its favour: upstream's own docstring claims combined extraction *"produces better results… reducing
orphaned nodes"*, so the quality risk is at least not adverse — unlike this lever, where every risk
pointed one way.

**Its ~15% is the parent spec's estimate and is itself unmeasured** — flagged here because this
document exists to stop unmeasured parent numbers travelling, and carrying one through unhedged while
correcting the other would be exactly that failure.

**It is still the better next lever**: larger (~15% estimated vs ~5% measured), no schema change, no new table, no
attribution surface, and **no tier surface** — which is the one that matters, because packing is the
only lever in this workstream with an unrecoverable failure mode.

---

## 8. What would flip this decision

Not "more conviction" — these, specifically:

1. **Volume — but with no numeric trigger, and never on its own.** An earlier draft of this section
   said "revisit when commit episodes exceed ~25% of the fleet, or the marginal saving exceeds
   ~$25/month". **Both numbers were invented** — round figures with no derivation anywhere in this
   document. Worse, a dollar trigger contradicts the constraint that governs this whole workstream:
   §4's attribution paths and §5's arc-identity and representation regressions are
   **volume-independent** — arc-identity churn arguably *worsens* as commit share grows — and cost may
   not be bought with quality at any price. **So no saving figure alone can flip this.** Revisit on
   volume only *in combination with* item 4 below, or with a design that actually resolves §4 and §5.
2. **A measured marginal price for a commit episode.** Until that exists, every number here is a
   ceiling. It is a free measurement and it is the first thing to do if anyone reopens this.
3. **A two-phase projector**, if one is built for another reason. §3's replace semantics need it, and
   it is most of the build cost.
4. **Per-item provenance inside the graph payload.** The root constraint is that authorship never
   reaches Graphiti (`graphiti-client.ts` sends `role: null`) so the episode *name* is the only
   structured provenance. If that ever changes, §4 and §5 mostly dissolve.

---

## 9. What this cost, and what it bought

Two prod measurement passes and one plan review; **no code, no LLM spend, nothing deployed.**

What it bought beyond the decline:

- **PIPEFF-2 already banked a material — but unmeasured — fraction of this lever's saving** (the
  predecessor block, proportionally largest for exactly these episodes; *not* established as "most")
  — single-chunk items get zero predecessors,
  so the small-item tail is no longer the expensive thing the parent spec described. **The parent
  spec's §3 is now stale and should say so.**
- **The commits-only marginal cost is unmeasured**, and it is the number any future small-item work
  starts from.
- **`use_combined_extraction` is real and reachable via a deeper patch** — verified in the wheel, no
  longer a note anyone has to re-derive.
- **An acceptance-criteria hole worth remembering:** I wrote A1–A11 against the constraints I had
  listed, and still missed the criterion for "the removed member's content is gone" — the *inverse*
  of the one I did write. When a criterion asserts something survives, ask what must not.

---

## Appendix — what survives the decline

Restored at the reviewer's insistence: the rewrite deleted both of these, and they are the most
durable things this work produced. Anyone touching graph projection for **any** reason starts
here rather than re-deriving it.

### A.1 Terrain facts C1–C10 (verified against the working tree; true independent of packing)

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
| C9 | Eligibility keeps a fact if **any** of its items is eligible | `arcs.ts:849-856` | An ineligible item rides along on an eligible pack-mate. |
| C10 | Arc identity is item-set overlap, `MIN_SHARED_ITEMS = 2` | `arc-continuity.ts:29,39` | Changing which items a fact resolves to perturbs day-to-day arc identity. |


### A.2 Design fragments the review upheld

The lever is declined; these parts of it were judged **correct** and should be reused, not rebuilt, if
anyone reopens this or designs anything adjacent:

- **`group_id` inside the pack key.** This closes C1 *by construction* rather than by check — two
  items of different `access` cannot share a key because the key contains the group. For the one
  invariant with no RLS backstop, "impossible by construction" beats any guard.
- **Never pack an author-less item.** Not "pack into a `(none)` bucket" — never. Measured population:
  17 of 570 commits (3%), immaterial to the saving and material to correctness.
- **A join table, not an array column.** Reconcile's fixed landed-check needs the *episode-side*
  question ("which members does `pack:<id>` claim"), which an array on member rows cannot answer
  without a scan; and membership changing over time makes the array a mutation-in-place shape.
- **Replace semantics as the deletion primitive** — delete the old pack episode(s) by name, *then*
  push the remainder, in that order. This is the correct fix for §3's leak, and it is safe precisely
  because the survivors are re-pushed. It needs a two-phase projector (§8.3).
- **`entitiesPerEpisode` keeps packs in its denominator.** Excluding them would blind the sensor to
  pack-extraction failures. Annotate the discontinuity instead.
