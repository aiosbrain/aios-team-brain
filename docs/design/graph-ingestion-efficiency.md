# Graph ingestion bills 40× the source text

**Status:** draft, for plan review · **Date:** 2026-08-06 · **Owner:** Chetan
· **Task:** `PIPEFF-1` → [AIO-820](https://linear.app/je4light/issue/AIO-820)

## The measurement

One real batch — John's 2026-08-05 06:50 UTC workspace push, 34 items (8 Granola transcripts, 22
work docs, 4 others), 378,129 characters of source text ≈ **94,500 tokens of content**:

```
LLM calls                912
input tokens billed  3,827,266
cost                     $1.40
```

**10.1 input tokens billed per source character. ~40× the content.**

Per episode of content — 2,500 chars ≈ 625 tokens — we spend **~22,800 input tokens**. The unit price
is not the problem: extraction is already on the cheapest model that passes the quality battery, and
$1.40 for eight meeting transcripts is still indefensible.

Where it goes (same batch):

| call | calls | avg input | carried beyond the episode itself |
|---|---|---|---|
| `dedupe_nodes` | 107 | **10,412** | up to 10 candidate entities + their summaries |
| `extract_nodes` | 109 | 8,360 | **the 3 previous episodes** + entity-type prompt |
| `extract_edges` | 109 | 8,110 | the same 3 previous episodes, again |
| `dedupe_edges` | 459 | 1,060 | per edge |
| `node_summaries_batch` | 56 | 6,998 | |
| `edge_timestamps` | 72 | 552 | |

Two structural facts, both measured rather than reasoned:

1. **The same text is billed 4–5 times.** `EPISODE_WINDOW_LEN = 3` (graphiti_core, hardcoded) means
   every extract call carries the episode *plus its three predecessors*. `extract_nodes` and
   `extract_edges` each re-send that context independently.
2. **Cost is ~90% fixed overhead, not content.** Measured across yesterday's projections:

   | | chars per episode | cost each |
   |---|---|---|
   | large docs | 2,608 | $0.0099 |
   | commits | **189** | $0.0099 |

   A commit is **14× less efficient per character** than a full chunk, because the prompt, the
   previous-episode context and the candidate list dominate. **898 of 2,267 items (40%) are under 600
   characters and each occupies a whole episode.**

## Why this is the scaling question, not a tuning question

At 5–10 actively-working people the corpus grows by megabytes a week, and two multipliers compound:

**Insertion-edits re-extract everything downstream.** Chunking is byte-offset — `slice(i, i+2500)`
stepping by 2,500 — so the chunk-delta ledger (#485) only helps for same-length edits and appends.
Verified directly against `chunkContent`'s algorithm on a 50,000-char document:

| edit | chunks re-extracted (of 20) |
|---|---|
| edit in place, same length | 1 |
| append at the end | 1 |
| **insert 33 chars near the top** | **21 — all of them** |

Adding a heading, a paragraph or a bullet near the top of a document re-bills the entire rest of it.
That is the normal way documents are edited.

## What this is NOT

**Not admission control.** An earlier framing of mine proposed deciding what "deserves" to be a graph
episode. That is the wrong lever and it was rightly rejected: a team brain that declines to learn
about some of your work because reading it was expensive is a worse product, and rationing coverage
while the pipeline is 40× inefficient is fixing the symptom. **Every lever below is
coverage-neutral** — the same content, the same entities, fewer billed tokens.

(For the record, nothing was ever at risk of being unsearchable: `items` holds every body with FTS +
pgvector regardless. The graph is an additional layer. But that distinction does not rescue the idea.)

## The levers

### 1. Content-defined chunking — kill the insertion cascade

Replace byte-offset boundaries with a rolling-hash boundary (the rsync/restic/borg approach): a
boundary falls where the content says, so an insertion shifts only the chunk it lands in.
Expected: the 21-of-20 case becomes 1–2 of 20.

**The rollout is the hard part, and it is worth $51.** Changing boundaries makes every stored
`chunk_shas` entry meaningless, so `chunkConfigDeltaCompatible` returns false for all 2,267 items and
the composite skip falls them all through to a full re-push: **5,166 episodes ≈ $51.14, for zero new
information** — the same text, re-extracted under different boundaries.

**So CDC must roll out LAZILY.** An item whose body has not changed keeps its existing chunking
indefinitely; only items that actually change get re-chunked under the new algorithm. The
`chunk_config` column already records the algorithm per row (`"2500x40"` → e.g. `"cdc1-2500"`), so a
mixed corpus is representable and honest. This needs a third case in the compatibility helper that
today's two-case design cannot express:

- boundaries *trustworthy* → delta-eligible (today: same chars, cap grew);
- boundaries *stale AND the item owes content* → re-push (today: everything else);
- **boundaries stale but the item is complete → leave it alone** (new): re-pushing buys nothing, and
  the item converges the next time its body changes.

That third case is the whole difference between a $0 rollout and a $51 one, and it is the part most
likely to be got wrong — it must not become a hole through which genuinely-owed content stops being
pushed.

### 2. Cut the repeated context — `EPISODE_WINDOW_LEN` 3 → 1

A one-line `sed` in `graphiti/Dockerfile` (the precedent exists — the same file already patches
`DEFAULT_MAX_TOKENS` and constructs `OpenAIGenericClient`). Removes two of the three carried
predecessor episodes from **both** extract calls, the two largest input consumers after dedupe.

**This one has a real quality trade and must not ship on an estimate.** Previous episodes are how the
extractor resolves pronouns and references across chunk boundaries — "he said", "that project". The
2026-06/07 blank-arcs incidents were extraction-quality failures, and this is an extraction-quality
knob. Acceptance is the differential battery on the *same* 34-item batch: entity count per episode,
people recall, and `IS_DUPLICATE_OF` share must not degrade against the window-3 baseline.

### 3. Pack small items into full episodes — coverage-neutral, 40% of items

898 items under 600 characters each occupy their own episode at full fixed-overhead price. Packing
them (per source, per time bucket, preserving per-item provenance in the episode body so attribution
survives) turns ~898 episodes into ~180.

The constraint that makes this non-trivial: `graph_episodes` is keyed
`(team_id, source_table, source_id)` — one ledger row per item — and episode names are `items:<id>#k`,
which the delete/reconcile paths parse. A packed episode covers *several* item ids, so either the
ledger grows a many-to-one shape or packing is confined to a synthetic aggregate item. **This is the
lever with the deepest blast radius on existing invariants and should be the last of the three built.**

### 4. Noted, not proposed: `use_combined_extraction`

graphiti 0.29.3 can merge node+edge extraction into one call, which would collapse the two 8k-token
calls into one. Per an earlier investigation it is **unreachable from the public API** (`add_episode`
does not accept it and the sole internal caller omits it), so it would be another Dockerfile patch.
Recorded so the next person does not rediscover it; out of scope here.

## The measurement harness comes first

Before any lever, a repeatable way to price a change against a **real payload**, because this
workstream is exactly where stacked estimates go wrong:

`scripts/graph-ingest-cost.mjs <since> <until>` — reads `llm_usage` + `graph_episodes ⋈ items` for a
window and reports: source characters, episodes, calls, input tokens, **tokens-per-source-char**, and
cost, broken down by `call_kind`. The 06:50 batch is the fixed baseline every lever is measured
against (10.1 tokens/char, 5.4 calls/episode, $1.40).

A lever that cannot show movement on that number against that batch does not ship.

## Sequencing

1. **Harness** (this PR) — no behaviour change, establishes the baseline.
2. **Lever 2** (`EPISODE_WINDOW_LEN`) — biggest token win per line changed, gated on the quality battery.
3. **Lever 1** (CDC) — the durable structural fix; needs the lazy-rollout third case.
4. **Lever 3** (packing) — deepest blast radius, last.

Each is its own PR with its own before/after measurement in the body.

## How we will know it worked

Tokens-per-source-char on a replayed batch of comparable shape falls from **10.1** toward **<4**, with
entity yield, people recall and duplicate share unchanged. Cost per active-person-day becomes a number
that survives a 10× corpus rather than one that multiplies with it.

## Risks

- **Lever 2 degrades extraction quality invisibly.** Mitigated by making the battery the gate, not the
  reviewer's judgement — and the dedupe-pollution alarm (AIO-693) is live as a backstop.
- **Lever 1's lazy rollout leaves the corpus permanently mixed.** Accepted and made explicit in
  `chunk_config`; the alternative is $51 to re-extract text we already have.
- **Lever 3 collides with the one-row-per-item ledger.** Flagged early precisely so the design is
  reviewed before code, not after.
