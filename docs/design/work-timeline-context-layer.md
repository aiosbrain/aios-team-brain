# Design spec — Work Timeline as a queryable context layer (evidence-linked, Slack-aware)

**Status:** proposed · **Author:** Chetan (via Claude) · **Date:** 2026-07-22
**Reviewers:** Fable (`code-reviewer`) — **reviewed 2026-07-22; verdict: sound architecture, amended
below.** Root-cause analysis verified accurate; BLOCKER B1 (evidence key source), B2 (`updated_at`
gating), and HIGH H1–H4 folded into Parts A/D/E, §9, and the open questions.
**Supersedes:** `.context/timeline-redesign-spec.md` (the v1 dynamic panel that shipped in #340)

> **Review-driven corrections (read first):**
> - Part D links evidence via **`tasks.row_key`** (mirror-imported Linear/Plane tasks store the
>   provider identifier there, e.g. `AIO-123`), **not** `task_pm_links.provider_external_id` (which
>   holds the brain's `row_key` for brain-projected tasks). See §7.
> - Part A splits **`persistedChanged`** (gates `updated_at`) from **`projectableChanged`** (gates PM
>   projection — must stay `due`/`body`-insensitive). See §4.
> - `tasks.worked_at` = the provider's **state-transition** time (`startedAt`/`completedAt`), not
>   `updatedAt` (which bumps on any edit — it would re-create the very bug). See §4.
> - Slack repliers go in a **`participants[]`** frontmatter key, **never** in `authors[]` (that would
>   let a resolvable replier steal thread ownership via `resolveAuthors`). See §8.
> - Every new task-row field (`worked_at`) and the `/api/v1/timeline` route are **brain-api.md
>   contract bumps** (v1.12), not just drift/ARCHITECTURE updates. See §9.

---

## 1. Problem

The Learning → **Timeline** (shipped #340, `commit 412873e`) is a good v1 but has three structural
gaps, surfaced while dogfooding:

1. **Stale tasks resurface as "today's work" under the wrong signal.** A Linear ticket
   ("work on spawning agents") the user wrote long ago and hasn't touched shows up under **Today**,
   attributed to them. Two artifacts combine:
   - Tasks have **no real work-time**, so the view falls back to `tasks.updated_at`
     (`lib/dashboard/work-timeline.ts:204`). But `updated_at` is a **sync** timestamp:
     `materializeTasks` upserts **every** row in a pushed task file with `updated_at = syncedAt`
     unconditionally (`lib/ingest/index.ts:382`) — row-level change detection exists right above
     (`changed.add(row.row_key)`, used only for PM projection) but does **not** gate `updated_at`.
     So any re-sync of the parent Linear item re-stamps all its tasks to *now*.
   - Attribution is the **current `assignee`**, not "who did work" — a still-assigned but dormant
     ticket becomes "your work today" the instant its `updated_at` bumps.
   This is already flagged as KNOWN v1 noise in `work-timeline.ts:26-30`.

2. **No human-readable summary.** The per-person line is a bare count string ("9 items · GitHub,
   Linear", `personSummary` in `timeline-panel.tsx`). There's no "here's what Chetan actually did"
   sentence.

3. **It is not a layer of the context system — it's a view-local computation.** `getWorkTimeline`
   is `server-only` with exactly one caller (`components/learning/timeline-panel.tsx`). There is no
   table, no API route, and no exposure to the CLI or the LLM retrieval path
   (`lib/query/retrieve.ts`). Every load recomputes it. This violates the repo's own
   "design for multiple surfaces / push derived facts to the lowest shared layer" principle
   (CLAUDE.md, global design rules).

Plus two new product requirements:

4. **Evidence-linked tasks.** For each Linear/Plane task, show the *actual work* behind it —
   GitHub commits, Notion docs, Slack messages — nested/indented under the task. Evidence that maps
   to **no** task goes into an **"Other"** tab, intelligently grouped per person.

5. **Smart Slack.** Understand the *conversations* in ingested Slack channels and *who contributed
   to which conversation*. Each person's Slack activity must appear in their timeline update. (Today
   Slack is `kind='transcript'`, attributed to the thread root only, and **excluded** from the
   timeline outright — `work-timeline.ts:185`.)

---

## 2. Goals & non-goals

**Goals**
- A **persisted, tier-aware, queryable** work-timeline layer that the dashboard, the CLI, and the
  LLM read identically.
- Correct work-time and attribution (fix #1 at the data layer, not in the view).
- Per-person-per-day natural-language summaries (precomputed, cached, resilient).
- A durable **task ↔ evidence** edge, derived deterministically where possible and by LLM where not,
  driving the nested task→evidence UI and the "Other" bucket.
- **Per-participant** Slack signal + a lightweight conversation abstraction, so Slack shows up as a
  person's work.

**Non-goals**
- Not rebuilding narrative arcs — arcs stay the graph-sourced narrative; the timeline stays the
  per-person **work ledger**, now enriched with evidence links and summaries.
- Not real-time streaming — the layer is recomputed on the ingest cadence + on demand (SWR), same as
  arcs.
- No new heavy infra — reuse Postgres, the `arc_cache`/SWR + empty-clobber machinery, and the shared
  `lib/llm/complete` primitive.

---

## 3. Architecture overview

```
 items + tasks (source of truth) ──► [builder: lib/timeline/build.ts] ──► work_timeline_cache (persisted, tier-scoped)
        │                                    │                                     │
        │                              task_evidence (edges)                       ├─► dashboard panel (one consumer)
        │                              slack_conversations (derived)               ├─► GET /api/v1/timeline (CLI + machines)
        └──────────────────────────────────────────────────────────────────────► └─► lib/query/retrieve structured context (LLM)
```

Three new pieces of persisted state (all single-writer-guarded, tier-inherited, regenerable):

- **`task_evidence`** — the edge table linking a `task` to the `items` that are evidence for it.
- **`work_timeline_cache`** — the assembled, per-team-per-tier day→person→(tasks+evidence+summary)
  payload, SWR-cached like `arc_cache`.
- **Slack enrichment** — structured per-participant authorship on the existing Slack `items` (via
  frontmatter `authors[]` + `participants[]`), plus an optional `slack_conversations` derived view.

One reader (`lib/timeline/read.ts`) + one API route feed all surfaces.

---

## 4. Part A — Ingest correctness fix (root cause of #1)

**Standalone, ships first.** Two changes in `lib/ingest`:

### A1. Only bump `tasks.updated_at` on rows that actually changed — with TWO distinct change sets
The critical correction (Fable B2): `materializeTasks`'s `changed` set drives **reactive PM
projection** (`lib/ingest/index.ts:442-444`), and `projectable-diff.ts:11-13` **deliberately
excludes** `due_date`/`body` (a due-date-only push must NOT trigger a provider write). So do **not**
widen `projectableChanged` — introduce a **second** predicate:
- `projectableChanged` — **unchanged**, still gates projection (title/status/sprint/priority/labels/
  parent/assignee).
- **`persistedChanged`** = `projectableChanged` ∪ {`due_date`} — gates `updated_at`. (`body` never
  travels the push contract — `lib/api/schemas.ts:20-21` — so it's excluded; it can't be diffed
  push-side anyway.)
- Set `updated_at = syncedAt` **only** when `persistedChanged`; otherwise **preserve the existing
  `updated_at`**. New rows (no snapshot) are changed by definition.
- **Also add `due_date` to the snapshot select** (`lib/ingest/index.ts:341` doesn't fetch it today,
  so the diff can't see it).
- Guard: a data-mechanics test that pushes a 3-row task file, re-pushes with **one** row edited, and
  asserts the other two rows' `updated_at` is unchanged (today all three bump).
- Writeback contract verified safe by review: `app/api/v1/tasks/route.ts:48-54` compares
  `updated_at > synced_at`; the item's `synced_at` bumps every push regardless, so a preserved
  (older) `updated_at` correctly keeps an untouched row out of the writeback feed. Keep that test.

### A2. Give tasks a real work-time — from STATE TRANSITIONS, not `updatedAt`
Persist a provider work-time so the timeline stops leaning on `updated_at`:
- Add nullable `tasks.worked_at timestamptz`. Define it as the provider's **state-transition** time —
  `max(startedAt, completedAt, canceledAt)` for Linear (all exposed on the issue) — **falling back to
  `updatedAt` only where the provider has nothing better**. Rationale (Fable H2): Linear's
  `updatedAt` bumps on *any* edit (a bulk relabel, a cycle rotation), which would resurface every
  dormant assigned ticket as "today's work" — the exact bug being fixed. State-transition timestamps
  give ~the `task_status_history` 80% with **zero new tables** (this resolves open question 1: no
  `task_status_history` in v1).
- **The Linear GraphQL query fetches no timestamps today** (`lib/ingest/sources/linear.ts:40-46`) —
  add `startedAt completedAt canceledAt updatedAt` to it, and thread the value through
  `linear-normalize.ts` / `plane-normalize.ts`.
- **`worked_at` must be serialized into the mirror row line** so the body sha churns when it changes
  (Fable H3) — otherwise an unchanged sha takes the fast-path (`index.ts:98`) and `worked_at` never
  reaches the DB. This sha churn is now **harmless because of A1** (an unchanged projectable row no
  longer bumps `updated_at`), which is why **A1 must land with or before A2** (PR-A bundles both).
- **Wire contract:** `worked_at` on the task row is a **brain-api.md v1.12** change (`taskRowSchema`,
  `lib/api/schemas.ts:10-28`) and needs a CLI change before *workspace-pushed* tasks carry it.
  Mirror-imported (Linear/Plane) tasks get it immediately; workspace-pushed tasks stay `worked_at`-
  null (timeline falls back to `updated_at`) until the CLI ships — a **long-lived**, not transitional,
  fallback (Fable L3).
- The timeline reads `worked_at ?? updated_at`, and prefers a real status transition or an in-window
  linked-evidence item (Part D) as the "worked on it in-window" signal.

### A3. `tasks.assigned_at` — power "newly assigned tasks"
Add nullable `tasks.assigned_at timestamptz`, set to `syncedAt` **only when the effective assignee
changes** (detected against the snapshot; a brand-new assigned row counts as a change), preserved
otherwise. This is the dedicated signal for the "newly assigned to me" case — distinct from
`worked_at` (did work) and `updated_at` (any edit). Clearing an assignee does not stamp it.

### Task display rules (the refinement the user asked for)
A task appears in a person's day **only** when there's a real in-window signal, in priority order:
1. **Newly assigned** — `assigned_at` in-window (to the current assignee) → shown in a distinct
   **"Newly assigned"** group, *even with no work evidence yet*. (`at = assigned_at`.)
2. **Worked** — `worked_at` (state transition) in-window → shown as worked. (`at = worked_at`.)
3. **Evidence-backed** — ≥1 linked evidence item in-window (Part D) → shown with its nested evidence.
4. **Old + none of the above → DROPPED.** "If the task is old and has no evidence against it, do not
   list it." This is the "spawning agents" fix.

Between PR-A and PR-D the evidence prong (3) isn't wired yet, so an old task with real work but no
`worked_at` transition and no evidence link is briefly hidden (Fable L2 — accepted transitional gap);
newly-assigned (1) and worked (2) cover the common cases immediately.

---

## 5. Part B — The persisted `work_timeline_cache` layer

Mirror the arcs cache pattern exactly (it's the proven SWR + empty-clobber design).

### Schema (`postgres/schema.sql` + migration)
```sql
create table if not exists work_timeline_cache (
  team_id     uuid not null references teams(id) on delete cascade,
  group_key   text not null,          -- sorted visibleGroupIds(tier), like arc_cache
  payload     jsonb not null,         -- TimelineDay[] incl. tasks, evidence, summaries
  window_days int  not null default 7,
  computed_at timestamptz not null default now(),
  primary key (team_id, group_key)
);
```
- **Sole writer** `lib/timeline/cache.ts` (single-writer guarded, like `lib/graph/arc-cache.ts`).
- **Tier-scoped by construction** — `group_key` = the caller's **`visibleGroupIds(teamSlug, tier)`**
  (note: takes the slug, `lib/graph/group.ts:32`), so an `external` viewer only ever reads/writes the
  external row (no cross-tier bleed, no RLS backstop). Fixed at `window_days = 7` for v1 — the
  `?window=` param is deferred, else it splits/clobbers the PK (Fable M1).
- **Carry the arc invariants (Fable M2):** stale-marking sets `computed_at` **just past the TTL,
  never epoch** (epoch re-creates the blank-panel bug, `arc-cache.ts:50-61`); `bustTeamTimeline`
  stales **all** group keys for the team (team-wide, like `staleArcCache`).
- **Regenerable** — safe to truncate.

### Builder (`lib/timeline/build.ts`, server-only)
Refactor today's `getWorkTimeline` fetch into a builder that returns the full enriched
`TimelineDay[]` (adds evidence links + summaries). Tier-gated through `visibleItems`/`visibleTasks`
(unchanged §5 choke-point). Reuses the pure grouping in `lib/dashboard/timeline-group.ts`.

### Reader + SWR (`lib/timeline/read.ts`)
`getTimeline(db, teamId, tier)`:
1. in-memory (short TTL, e.g. 5 min) → instant;
2. `work_timeline_cache` — fresh (< TTL) return; **stale return-now + fire-and-forget rebuild**
   (in-flight-deduped);
3. cold miss → build inline.
- **Empty-clobber guard**: a build that returns `[]` (transient LLM/DB blip) keeps the prior
  non-empty payload if younger than `TIMELINE_EMPTY_CLOBBER_MAX_AGE_MS` (reuse the arcs constant
  family + the NaN-guarded env parse).
- **Invalidation**: attribution corrections + identity remaps already call `bustTeamArcs`
  (`reconcile-attribution.ts`); add a sibling `bustTeamTimeline` so a re-attribution refreshes the
  timeline too. Ingest ticks mark it stale (don't rebuild inline — let the next view/SWR do it).

### Exposure — the whole point
- **API:** `GET /api/v1/timeline?window=7` (API-key + `X-AIOS-Team`, tier from the key) → the cached
  `TimelineDay[]`. Also add a session route `GET /api/dashboard/timeline` for the panel.
- **CLI:** `aios timeline` reads the v1 route (the members route already anticipates this,
  `app/api/v1/members/route.ts:16`).
- **LLM:** fold a compact form into `lib/query/retrieve.ts` structured context (gated by intent, like
  the activity digests) so "what did the team do this week / what did Dani work on" answers from the
  same layer.
- **Dashboard panel** becomes a thin consumer of `getTimeline` — no more view-local compute.

---

## 6. Part C — Per-person-per-day summary

- In the builder, after grouping, synthesize a **one-line, human-readable** summary per
  `PersonDay` via the shared settings-aware `completeTextOrNull` with `role: "reasoning"` (honors the
  team's answering/reasoning provider; never a hardcoded model — CLAUDE.md §6). Input = that person's
  evidence titles + linked tasks for the day; output = a grounded sentence
  ("Shipped the Timeline redesign (#340) and the per-person attribution drill-down; reviewed 2 PRs").
- Cached inside `work_timeline_cache.payload` (computed once per rebuild, not per page load).
- **Resilience**: summary failure is non-fatal — fall back to the count string; empty-clobber keeps
  the prior good summary.
- **Cost control**: only summarize days/people in the active window with ≥1 evidence item; skip empty
  people. Batch per day to bound LLM calls.
- **Tier**: external viewers get summaries built only from external-visible evidence (the builder
  already runs under their `group_key`).

---

## 7. Part D — Task ↔ evidence linking

### Data model — `task_evidence` (new, single-writer-guarded)
```sql
create table if not exists task_evidence (
  team_id     uuid not null references teams(id) on delete cascade,
  task_id     uuid not null references tasks(id) on delete cascade,
  item_id     uuid not null references items(id) on delete cascade,
  method      text not null check (method in ('issue_ref','pr_link','llm','manual')),
  confidence  real not null default 1.0,   -- deterministic = 1.0, llm = model score
  detail      text,                        -- e.g. the matched issue key / prompt rationale
  created_at  timestamptz not null default now(),
  primary key (team_id, task_id, item_id)
);
```
- Sole writer `lib/timeline/evidence-link.ts`. Tier is **inherited from the item** (`items.access`);
  reads re-apply the tier filter (no per-row column needed — join to `items.access`).
- An edge is regenerable; deterministic edges are recomputed each build, LLM edges cached with their
  confidence.

### Linking algorithm (deterministic-first, LLM-second — repo philosophy)
1. **Issue-ref extraction (`method='issue_ref'`, confidence 1.0):** the key set is **`tasks.row_key`**
   (Fable B1 — corrected). Mirror-imported Linear/Plane tasks store the **provider identifier** there
   (`linear-normalize.ts:130` → `row_key: it.identifier`, e.g. `AIO-123`); those tasks have **no
   `task_pm_links` row** at all. `task_pm_links.provider_external_id` holds the **brain's `row_key`**
   for *brain-projected* tasks (`lib/pm-sync/project.ts:168`), so it is NOT the issue key — use
   `provider_url` parsing only as the secondary source for that (smaller) class. Plane-projected tasks
   may be **LLM-only** in v1 (UUID URLs, no recoverable key). Anchor the regex to the **actual team
   `row_key` set** (not a generic `[A-Z]+-\d+`, which would false-match `SHA-256`/`UTF-8`). Scan each
   in-window evidence item's title + body for those keys — commit messages, PR titles, branch names,
   Notion/doc text, Slack text. Pure + unit-tested (`lib/timeline/issue-ref.ts`).
2. **PR ↔ issue links (`method='pr_link'`) — NOT available today; fast-follow.** Verified: the GitHub
   importer excludes PRs from the task import (`github-normalize.ts:13,30`), and `github_issues` has
   an `is_pull_request` flag but **no linked-issue field** (`schema.sql:1338-1356`). This method
   requires an importer change to capture the PR→issue link first — explicitly a later PR, not part of
   PR-D.
3. **LLM grouping (`method='llm'`, confidence = model score):** for each person×window, give the
   reasoning model their **active tasks** + the **still-unlinked** evidence and ask it to attach each
   evidence item to the best task or to "none". Closed JSON schema (like the attribution correction
   plan), scoped, capped. Deterministic links always win (never overwritten by a lower-confidence LLM
   guess). Reuse `lib/llm/complete` (`role:"reasoning"`).

**Scan scope (Fable L1):** bound the issue-ref scan to the already-fetched in-window evidence set
(≤ `ITEM_LIMIT` = 2000), never a full-table scan; `items.search` (a GIN tsvector) is available as a
SQL prefilter if it grows.

**Tier on reads (Fable M3):** a `task_evidence` read must filter **both sides** — the evidence via
`items.access` **and** the task via `visibleTasks` — because an external-visible item could link to a
`team`-audience task, and surfacing that task's title/status would leak. No RLS backstop, so this is
an explicit invariant with its own guard test.

### UI — nested task → evidence, plus the "Other" tab
Two tabs in the per-person day card (or a per-day toggle):
- **By task:** each linked task as a header line (title, status pill, source icon), and **indented
  underneath** its evidence items grouped by source — "GitHub ×3, Notion ×1, Slack ×2" — each a
  linked line with work-time. Matches the ASCII the user described:
  ```
  ▸ AIO-123  Provider-adapter interface            [in progress]
      GitHub   feat(ingest): provider adapter (#341)          05:34
      GitHub   refactor: dedupe run.ts orchestrators          04:12
      Notion   Provider-adapter design notes                  Jul 21
      Slack    #eng thread: "adapter vs registry?"            Jul 21
  ```
- **Other:** evidence with **no** linked task, grouped per person and **intelligently sub-grouped**
  (deterministic by source first; optionally an LLM topic label per cluster — "Docs & housekeeping",
  "Slack support"). This is the honest "loose work" bucket so nothing is dropped or force-fit.

### Edge cases
- Evidence links to a task **not** in-window → still show the task if any linked evidence is in-window
  (that's the work signal from Part A).
- One evidence item matches **multiple** tasks (e.g. a commit citing two keys) → allowed (edge per
  task); the item appears under each. De-dupe within a source group.
- A task with linked evidence but a stale `worked_at` → now correctly shows (evidence is the signal),
  fixing the inverse of the #1 bug.
- Issue key appears in prose but is unrelated (false positive) → confidence stays 1.0 for exact key
  match, but bound extraction to a strict key regex + word boundaries; LLM pass can demote obvious
  mismatches (kept simple in v1 — exact key match is high-precision).

---

## 8. Part E — Smart Slack ingestion

### E1. Structured per-participant authorship (ingest change)
Today `normalizeThread` (`slack-normalize.ts`) records only the **root** author. Change it to also
emit **structured** participant data — but keep repliers OUT of `authors[]` (Fable H4, load-bearing):
- Add a **`participants[]`** frontmatter key only: `{author_id, display_name, message_count,
  first_ts, last_ts}` per distinct message author. The **root stays the sole `authors[]` entry**
  (role `author`).
- **Why not put repliers in `authors[]`:** `resolveAuthors` picks the strongest-role ref that
  *resolves* (`resolve-authors.ts:180-188`), and `participant` is unranked (rank 50). For a thread
  rooted by an **unmapped/external** person, a resolvable replier would become the item's `member_id`
  — and the unchanged-repush heal (`index.ts:117-119`) would retroactively hand existing unattributed
  threads to whoever replied first. So participants are a **separate** structured signal; the timeline
  resolves them itself via the identity map (`lib/identity/resolve`). Item ownership is unchanged.
- **Dedup/sha (verified safe, Fable M6):** `content_sha256` covers body only
  (`slack-normalize.ts:62`), so adding `participants[]` creates **no** new versions; the frontmatter
  heal updates the stored value next tick. A new reply changes the body → new sha → new version, as
  today.
- Requires the Slack user map (already fetched, `slack.ts`); needs `users:read.email` for identity
  resolution (documented limitation, `slack-identity.ts:8-9`).

### E2. Conversation understanding
A Slack thread **is** a conversation. Add lightweight per-thread metadata during ingest or the
timeline build:
- `frontmatter.topic` — a short LLM one-liner ("debugging the projector 422") via `completeTextOrNull`
  (best-effort, cached by content sha so it's computed once). Skips trivial threads (< N messages).
  **Heal interaction (Fable M4):** `normalizeThread` is pure, so the topic is attached in the source
  runner — but the unchanged-repush heal *replaces* frontmatter (preserving only author keys,
  `index.ts:126-132`), so a tick where the runner skips the LLM (cache miss/outage) would wipe a
  stored topic. Mitigate by having the runner read the existing item's topic on an unchanged sha,
  and/or add `topic` to the heal's preserve-list.
- Optionally a derived **`slack_conversations`** view keyed by `(channel, thread_ts)` for direct
  query — but v1 can live entirely on the enriched `items` frontmatter (cheaper; no new table).
  **Decision for Fable:** table now, or defer until a query needs it? Leaning defer (frontmatter is
  enough for the timeline + retrieve).

### E3. Slack in the timeline
- **Stop excluding Slack.** In `work-timeline.ts` the `kind === "transcript"` exclusion currently
  drops Slack **and** meetings together. Split them: keep meetings (granola) excluded as team signal;
  **include Slack**, but attribute per **participant** (from E1), not just the thread root. So a
  person who contributed 4 messages to a thread they didn't start still sees that conversation in
  their day.
- Slack evidence rows carry the conversation topic as the title, the channel as detail, and the
  person's **own** last-message time in-window as `at`.
- Per-person summary (Part C) now naturally includes "active in #eng on the projector-422 thread".
- **Edge cases:** a person who only *reacted* (no message) → not a contributor (v1); a huge channel
  backfill → bound by the same window + `ITEM_LIMIT`; DMs/private channels → tier `access` already
  governs (Slack items are `team`); a bot/connector author → excluded via `is_connector`.

---

## 9. Data-model & migration summary

| Change | File | Kind |
|---|---|---|
| `tasks.worked_at timestamptz` (nullable) | `schema.sql` + migration | additive column |
| Gate `tasks.updated_at` on real change | `lib/ingest/index.ts` | logic |
| `task_evidence` table | `schema.sql` + migration | new table |
| `work_timeline_cache` table | `schema.sql` + migration | new table (regenerable) |
| Slack `authors[]` + `participants[]` + `topic` in frontmatter | `slack-normalize.ts` | payload shape (no schema) |
| (optional) `slack_conversations` view | deferred | — |

All additive; from-zero via `schema.sql`, existing DBs via `postgres/migrations/` (CLAUDE.md schema
rules). New enumerable surfaces (the `/api/v1/timeline` route, the two new tables) must update the
`drift:*` blocks + `docs/ARCHITECTURE.md` in the same PR (the architecture-map build loop).

**Contract obligations (Fable H1 — do not skip):** `tasks.worked_at` on the task row and the new
`GET /api/v1/timeline` route are **brain-api.md contract changes** (bump to **v1.12**), not just
drift/ARCHITECTURE edits — `taskRowSchema` (`lib/api/schemas.ts:10-28`) is the wire format the CLI
pushes. PR-A adds `worked_at` to the task-row contract (workspace-pushed tasks stay null until the
CLI ships); PR-B documents the timeline route. This is the standing sync-contract rule
(brain ⇄ `aios-workspace`).

---

## 10. Tier / security

- Every read stays behind `visibleItems`/`visibleTasks`/`visibleGroupIds` (no new bypass).
- `work_timeline_cache` + summaries are tier-scoped by `group_key`; `task_evidence` re-applies the
  tier filter by joining `items.access`. External viewers never see team evidence, tasks, Slack
  topics, or summaries.
- New API route mirrors existing v1 auth (Bearer key + team header, tier from key); external keys get
  the external-only payload.
- Slack `source_url`/topic sanitized (`httpUrl`, no `javascript:`), summaries are model output over
  already-tier-filtered evidence.
- Guards: extend `test/guards/dashboard-tier-filter` coverage to the timeline reader; a data-mechanics
  test proving an `external` viewer gets no team task/evidence/Slack rows.

---

## 11. Tests (spec-first, per CLAUDE.md §4)

- **unit:** issue-ref extraction (key regex, word boundaries, multi-key); timeline grouping already
  covered; per-day summary input shaping; Slack participant parsing.
- **data-mechanics (real Postgres):** A1 selective `updated_at` bump; `task_evidence` write→read;
  timeline cache SWR + empty-clobber (empty build keeps prior); tier isolation (external gets nothing
  team-tier); Slack per-participant attribution.
- **integration/http:** `GET /api/v1/timeline` routing/auth/tier-422/wire shape; `aios timeline`
  end-to-end in `e2e.sh`.
- Any confirmed-but-unfixed gap uses `it.fails(...)` until fixed.

---

## 12. Sequencing (small, reviewable PRs)

1. **PR-A — correctness (root cause):** A1 selective `updated_at` + A2 `tasks.worked_at`; timeline
   reads the real work-time; drop dormant tasks without in-window signal. _Standalone; fixes the
   "spawning agents" bug immediately._
2. **PR-B — context layer:** `work_timeline_cache` + `lib/timeline/{build,read,cache}.ts` + SWR/
   empty-clobber + `GET /api/v1/timeline` + panel becomes a consumer + `retrieve` structured-context
   fold + `bustTeamTimeline`.
3. **PR-C — summaries:** per-person-per-day LLM summary in the builder/cache.
4. **PR-D — evidence linking:** `task_evidence` + issue-ref (+ PR-link) + LLM grouping + nested
   task→evidence UI + "Other" tab.
5. **PR-E — smart Slack:** structured participants + conversation topic + include Slack per
   participant in the timeline.

Each PR: spec-first tests, architecture-map update, local Fable review before push (CLAUDE.md gate).

---

## 13. Open questions

**Resolved by the Fable review:**
1. **Work-time source (A2):** ~~`worked_at` vs `task_status_history`~~ → **`worked_at` from provider
   state-transition timestamps** (`startedAt`/`completedAt`), no new history table in v1 (Fable H2).
3. **Slack conversation table:** ~~table vs frontmatter~~ → **defer the table**; live on `items`
   frontmatter for v1 (cheaper; the timeline + retrieve don't need a join).

**Still open:**
2. **Evidence-link confidence:** exact issue-key match auto-nests (confidence 1.0); LLM links flagged
   as "suggested"? (Leaning yes.)
4. **LLM cost:** summaries + evidence grouping are O(people × days) calls per rebuild. Acceptable
   behind SWR (only for viewed teams) + windowing + skip-empty-people? Cheaper reasoning model for
   this path?
5. **"Other" sub-grouping:** deterministic-by-source only, or an LLM topic label per cluster?
6. Should the timeline layer also power the home-page **"Working On" box** (`team-work-live.ts`),
   collapsing two near-identical reads into one layer?
7. **Transitional regression (Fable L2):** between PR-A and PR-D, a task with real current work but a
   stale `worked_at` and no evidence-link prong yet will drop from the timeline. Accept as a known,
   short-lived gap, or reorder D before the dormant-task drop?
