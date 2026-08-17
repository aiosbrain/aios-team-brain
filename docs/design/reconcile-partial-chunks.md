# Reconcile is blind to partial multi-chunk loss (RECONCILE-1)

Status: **proposed — needs a cold read before code** · Owner: chetan
· Tier build-with: unit (the pure landed-check) + data-mechanics (the reconcile outcome on real Postgres)

**Deps:** none. Supersedes the instrumentation approach explored under EXTRUNC-1 — see "Why this and
not EXTRUNC-1".

**Increment:** ONE PR = **OBSERVABILITY ONLY**. Reconcile counts and identifies partially-landed items;
it does NOT change any verdict, re-queue anything new, or touch the projector. Enforcement is
increment 2, gated on what this measures. The cold read below is why that order is not timidity.

## Problem

`lib/graph/reconcile.ts` decides an item **landed if ANY of its chunks is present**:

```ts
// An item is projected as one OR MANY chunk episodes (`items:<id>` / `items:<id>#k`) — it "landed"
// if ANY of its chunks is present. Map each item id → one of its episode uuids.
const uuidByItemId = new Map<string, string>();
for (const e of episodes) {
  const itemId = itemIdFromEpisodeName(e.name);
  if (itemId && !uuidByItemId.has(itemId)) uuidByItemId.set(itemId, e.uuid);   // FIRST wins
}
```

Meanwhile the projector records **every** chunk sha optimistically at push time (`lib/graph/project.ts`,
the `chunk_shas: chunkShas` write). So when a worker dies mid-item:

- chunks 0..32 landed, chunk 33+ never did;
- the ledger says all N chunks were pushed;
- reconcile sees chunk 0 present, marks the item **confirmed**, and re-queues nothing;
- the delta path then treats those shas as already-pushed, so **it is never re-pushed either**.

The tail chunks are permanently absent, and nothing anywhere records it.

**This is not inferred — it was observed live.** In the PIPEFF-2 battery a 502 killed the worker at
**chunk #33 of the repo's `docs/ARCHITECTURE.md`**; reconcile requeued **0** for that item while correctly requeuing 7
fully-missing items. The self-heal ran, reported success, and left the hole.

## Why this and not EXTRUNC-1

EXTRUNC-1 proposed instrumenting output-token truncation. Investigation (recorded here so it is not
re-derived) showed:

- **The single-chunk case already self-heals** — reconcile re-queues never-landed rows and the
  projector re-pushes them, so a truncated single-chunk item comes back next cycle.
- **This is the genuinely silent channel**, and it is cause-agnostic: truncation, timeout, a 429
  storm, a worker crash — every one of them leaves the same hole, and this fix covers all of them
  where an output-token detector covers one.
- **The truncation rate is already measurable** with `output_tokens = 16384` (clean from 2026-07-31,
  once reasoning was disabled), so the proposed column added robustness, not the measurement.

## Decision (REVISED after the cold read — enforcement deferred, measurement first)

The first draft proposed enforcing an all-chunks landed check immediately. Review found three defects
that each turn that into a net harm, and all three are **unresolved by measurement I can do from here**:

1. **The expected-name set is NOT derivable from `chunk_shas.length`.** The delta path pushes by SHA —
   `toPush = episodes.filter((_, i) => !alreadyPushed.has(chunkShas[i]))` (`lib/graph/project.ts`),
   set membership, position-independent — while names come from `episodeName(item.id, i, total)`, by
   INDEX. A mid-document insertion re-chunks A,B,C → A,X,B,C: only X is pushed, as `#1`; the graph
   holds old `#0..#2` plus a new `#1`, the ledger holds 4 shas, and expected `#3` **never existed**.
   The strict check would re-queue a fully-healthy item — triggered by ordinary edits to a growing
   document, i.e. the `docs/ARCHITECTURE.md` class, converting GRAPHCOST-1's delta savings back into
   full-item extractions indefinitely.
2. **It re-opens the amplifier `LANDED_GRACE_MS` exists to close.** Episodes become visible only as
   Graphiti's queue drains at LLM speed. The ANY-check needs one chunk visible inside the grace; an
   ALL-check needs all N. A 40-chunk item behind any backlog reads as partial, is re-pushed in full,
   and deepens the queue that caused the misread — self-sustaining at the throttle rate.
3. **Every heal DUPLICATES the landed chunks.** The re-queue writes only `content_sha256 = ''`, which
   fails `deltaEligible`, so `toPush = episodes` — all of them. `addEpisodes` does not overwrite by
   name, so each repair adds ~N-1 duplicate episodes: double-weighted facts, and group growth toward
   `LANDED_SCAN_DEPTH`, past which self-healing switches off for that group **permanently**.

So this PR **measures instead**: reconcile already fetches every group's episode list on every pass, so
counting partially-landed items and recording which names are missing is **free** — no extra reads, no
verdict change, no re-queue. That data is what separates persistent holes from the transient
(still-queued) and structural (index-shift) false positives above, which is exactly the discrimination
enforcement needs and nobody currently has.

**Increment 2 (NOT this PR)** picks a repair shape informed by that data, and must resolve: the
name/sha divergence (element-wise delta diff, recorded pushed names, or scoping to full pushes); a
partial-specific grace or an N-consecutive-passes rule; and purge-before-repush
(`pending_delete_group_id` → `purgeBeforeRepush`) to avoid duplicate episodes.

### The check itself (built here, but only to COUNT)

**Verify EVERY expected chunk episode, not just one.** The expected names are already derivable:
`chunk_shas.length` gives the count and `episodeName(itemId, i, total)` gives each name
(`items:<id>` when `total <= 1`, else `items:<id>#<i>`, zero-based).

Landed ⇔ every expected name is present in the group's episode scan.

### Guards this must NOT break (each is load-bearing today)

1. **An EMPTY chunk ledger still means "never pushed", not "all chunks missing".** `reconcile.ts`
   already relies on this: *"A row that EVER pushed keeps its chunk_shas (the re-queue resets only the
   sha), so the empty ledger is the honest discriminator."* A never-pushed row is the PROJECTOR's to
   converge; deleting it re-cold-starts an arm every cycle. So an empty ledger keeps today's path
   exactly.
2. **Saturated groups stay skipped.** `LANDED_SCAN_DEPTH` (5,000) bounds the episode scan; a group at
   or beyond it is skipped and counted, because healing a group whose scan is truncated would re-push
   items whose later chunks simply weren't scanned — a self-amplifying loop. A per-chunk check makes
   that hazard *worse* if the guard were removed, so it must remain.
3. **The re-queue throttle bounds the blast radius.** `REQUEUE_MAX_PER_PASS` (20) already caps
   re-queues per pass, and `requeueThrottled` is the operator signal. This change can only INCREASE
   re-queues, so that cap is what keeps a bad day from becoming a re-push storm on the most expensive
   call class.

### Measured blast radius, and the one thing I could not measure

From prod `graph_episodes` (2026-08-17):

| | |
|---|---|
| rows total | 2,621 |
| **multi-chunk rows** (newly subject to the stricter check) | **984 (38%)** |
| rows with an EMPTY ledger but a landed episode (legacy-storm risk) | **0** |

The zero matters: there is no population of legacy rows that would newly read as "missing chunks" and
re-queue en masse. **What I could NOT measure is how many of those 984 actually have a missing chunk
today** — that needs a Neo4j read, and `NEO4J_URI` is `bolt://neo4j.railway.internal:7687` with no
public proxy. So the true re-queue count on first run is unknown, and the throttle above is the
mitigation rather than a prediction. That is stated rather than estimated.

## Scope

**In this PR:**
- A pure expected-names helper reusing `episodeName` from `lib/graph/episode-name.ts`.
- A pure landed predicate that distinguishes FULLY landed / PARTIALLY landed / never landed.
- `lib/graph/reconcile.ts` COUNTS partial items (`partialItems`, plus the missing names for the first
  few, bounded) into its summary and `ingest_runs.meta`. **Verdicts are unchanged** — a partial item
  is still `confirmed` today, exactly as now.
- The three guards kept intact (empty ledger, saturated groups, re-queue throttle), each pinned.

**Cut, deliberately:**
- **No schema change.** `chunk_shas` already carries everything needed; adding a column would be
  inventing state that exists.
- **No change to the projector's push path** (`lib/graph/project.ts`). The optimistic chunk-sha write
  is what makes the ledger authoritative about *expected* chunks; the bug is the READ, not the write.
  Changing both at once would make a regression un-bisectable.
- **No back-fill / repair sweep** of items already holding a hole. The fix makes reconcile heal them
  on its own schedule, bounded by the throttle; a bulk repair would re-push at a rate nothing caps.
- **ENFORCEMENT** — re-queuing on a partial verdict. Deferred to increment 2 for the three reasons in
  Decision; shipping it now can make the graph strictly worse (duplicates + permanent healing shutoff).
- **Truncation instrumentation** (EXTRUNC-1) — a different, mostly-healed channel, argued above.

## Acceptance criteria

1. **unit** — `expectedEpisodeNames` returns exactly `["items:x"]` for a single-chunk item and
   `["items:x#0","items:x#1","items:x#2"]` for a 3-chunk one — asserted against LITERAL strings, not
   against `episodeName` itself, which would be green by construction.
2. **unit** — the landed predicate returns `"partial"` for the observed shape (chunks 0..32 present,
   33 missing), `"full"` when all are present, and `"none"` when none are.
3. **unit** — an EMPTY chunk ledger yields `"none"`, preserving the never-pushed discriminator the
   projector-owns-convergence guard depends on.
4. **data-mechanics** — on real Postgres with an injected Graphiti client, a partially-landed row is
   COUNTED in `partialItems` and its verdict is UNCHANGED (still confirmed, not re-queued) — the
   measurement must not smuggle in enforcement.
5. **data-mechanics** — `partialItems` reaches `ingest_runs.meta`, so the rate is queryable after the
   fact rather than living only in a log line.
6. **unit** — the recorded missing-name detail is BOUNDED (first N items), so a pathological pass
   cannot write an unbounded blob into `ingest_runs.meta`.

## What would falsify this

- ANY verdict changes in this PR — a re-queue count that differs from today's means measurement
  leaked into enforcement.
- `partialItems` reading persistently ~0 in prod → the hole is a battery artefact, not a live defect,
  and increment 2 should not be built (a legitimate, valuable outcome of measuring first).
- `partialItems` tracking the count of multi-chunk items that were merely EDITED (the index-shift
  false positive) rather than genuinely holed — which the recorded missing-names detail is there to
  let an operator tell apart before anything enforces on it.
- The detail blob growing unbounded in `ingest_runs.meta`.
