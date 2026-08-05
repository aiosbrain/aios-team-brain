# The graph silently drops the back half of our densest documents

**Status:** revised after plan review — 1 blocker (my mechanism delivered nothing) + 1 high, both mine
· **Date:** 2026-08-05 · **Owner:** Chetan
· **Task:** `CHUNKCAP-1` → [AIO-808](https://linear.app/je4light/issue/AIO-808)

## The problem, measured

`lib/graph/project.ts` chunks an item into at most `MAX_EPISODE_CHUNKS` (16) slices of `CHUNK_CHARS`
(2,500), and `chunkContent` **drops everything past that** — 40,000 characters per item, by design, as
a "runaway-size backstop". Measured against the live ledger (2026-08-05, `graph_episodes ⋈ items`):

```
                       items   chars extracted   chars DROPPED
fully extracted        2,190       7,358,000               0
OVER the 40k cap          21         840,000         689,235
```

**689,235 characters — 8.6% of the corpus text — have never entered the graph**, and they are
concentrated in exactly the documents with the highest information density per byte:

| document | in the graph |
|---|---|
| `docs/ARCHITECTURE.md` (338,122 chars) | **11.8%** |
| `gui/server/skill-library/claude-api/…/model-migration.md` | 33.8% |
| `docs/brain-api.md` | 35.4% |
| `2-work/weekly-digest-team-2026-07-27…` | 42.6% |
| `1-inbox/transcripts/2026-07-16-follow-up-re-pikl-b2b-velocity.md` | 53.1% |
| `2-work/transcripts/2026-07-03-john-chetan-aios.md` | **54.5%** |

The last two are meeting transcripts between the people whose work the graph exists to describe. The
brain answers "what does the architecture say" from the first 12% of the architecture document, and
nothing anywhere says so — the item is fully present in `items`/FTS/pgvector, so search and citation
look complete while the *graph's* picture is truncated.

This is not a cost problem: at today's $0.0099/episode the recoverable tail is **179 episodes ≈
$1.77**, one time (see the corrected arithmetic below — my first figure was wrong).

## Why this went unnoticed

Nothing surfaces it. `chunkContent`'s own comment calls the drop "a runaway-size backstop, not the
common path" — true when written for a corpus of Slack threads (median item ~240 chars), false now
that the corpus includes 338KB design documents and 75KB transcripts. `graph_episodes.chunk_shas`
records what WAS pushed; there is no record of what was refused, so no query can find the gap without
recomputing it from `items.body` — which is how it was found, by accident, while pricing something
else.

## What plan review corrected

### 1. The predicate I proposed to change is never reached (BLOCKER)

`project.ts:440` skips an item whose body is unchanged, **before** the delta predicate at `:567`:

```ts
if (existingRow && existingRow.content_sha256 === contentSha && !tierChanged && !purgeBeforeRepush) {
  … continue;   // ← every over-cap item lands here
}
```

`content_sha256` hashes the **whole body** and is invariant to the cap, so all 21 over-cap items —
whose bodies have not changed — hit that `continue` and `deltaEligible` is never evaluated for them.
**Changing the predicate alone delivers zero tails.** The spec's own real-Postgres guard would have
gone red against the build the spec described, which is the one honest thing about the first draft.

The second change site has to be named: **the unchanged-content skip must become chunk-config-aware**,
so a body-identical item whose stored config differs routes to the delta path instead of being
skipped. There `toPush` is exactly the tail.

(An item already **complete** under the new cap does not route there at all — the composite skip's
second term keeps it skipped, so its `chunk_config` stays on the old string indefinitely. Harmless
and verified monotonic: compatibility compares the *stored* value, so a later raise still parses
compatible from `"2500x16"`. The ANTI-FLOOD guard enforces that no write happens for these.)

### 2. The backfill branch would bless chunks it never pushed (HIGH)

Inside that same skip, `:453` backfills a row with an empty chunk ledger using **current**-config
hashes. After a cap raise that would stamp 40 shas + `"2500x40"` for tail chunks never sent —
permanently marking the item extracted. The code's own comment (`:447-452`) names this exact hazard.

**Measured, and it is empirically closed:** `select count(*) from graph_episodes where
cardinality(chunk_shas) = 0` → **0 rows**. No row can take that branch today. It is still gated on a
present-and-compatible config, because "no rows today" is a fact about this instant, not an invariant.

### 3. The cost framing was wrong in both directions

There is no $47-or-$2.73 dichotomy. Measured against the ledger:

| rollout | episodes | cost |
|---|---|---|
| naive cap raise, no other change | **0** | $0 — *and no tails*, which is the actual failure |
| targeted invalidation (clear `content_sha256` on the 21 rows) | 515 | **$5.10** |
| **config-aware skip — tails only** | **179** | **$1.77** |
| naive full invalidation (clear every row) | 4,750 | $47.03 |

My "$2.73 / 276 episodes" came from dividing dropped characters by `CHUNK_CHARS` — which assumes the
new cap recovers *all* of them. It does not: **3 of the 21 items are still capped at 40**
(`ARCHITECTURE.md` needs 136 chunks). The recoverable tail is 179 episodes.

So the durable fix saves $3.33 against a targeted data-clear — trivial money. **The reason to do it
is correctness, not cost:** with the skip as shipped, any config change leaves every unchanged item
stranded on its old config *indefinitely* (until its body happens to change), so the graph holds a
permanent mix of chunkings and the sanctioned rollout is a manual production data write, every time.

## Proposal

### 1. Make the delta predicate understand the two halves of the config

Replace the string equality with a comparison that distinguishes the two parameters, because they
have different consequences:

- **`CHUNK_CHARS` differs** → every boundary moved → not delta-eligible (today's behaviour, kept).
- **`CHUNK_CHARS` same, `MAX_EPISODE_CHUNKS` GREW** → boundaries identical, tail appended →
  **delta-eligible**; the existing sha diff then pushes exactly the new chunks and nothing else.
- **`CHUNK_CHARS` same, cap SHRANK** → not delta-eligible. Chunks beyond the new cap become
  orphans in Graphiti that the ledger stops tracking (a shrink sets no pending-delete flag, so
  nothing purges them); a full re-push is the honest answer. It is not a clean one: for a
  RETAINING source nothing deletes first and `addEpisodes` does not overwrite by name, so chunks
  `0..N` land a second time alongside the originals. Rare, deliberate, and cheaper to state than
  to engineer around.

The stored `chunk_config` string is already `"<chars>x<cap>"`, so this is a parse, not a migration —
and **a malformed, empty or NULL config parses to "incompatible"**, i.e. not delta-eligible. `""` is a
real stored value (a dm fixture writes exactly that), so this is a live case, not defensive padding.

Because `test/guards/graph-delta-predicate.test.ts` asserts the predicate is a pure conjunction with
**no `||`**, the cap-grow rule cannot be inlined — it lives in a named pure helper
(`chunkConfigDeltaCompatible(stored, current)`) that the predicate calls as one term. That is also
where the four cases are unit-tested, and it keeps the guard's no-`||` assertion intact rather than
weakening it to accommodate this change.

### 1b. …and make the unchanged-content skip reach it — asking a DIFFERENT question

The change above is inert without this one (the blocker). But the second draft got the condition
backwards, which would have re-shipped the same bug in new words: I wrote "fall through when the
stored config is **incompatible**" — and `2500x16` → `2500x40` *is* compatible (that is precisely
what makes it delta-eligible). All 21 items would still have skipped.

**The two sites ask different questions, and one boolean cannot answer both:**

| site | question | cap-grew answer |
|---|---|---|
| delta predicate (`:567`) | can I trust the stored shas? | **yes** — boundaries unchanged |
| unchanged-content skip (`:440`) | could this item still OWE chunks? | **depends on the body's length** |

So the skip's condition is composite:

```
skip  iff  <the existing sha / tier / purge terms>                         // unchanged
      AND  chunkConfigDeltaCompatible(stored, current)
      AND  episodes.length <= (existingRow.chunk_shas?.length ?? 0)        // nothing owed
```

Both new terms are AND-ed **into** the existing condition, not a replacement for it. And
`currentChunkCount` is `episodes.length` — never a re-derived `ceil(len/chars)`, which is a second
derivation that can drift from `chunkContent` (they already disagree on a whitespace-only body) and
would violate the module's own rule at `:396` that the ledger is derived from `episodes` so it "can
never describe something else".

That routes exactly the 21 owing items to the delta path (where `toPush` is their tail), keeps all
2,190 complete items skipped, and is what makes the cost table's 179 episodes exact rather than
aspirational. Both terms are free: `episodes` and `chunkShas` are already computed at `:374`/`:398`,
above the skip — no reordering, no added work on the hot path for the 2,190.

**A `CHUNK_CHARS` change still floods, and that is correct.** Compatibility fails, so every item —
complete or not — falls through to a full re-push, because every boundary genuinely moved. Today that
flood requires a manual `content_sha256` clear and otherwise never happens at all; after this change
it happens automatically on deploy. That is the right behaviour and a real cost (~$47 at today's
corpus), so changing `CHUNK_CHARS` becomes a decision with a price tag attached rather than a
constant edit whose effect arrives item-by-item over months. Worth stating loudly next to the
constant.

**The backfill at `:453` was gated on STRICT equality** (`stored === CHUNK_CONFIG`), not helper
compatibility — under compatibility, an empty-ledger over-cap row would stamp current-config hashes
for tails never pushed, i.e. the hazard surviving its own fix. (Under the composite skip such a row
always "owes chunks" and falls through to a sound full push anyway; the gate is strict regardless,
because a second line of defence that shares the first one's blind spot is not one.)

### Found at build: the backfill branch is DELETED, not gated

Building this made the branch unreachable — a pre-ledger row carries `chunk_config = ""`, which the
composite skip correctly rejects, so the backfill inside the skip can never run and its acceptance
criterion (AC4) went red. Reviewed rather than patched, and the branch is **removed**:

- **Its own comment set the expiry.** The premise "an identical body means these are the chunks we
  pushed" holds "only while the chunk config is the one that produced them, which an empty ledger
  cannot attest", and it prescribed invalidation on any config change. This change *is* that change.
- **For the population it still served, it produced this feature's own bug.** A pre-ledger row over
  the old cap would have been blessed with 40 current-config hashes including tails present in the
  graph in no form — permanent silent loss, invisible to reconcile. A full push is both correct and
  the first time those tails are extracted.
- **The "bless shas but not the config" variant is self-defeating.** The saving lives entirely in the
  *subsequent* skip, that skip requires a trusted config, and a pre-ledger row's producing config is
  unattestable by construction. It would re-push next pass anyway, from a ledger claiming hashes it
  never used.

**AC4 is inverted, not deleted:** a pre-feature row (empty ledger, `""` config, unchanged body) now
converges via one full re-push and lands on the current config. That is the self-hosted upgrade path,
and the guard that stops someone restoring the backfill without confronting the hazard above.

**Upgrade-path note for the release, not a mechanism:** an install upgrading from pre-GRAPHCOST-1 with
Graphiti enabled re-extracts its pre-ledger rows once, on the first tick (~$0.01/episode). Prod holds
**0** such rows so the cost table below is unchanged; building a migration for that population would
be a guard with no failure mode behind it.

### 2. Raise the cap to 40 (100,000 chars/item)

Sized from the measured corpus, not chosen: 40 chunks covers **18 of the 21** over-cap items
completely. The three it does not (`ARCHITECTURE.md` needs **136** chunks, `model-migration.md` 48,
`brain-api.md` 46) are pathological and stay capped — a 338KB file is a documentation-structure
problem, not an extraction-budget one, and this doc's job is not to hide that by paying to extract it.

Cost at 40: **179 episodes ≈ $1.77**, one time; ongoing, only items that grow past 100,000 chars pay
more than today. Verified read-only in prod: neither `GRAPH_MAX_EPISODE_CHUNKS` nor
`GRAPH_CHUNK_CHARS` is set on the service, so the code default is what takes effect.

**Why the per-episode ceiling is NOT at risk.** `MAX_EPISODE_CHUNKS` changes how many episodes an item
becomes; `CHUNK_CHARS` (unchanged at 2,500) governs how big each one is. Graphiti's extraction cap is
per-episode — the 2026-06/07 blank-arcs incidents were oversized *episodes* overflowing the 8,192-token
output ceiling (fixed by the image's 16,384 patch and by `CHUNK_CHARS` itself). Nothing in this change
makes any episode larger. That is the load-bearing distinction and the reason this is a safe knob.

### 3. Make the drop visible instead of silent — SPECCED, DEFERRED (not in the first PR)

**Status: not built.** The tails-land half is self-contained and verified; this observability half
changes `chunkContent`'s signature and threads a count through two summary types, and it was cleaner
to ship the correctness fix on its own than to bundle a second surface into it. Deferred deliberately
and tracked as **CHUNKCAP-2 → [AIO-811](https://linear.app/je4light/issue/AIO-811)**, not forgotten — and no comment or test in the shipped code may claim it exists (one did,
which the code review caught).


`chunkContent` currently discards the tail with no signal. It should report how many characters it
refused, and the projector should record the total on the run (`ingest_runs.meta.chunk_overflow_chars`)
— so "the graph is missing content" becomes a number on a surface someone already reads, rather than
something you rediscover by joining `items` against a constant. Non-zero from day one here (the three
still-capped files), which is the point: it names them instead of hiding them.

Two ripples this touches, both stated so they are not discovered at build time: `chunkContent`'s
signature changes (callers in `toEpisodes` plus its unit tests), and the count must be threaded
through **both** summary types — `ProjectSummary` and `GraphProjectionSummary` → `projection-run`
meta. Two summaries for one fact is the H6 drift shape; one writer, both readers.

## Guards (CLAUDE.md §7)

- **The helper's four cases, unit-tested and each mutation-proven**: same-config → eligible;
  chars-changed → ineligible; cap-grown → **eligible** (the new case); cap-shrunk → ineligible; plus
  malformed/`""`/NULL → ineligible. `test/guards/graph-delta-predicate.test.ts` is **rewritten** to
  pin the helper call as the predicate's term — its current slice-anchor on the literal
  `existingRow.chunk_config === CHUNK_CONFIG` breaks loudly (the length assertion reddens), which is
  the guard behaving correctly, not collateral.
- **Both degenerate implementations die to a NAMED test, which is the point of listing them.** A
  *compatibility-only* skip (dropping the count term) is killed by the tail test: cap-grew is
  compatible, so all 21 items skip and no tail lands. A *count-only* skip (dropping the compatibility
  term) needed its own fixture — **AC11 does NOT kill it**, which I claimed and the code review
  disproved: AC11 edits the body, so the sha term fails first and neither new term is ever consulted.
  The killer is a dedicated case: unchanged body, real pushed shas kept (so counts match by
  construction), `chunk_config` rewritten to a **different-chars** value ⇒ must full re-push.
- **ANTI-FLOOD — the case that separates a correct build from a plausible one.** A body-unchanged,
  config-stale, **complete** item from a RETRACTABLE source (Slack) must be neither deleted nor
  re-pushed: the fake-graphiti spy log must be empty for it. A builder who implements the skip as
  bare `stored !== CHUNK_CONFIG` passes every other guard here while sending the whole corpus through
  the push path — and for retractable sources the retract-delete branch (`:494-517`) fires *before*
  the predicate, so each Slack item gets a `deleteItemEpisodes` + full re-push, unbudgeted. This
  guard is the difference.
- **The append-only claim is asserted, not assumed**: a test that chunking a fixed body at cap 16 and
  at cap 40 yields byte-identical first-16 chunks. If that is ever false, the delta optimisation is
  unsound and this test is what says so.
- **Real-Postgres**: an item stored at `2500x16` with 16 shas, re-projected under `2500x40`, pushes
  ONLY the tail — asserted against the fake-graphiti spy's call log, not just the ledger row.
- **Overflow accounting**: `chunkContent` reports refused characters; a fixture over the cap reports
  exactly `len - chars*cap`, and one under it reports 0.

## What this does not do

- It does not re-project the corpus. The tails land on the projector's **first tick after deploy** —
  one burst, not "normal pace": `lib/graph/run.ts` full-rescans from `since: undefined` every tick, so
  all 179 episodes POST in that run. Harmless at this size (one ~110KB POST per item, serial worker,
  and reconcile cannot false-requeue because its landed-check is satisfied by any chunk), but it is a
  burst and the spec should not pretend otherwise.
- **Scoping (SR18):** the delta path is retaining-sources-only (predicate term 1). All 21 over-cap
  items are workspace/github/transcript sources with `retainSupersededBodies: true`, so the set is
  covered today; a retractable-source item over the cap would get its tail only on its next body
  change. Named rather than assumed.
- It does not clean the existing duplicate entities (separate task) or change extraction quality.
- It does not fix `ARCHITECTURE.md` being 338KB. That file is over any reasonable budget and the right
  answer is splitting it, which is a docs decision, not a projector one.

## How we will know it worked

Not the admission-side sum I first proposed — `sum(greatest(length(body) − chars×cap, 0))` reads its
target the instant the constant changes, whether or not a single tail landed, and `chunk_shas` is
written on POST-**accept** (202 ≠ extracted) while reconcile's landed-check is satisfied by chunk `#0`
alone. Every one of those signals is green if the worker dies mid-burst.

The verification is **extraction-side, once, after the rollout**: count episodes in Graphiti under
each `items:<id>` name-prefix and compare against that row's `chunk_shas` length, for the 21 items.
Equal ⇒ the tails actually landed. Alongside it: transition spend inside ~$2. (The
overflow counter is NOT a criterion for this change — it belongs to AIO-811, whose acceptance signal
it is. A criterion this PR cannot satisfy would contradict §3's own DEFERRED status.)

**And the remediation, named rather than left to improvisation:** a mismatch means Graphiti accepted
(202) and its worker then died, so the ledger blessed chunks that were never extracted — invisible to
reconcile forever, because its landed-check is satisfied by chunk `#0`. The heal is to clear
`content_sha256` to `''` on the mismatched rows: the sentinel misses the skip *and* fails delta term
4, forcing a real full re-push. (A wholly dead worker is separately caught by the extraction-health
fact-count probe; it is the per-item ledger blessing that has no automatic retry.)
