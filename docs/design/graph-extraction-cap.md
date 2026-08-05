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
skipped. There `toPush` is exactly the tail (or empty, for an item already complete under the new
config, whose ledger row is then refreshed to the current config and nothing is sent).

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
- **`CHUNK_CHARS` same, cap SHRANK** → not delta-eligible. Chunks beyond the new cap are now orphans
  in Graphiti that our ledger would stop tracking; a full re-push (which `purgeBeforeRepush` precedes)
  is the honest answer. This case earns no optimisation — it is rare and the cheap path is wrong.

The stored `chunk_config` string is already `"<chars>x<cap>"`, so this is a parse, not a migration —
and **a malformed, empty or NULL config parses to "incompatible"**, i.e. not delta-eligible. `""` is a
real stored value (a dm fixture writes exactly that), so this is a live case, not defensive padding.

Because `test/guards/graph-delta-predicate.test.ts` asserts the predicate is a pure conjunction with
**no `||`**, the cap-grow rule cannot be inlined — it lives in a named pure helper
(`chunkConfigDeltaCompatible(stored, current)`) that the predicate calls as one term. That is also
where the four cases are unit-tested, and it keeps the guard's no-`||` assertion intact rather than
weakening it to accommodate this change.

### 1b. …and make the unchanged-content skip reach it

The change above is inert without this one (the blocker). At `project.ts:440`, an item whose body is
unchanged but whose stored config is **incompatible with the current one** must fall through to the
delta path rather than `continue`. Same helper, same three cases, so the two sites cannot disagree.

The backfill at `:453` is additionally gated on a present-and-compatible stored config, so it can
never bless current-config hashes for chunks pushed under a different one.

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

### 3. Make the drop visible instead of silent

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

- **The delta predicate's three cases, unit-tested and each mutation-proven**: same-config →
  eligible; chars-changed → ineligible; cap-grown → **eligible** (the new case, and the one worth
  $44); cap-shrunk → ineligible. The existing `test/guards/graph-delta-predicate.test.ts` is where
  this belongs — it already exists precisely because this predicate is load-bearing.
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
Equal ⇒ the tails actually landed. Alongside it: transition spend inside ~$2, and the overflow counter
reporting the three-file residue rather than 0 or 689,235.
