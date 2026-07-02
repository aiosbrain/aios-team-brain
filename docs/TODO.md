# TODO / Deferred work

Engineering work we've **consciously deferred**, with the rationale recorded so the decision isn't
re-litigated from scratch later. This is not a bug tracker — it's the "we chose not to do this yet,
and here's why + when to revisit" list.

Format per item: **Status · Why deferred · When to revisit · How to do it**.

---

## Cross-encoder reranker for retrieval (`RERANK_URL`)

**Status:** Deferred (2026-07-02). Dense retrieval is live without it.

**What it is:** A cross-encoder that re-scores the top retrieved candidates by reading the
*(query, passage)* pair **together** (vs. our bi-encoder embeddings, which encode query and doc
separately and compare vectors). It's a precision booster that reorders an already-good candidate
set. The seam already exists — set `RERANK_URL` (+ optional `RERANK_MODEL`/`RERANK_TOKEN`) to a
ZeroEntropy/Cohere/Voyage endpoint or a local `llama-server --reranking`; `lib/query/retrieve`
runs it after the dense+FTS RRF fusion. No code change needed to turn on.

**Expected lift:** Typically **+5–15% relative on ranking metrics** (nDCG@10 / MRR / P@5) over a
strong hybrid baseline. Bigger when the base retriever has high recall but messy ordering; smaller
when the top few are already right. (Note: gbrain's headline "+31 P@5" was from its *graph*, which
we already approximate via Graphiti — the reranker alone is the more modest lever.)

**Why deferred now:**
1. **Tiny corpus** — ~175 items / ~305 chunks (2026-07-02). Recall is near ceiling; there's little
   noise to reorder away.
2. **The LLM already reranks.** Retrieved sources (up to ~40k tokens) are all fed to the answering
   model, which reads them and picks what's relevant. With ~305 chunks we rarely hit the char
   budget, so nothing good gets truncated — the reranker would mostly change citation order
   (`[S1]` vs `[S3]`), not *which* facts the answer uses. Near-zero impact on answer quality today.
3. Adds a per-query network call (~100–300 ms) + cost/hosting for marginal gain at this scale.

**When to revisit:**
- Corpus grows **10–100×** (thousands of items), so the candidate set gets noisy and good docs
  start falling outside the context budget (where reranking prevents them being dropped).
- We start **hard-truncating** the context (e.g. feeding only top-N sources to the LLM).
- We observe the brain **citing/using the wrong passages** despite dense retrieval.

**How to decide precisely:** Don't guess — run a measured eval on our own data before enabling.
The harness exists (`test/datamechanics/retrieval-eval` / `retrieval-semantic`). Wire a temporary
reranker endpoint, A/B dense+FTS vs +reranker on real questions, and record the nDCG/P@5 delta.

---

## Harden `item_chunks` indexing against concurrent writers

**Status:** Deferred (2026-07-02). Benign in normal operation.

**What/why:** `lib/query/dense-index.indexItem` replaces an item's chunk set with a non-atomic
**DELETE then INSERT**. If two writers touch the same item concurrently they can collide on the
`(item_id, chunk_idx)` unique constraint (observed once: a manual `embed:backfill` running at the
same moment as the in-prod scheduler's `indexPendingItems` — 13 duplicate-key errors that were
self-healing; everything converged to 0 pending).

**Why deferred:** In steady state the **scheduler is the sole writer** (single-writer guarded), so
there's no concurrency. The race only appears if we run a manual backfill *while* the scheduler is
live — an operational edge case, not a product path.

**When to revisit:** If we ever need concurrent indexers (e.g. parallel backfill workers for a large
corpus), or if a manual backfill alongside the scheduler becomes routine.

**How:** Make the replace atomic — wrap DELETE+INSERT in a transaction and/or take a per-item
advisory lock (`pg_advisory_xact_lock(hashtext(item_id))`), or switch to an upsert on
`(item_id, chunk_idx)` with a trailing delete of now-excess chunk indexes.
