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
4. **No channel scoping.** A user who scopes explicitly ("…in the #sales channel") gets bleed from
   other channels — path prefixes aren't a query dimension, so an `#eng` "Atlas" contaminates a
   sales-scoped "Atlas" question. Same-name-different-meaning collisions multiply with channels.
5. **Aggregation/rollup truncates.** The task digest caps at 80 (most-recently-updated), so "how many
   open tasks?" undercounts once a multi-channel org passes 80 live tasks — the oldest-updated ones
   are simply invisible to the answer.
6. **Temporal fall-off.** The decisions digest caps at 50 (newest-first) with no date-range awareness.
   "Which vendor did we pick in Q1?" loses grounding once ~50 newer decisions exist, even though the
   decision is on record.

## The through-line

The system is tuned for **one low-volume channel**: fixed caps are never hit, unranked FTS is fine
because there's little to rank, recency masks crowding, and `grounded` rarely false-positives. Every
gap above is a **scaling cliff** that the current corpus hides. The durable fixes are already gestured
at in the code comments — **semantic/dense ranking (pgvector) + a reranker** for (1)(2), a stronger
grounding signal than "any FTS hit" for (3), **channel/source as a first-class retrieval filter** for
(4), and **query-scoped (not global-capped) structured context** for (5)(6). The tests here make each
fix *provable*: close the gap and its `it.fails` turns red.
