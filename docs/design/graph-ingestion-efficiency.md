# Graph ingestion bills ~64× the source text

**Status:** revised after plan review — 1 blocker (my patch target was a no-op) + a corrected baseline
· **Date:** 2026-08-06 · **Owner:** Chetan
· **Task:** `PIPEFF-1` → [AIO-820](https://linear.app/je4light/issue/AIO-820)

## What plan review corrected, first

### 1. The constant I proposed patching is not the one in the path (BLOCKER)

I named `EPISODE_WINDOW_LEN = 3` as the repeated-context knob. **The deployed `add_episode` path
does not use it.** Verified against graphiti_core 0.29.3, the exact pin in `graphiti/Dockerfile`:

```python
# graphiti_core/graphiti.py:1087-1090
previous_episodes = (
    await self.retrieve_episodes(
        last_n=RELEVANT_SCHEMA_LIMIT,      # ← 10, not EPISODE_WINDOW_LEN's 3
```

`EPISODE_WINDOW_LEN` reaches only `bulk_utils.py`, which the server never calls. So the sed I
proposed would have built green, passed a grep gate, and **changed nothing** — the silent-no-op class
this Dockerfile's own comments were written to prevent.

Two consequences beyond the patch target:
- **The real window is 10 previous episodes, not 3.** That is why an `extract_nodes` call averages
  8,360 input tokens for a 625-token episode: ~6,250 of it is the ten predecessors.
- **The patch target is the call site** (`graphiti.py:1090`, `last_n=RELEVANT_SCHEMA_LIMIT` →
  `last_n=1`), not the constant. `RELEVANT_SCHEMA_LIMIT` is *also* the dedupe-candidate limit and the
  query-time retrieval limit across ~20 call sites in `search_utils.py`; patching it at its
  definition would silently narrow retrieval quality too.

### 2. My baseline was measured over mismatched sets

I computed 10.1 tokens-per-source-char by dividing a 2-hour **billing** window by a 1-hour
**projection** window. Extraction is async, so those cover different episodes — the window billed 109
`extract_nodes` calls while the join counted ~169 episodes pushed. The ratio was polluted in both
directions, and the "cannot show movement ⇒ does not ship" rule would have gated on a broken
instrument.

**The honest instrument needs no join at all.** `extract_nodes` fires once per episode, so both
numerator and denominator come from `llm_usage` alone:

| day | episodes | calls/episode | **input tokens/episode** | $/episode |
|---|---|---|---|---|
| 2026-08-04 (post-upgrade) | 92 | 12.0 | **37,564** | $0.0144 |
| 2026-08-05 | 427 | 9.7 | **38,170** | $0.0140 |
| 2026-08-06 | 3 | 8.0 | **38,572** | $0.0144 |

Stable within 3% across three days and 522 episodes — that stability is what makes it a baseline.

## The measurement, corrected

An episode carries at most `CHUNK_CHARS` = 2,500 characters ≈ **625 tokens of content**. We bill
**~38,000 input tokens** to ingest it.

**That is ~64× the content, not the 40× I first reported** — and ~10 LLM calls per episode, not the
5.4 I derived from the mismatched window. Cost is **$0.0147/episode**, not $0.0099.

Where it goes, per call kind (2026-08-05 06:50 batch):

| call | calls | avg input | what it carries beyond the episode |
|---|---|---|---|
| `dedupe_nodes` | 107 | **10,412** | up to 10 candidates + **the 10 previous episodes** |
| `extract_nodes` | 109 | 8,360 | the 10 previous episodes + entity-type prompt |
| `extract_edges` | 109 | 8,110 | the 10 previous episodes, again |
| `dedupe_edges` | 459 | 1,060 | per edge |
| `node_summaries_batch` | 56 | 6,998 | |
| `edge_timestamps` | 72 | 552 | |

The previous-episode window is carried by **four** call kinds (extract_nodes, extract_edges,
dedupe_nodes, and attribute extraction) — not the two I first claimed. The same text is billed many
times over.

Cost is also ~90% fixed overhead rather than content. Measured across yesterday's projections:

| | chars per episode | cost each |
|---|---|---|
| large docs | 2,608 | $0.014 |
| commits | **189** | $0.014 |

A commit is **14× less efficient per character** than a full chunk. **898 of 2,267 items (40%) are
under 600 characters and each occupies a whole episode.**

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
while the pipeline is ~60× inefficient is fixing the symptom. **Every lever below is
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
- **boundaries stale but the item is provably complete → leave it alone** (new).

**"Complete" has to be defined precisely, because the loose definition is the hole.** It must NOT
mean `content_sha256` matches — that is the exact bug this codebase shipped twice in review, since
the body sha is invariant to chunking. It means:

1. parse the **stored** `chunk_config` and re-chunk the body under **that** algorithm and parameters;
2. require **element-wise hash equality** with the stored `chunk_shas` — not count equality;
3. require the stored config to have **covered the whole body** (`storedChars × storedCap ≥
   body.length`) — otherwise an item clipped at its old cap is "complete under the stored config"
   while still owing content, and CDC would permanently re-strand exactly the population AIO-808
   existed to un-strand (3 items today);
4. an empty or unparseable `chunk_config` (`''` is the column default) is **never** complete.

The other skip terms stay ANDed: this is a widening of the composite skip, not a new site, so
`!tierChanged`, `!purgeBeforeRepush` and the `''` reconcile sentinel are inherited — a re-queued or
redacted row can never sha-match and so still pushes. **One mutation test per term**, per the
one-condition-per-fixture rule.

**Cap-shrink must be decided explicitly, not inherited.** Today `chunkConfigDeltaCompatible`
documents cap-shrink → false because "a full re-push is the honest answer". A naive third case would
instead leave a shrunk-cap item alone, since it verifies complete under the stored, larger cap. That
is content-safe but silently rewrites a documented decision. **Decision: leave it alone** — the
orphan tails a shrink creates are not fixed by re-pushing the head either (nothing purges them), so
paying to re-extract buys nothing. The `chunkConfigDeltaCompatible` comment must be updated to say
so rather than left contradicting this.

### 2. Cut the repeated context — the previous-episode window, 10 → 1

**Patch the CALL SITE, not the constant:** `graphiti.py:1090`, `last_n=RELEVANT_SCHEMA_LIMIT` →
`last_n=1`, as a `sed` in `graphiti/Dockerfile` (precedent: the same file constructs
`OpenAIGenericClient` by sed; note the `DEFAULT_MAX_TOKENS` sed it once had is now an assert-only
grep, so that half of the precedent no longer stands). `RELEVANT_SCHEMA_LIMIT` is *also* the
dedupe-candidate limit and the query-time retrieval limit across ~20 sites in `search_utils.py` —
patching its definition would silently narrow retrieval quality, which is a different feature.

The window is carried by **four** call kinds (`extract_nodes`, `extract_edges`, `dedupe_nodes`,
attribute extraction), so at ~6,250 tokens of predecessors per call this is the single largest term
in the ~38,000.

**This one has a real quality trade and must not ship on an estimate — and the trade is bigger than
I first scoped.** Cutting 10→1 removes nine predecessors, not two. Previous episodes are how the
extractor resolves pronouns and references across chunk boundaries ("he said", "that project"), and
the 2026-06/07 blank-arcs incidents were extraction-quality failures. So this lever is
coverage-neutral only **as a hypothesis the battery tests**, not by construction: entity count per
episode, people recall, and `IS_DUPLICATE_OF` share must hold against the window-10 baseline on the
same replayed batch. If they move, the lever is a quality regression wearing a cost saving.

An intermediate (10 → 3, matching the library's own `EPISODE_WINDOW_LEN` intent) is available if 1
degrades and 10 is wasteful, and should be measured in the same run rather than as a follow-up.

### 3. Pack small items into full episodes — coverage-neutral, 40% of items

898 items under 600 characters each occupy their own episode at full fixed-overhead price. Packing
them (per source, per time bucket, preserving per-item provenance in the episode body so attribution
survives) turns ~898 episodes into ~180.

The constraint that makes this non-trivial: `graph_episodes` is keyed
`(team_id, source_table, source_id)` — one ledger row per item — and episode names are `items:<id>#k`,
which the delete/reconcile paths parse. A packed episode covers *several* item ids, so either the
ledger grows a many-to-one shape or packing is confined to a synthetic aggregate item.

**Three failure modes recorded now so the design PR is reviewed against them, not surprised by them:**

1. **Perpetual re-queue.** If a packed episode's name does not parse to each member's item id,
   reconcile judges every member row "never landed" and re-pushes it forever.
2. **Silent tier leak.** The same parse failure makes `deleteItemEpisodes` a no-op, so purge,
   tier-reclassification and retraction deletes stop working **with no retry and no error** — the
   B2 class this module has already paid for.
3. **A pack may never span `access` tiers.** `episodeGroupId(teamSlug, access)` is the *sole* tier
   enforcement in the graph (no RLS, CLAUDE.md §5), so packing must be per-group, and must also
   handle a member item whose tier later flips alone.

**Deepest blast radius of the three; built last, and its design PR gets its own plan review.**

### 4. Noted, not proposed: `use_combined_extraction`

graphiti 0.29.3 can merge node+edge extraction into one call, which would collapse the two 8k-token
calls into one. Per an earlier investigation it is **unreachable from the public API** (`add_episode`
does not accept it and the sole internal caller omits it), so it would be another Dockerfile patch.
Recorded so the next person does not rediscover it; out of scope here.

## The measurement harness comes first

Before any lever, a repeatable way to price a change against a **real payload**, because this
workstream is exactly where stacked estimates go wrong:

`scripts/graph-ingest-cost.mjs <since> <until>` reports **input tokens per episode**, calls per
episode, and $/episode — derived from `llm_usage` **alone**, with `extract_nodes` as the denominator.

**What that denominator counts is attempts, not episodes**, and the distinction matters for lever 2.
graphiti_core 0.29.3 has no reflexion loop and fires `extract_nodes` once per extraction attempt —
but two retry layers (a MAX_RETRIES=2 pydantic-validation loop, and tenacity on
EmptyResponse/JSONDecode) add *metered* attempts for the same episode. Rate-limited attempts carry no
usage and never distort. So **the cross-check's SIGNED gap is the retry-rate instrument**: positive
means retries, negative means a push the window did not bill.

**Lever 2's before/after must compare the signed gap as well as the ratio.** Cutting the context
changes prompt shape, which can change the validation-retry rate — so a token "saving" could partly
be a retry-rate shift in either direction. Reading only the ratio would credit the lever for it. No `graph_episodes ⋈ items` join, because that join is what made my first baseline
wrong: extraction is async, so a billing window and a projection window cover different episodes, and
the ledger's `chunk_shas` is last-state while `projected_at` is overwritten by later pushes.

Two refusals, so the instrument cannot lie quietly:
- **Drain check** — `source='graph'` must be quiet for N minutes before `since` and before `until`,
  or the window is straddling a burst; report refuses rather than printing a ratio.
- **Cross-check** — compare the `extract_nodes` count against episodes pushed in the same window from
  `ingest_runs.meta.episodes`; on material divergence, report the divergence instead of a ratio.

**Baseline, measured by the harness on a quiet-bounded window** (2026-08-05 06:45→09:52 UTC — John's
30-item workspace push; drain-clean at both edges, cross-check 0% apart):

```
episodes    169            calls/episode  10.3
input tok   6,771,879      per episode    40,070
cost        $2.48          per episode    $0.0147
MULTIPLE    64.1x the content a full episode carries
```

Every lever is measured against this window. It also corrects the batch's cost: **$2.48, not the
$1.40 I first reported** — that figure came from a 2-hour window that clipped the burst's tail.

A lever that cannot show movement on tokens-per-episode does not ship.

## Sequencing

1. **Harness** (this PR) — no behaviour change, establishes the baseline.
2. **Lever 2** (`EPISODE_WINDOW_LEN`) — biggest token win per line changed, gated on the quality battery.
3. **Lever 1** (CDC) — the durable structural fix; needs the lazy-rollout third case.
4. **Lever 3** (packing) — deepest blast radius, last.

Each is its own PR with its own before/after measurement in the body.

## How we will know it worked

Input tokens per episode falls from **~38,000** toward **<12,000** (a 625-token episode billed at
under 20× rather than ~61×), with entity yield, people recall and `IS_DUPLICATE_OF` share unchanged on
the same replayed batch. Cost per active-person-day becomes a number that survives a 10× corpus
rather than one that multiplies with it.

## Risks

- **Lever 2 degrades extraction quality invisibly.** Mitigated by making the battery the gate, not the
  reviewer's judgement — and the dedupe-pollution alarm (AIO-693) is live as a backstop.
- **Lever 1's lazy rollout leaves the corpus permanently mixed.** Accepted and made explicit in
  `chunk_config`; the alternative is $51 to re-extract text we already have. The `$47 re-extracts the
  corpus` warnings now sitting on `CHUNK_CHARS`/`MAX_EPISODE_CHUNKS` become misleading once lazy CDC
  lands and must be updated in that PR.
- **Lever 3 collides with the one-row-per-item ledger.** Flagged early precisely so the design is
  reviewed before code, not after.
