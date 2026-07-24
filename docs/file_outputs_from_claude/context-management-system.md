# The AIOS Team Brain — Context Management System

_A high-level overview of how the brain ingests, chunks, deduplicates, prioritizes, reconciles,
and surfaces team context — plus the edge cases it handles and the views built on top._

> **Scope & provenance.** This document was produced by reviewing the code on
> `chetan-guevara/timeline-work-view` (HEAD `412873e`) and the ~136 merged PRs that built the
> system, cross-checked against `docs/ARCHITECTURE.md` (the repo's source-of-truth map). Where a
> claim cites `file:line`, it was verified against the code, not the prose. Two mechanisms
> (source-reassignment propagation, the ownership-transition stream) live on the not-yet-merged
> branch `origin/chetan/source-reassignment` and are flagged inline.
>
> **Last synthesized: 2026-07-22.**

---

## 0. TL;DR — what "smart" means here

"Context management" in the AIOS Team Brain is the whole pipeline from _a document lands_ to _a
grounded answer streams back_. The system is deliberately built so that **every derived fact lives
at the lowest shared layer** (Postgres `items`/`tasks` + the graph), and every surface — the Query
box, the Learning page, the Timeline, Codebases, Meetings, the admin dashboards — reads that one
substrate identically. Nothing re-derives attribution, work-time, or tier in a single UI.

The intelligent behaviors, in one breath:

- **Single-writer ingestion** with a client-computed `content_sha256` so an unchanged re-push is a
  near-free no-op.
- **Two independent chunkers** (a fixed-width one for the graph's extraction cap, a
  boundary-aware-with-overlap one for dense retrieval) — both idempotent projections off the
  intact `items.body`, never a mutation of it.
- **Deduplication** at every layer: content-hash on items, content-keyed `row_key`s for tasks and
  meeting todos, idempotent embeddings, and same-meeting duplicate-merge.
- **Diff-sync** that reconciles a full re-push against stored rows, deletes what disappeared, and
  **protects** UI-origin rows, dashboard decisions, merge-owned meeting items, and PM-pushed tasks
  from being diff-deleted.
- **Hybrid retrieval** — Postgres FTS + pgvector dense, fused with Reciprocal Rank Fusion, an
  optional cross-encoder reranker, blended with Graphiti temporal facts and the company graph — all
  under a hard token budget and re-applied tier filter.
- **Grounding-aware answering** that abstains ("stay quiet") when retrieval is weak instead of
  confabulating.
- **Conflict resolution via a durable lock** (`items.member_id_locked`): a deliberate human
  attribution correction survives every automatic re-sync, heal, and re-attribution pass.
- **Staleness that knows the difference between "broken" and "quiet"** — per-source thresholds, a
  synthetic leg for the one failure the run-ledger structurally can't see, and serve-stale-while-
  revalidate caches.
- **Empty-clobber guards** everywhere: a transient LLM/graph outage never overwrites good data with
  an empty result.

---

## 1. Architecture at a glance

```
 Sources                 Boundary                Storage (source of truth)         Projections (derived)
 ───────                 ────────                ─────────────────────────         ─────────────────────
 Slack, Notion, Drive,   POST /api/v1/items ──►  items  (body + frontmatter,       ├─► graph_episodes → Graphiti/Neo4j
 Confluence, GitHub,     (Zod/Pydantic           content_sha256, member_id,        │     (facts, entities, edges)
 Linear, Plane, web,      contract,              access-tier, member_id_locked)    ├─► item_chunks (pgvector embeddings)
 local, Granola          tier gate,              item_versions (append-only)       ├─► items.search (FTS tsvector, auto)
   │                     attribution)            tasks / decisions / task_pm_links └─► arc_cache (narrative arcs, SWR)
   ├─ Python sidecar ───►                        meeting_notes / meeting_note_attendees
   └─ native TS runners ►  (in-process poll)     codebases / code_metrics / code_contributions
                                                 ingest_runs (the observability ledger)

 Read path:  lib/query/retrieve.ts  ──►  FTS ⊕ dense (RRF) ⊕ rerank ⊕ graph facts ⊕ company graph
             (tier-gated)                 └─► lib/query/claude.ts streams a grounded, cited answer
```

**The invariant that makes it all cohere:** `items.body` is _always_ stored intact. Every chunker,
the FTS vector, the embeddings, the graph episodes, and the meeting-notes layer are **idempotent,
rebuildable projections** keyed off `content_sha256`. No consuming surface computes a fact another
surface would also need.

The brain is **self-hosted per organization** — one Postgres, all rows one org. There is **no RLS**;
**tier isolation** (an `external` collaborator must never read `team`/`admin` content) is enforced
_entirely in app code_ on every read path, through the `lib/auth/visibility` choke-point and
per-table `access`/`audience` filters.

---

## 2. Ingestion — how content enters

### 2.1 The single writer

`lib/ingest/index.ts::ingestItem` is the **sole legal writer** of `items` + `item_versions` (guarded
by a single-writer test). Its contract (`lib/ingest/index.ts:19-32`):

1. Upsert `projects` on `(team_id, slug)`.
2. Load the existing item by `(team_id, project_id, path)`.
3. **sha-dedup fast path** — if `existing.content_sha256 === payload.content_sha256`, skip the body
   rewrite, just bump `synced_at`, return `"unchanged"` (`index.ts:98-154`). Deliberately writes
   **no audit row** on this path (audit M4: an `item.unchanged` row per item per 30-min tick was
   ~24k rows/day of unbounded `audit_log` growth).
4. Upsert the item, insert one `item_versions` row on a body change, materialize `rows[]` into
   `tasks`/`decisions`/`task_pm_links`.
5. Commit `content_sha256` **last**.

**Crash safety (audit H4).** The item write and row materialization aren't one transaction (the pg
compat adapter can't pin a shared connection). So a new row is inserted with a sentinel
`PENDING_SHA = ""` (`index.ts:174`) and the real 64-hex hash is committed only in step 5, after
materialize succeeds. A mid-materialize crash leaves `""`, so the retry's "unchanged" fast-path
_can't_ fire and rows get re-materialized — the item is never marked synced while its task/decision
board is diverged. `""` can never equal a 64-hex sha.

### 2.2 The HTTP boundary (`POST /api/v1/items`)

Validation happens at the edge (`app/api/v1/items/route.ts`), in order:

- API-key auth + rate limit (120 pushes/min/key).
- Payload cap `MAX_PAYLOAD = 1_000_000` (1 MB) → 413.
- Zod parse (`lib/api/schemas.ts`); `content_sha256` is format-validated `^[a-f0-9]{64}$` (the hash
  is computed **client-side**, only its shape is checked server-side).
- **Tier gate** (`route.ts:52-62`): `access` normalized (`client`/`company` → `external`);
  `admin`/`private` are **hard-rejected** `422 forbidden_tier` — private/admin content must never
  leave the workspace.
- **Attribution derivation**: for trusted **team-tier** keys the author is resolved from frontmatter
  (§8); **external-tier** keys skip this so an untrusted client can't spoof authorship onto a member.

### 2.3 The Python sidecar & native runners

- The **Python sidecar** (`ingestion/aios_ingest/`) mirrors the contract in Pydantic, computes the
  hash caller-side, and normalizes every source's uniform `RawDoc` into one `ItemPayload`. It
  prepends the title into the body (`# {title}\n\n{body}`) so identical bodies under different
  titles hash distinctly, and puts structured `authors[]` **last** so scalar frontmatter can't
  clobber the resolvable signal. 8 registered source types: `slack, notion, gdrive, confluence,
  web, local, radar, granola`.
- **Native TS runners** (`lib/ingest/sources/` driven by `lib/ingest/run.ts` + `scheduler.ts`) run
  Slack, Plane, Linear (+ Linear inbound), GitHub in-process every `INGEST_POLL_MINUTES` (default
  30), then the meeting-notes backfill, then dense indexing.
- **Granola privacy model:** the team-push path yields **metadata-only** meeting markers — never
  verbatim transcript text at team tier; full transcripts go to a local admin-tier folder gated by
  allowlist + consent.

---

## 3. Chunking strategies

There are **two independent chunkers plus a zero-cost FTS "chunker."** Neither mutates `items.body`;
chunking is purely a downstream projection concern.

### 3.1 Graph / episode chunker → Graphiti (`lib/graph/project.ts`)

**Why:** Graphiti extracts entities/edges with its own LLM whose output is hard-capped at
`DEFAULT_MAX_TOKENS = 16384` (gpt-4o's ceiling on the patched image). A dense episode whose
extraction output overflows raises `Output length exceeded max tokens` — the episode is accepted
(202) but **never becomes facts**. Truncating loses content, so the fix is to chunk.

- Constants (env-tunable, both floored through `resolvePositiveInt`):
  `CHUNK_CHARS = 2500`, `MAX_EPISODE_CHUNKS = 16` (`project.ts:44-45`).
- `chunkContent` is a deterministic fixed-width character slicer. A whitespace-only body → `[]`
  (skipped). Content beyond `2500 × 16 = 40,000` chars is **dropped** (a runaway backstop; full text
  still lives in `items`/pgvector/FTS). Median item (~240 chars) = one chunk.
- **Backward-compatible naming** (`episode-name.ts`): a single-chunk item keeps `items:<id>`; only
  multi-chunk items get `items:<id>#k` suffixes, and `itemIdFromEpisodeName` strips the suffix so
  any chunk resolves back to the one item.
- **Idempotency** is a hash over the **full body**, so deterministic chunk boundaries mean an
  unchanged item is a no-op regardless of split count. `graph_episodes` is the single-writer state
  table.

### 3.2 Dense-index chunker → pgvector `item_chunks` (`lib/query/chunk.ts`)

Distinct from the graph chunker — **boundary-aware, with overlap**:

- Constants: `DEFAULT_MAX = 1200` chars (soft cap), `DEFAULT_OVERLAP = 150` chars (`chunk.ts:14-15`).
- Splits on blank lines first, over-long paragraphs on sentence boundaries, hard-slicing only a
  single >max sentence. Carries a **word-aligned overlap tail** between adjacent chunks so a fact
  spanning a boundary surfaces whole. Never splits mid-word at the seam.
- **Single writer** `lib/query/dense-index.ts::indexItem` (guarded). Optional + best-effort: a no-op
  unless `EMBEDDINGS_URL` is set _and_ the `item_chunks` table exists. **Idempotent on
  `content_sha256`** — an unchanged body never re-embeds (never double-charges the embeddings API).
  `embedding vector(1536)`, HNSW cosine index; `access` mirrors `items.access` for tier filtering.

| | Graph / episode | Dense-index |
|---|---|---|
| Store | Graphiti (`graph_episodes`) | pgvector `item_chunks` |
| Split | fixed-width char slice | blank-line → sentence, with overlap |
| Size | `CHUNK_CHARS` = 2500 | `DEFAULT_MAX` = 1200 |
| Overlap | none | 150 (word-aligned) |
| Cap | 16 chunks (drops overflow) | none |
| Why | Graphiti 16384-token extraction cap | embedding/retrieval granularity |

### 3.3 The FTS "chunker" (zero-cost, whole-doc)

`items.search` is a **stored generated `tsvector`** —
`to_tsvector('english', coalesce(path,'') || ' ' || coalesce(body,''))`, GIN-indexed. Postgres
maintains it automatically on every insert/update; no ingest code touches it. This is why every
item is keyword-searchable "for free," and it's the fallback when dense retrieval is off. The same
pattern indexes `chat_messages.content`.

**Meeting transcripts** get no special chunking — a meeting is a normal `items` row
(`kind='transcript'`) written through `ingestItem`, searchable for free, with a rich metadata layer
alongside in `meeting_notes`. The bridge only recognizes true meeting sources
(`granola/zoom/fireflies/otter/fathom/meet/teams/gong`) — **never `slack`**, so chat threads don't
fill the Meetings page.

---

## 4. Deduplication

- **`items.content_sha256`** — the primary "unchanged" gate (covers **body + title only**). Keyed
  `unique (team_id, project_id, path)`.
- **Dense-index dedup** — idempotent on `content_sha256`; the batch selects only items whose chunk
  set is missing or stale (`c.sha <> i.content_sha256`).
- **Content-keyed `row_key`s.** Tasks/decisions dedup on `unique (team_id, project_id, row_key)`.
  Meeting todos use a **content key** `meet-<hash(item)>-<hash(normalized title)>` (**not** ordinal
  position, `extract-todos.ts:163`) — so re-extracting the same transcript maps each todo to the
  **same** task regardless of the LLM's order/count, preserving any PM-tool push link. Identical
  titles within one extraction collapse to one row ("the same action item stated twice is one task").
- **Meeting duplicate-merge** (`lib/meetings/merge.ts`). `findDuplicateMeeting` searches same-date,
  non-tombstoned notes and returns the best match whose transcript overlap ≥ `0.5`. No `occurred_at`
  ⇒ no auto-merge. The merge writes to a **merge-owned synthetic path** `meetings/<noteId>.md`
  (never back into a connector-owned path, or the next sync would silently overwrite it).

---

## 5. Diff-sync — what updates, what's deleted, what survives

A push carries the **full** row set for an item (empty rows present, so an emptied table diff-deletes
its synced rows). In `materializeTasks`/`materializeDecisions`:

- **Updated in place** — each incoming row upserts on `(team_id, project_id, row_key)`. A
  **partial-write rule**: `parent`/`labels`/`priority`/`assignee` are written only when the row
  carries the key (a 6-column push preserves them; a present-but-empty value clears them).
- **Diff-deleted** — rows where `origin === "sync" && !incomingKeys.has(row_key)`. Dangling
  `parent_row_key` references are then nulled (no DB FK) so a deleted epic doesn't orphan a child.
- **Survives a diff (the protected classes):**
  - **UI-origin rows** (`origin='ui'`) — only `origin='sync'` is deletable.
  - **PM-adopted tasks** — inbound sync flips a natively-adopted Linear issue's `origin` to `'ui'`
    _precisely_ so the next diff-delete can't remove it, and seeds `tasks.body` once from the Linear
    description so a later empty-body projection can't wipe it.
  - **Dashboard-created decisions** — discriminated by `source_item_id IS NULL`; never diff-deleted.
  - **Meeting-merge-owned items** — the merge writes to its own path so a re-sync can't clobber it.
  - **Meeting todos pushed to a PM tool** — `pruneStaleMeetingTodos` deletes disappeared todos
    **except** any with a `task_pm_links` row (never orphans a live Linear/Plane issue). A **0-item
    extraction never prunes** (an empty result is indistinguishable from a failed one).

**Writeback (dashboard → `aios pull`)** surfaces exactly these survivor classes: a task is emitted if
`origin='ui'` **or** `updated_at > synced_at` (edited after sync); a decision if `source_item_id`
is null **or** edited after sync — all tier-filtered through the choke-point.

---

## 6. Versioning

`item_versions` (append-only, `on delete cascade`, indexed `(item_id, created_at desc)`) gets **one
row per real content change** — only on the changed-content path past the sha gate. An unchanged
re-push adds no version (even though it may heal `synced_at`/`member_id`/`frontmatter`). Version
insert errors are surfaced, not swallowed (audit LOW: versions were previously silently lost).

**Unchanged-path heals** (each guarded, so an unchanged re-push can still repair metadata):
attribution heal (fill `member_id` only when currently null **and not locked**, audited as
`item.attribution_healed`); frontmatter heal (canonical-JSON comparison so a key-order mismatch
isn't a false change; author keys the store has but the push omits are preserved); and locked-item
protection on the changed-body path too (`delete updateRecord.member_id` when locked).

---

## 7. Prioritization & retrieval (Organ 3, `lib/query/retrieve.ts`)

`nativeRetrieve()` fans out every independent leg in parallel and merges them into one
`RetrievedContext = { sources, structured, grounded }`.

### 7.1 Hybrid search + fusion

- **FTS (keyword):** `significantTerms()` drops stopwords and noise (keeps 2-char versions/acronyms
  like `CI`/`S3`, never 1-char); OR-joins by default (recall bias), switching to AND only on an
  upper-cased `AND` operator; `#channel` scoping is parsed out. Executed via `ts_rank`-ordered raw
  SQL so the capped window is the _best_ N, not an arbitrary N. Candidate cap `FTS_CANDIDATE_LIMIT
  = 50`.
- **Dense (vector):** HNSW cosine over `item_chunks`, best chunk per item, default `limit = 20`,
  with a **distance floor `DENSE_MAX_DISTANCE = 0.6`** — load-bearing, because nearest-neighbor
  always returns _something_; the floor means a dense hit is a _real_ semantic match, which is why
  it's allowed to set `grounded = true`.
- **RRF fusion** (`fuseByRrf`, `RRF_K = 60`): `score(s) = Σ 1/(k + rank)` across the FTS list and
  the dense list. Items in both rank above items in one, which rank above recency/augment padding.
  Reassigns `S1, S2, …` so the top-fused source is `S1`. Only runs when dense contributed.
- **Reranker (cross-encoder):** optional (`RERANK_URL`, default model `qwen3-reranker-0.6b`,
  `RERANK_TIMEOUT_MS = 4000`) — the final reorder, reassigning sids so the most-relevant source is
  cited `S1`. Best-effort: any error/timeout returns the input order.
- **Graphiti temporal facts** (`GRAPH_FACTS_LIMIT = 12`, tier-scoped, 4s timeout) + **semantic
  query-expansion** (harvest entity/fact terms → a second FTS pass to reach paraphrases literal FTS
  missed) + optional **external augmentation** seam.

### 7.2 Signals & budget

- **Recency:** `ts_rank … , synced_at desc` secondary sort, plus a dedicated 8-newest-items fallback
  so fresh content always has a shot.
- **Company graph** (team tier only): actors, commitments, and `REPORTS_TO`/`OWNS`/`BLOCKS`
  relationships, written solely by `lib/graph/company-actors.ts` in lock-step with the `members`
  roster; disabled members filtered out so a departed person is never cited as current staff.
- **Activity digests** (context-shaped, team-tier only) included only when an inclusive intent regex
  fires.
- **Token / top-K caps:** `MAX_SOURCE_CHARS = 8_000` per source; **`MAX_TOTAL_CHARS = 160_000`
  (~40k tokens)** is the real ceiling; structured caps decisions 50 / tasks 80 / actors 40 /
  commitments 30 / rels 80.

### 7.3 Tier filtering on the read path (no RLS)

`isRestrictedTier(tier) = tier !== "team"` (fail-closed). The `access = 'external'` filter is
re-applied on **every** read leg — FTS, dense (on the **live** `items.access`, not the chunk copy),
recency fallback, decisions/tasks (via `audience`). Graph entity tables (which carry no tier column)
are **omitted entirely** for external rather than risk a leak.

### 7.4 The answer path & "stay quiet"

`resolveAnsweringKeys()` assembles decrypted keys+models + `teams.answering_provider` /
`reasoning_*`; `selectLlmBackend()` picks the backend deterministically (explicit override, else AUTO
precedence OpenRouter → local → Anthropic; never OpenAI-cloud on the strength of an embeddings key).
`lib/query/claude.ts` streams with a cached system prefix and the question **last** (stable cacheable
prefix). The OpenAI-compatible path adds `STREAM_REASONING_HEADROOM = 6000` on the first attempt so a
reasoning model can't spend the whole `max_tokens` on hidden thinking and stream an empty answer, and
strips `<think>…</think>` spans.

**Grounding → abstain.** `grounded` is true when a rare/specific term matched, or a dense/semantic
hit fired; false when specific-but-no-match. On `grounded === false`, `groundingNote()` injects an
explicit abstain instruction so the model says "I don't have that" instead of confabulating.

**Chat history windowing:** owner-scoped `recentTurns()` (6 turns) → each prior answer truncated to
400 chars, so follow-ups/pronouns resolve without blowing the budget.

---

## 8. Conflict resolution & attribution — the durable lock

This is how the brain decides _whose work_ an item is, reconciles conflicting identity signals, and
**protects deliberate human corrections from automated reversion.**

### 8.1 Attribution at ingest (never the connector)

`lib/attribution/resolve-authors.ts` is the one source-agnostic resolver. `attributeIncomingItem`:

- author signal resolves to a real member → attribute to that member (even if someone else pushed);
- unresolved + pushed by a **connector** key → `member_id = null` (a sync account never claims a
  human's work);
- unresolved + pushed by a **human** key → no override (keeps the pusher's attribution);
- any ref that resolves _to_ a connector is treated as a **non-resolution** (a coincidental email
  match can't attribute a person's work to "Notion Sync").

Author refs are parsed in precedence order — structured `authors[]`, then source-specific keys
(slack `author_id`, linear/plane `assignee_id`, git `author`), then a generic `author_email`
(**email-only** — a bare display name is not a reliable key). Refs are role-ranked
(author > creator > editor > … > commenter); the **primary** is the strongest-role ref that
_actually resolves_. Notion `created_by`/`last_edited_by` are normalized to author/editor roles
(bots skipped) by a best-effort Python enricher that never raises.

`lib/identity/resolve.ts` builds a per-team identity map: `byEmail` (roster + `member_emails`
aliases, exact), `byHandle`, `byProviderId` (from `member_identities`), and an email-local-part →
handle **heuristic gated on roster domains** (so `alex@gmail.com` can't be misattributed to internal
handle "alex").

### 8.2 Identity mapping conflicts

`setMemberIdentity` is the single, collision-safe writer for `member_identities`: same member →
patch only non-empty fields (a handle-only map doesn't wipe a synced email); different member +
`force` → remap; **different member, no force → conflict, left as-is** (an automatic by-email sync
can never silently clobber a deliberate manual mapping). `syncProviderIdentities` (the shared
Slack/Linear/Plane auto-map) always calls it **without force**, and is a no-op when a connector lacks
emails (Slack needs `users:read.email`).

### 8.3 The correction core: `items.member_id_locked`

A natural-language correction box (Admin → Attribution) drives **parse → preview → apply**:

1. `parseCorrectionPlan` turns plain language into a **closed, `.strict()` `reassign` schema** whose
   `match` is `.refine`-guarded to require a scope criterion (source / pathPrefix / onlyUnattributed
   / fromMemberName / itemId) — an unbounded "all items" correction is refused. Ambiguous target →
   error, not a silent mis-apply.
2. `previewCorrection` is **read-only** — it re-resolves and returns the exact count + sample paths.
3. `applyAttributionCorrection` (in `lib/ingest`, the single writer) **re-resolves from scratch**,
   enforces a **TOCTOU check** (abort if the live match count ≠ what the admin previewed), then
   writes `member_id = target` **and `member_id_locked = true` atomically**, audited as
   `attribution.corrected`.

**How the lock survives every automatic path:**

- **Re-attribution batch** skips locked rows _and_ carries `.eq("member_id_locked", false)` on
  writes (closes the mid-scan TOCTOU window).
- **Unchanged-repush heal** fires only when `member_id === null && !locked` — a locked
  "correct-to-nobody" is never refilled.
- **Changed-body path** drops `member_id` from the update when locked — a real content edit can't
  silently undo the correction.

**Upgrade-only heal:** the heal only fills an _unattributed_ item; it never re-points an
already-attributed one on a routine sync, and never clears a resolved human to null.

### 8.4 Auto-propagation

Changing an identity mapping fires `reconcileAttribution` in `after()`: re-attribute (skip locked) +
mark `arc_cache` stale so arcs recompute without waiting out the 10-min TTL. It's a **per-team
trailing-edge coalescer** — at most one scan per team, one queued trailing pass — which kills a
stale-map-snapshot race and collapses N rapid edits into ≤2 scans. The NL correction path
deliberately does **not** re-run reattribute (that would fight the correction) — it only busts arc
caches. A manual **"Re-attribute content"** button is the recovery path.

> **On branch `origin/chetan/source-reassignment` (not yet on HEAD):** source-reassignment
> propagation closes the gap where a pure assignee change (prose unchanged → unchanged fast-path)
> never re-pointed `member_id`. A pure `decideReattribution` classifies null→member as a **heal** and
> A→B as a **reassignment**, emitting an `item.reassigned` audit stream that (via a `via` tag —
> `author_signal` / `pusher_default` / `correction`) lets a later feature distinguish a genuine
> **handoff** from a **mislabel**. Credit is designed to accrue by **evidence, not label**, so a
> mislabel (which leaves no corroborating work) earns none.

### 8.5 Merge & tier conflicts

- **Meeting merge** floors `access` to the most-restrictive source (a team upload folded into an
  external note never becomes externally readable), remaps action items onto the merge-owned item,
  and tombstones the retired copy with `merged_into` set **atomically** (never briefly visible; the
  backfill can't resurrect it).
- **Tier reclassification on re-sync** (`lib/graph/project.ts`): when an item moves tiers, its stale
  episodes are deleted from the **old** graph group (resolving each chunk name → uuid) **before**
  projecting into the new group — otherwise it stays searchable in the old tier forever (a cross-tier
  leak). The idempotency no-op requires _same tier_.

---

## 9. Narrative arcs — precomputed context (Layer 3)

`lib/graph/arcs.ts` synthesizes human-readable "narrative arcs" from the last 7 days of graph facts,
cached in `arc_cache`.

- **Representation fix (#303):** fetch a **deep pool** `FACT_POOL = MAX_FACTS × 20 = 4000` (not the
  globally-newest 200, which were ~84% dominated by the highest-volume contributor), dedupe, then
  **two-level balance**: group by contributor, cap every source item at `PER_ITEM_CAP = 20` (so a
  257k-char ARCHITECTURE.md can't be one author's whole story), and **round-robin one-per-contributor
  per round** down to `MAX_FACTS = 200`.
- **Ordered by WORK time**, never extraction time (`workTs` = Graphiti `valid_at` clamped to
  `created_at`); displayed arcs ranked recency-first by newest cited evidence.
- **Only ACTIVE Linear issues inform arcs** — a Linear item is arc-eligible only when its canonical
  `state_type === "started"` (or a progress/review name regex); the filter is applied **at synthesis
  only**, so excluded tickets stay in the graph and the raw facts panel.
- Synthesis runs on the **reasoning role** (`role: "reasoning"`, its own provider/model) with a
  `110s` timeout (a reasoning model over ~200 facts needs far more than the 30s default). Cited
  `supporting_facts` map to verifiable, clickable evidence (each links to `/library/{itemId}`).
- **Corrections fold back:** the Recompute button writes human edits back to Graphiti as
  `correction:<arc_id>` episodes.

---

## 10. Resilience — the empty-clobber guard family

The recurring principle: **a transient upstream failure (LLM outage, reasoning starvation, graph
blip) must never overwrite good data with an empty result.**

- **Arcs (`commitArcs`)** — the primary implementation. An empty synthesis, if a prior non-empty
  arc set is younger than `EMPTY_CLOBBER_MAX_AGE_MS` (default 48h, env
  `ARCS_EMPTY_CLOBBER_MAX_AGE_MS`, parse-guarded against NaN), **keeps the stale-but-real arcs and
  does not refresh the timestamp** (so it keeps retrying until synthesis recovers). Beyond 48h, an
  empty result is accepted as genuine (quiet team, deleted content). This is the fix for the 2026-07
  incident where one bad LLM call pinned the Learning page empty for hours.
- **Serve-stale-while-revalidate** — `getArcs` returns fresh in-memory (10-min TTL) → persistent
  `arc_cache` (fresh return; **stale return-now + background refresh**) → cold-miss inline compute.
  `staleArcCache` sets `computed_at` to "11 min ago" (just past TTL), **never epoch**, so the
  empty-clobber guard still sees a recent prior.
- **Meeting-transcript merge** rejects an LLM result shorter than 60% of the longer source (a
  summary, not a merge) and falls back to a lossless deterministic union.
- **PM-adopt body seed** — seeds `tasks.body` from the Linear description so a later empty-body
  projection can't wipe the native description.
- **Ingest crash sentinel** (`PENDING_SHA`, §2.1) — the same family: a half-materialized push is
  never marked "synced."

---

## 11. Edge-case catalog

| Category | Edge case | How it's handled |
|---|---|---|
| **Chunking** | Oversized item overflows the 16384-token extraction cap | Split into ≤16 fixed-width episodes; overflow beyond 40k chars dropped (full text still in items/FTS/pgvector) |
| | Whitespace-only body | `chunkContent` → `[]`, episode skipped; dense-index clears stale chunks |
| | Fact spans a chunk boundary (dense) | 150-char word-aligned overlap tail carries it into one chunk whole |
| | Multi-chunk item, one chunk fails to land | Reconcile treats item as "landed" if _any_ chunk episode is present; a 5-min grace avoids judging in-flight extraction |
| **Dedup** | Identical body under different titles | Title prepended into body → distinct hash |
| | Re-extracting a transcript reorders/renumbers todos | Content-keyed `meet-<hash>` row_key maps each to the same task, preserving PM links |
| | Same action item stated twice in one meeting | Collapsed to one row via a `seen` set on normalized title |
| | Same meeting uploaded by two people | Duplicate-merge folds into the existing note (overlap ≥ 0.5); unknown date → no auto-merge |
| **Diff-sync** | Emptied markdown table | Empty rows present in the push → synced rows diff-deleted |
| | Dashboard-created task/decision on a synced item | `origin='ui'` / `source_item_id IS NULL` survives the diff |
| | Natively-adopted Linear issue | `origin` flipped to `'ui'` + body seeded so diff-delete can't remove it |
| | A meeting todo already pushed to Linear disappears from a re-extract | Kept (has a `task_pm_links` row); a 0-item extraction never prunes |
| | Deleted epic leaves a child pointing at a missing parent | Dangling `parent_row_key` nulled after diff-delete |
| **Attribution** | Person has a different email per platform | `member_identities` folds each platform email into `byEmail` |
| | Author resolved _after_ first ingest (Notion enrichment, late mapping) | Healed on a later unchanged re-push — but only if still unattributed, upgrade-only |
| | External key names a team member in free-form frontmatter | External-tier rows skip attribution derivation and re-attribution |
| | Coincidental email match to a connector account | Resolving _to_ a connector is a non-resolution |
| | git noreply alias email | Exact `member_emails` match without widening the domain heuristic |
| | Deliberate "meeting notes aren't anyone's work" | Correct-to-nobody → locked null, never refilled |
| | Correction applied mid re-attribution scan | Write-time `.eq("member_id_locked", false)` predicate protects it |
| | Preview count drifts before apply | TOCTOU check aborts |
| | Auto by-email sync would remap a manual mapping | No-force conflict rule leaves it as-is |
| **Staleness** | Healthy 24h job flagged by a blanket 3h threshold | Per-source override (`auth_cleanup` = 26h) |
| | Quiet/idle source (no work this tick) | Record-only-when-active legs write no row; age threshold = `null` (`dense`, `graph_project`, `pm_sync`, `llm`, `scan`) — failures surface via `ok=false` + residual probes |
| | Graphiti accepts an episode (202) then fails extraction async | Synthetic `graph_extract` leg (episodes ≥ 25 && facts == 0) named on the banner |
| | Re-scan resurfaces old work as "today" | Timeline work-time = `committed_at ?? source_ts`, never `synced_at`; undated dropped |
| **Retrieval** | No FTS results | 8-newest recency fallback; `grounded=false` → abstain note |
| | External viewer, nothing external matches | Graph tables omitted; `<no document sources matched>` placeholder |
| | Dense index absent | `denseSearch` → `[]`, no RRF, pure FTS+recency (byte-for-byte unchanged default install) |
| | Reranker / augment / Graphiti down | Each best-effort with a timeout → input order / `[]`; degrades to Postgres-only |
| | Reasoning model spends the whole budget on hidden thinking | `STREAM_REASONING_HEADROOM` on attempt 1 + retry-without-headroom; empty answer logged |
| **Resilience** | Transient LLM outage returns empty arcs | Empty-clobber guard keeps stale-but-real arcs < 48h without refreshing the timestamp |
| | Crash mid-materialize | `PENDING_SHA` sentinel → retry re-materializes; never marked synced diverged |
| | LLM transcript merge degrades to a summary | Rejected (< 60% length) → lossless deterministic union |

---

## 12. The views built on the system

Every view reads the **same shared substrate** (`items` + `tasks` + the graph + regenerable caches),
tier-gated through `lib/auth/visibility`. Nothing re-derives attribution or work-time in the UI.

### 12.1 Query / chat (`/query`)

**UI → reader → tables.** `app/t/[team]/query/page.tsx` → `<ChatWorkspace>` (thread rail +
`<QueryChat>`). A turn streams from `POST /api/dashboard/query` (SSE `delta`/`sources`/`done`), whose
retrieval core is the same `lib/query/retrieve.ts` the machine API (`/api/v1/query`) uses — session-
authed vs key-authed twins. Threads persist in `conversations` + `chat_messages` (owner-scoped,
`lib/chat/store.ts`, LLM-written titles). The **spend meter is `query_log`**: the route enforces
`DAILY_QUERIES_PER_MEMBER = 20` and `DAILY_TEAM_BUDGET_USD = 10` from it, then inserts one row per
answered turn — the same ledger the Admin → Usage dashboard reads. Typing `/sync` overloads to a
manual sync (team-tier, audited) instead of the LLM.

### 12.2 Learning page + narrative arcs

`app/t/[team]/learning/page.tsx` keeps arcs expanded (`<ArcsPanel>`) with Timeline + raw Events/Facts
collapsed below. `<ArcsPanel>` posts to `/api/brain/arcs` — tier enforced by
`visibleGroupIds(teamSlug, tier)`; an empty result is diagnosed to an actual cause
(`no_facts` / `model_failing` / `synthesis_empty`) and the raw provider error is redacted for
`external`. Reads Graphiti facts (7d, work-time ordered) → `getArcs` (§9), cached in `arc_cache`.
Each arc's summary is inline-editable; **Recompute** posts corrections to `/api/brain/arcs/recompute`.

### 12.3 Timeline / work-time view (commit `412873e`)

The newest surface — a human-readable **day → person → work-grouped-by-source** ledger over the last
7 days, replacing the old flat graph-episode dump (which was chunk-spammy and stamped at extraction
time). Source of truth is **Postgres `items` + `tasks`, not the graph** (so one item = one row, no
16-chunk doc spam, and attribution/source live reliably on the row):

- `components/learning/timeline-panel.tsx` (server, in its own Suspense boundary) renders per day a
  header, a `prism-card` per person (`MemberAvatar` + "12 items · GitHub, Linear"), evidence grouped
  by source with `<SourceIcon>` (`components/icons/source-icon.tsx` — inline brand SVGs), item titles
  as external links, and "+N more" when capped.
- `lib/dashboard/work-timeline.ts::getWorkTimeline` reads the non-connector roster,
  `visibleItems(...)` for git commits and other items (granola/transcript excluded as team signal),
  and `visibleTasks(...)` attributed by `assignee` (unmatched dropped, never mis-attributed). Work
  time = `committed_at ?? source_ts` (never `synced_at`); URLs sanitized to http(s).
- `lib/dashboard/timeline-group.ts::groupTimeline` is a **pure, unit-tested** grouper: days DESC
  (undated last), people by total DESC, sources by count DESC, items newest-first, per-source cap 6,
  Today/Yesterday/"Mon Jul 21" labels. Modeled on the proven `lib/dashboard/team-work-live` read.

### 12.4 Attribution admin dashboard (Admin → Attribution)

`app/t/[team]/admin/attribution/page.tsx` (admin-gated; the health lib spans all tiers with no RLS
backstop, so the page gates itself). Reads `getAttributionHealth` over `items ⋈ members`:

- **Per-source health** — human vs connector vs nobody per source, with a percent-human bar and a
  low-attribution alert (< 50% on non-signal sources).
- **Per-person drill-down** — `getMemberItems` expands a member (or the "Unattributed" bucket) to the
  actual items, each linking to its library page, filterable by source chip, with a per-item
  "correct" affordance. It **throws** on error by design (a chip that says "14" must never silently
  expand to an empty list).
- **NL correction box** — the parse → preview → apply flow (§8.3), plus **resolution provenance**:
  each item shows the signal that resolves it, _how_ (`via provider/email/handle/heuristic`), who it
  resolves to now, a "manual" lock badge, and a red **drift** pill when the signal now points at a
  _different_ member than the current attribution (suppressed for locked + external rows).

This view is the **observability layer over `items.member_id`** — it re-uses the one shared resolver
(`resolveAuthors`), the one write path (`lib/ingest`), and the one `SOURCE_EXPR` so chips,
drill-down, and correction blast-radius all reconcile.

### 12.5 Observability — pipeline-health, retrieval-health, runs

All built on **one spine: the `ingest_runs` ledger** (single writer `recordIngestRun`, never throws)
plus two live probes (`graph_episodes` + Neo4j fact counts). Every reader is best-effort (degrades to
healthy/empty so it never breaks a render).

- **Pipeline-health banner** (`components/admin/pipeline-health-banner.tsx` ← `getPipelineHealth`) —
  a loud red banner naming each _broken_ (`ok=false`) or _stale_ (older than its per-source
  threshold, default 3h) leg. Dismissal is fingerprinted by `alertSignature` so a _new_ failure
  re-shows it. Appends the synthetic `graph_extract` leg for the 202-accepted-but-zero-facts failure.
- **Retrieval-health card** (`retrieval-health-card.tsx` ← `getRetrievalHealth`) — per-leg state of
  the context stack (answering model, keyword-always-on, semantic/dense coverage %, graph memory,
  reranker, augment), with edge-triggered admin emails on the dense ok→degraded / degraded→ok edges.
- **Recent ingestion runs panel** (`ingest-runs-panel.tsx` ← `listRecentIngestRuns`) — the raw run
  log (Source, Trigger, Status, `+created ~updated =unchanged`, When, Details) so failures are
  diagnosable after the fact. Reused verbatim on the PM-sync page (`source='pm_sync'` rows).
- **PM-projection health card** — `never_run`/`failed`/`stale` (`PROJECTION_STALE_AFTER_HOURS = 24`,
  a heuristic since projection is reactive, not scheduled) — stored in the _same_ `ingest_runs`
  table under `source='pm_sync'`.

### 12.6 Codebases (`/codebases`)

Index + detail pages read through the one choke-point `lib/metrics/codebases.ts` (the sole
tier-enforcement point; external → empty). Score/readiness cards, a full-width agentic-score trend, a
commit-volume chart (AI vs human), a contributor table (collapsing one person's git aliases), and a
collapsible Issues & PRs `<details>`. **Scores are derived in the brain** from raw scanner facts
(`lib/codebases/score.ts`, weighted sub-scores; AI-commit ratio deliberately the _lowest_ weight),
stored on `code_metrics` keyed `(codebase_id, head_sha)` so a re-scan of the same commit adds no
point (new commit does; older scans flagged `stale` at 14 days rather than blanked). Two write paths
— the full CLI scan (all four tables + commit→item projection) and a GitHub-API fallback (`codebases`
+ `code_contributions` only, never `code_metrics`, so a linked-but-unscanned repo reads honestly as
"not scanned"). Commits also become searchable `artifact` items via `commits-to-items.ts`, so the
same data feeds Codebases, Timeline, and Query.

### 12.7 Meetings two-pane (`/meetings`)

A list rail + detail with Summary/Transcript tabs. Meetings are **`items` with a transcript kind**;
summaries and action items are LLM-extracted; selected action items push to the team's PM provider,
writing the **same `tasks` table** Timeline and Query read.

### 12.8 Admin → Integrations + "Working On" box

The answering/reasoning model picker writes `teams.answering_provider`/`reasoning_*` — the single
global LLM switch resolved through `resolveAnsweringKeys` → `selectLlmBackend`, the same keys the
Query route _and_ arc synthesis consume. Provider keys and GitHub repos persist to the
`integrations` tables read across surfaces. The home-page **"Working On" box**
(`components/dashboard/working-on.tsx` ← `lib/dashboard/team-work-live.ts`) is the tier-gated,
non-connector, `committed_at` work-time read over `items` + `tasks` + `members` that the Timeline was
explicitly modeled on.

---

## 13. Data-model relationships (the "design for multiple surfaces" spine)

```
                          ┌───────────────────────────────────────────────────────────┐
                          │  items  (body + frontmatter, content_sha256, member_id,    │
                          │          access-tier, member_id_locked)  ── SOURCE OF TRUTH │
                          └───────────────────────────────────────────────────────────┘
      ┌───────────────┬───────────────┬──────────────┬───────────────┬─────────────────┐
      ▼               ▼               ▼              ▼               ▼                 ▼
 item_versions   items.search   item_chunks    graph_episodes   tasks/decisions   meeting_notes
 (append-only)   (FTS tsvector) (pgvector)     → Graphiti        (materialized     (metadata layer
                                               (facts/entities)   rows)             on transcript items)
      │               │               │              │               │
      └──────── all regenerable, idempotent projections keyed off content_sha256 ───────┘
                                      │
                                      ▼
                          arc_cache (SWR narrative arcs) · query_log (spend) · code_* (analytics)
                          — all regenerable derived caches, never source of truth
```

Key relationships:

- **`items.member_id` → `members(id)`** is the one attribution field every learning/arc/timeline
  surface stands on, resolved per-source at ingest by the one shared resolver, and protected by
  `member_id_locked`. The attribution dashboard is just observability over it.
- **`tasks` / `decisions`** are materialized from item `rows[]` (diff-synced), but UI-origin and
  PM-adopted rows are protected survivors — so the same table is safely both a sync mirror and a
  first-class CRUD store shared by Meetings, Timeline, Working-On, and Query.
- **The graph** (`graph_episodes` → Graphiti/Neo4j, `graph_entities`/`graph_relationships`) is a
  projection of the same items, tier-encoded in `group_id` (`<slug>_<tier>`), feeding arcs and the
  Query graph-blend.
- **Regenerable caches** (`arc_cache`, `query_log`, `code_metrics`, `item_chunks`) are safe to
  truncate and rebuild; none is a source of truth.
- **Tier is a data-layer property** (`items.access`, `tasks.audience`, graph `group_id`,
  `codebases` team-tier gate), re-applied on every read path — there is no RLS backstop, so the
  `lib/auth/visibility` choke-point + per-table filters _are_ the enforcement.

---

## 14. Appendix

### 14.1 Key constants

| Constant | Value | Where / why |
|---|---|---|
| `CHUNK_CHARS` / `MAX_EPISODE_CHUNKS` | 2500 / 16 | graph episode chunker (Graphiti 16384-token cap) |
| dense `DEFAULT_MAX` / `DEFAULT_OVERLAP` | 1200 / 150 | dense chunker (boundary-aware, word-aligned overlap) |
| `RRF_K` | 60 | Reciprocal Rank Fusion constant |
| `DENSE_MAX_DISTANCE` | 0.6 | dense distance floor (real semantic match) |
| dense `limit` / `FTS_CANDIDATE_LIMIT` | 20 / 50 | candidate pools |
| `MAX_SOURCE_CHARS` / `MAX_TOTAL_CHARS` | 8000 / 160000 (~40k tok) | per-source / total context budget |
| answer `max_tokens` / `STREAM_REASONING_HEADROOM` | 4096 / 6000 | streaming budget + reasoning headroom |
| history window | 6 turns × 400 chars | follow-up/pronoun resolution |
| arcs `MAX_FACTS` / `FACT_POOL` / `PER_ITEM_CAP` | 200 / 4000 / 20 | contributor-balanced sampling |
| arc cache TTL / empty-clobber age | 10 min / 48h | SWR + resilience |
| pipeline stale default / `auth_cleanup` | 3h / 26h | per-source staleness |
| `PROJECTION_STALE_AFTER_HOURS` | 24 | reactive PM projection heuristic |
| `DAILY_QUERIES_PER_MEMBER` / `DAILY_TEAM_BUDGET_USD` | 20 / $10 | spend guards over `query_log` |
| `MAX_PAYLOAD` | 1 MB | ingest boundary cap |

### 14.2 PR history (the ~136 PRs that built this)

Grouped by theme, in rough chronological order. Numbers are merged PRs.

- **Foundations — ingestion & knowledge repo:** #27 native Slack connector · #73/#74/#76 native
  Plane/Linear/GitHub importers · #80 retire GitHub Python sidecar · #97 retrieval eval harness
  (context-management foundation) · #123 `ingest_runs` log + recent-runs panel.
- **Graph memory (Graphiti):** #77 stack + projector + tier-scoped query · #82/#83 projector trigger
  + blend graph facts into the query box · #133 cap episode content · #155 projector paging +
  hardening · #216/#232 malformed/`down` `GRAPHITI_URL` handling · #294/#296 diagnosable 422 → ISO
  timestamp fix · #301 raise extraction cap to 16384 · #303 representative arc synthesis + fit under
  cap · #305 chunk large items into multiple episodes (no-loss).
- **Retrieval / context shaping:** #84 chat UI + parallelize retrieval · #98 semantic query-expansion
  · #99 "stay quiet" abstain · #100 gate heavy digests by intent · #101 completion-aware retrieval ·
  #124/#126 pluggable context layer + optional pgvector + per-team embedding key · #128 context-layer
  roadmap · #177/#178 chat FTS search · #180 adversarial retrieval suite · #182/#183/#186/#187/#188
  FTS gaps (acronyms, ts_rank, IDF grounding, full-corpus counts, channel scope) · #211 dense
  distance floor · #214 raise FTS candidate cap · #228 explicit AND operator · #229 dedicated
  `EMBEDDINGS_API_KEY`.
- **Learning / narrative arcs:** #129/#130 Layer 1 facts + Layer 3 arcs + Layer 2 events · #132
  sparse-data fallback · #173/#174 arcs degrade-to-empty diagnosis · #176 clickable evidence · #179
  trace AI-agent participants to a human · #181 ground synthesis in human attribution · #185 collapse
  raw evidence · #217 persist arc cache (SWR) · #281/#290/#307 resilient arcs (reasoning headroom, no
  empty-clobber, stale-arc cap) · #285 disable reasoning for extraction on OpenRouter · #312/#315
  structural participants + rebalance fact pool · #330 order by work time · #331 only active Linear
  issues · #332/#340 work-time timeline view → human-readable Timeline.
- **Identity & attribution:** #87/#88 Slack→person + unified `member_identities` · #90 attribute
  Linear/Plane issues · #92 re-attribute existing content · #93/#95 per-member context layer · #139
  attribute git commits to the author · #168/#171 flag connector accounts / stop mis-attributing to
  the connector · #252 attribute GitHub repo files to their author · #316/#318/#320 attribution-health
  read + resolve author at ingest + admin dashboard · #322 NL correction box · #329 Notion normalizer
  + heal on unchanged re-push · #333 auto-propagate re-associations + durable correction lock · #334
  per-person drill-down.
- **Observability / staleness:** #189/#190 retrieval-stack health card + degrade emails · #199 correct
  stale PM-sync doc · #232 probe Graphiti reachability · #248 projection last-run + staleness · #288/#292
  percolate silent failures · #300 fail loudly on a broken pipeline · #302/#306 per-source staleness
  (stop crying wolf) · #325 dismissable pipeline-health alert.
- **Meetings:** #220 meeting notes + LLM attendees · #250 show CLI-pushed meetings · #259/#266/#267/#269
  action items + two-pane + summaries + auto-extract · #270/#271/#273 duplicate-merge (LLM + lossless
  fallback + backfill) · #279/#283/#284/#286/#308 perf + robustness (timeouts, truncation, no silent
  revert/orphan/leak) · #323/#326/#338 skeleton + prefetch + in-place update.
- **Codebases:** #21/#23/#28 AEM readiness + maturity + scorer · #147 last-known metrics + stale badge
  · #11/#252 author-handle misattribution fixes · #336 (08c3028) side-by-side score/readiness +
  full-width trend + collapsible Issues & PRs.
- **PM-sync & tasks:** #44/#55/#64/#69/#70 hierarchy model + projection engine + reactive projection +
  divergence detection · #62 external AI spend · #151/#153 company-graph API + ce_band.
- **LLM routing:** #285 OpenRouter reasoning fix · #324 provider + model picker per role (answering +
  reasoning) · plus the `lib/llm/complete` single-caller guard.

_Not exhaustive — see `git log` for the full set; the above covers the context-management-relevant
PRs found in the merged history._

---

_Generated by reviewing the codebase and merged PR history on 2026-07-22._
