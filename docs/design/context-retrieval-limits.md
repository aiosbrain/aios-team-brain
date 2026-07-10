# Context-retrieval limits — adversarial findings

**What this is.** A map of where the context-management system (Organ 3 — `lib/query/retrieve.ts`)
holds up and where it breaks, derived from adversarial tests that assert to the observable retrieval
outcome on real Postgres. Today the brain ingests ~one Slack channel; these findings target the
**near-future multi-channel world** (many busy Slack channels + Notion/Docs), where the current
fixed caps and unranked keyword search degrade. Every claim below is pinned by a test:

- `test/query-adversarial.test.ts` — pure query-transformation probes (fast, no DB).
- `test/datamechanics/multichannel-adversarial.datamechanics.test.ts` — a simulated multi-channel
  corpus through the real `retrieve()`.
- Existing baselines: `test/datamechanics/retrieval-eval` (recall benchmark), `grounding`,
  `retrieval-semantic`, `tasks-tier-isolation`.

Confirmed-but-unfixed gaps are `it.fails()` — green today, they flip **red** (i.e. "promote me to a
real test") the moment the gap is closed. So the count of `it.fails` in these files is a live backlog.

## What we're GOOD at (green tests)

- **Direct keyword hits survive cross-channel noise.** A specific term (SSRF, "image proxy") pulls
  its doc even amid unrelated chatter on other channels.
- **A single relevant item is protected by the recency net.** Even when 20+ items share the query's
  weak term and FTS is capped/unranked, the recency-8 fallback (newest-first) still surfaces the one
  specific item. This is why single-topic queries feel reliable today.
- **Tier isolation does NOT degrade with channel count.** An `external` principal retrieving across 6
  channels sees zero team content — the invariant that matters most holds at scale.
- **Recall-friendly normalization.** Question/stop words are dropped and significant terms OR-joined,
  so paraphrase queries still recall (the FTS AND-semantics regression is fixed).

## What we FAIL at (each is a live `it.fails` gap)

1. ~~**Short but load-bearing tokens are dropped.**~~ **FIXED** — `toOrQuery` now keeps a 2-char token
   when it's an upper-cased acronym (`CI`, `QA`, `PR`, `DB`) or carries a digit (`S3`, `v2`, `k8`),
   while still dropping lowercase common words (`us`, `up`, `so`). Proven end-to-end: a query whose
   only shared terms are `CI`/`S3` now retrieves its doc.
2. **Hard caps → truncated recall at scale.** ~~No relevance ranking~~ **RANKING FIXED** — the FTS
   query now orders by `ts_rank` (`lib/query/fts-search`), so the capped top-20 is the *most relevant*
   20, not an arbitrary 20 (proven: a 5-term-match item beats 25 single-term items into the window
   even when recency can't save it). **Still open:** the *recall ceiling* — a query legitimately
   matching 50 items still returns only ~28 (test: 22/50 dropped). Ranking makes the kept set the
   best set; closing the ceiling needs dense/pgvector retrieval + higher/query-scoped caps.
3. ~~**False grounding.**~~ **FIXED** — grounding now keys on term **specificity (document frequency)**,
   not "any FTS hit" (`lib/query/grounding`). A *specific* (rare, ≤15%-of-corpus) term that actually
   matches → grounded; if every query term is corpus-common → fall back to any-hit (no over-abstain on
   "what's the latest update?"); otherwise (specific terms that match nothing + incidental common words)
   → NOT grounded. Temporal deictics ("latest/recent/today") are now stopwords so they don't poison the
   signal. Verified: the "Helsinki migration" chatter no longer grounds, while a specific single-term
   query ("SSRF") still does.
4. ~~**No channel scoping.**~~ **FIXED** — `parseChannelScope` detects an explicit `#channel` /
   "in the X channel" qualifier (conservative — "the sales pipeline" never scopes), strips it from the
   search terms, and filters item retrieval to that channel's path segment. An `#eng` "Atlas" no
   longer contaminates a sales-scoped "Atlas" question; an unscoped query still sees both.
5. ~~**Aggregation/rollup truncates.**~~ **FIXED** — a full-corpus **task count-by-status** line
   (`lib/query/structured-extras`) is now in the structured context, so "how many open tasks?" is
   correct regardless of the 80-row detail cap.
6. ~~**Temporal fall-off.**~~ **FIXED** — ALL decisions are now **keyword-searched** (title+rationale,
   ranked), so an on-record decision surfaces past the recency-50 window ("which vendor did we pick in
   Q1?" reaches it).

## Status

**All six gaps are addressed** — the multi-channel adversarial data-mechanics suite is fully green
(every `it.fails` flipped to a green `it()`):

- #1 short-token recall, #2 `ts_rank` ordering, #3 IDF grounding, #4 channel scoping, #5 full-corpus
  task counts, #6 decision keyword search — all fixed as above.
- **#2 recall facet** — the FTS candidate cap was raised 20 → `FTS_CANDIDATE_LIMIT` (50). A realistic
  broad query no longer loses half its evidence; `MAX_TOTAL_CHARS` is still the real output ceiling, so
  large corpora truncate best-ranked-first rather than blowing the token budget.
- **Dense grounding** — `denseSearch` now applies a distance floor (`DENSE_MAX_DISTANCE`), so far
  nearest-neighbors don't false-ground (they were silently overriding the IDF signal once dense went live).

**What remains (intentionally, for the large-collective-data future, not this scale):** the recall
ceiling BEYOND the candidate cap (a query matching *hundreds* of items) and true relevance beyond
lexical rank — both the job of **dense/pgvector + a reranker**, whose leg exists (`EMBEDDINGS_URL`,
`RERANK_URL`) and is now grounded safely. Also open: conjunctive intent ("auth AND payments" as a
precision narrow), tracked by a unit `it.fails` in `test/query-adversarial`.
