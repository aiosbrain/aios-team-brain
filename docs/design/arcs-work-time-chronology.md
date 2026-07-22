# Narrative arcs — order by WORK time, not extraction time

**Status:** design. **Grounds:** the arcs recency/chronology question — "are we collating the data by
the real chronology of the work?" Measured on prod (Neo4j, team `aios`) 2026-07-21.

## Problem

Arc synthesis, the fact pool, evidence timestamps, and arc ranking all key off `r.created_at` — the
RELATES_TO edge's **extraction** time (when Graphiti pulled the fact out), NOT when the work happened:

- `recentFacts` (`lib/graph/learning.ts`) → `ORDER BY r.created_at DESC` and `at = toString(r.created_at)`.
- `recentEvents` (Layer 2) → `ORDER BY ep.created_at`.
- `newestEvidenceAt` / `rankArcs` (`lib/graph/arcs.ts`) rank arcs by the newest evidence `at` — i.e. by
  extraction time.

Two consequences:
1. **A re-projected old document looks "recent."** `ARCHITECTURE.md`, re-extracted on every PR (CLAUDE §1
   requires updating it), gets a fresh `created_at` each time and floods the "recent" window — the RC4
   the arcs root-cause analysis flagged. The recency signal is *ingestion* recency, not *work* recency.
2. **No true chronology.** "What happened, in the order it happened" isn't expressible — the ordering is
   ingestion order.

## The data supports the fix (measured, prod, tier `aios_team`+`aios_external`)

Graphiti stores a second timestamp — `valid_at` — which is the **episode reference time** we set from the
item's `source_ts` via `pickEpisodeTimestamp` (`lib/graph/project.ts`), i.e. **work time**:

| | populated | notes |
|---|---|---|
| RELATES_TO `valid_at` | **15,663 / 15,793 (99.2%)** | fallback needed for the 0.8% |
| RELATES_TO `created_at` | 15,793 / 15,793 | always present (extraction) |
| Episodic `valid_at` | **2,181 / 2,181 (100%)** | the reference time we set |
| `valid_at` differs from `created_at` by >2 days | **6,073 edges (38%)** | the bias is large, not marginal |

Sample: an episode `created_at` 2026-07-03 with `valid_at` 2026-06-24 — extracted 9 days after the work.

## Crux: what `valid_at` actually is (corrected after design review)

`valid_at` is **not** guaranteed to be the episode reference verbatim. Graphiti's `extract_edge_dates`
LLM step sets edge `valid_at` = the episode reference for present-tense facts, but for facts with an
explicit/relative date in their *text* ("last week we decided…", "launching in Sept") it extracts THAT
date, and null when undeterminable. So `valid_at` is an *LLM-dated* value anchored to the reference — not
a pure reference copy.

What the prod probe establishes is therefore a **bounded empirical property of today's corpus, not an
invariant**: comparing each edge's `valid_at` to the max `valid_at` of its source episodes (the
reference we set), 15,684 edges — **82% match within 1 minute** (present-tense → reference), **0.8% null**
(undeterminable), the **18% between 1min–30d** are content-relative dates + multi-episode dedup (a
re-observed edge keeps its first `valid_at` as `episodes` grows), and **0 diverge by >30d, 0 before 2020**.
A ≤30d, past-directed skew is **strictly better** than the 38% extraction-time bias, and a "since 2019"
fact sinking *down* the pool is a mild, arguably-correct outcome. Accepted — but the future-date direction
must be closed (below).

## Fix (surgical)

Order + timestamp by a **`created_at`-clamped work-time**, not a bare coalesce. Work always precedes
extraction, so `created_at` is a valid upper bound that (a) supplies the null fallback and (b) forecloses
a future-dated `valid_at` (from either a future `source_ts` OR the LLM date path stamping planning
language) — which, under recency-ranking, would otherwise pin the top of the pool until the date passed:

```cypher
CASE WHEN r.valid_at IS NULL OR r.valid_at > r.created_at THEN r.created_at ELSE r.valid_at END
```

1. **`recentFacts`** (no aggregation → may order on the datetime expr directly): use the CASE as the
   `ORDER BY … DESC` key, as `toString(CASE …) AS at`, and in the `withSince` predicate (`… >= datetime($since)`).
   Sparse-data fallback unchanged.
2. **`recentEvents`** (aggregates via `collect` → `ORDER BY` runs post-projection on the ALIAS): today it
   sorts the **string** `at` — accidentally safe for `ep.created_at` (uniform `…Z`) but NOT for `ep.valid_at`,
   which carries our `source_ts` and can hold non-UTC offsets (`+02:00`); lexicographic string compare across
   mixed offsets misorders. **Project a datetime sort key** — `CASE … AS sortAt`, `ORDER BY sortAt DESC`
   (Neo4j datetime compare is instant-based, offset-safe) — and keep `at = toString(CASE …)` for display.
3. **No change in `lib/graph/arcs.ts`** — `buildEvidence`→`evidence.at`→`newestEvidenceAt`→`rankArcs`, and the
   pool order feeding `dedupeFacts`/`balanceFacts` (bucket order preserved → newest-*work*-first per
   contributor), all inherit it via the fact `at`. Verified `learning.ts` is the only Cypher reader of these
   timestamps; nothing else becomes inconsistent. Arc cache keeps its extraction-era `at`s until the next SWR
   refresh — no mixed-era compare (`rankArcs` only runs at synthesis), no migration.

Net effect: "recency" means recent **work**; a re-projected old doc keeps its old `valid_at` and no longer
jumps to the top — **de-biasing the re-projection problem at its source** (complements Phase A's per-item cap).

## Comment drift to fix in the same PR

`AtomicFact.at` says "ISO created_at" (`learning.ts:41`); the module-header schema comment; `dedupeFacts`'
"keep the first = newest" (`arcs.ts`) now means newest-*work*. Update all three.

## Out of scope

A dedicated **chronological timeline view** (facts/events/arcs on a work-time axis) — separate UI surface;
this change makes the *data* correct first.

## Verification (real-Neo4j tier, `test/graph-neo4j-tier.test.ts`)

Note: this tier is `NEO4J_TEST`-gated and **not in `ci.yml`** (only unit/datamechanics/http run in CI) — the
red-before proof is local (`npm run db:test:neo4j:up && npm run test:neo4j`); paste the red run in the PR body.

1. **Ordering** — two facts whose `valid_at` order REVERSES their `created_at` order → `recentFacts` orders by
   work-time and returns `valid_at` as `at`. (Red today: `ORDER BY created_at` gives the wrong order.)
2. **Null fallback** — a fact with no `valid_at` → sorts/timestamps by `created_at`.
3. **Future clamp** — a fact with `valid_at` in the future → clamped to `created_at` (not pinned to the top).
4. **Window exclusion** (the re-projection de-bias, the headline claim) — a fact `created_at = now`,
   `valid_at = 8d ago` → a 24h-window `recentFacts` **excludes** it.
5. **`recentEvents` offset ordering** — two events whose `valid_at` carry different UTC offsets (`Z` vs `+02:00`)
   in an order that a *string* sort would get wrong → asserts the datetime-key sort orders them correctly.
   Also assert seeded `valid_at` are datetimes (guards the mixed-type ordering foot-gun).
