# TODO / Deferred work

Engineering work we've **consciously deferred**, with the rationale recorded so the decision isn't
re-litigated from scratch later. This is not a bug tracker — it's the "we chose not to do this yet,
and here's why + when to revisit" list.

Format per item: **Status · Why deferred · When to revisit · How to do it**.

---

## ⚠️ Working note — parallel Conductor worktrees collide on the same subsystem

This repo is often worked by **multiple Conductor worktrees at once** (all under one git account, so
author name is not a signal). It has already caused duplicated work twice: two independent sessions
built different fixes for the same auth vuln (2026-07-06), and two worktrees built the same Social
Brain generation/image slices in parallel (2026-07-11) — the later one merging first and wasting
~1,200 lines of the other's effort (PRs #230/#234, closed as superseded by #227/#233).

**Before starting deep work on a subsystem** (e.g. `lib/social`, `lib/query`, auth), check for
competing in-flight work first — it costs seconds:

```
gh pr list --state all --search "<subsystem> in:title" --limit 20
git log --oneline -20 origin/main            # has main moved in this area?
```

If another worktree is already shipping the same milestone, **stop and confirm which worktree owns
it** rather than building a duplicate. Also `git fetch origin main` partway through a long build (not
just at merge time) — `main` can move by many PRs during one session. When a duplicate is discovered
after the fact: the merged version wins, **close the duplicate PR**, and salvage only the delta main
lacks (diff the closed branch vs `main`).

---

## Navigation cleanup + Learning-page fixes — SHIPPED 2026-07-10

- ✅ **Lean primary nav** (#213) — Tasks, Maturity, Decisions removed from the left nav; the empty
  "Work" group dropped. Nav is now Home / Codebases / Learning / Query / Settings. Routes still
  resolve by direct URL (`/tasks`, `/maturity`, `/decisions`) — only the nav entry was cut.
- ✅ **Data moved under Admin → Data** (#213) — the ingested-data channel browser is now admin-gated;
  `/library` index redirects to `/admin/data`; `/library/[id]` detail + `/library/skills` unchanged.
- ✅ **Arc cache persisted + serve-stale-while-revalidate** (#217) — `arc_cache` table; `getArcs`
  reads in-memory → Postgres (fresh → return; stale → return stale + fire-and-forget recompute,
  in-flight-deduped; cold → compute inline). SWR chosen over a timer-driven global refresh.
- ✅ **Universal fact attribution** (#217) — `attributedFactTexts` now attributes every fact that has
  a resolvable human (fixes the nameless "Context-Management Enhancements" / "Deterministic Checklist
  Evaluator" arcs), keeping the `(Name, via Agent)` form for agent subjects.

## Deferred cleanups — KEEP THE CODE for now (decision 2026-07-10)

The nav-hidden surfaces still have live backends. **Decision: leave the code in place** (it's inert
from the product's POV now that the nav entries are gone) and revisit teardown later. Recorded here so
it isn't forgotten, not scheduled.

- ⬜ **Full Decisions backend teardown.** Nav entry is gone; the backend remains. A future teardown
  would delete the `decisions` table, the `lib/ingest` decision-row writer, `app/actions/decisions.ts`,
  the `visibleDecisions` choke-point, `components/decisions-table` + `decisions/*`, the `/decisions`
  route, the drift-guard table block, and the decisions tests. Larger surgical change with schema/drift
  implications — own PR, only once we're sure nobody wants Decisions back.
- ⬜ **Delete (vs. keep) the Tasks & Maturity routes.** Currently just unlinked from nav; the pages,
  loaders (`lib/metrics/maturity`, the tasks board), and their data still exist and resolve by URL.
  Keep for now — decide delete-vs-keep later; no action unless the routes are confirmed dead.

## Arc-cache proactive warming (timer-driven) — deferred follow-up

**Status:** Deferred (2026-07-10). SWR (demand-driven refresh, #217) covers the common case.
**Re-confirmed 2026-07-27** on closing **#327** ("narrative arcs as a precomputed background layer"),
which proposed exactly this. Its *problem* — an ~80s synthesis on the read path blocking the Learning
page — is solved on main by SWR + `refreshArcsInBackground` + the 4h TTL + the facts-hash skip, and
`lib/social/discover-arcs` reads the same cached layer, so Learning and Social Brain already share it.
The single residual is below: `getArcs`'s **cold-miss branch still synthesizes inline**, so a
first-ever load for a group-key waits on the model. #327 was closed rather than merged because its
88-line doc described the plan as unbuilt — a stale map next to shipped behavior is worse than none.

**What:** A scheduled job that proactively recomputes each active team's arcs on an interval so even a
team's *first* view of the day is warm (SWR only warms a team once someone has viewed it). **Why
deferred:** it fires LLM calls for teams nobody is looking at (cost multiplier) and needs each team's
provider keys available in the background. **When to revisit:** if first-view latency on the Learning
page becomes a real complaint, or an org wants a nightly org-wide warm. **How:** piggyback the
`lib/ingest/scheduler` tick; enumerate teams with a recent `arc_cache` row (proxy for "actively
viewed") and refresh only those, using the team's stored provider keys.

## Social Brain v1 — narrative arcs → social posts (product direction 2026-07-10)

**Status:** Spec'd, not started. Builds on the existing foundation: M0 durable jobs/outbox (#215),
M1 Brand Brain voice/knowledge/governance config (#218), M2 content domain model + tier isolation
(#219 — `social_opportunities`, `content_plans`, `content_variants`, `content_status` enum).

**The simple v1 (deliberately minimal — keep it small first):**
1. **Source = narrative arcs.** The discovery step reads the team's Layer-3 narrative arcs
   (`lib/graph/arcs.getArcs`) and selects some as **candidate stories** worth posting. Arcs are
   already synthesized, evidence-backed, and human-attributed — so this reuses existing intelligence
   instead of building a separate discovery engine. (Maps an arc → a `social_opportunity`.)
2. **Channels = text socials only.** LinkedIn and Twitter/X. No video/carousel/thread orchestration
   in v1 — a single text post per channel, shaped by the Brand Brain voice config (M1).
3. **Images.** Each post can generate **one relevant image** to accompany the text (image-gen
   provider TBD — wire behind a provider seam like the LLM/reranker seams, so it's swappable).
4. **Human approval before anything leaves.** Reuse the existing `content_status` `awaiting_approval`
   state + the approvals surface — nothing auto-publishes (mirrors the "promote, never auto-publish"
   philosophy the Radar already follows).

**Build status (slices):**
- ✅ **Slice 1 — arc → opportunity discovery** (`lib/social/discover-arcs.ts`). Reads Layer-3 narrative
  arcs and creates one `social_opportunity` per arc, at its **tier-safe** access (most-restrictive
  tier across the arc's evidence, fail-closed — an arc built from internal items stays `team` and
  can't become a public post). Idempotent by `arc:<id>`. Wired as **Admin → Social → "Discover from
  arcs"** (`discoverFromArcsNow`), alongside the existing item-based discovery. Feeds the existing
  deterministic planner (#224), which already emits `x` + `linkedin` text variants (bodies still
  empty — that's slice 2).
- ⬜ **Slice 2 — text generation.** Fill the `content_variant` bodies with LLM-drafted, Brand-voice
  posts (the "generation milestone" `plan.ts` defers). Land them in `awaiting_approval`.
- ⬜ **Slice 3 — images.** Generate one relevant image per post behind a swappable provider seam
  (like the LLM/reranker seams); on-by-default vs opt-in TBD.
- ⬜ **Slice 4 — publish.** LinkedIn/Twitter posting after human approval. Real per-team OAuth vs.
  draft-to-clipboard for v1 is an open product question.

**Open product questions (not blocking slices 1–2):**
- Which arc-selection signal picks "post-worthy" arcs (confidence? recency? a human toggle per arc)?
  Slice 1 currently surfaces *all* arcs as candidates, scored by confidence + recency; a human picks
  which to plan.
- LinkedIn/Twitter posting = real API integration (OAuth per team) or draft-to-clipboard for v1?
- Image generation provider + whether images are on by default or opt-in per post.

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

---

## Admin pages that rely on the layout alone for authz (harden to self-check)

**Status:** flagged (Fable review of #attribution-dashboard). Pre-existing, not introduced by that PR.

Several `app/t/[team]/admin/*` pages (`members`, `data`, `keys`, …) gate solely on `admin/layout.tsx`'s
role check. Per Next.js's own bundled docs (`authentication.md`, "Layouts and auth checks"), a layout is
NOT a reliable auth boundary — it doesn't re-render on client-side navigation, so a page segment can be
rendered/served without the layout's check re-running. With no RLS backstop (CLAUDE §5), a non-admin who
soft-navigates from `/admin` to one of these tabs could get the page's flight payload (roster
emails/roles on `members` — worse than the attribution page's names+counts).

**Fix:** each admin page should self-check via `requireTeamAdmin(teamSlug)` before any privileged read
(as `app/t/[team]/admin/attribution/page.tsx` now does), returning null when it's null. A guard test that
every `admin/*/page.tsx` calls `requireTeamAdmin` would make it build-enforced.

---

## Google Drive docs arrive unattributable (no owner enrichment) — the real Drive gap

**Status:** open, and it is the blocker for Drive, not the missing test. Surfaced while adding the
reader-adapter tests (`ingestion/tests/test_reader_adapters.py`).

Notion has `sources/notion_authors.py`: it resolves `created_by` / `last_edited_by` to a name +
email and emits the structured `authors[]` the brain maps to a roster member. **Drive has no
equivalent.** `GoogleDriveReader`'s document metadata is exactly six keys — `file id`, `author`,
`file path`, `mime type`, `created at`, `modified at` — and its `author` is a bare display string,
not an email or a stable id, so `lib/attribution/resolve-authors` cannot map it to a person.

**Why that matters more than it sounds:** a Drive document therefore lands with no credited worker.
It is ingested and searchable, but it never appears under anyone on the timeline, never counts
toward a person's work, and can never be picked up by the LLM doc→task pass (#394), which only
scores *attributed* work docs. So "connect Drive" currently buys retrieval and nothing else — and
the fetch tests now passing must not be read as "Drive works".

**Why deferred:** it needs Drive API fields the reader does not surface (`owners[]`,
`lastModifyingUser`), which means a second API pass with its own credentials — mirroring
`notion_authors.py` — and we have no Drive account to develop it against.

**When to revisit:** the moment a Drive account exists to test with, or before Drive is recommended
to anyone as a work-attribution source.

**How:** add `sources/gdrive_authors.py` mirroring the Notion pass — `files.get(fileId, fields=
"owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)")` → `authors[]` with
`role: "author"` / `"editor"`, `provider: "google"`, and the email as the mappable key. Same
best-effort contract: any API failure yields no authors and never breaks the sync.

**Two smaller mapping gaps in the same place**, worth fixing in that PR rather than alone:
`docs_to_raw` reads `url` from `file_path` and `title` from `file_name`, but the reader spells the
former `file path` (with a space) and omits a name entirely — so every Drive item has a **null
title and null URL**. (`source_ts` is fine: the work-time lookup is spelling-insensitive and
matches `modified at`.)

---

## Connector proof that genuinely needs a live account

**Status:** open by necessity. `ingestion/tests/test_reader_adapters.py` +
`test_reader_api_conformance.py` (2026-07-29) close the part that can be tested without one — the
adapter body, branch selection, metadata → `RawDoc` mapping, and the kwargs we pass checked against
the real installed reader classes. That pairing already caught a live TypeError in Notion's
database branch.

**Still unproven, and not provable without credentials:** that a token/service-account key actually
authenticates, that the documented Confluence credential recipe works against Atlassian Cloud, that
pagination behaves over a real corpus, and that the live APIs return the metadata keys the fakes
assert. Read the green suite as "our code is right given the reader's shape", not "the connector
works end to end".

**When to revisit:** when an org account exists for any of the three. **How:** record one real
response per connector with `respx` (already a dev dependency) and replay it — the fake-reader seam
in `tests/_reader_fakes.py` is where a recorded fixture drops in.
