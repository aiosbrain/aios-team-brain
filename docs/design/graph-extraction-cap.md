# The graph silently drops the back half of our densest documents

**Status:** draft, for plan review · **Date:** 2026-08-05 · **Owner:** Chetan
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

This is not a cost problem. At today's $0.0099/episode the missing tail is **276 episodes ≈ $2.73**,
one time.

## Why this went unnoticed

Nothing surfaces it. `chunkContent`'s own comment calls the drop "a runaway-size backstop, not the
common path" — true when written for a corpus of Slack threads (median item ~240 chars), false now
that the corpus includes 338KB design documents and 75KB transcripts. `graph_episodes.chunk_shas`
records what WAS pushed; there is no record of what was refused, so no query can find the gap without
recomputing it from `items.body` — which is how it was found, by accident, while pricing something
else.

## The decision that costs 17×

Raising `MAX_EPISODE_CHUNKS` changes `CHUNK_CONFIG` (`"2500x16"` → `"2500x40"`), and
`project.ts:566` makes an item delta-INELIGIBLE when its stored config differs:

```ts
existingRow.chunk_config === CHUNK_CONFIG;
```

That predicate is correct and was deliberately added (#485's spec review found it): a changed
`CHUNK_CHARS` moves every chunk boundary, so every stored sha is stale and a full re-push is the only
safe answer. **But a raised CAP is not that.** Chunking is `body.slice(i, i + size)` stepping by
`size`; increasing only `maxChunks` leaves chunks `0..15` byte-identical and merely *appends*
`16..N`. Their shas still match.

So the same edit is either:

- **$47.03** — 4,750 episodes, the entire corpus re-extracted because the config string changed; or
- **$2.73** — 276 episodes, only the tails that were never pushed.

The second is also strictly safer: a full re-push re-extracts 2,190 items that were already complete,
adding graph churn and dedupe load for nothing.

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

The stored `chunk_config` string is already `"<chars>x<cap>"`, so this is a parse, not a migration.

### 2. Raise the cap to 40 (100,000 chars/item)

Sized from the measured corpus, not chosen: 40 chunks covers **19 of the 21** over-cap items
completely. The two it does not (`ARCHITECTURE.md` at 135 chunks, `model-migration.md` at 48) are
pathological and should stay capped — a 338KB file is a documentation-structure problem, not an
extraction-budget one, and this doc's job is not to hide that by paying to extract it.

Cost at 40: the 276-episode tail becomes ~**$2.73**; ongoing, only items that grow past 40,000 chars
pay more than today.

**Why the per-episode ceiling is NOT at risk.** `MAX_EPISODE_CHUNKS` changes how many episodes an item
becomes; `CHUNK_CHARS` (unchanged at 2,500) governs how big each one is. Graphiti's extraction cap is
per-episode — the 2026-06/07 blank-arcs incidents were oversized *episodes* overflowing the 8,192-token
output ceiling (fixed by the image's 16,384 patch and by `CHUNK_CHARS` itself). Nothing in this change
makes any episode larger. That is the load-bearing distinction and the reason this is a safe knob.

### 3. Make the drop visible instead of silent

`chunkContent` currently discards the tail with no signal. It should report how many characters it
refused, and the projector should record the total on the run (`ingest_runs.meta.chunk_overflow_chars`)
— so "the graph is missing content" becomes a number on a surface someone already reads, rather than
something you rediscover by joining `items` against a constant. Zero on a healthy corpus; non-zero the
moment a document outgrows the budget again.

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

- It does not re-project the corpus. The tails land on the projector's normal tick, at normal pace,
  because delta-eligibility means each item pushes only what it owes.
- It does not clean the existing duplicate entities (separate task) or change extraction quality.
- It does not fix `ARCHITECTURE.md` being 338KB. That file is over any reasonable budget and the right
  answer is splitting it, which is a docs decision, not a projector one.

## How we will know it worked

`sum(greatest(length(body) - CHUNK_CHARS*MAX_EPISODE_CHUNKS, 0))` over `graph_episodes ⋈ items` falls
from 689,235 to the residue of the two pathological files, and the projector's overflow counter reads
that residue rather than zero — with total spend for the transition inside ~$5, not ~$47.
