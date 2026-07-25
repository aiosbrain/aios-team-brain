# Attributing documents to the task they belong to (LLM assignment)

**Status:** design v2 (pre-build). v1 proposed a GitHub-file work-time change as a prerequisite; **measuring
prod killed that** — see "What I got wrong". **Ask:** "when attributing different types of documents to
different Linear tasks, you're going to need to do an LLM-based assignment by looking at the content of the
document to see which Linear tasks are assigned to the person, and which doc is most appropriate or none at
all."

## Measured reality (prod, AIOS team, read-only)

Non-git, non-GitHub WORK items attributed to a member, last 30 days, by source — and whether they carry a
**work-time** (the timeline builder drops items without one, `lib/dashboard/timeline-group.ts:197`):

| source | kind | count | has work-time |
|---|---|---|---|
| **`(none)` — CLI-pushed markdown** | deliverable | **78** | **72** |
| `(none)` | artifact / skill | 39 | 2 |
| linear | deliverable | 373 | 0 |
| plane | deliverable | 43 | 0 |
| granola / tweet | deliverable | 5 | 5 |

**Corpus (a) — CLI daily-loop docs.** The `(none)`-source deliverables pushed through the aios CLI
(`2-work/…`, `1-inbox/…`): 127 items all-time, **127 of 127 attributed**, 76 with a work-time. They carry no
issue key in title or path, so they land in the "Other" bucket. ~18/week. **Live today, nothing to unblock.**
Attribution is normally the pusher — with exceptions, which is why the pass must read the item's resolved
credit (the shared attribution oracle), never assume "pusher = author".

**Corpus (b) — Notion + Google Docs. Supported, but NOT CONNECTED — zero items from either.**
`notion` and `gdrive` are first-class ingestion sources (ARCHITECTURE `drift:sources`) with Python
connectors (`ingestion/aios_ingest/sources/{notion,gdrive}.py`), but prod has **0 rows** from both, and the
team's enabled integrations are only `github · linear · slack · openai · openrouter`. So the half of the ask
about Notion/GDoc association **has no data to act on yet**. Two separate prerequisites, neither of which
blocks building the pass itself:

1. **Connect the two connectors** (ops/config). Note `integrations.type`'s CHECK
   (`postgres/schema.sql:1618`) allows `google` but has **no `notion`** value — confirm where Notion
   credentials are meant to live before wiring it.
2. **Google Drive has no owner enrichment.** Notion's already exists and is exactly the "owners of the doc"
   signal — `ingestion/aios_ingest/sources/notion_authors.py` maps `created_by` → role `author` and
   `last_edited_by` → role `editor` into the structured `authors[]` that `lib/attribution/resolve-authors`
   resolves to a roster member (bots excluded). `gdrive.py` is a 50-line llama-index wrapper with **no
   equivalent**, so a Drive doc arrives ownerless. A `gdrive_authors` pass mirroring the Notion one
   (Drive API `owners` / `lastModifyingUser`) is needed before Drive docs can be attributed at all.

**Design consequence: the pass must be SOURCE-AGNOSTIC** — it scores any attributed WORK doc that has a
work-time and no deterministic link, at the shared layer. CLI docs exercise it today; Notion and Drive docs
flow through the identical path the moment their connectors are on, with no second implementation. (This is
the "lowest shared layer, every surface reads it identically" rule applied to ingestion sources.)

The Linear/Plane "deliverables" (416 rows, zero work-times) are **PM mirrors**, not authored documents —
correctly out of scope.

## What I got wrong (recorded so it isn't re-derived)

v1 of this design claimed the LLM pass had only ~3 documents/week to chew on, and that persisting the
last-commit date onto **GitHub repo files** (410 rows with no timestamp at all) was a required Part 1.
Two further measurements refuted it:

1. **Both ingested repos already have their commits scanned** — 89 (`aios-team-brain`) + 32
   (`aios-workspace`) commit items in 7 days. Every in-window repo-file edit is therefore **already on the
   timeline as its commit**. Adding the file as a second evidence row would double-count the same edit
   against `total` (which is uncapped and drives person ordering + the Home "Working on" pin), and both
   normalize to source `"github"`, so docs and commits would compete for the same 6 display slots.
2. **The 3/week figure was an artifact of a 7-day window over a mostly-older corpus.** Over 30 days the
   CLI-pushed deliverables number 78, with 72 already timeline-eligible.

Fable's design review of v1 also found a real HIGH in that Part 1 — the ingest frontmatter heal's
preserve-list (`lib/ingest/index.ts:160`) covers only `author`/`author_email`/`author_login`, so a
transient GitHub commits-lookup failure (`github-files.ts:53,61-63` returns `undefined` on ANY error) would
have **wiped** a previously-stamped date and flickered items off the timeline. Dropping that part removes
the hazard entirely. **Recorded as a separate, lower-value follow-up** — if it is ever built it needs the
preserve-list fix, a same-sha collapse against the commit leg, and the author-vs-committer-date decision.

## Design — the LLM assignment pass

For each in-window WORK doc that has **no deterministic link**, a background pass reads the doc and a
candidate task list and returns the best match **or none**.

**The store already exists — no migration.** `task_evidence` (`postgres/schema.sql:1095-1106`) was built
for this: `method text check (method in ('issue_ref','llm','manual'))`, `confidence real` ("llm = the
model's score"), `detail text` ("reserved: the matched key / LLM rationale"). The existing writer's prune is
scoped `.eq("method","issue_ref")` (`lib/dashboard/timeline-evidence.ts:64`, "Leaves `llm`/`manual` edges
untouched") — a pre-built escape hatch so the two writers can't clobber each other.

**But the table has ZERO readers today.** It is written off the ingest scheduler and consumed by nothing;
the timeline computes links **inline**. So this feature must also add the **first read path**.

### Rules

- **Deterministic always wins.** An item with an own-text issue key — or, for a commit, the PR-inherited
  task from #377 — is never sent to the model. Precedence becomes `own text > PR > inferred > chip > Other`,
  slotting in at `work-timeline.ts:419`↔`:423`. Enforced in the **writer**, not the DB: the PK is
  `(team_id, task_id, item_id)` and `method` is **not** in it, so an `llm` row and an `issue_ref` row for
  the same pair collide with last-writer-wins.
- **"None" is a first-class, expected answer.** The system prompt states an unforced no-match is the normal
  outcome. The failure mode to design against is a model that always picks something.
- **Confidence gate.** Below threshold the row is still written (the audit trail of what the model thought)
  but is **not** used as a link. One constant, one place.
- **Candidates: the person's assigned active tasks first, but not hard-restricted.** `taskInfo` is the
  **team-wide** active set — the timeline has no assignee filter by design (a task is placed under the
  *evidence author*, not its assignee, `work-timeline.ts:48-49`), and prod assignee strings are messy
  (`Chetan`/`chetan.nandakumar`, `John Ellison`/`john`/`John`). Hard-scoping on those strings would silently
  drop the real case of a doc about a teammate's ticket. Resolve through the identity mapping, rank the
  person's own tasks first, and let the model still answer "none".
- **Tier (no RLS — app code is the only enforcement).** Candidates come only from maps fetched through the
  **`visibleTasks`** choke-point; an inferred `task_id` outside `taskInfo`/`chipInfo` links nothing,
  silently (`work-timeline.ts:407-408`). **`access='external'` items are never scored** — untrusted client
  frontmatter must never drive an actionable link, consistent with the attribution work. Note
  `visibleTasks("team")` is a passthrough (`lib/auth/visibility.ts:56`), so the real protection is
  **read-time re-gating**: every future `task_evidence` reader must re-apply both filters. `detail` will
  quote team doc content and inherits the same rule — never surfaced on a tier-ungated view.
- **Provenance is visible.** `linkVia` gains `"inferred"` (`timeline-group.ts:42`; the grouper at `:289`
  already copies the field, so this is a type-only widening) → bump `PAYLOAD_VERSION`
  (`timeline-cache.ts:36`, currently 5) and note the additive `GET /api/v1/timeline` change.
- **Bounded + metered**, copying the arcs evidence-coherence pass (`lib/graph/arcs.ts:539-568`) — the same
  feature with the polarity inverted, and the house pattern: **one batched call** with short synthetic ids,
  `jsonObject: true`, a closed output contract, a conservative prompt, `maxTokens`/`timeoutMs` caps, and a
  total no-op when the model returns null. Runs on the **ingest scheduler** (`lib/ingest/scheduler.ts` —
  `runTaskEvidenceLinking` at :253 is the sibling; `runMeetingNotesBackfill` at :211 is the per-team LLM-leg
  template). Never on a request path. Gate on the pure exported **`llmConfigured(keys)`**
  (`timeline-summary.ts:33-35`) so an unconfigured team — including every test team — spends nothing. Reuse
  an existing `LlmUsageSource` slice rather than widening that closed union (as the coherence pass reuses
  `"arcs"`). Prompt-injection defense verbatim from `timeline-summary.ts:19-24`: doc and task titles are
  DATA, never instructions.
- **Body fetch is new.** Neither the writer (`timeline-evidence.ts:25-26`) nor the builder
  (`work-timeline.ts:43-44`) pulls doc bodies — deliberately, they are large. This pass needs its own
  bounded, head-truncated body read.
- **Idempotent.** Hash the inputs that determine the output — doc **`content_sha256`** (not id, so an edited
  doc re-scores), the candidate set, **and the system prompt itself** — and skip when unchanged; the
  `arc_cache` facts-hash rule (`lib/graph/arcs.ts:588-595, 691-711`), whose key deliberately covers the
  prompt so a deploy that edits it re-runs instead of serving stale judgments. Must tolerate re-scoring a
  pair the deterministic writer previously upgraded to `issue_ref` and later pruned.

## Verification
- **unit (pure):** below-threshold → no link; explicit no-match → no link; deterministic present → never
  queried; inferred task outside the visible set → no link; the idempotency hash changes when the doc
  content, the candidate set, or the prompt changes.
- **data-mechanics (real Postgres):** an `llm` row never overrides an `issue_ref` row; a high-confidence
  inferred link nests the doc under its task and is marked `inferred`; **tier isolation** — an external
  viewer never receives a team task via an inferred link (non-vacuous: the team viewer does); an
  `access='external'` item is never scored. The model is stubbed in both tiers.

## Build-loop checklist (§1)
- `docs/ARCHITECTURE.md`: Timeline linkage prose (inferred links + `task_evidence.method='llm'` + the new
  read path), same PR.
- **No schema change** — `task_evidence` already carries `method`/`confidence`/`detail`. Any future CHECK
  widening (e.g. the `pr_link` value the original design named but the shipped schema dropped) must satisfy
  `test/guards/enum-check-replay.test.ts` — identical complete value set in every definition (#251).
- Second writer for `task_evidence` → add the missing **`single-writer-task-evidence` guard** (the repo has
  ~20 `single-writer-*` guards; this table has none).
- Inferred links become viewer-visible → add `task_evidence` to `bustTeamLearningCaches`
  (`lib/ingest/reconcile-attribution.ts:20-27`), which evicts arcs + timeline but not this table.

## Status of the Notion half (shipped separately)
Notion credentials now have a home: **PR #384** adds `notion` to `integrations.type` (+ the config schema
and the Admin → Integrations form), so the existing connector finally has a token to read. Google Drive is
deliberately excluded — see below.

## Prerequisites for the Notion/GDoc half (separate work, tracked here so it isn't lost)
1. Connect the **Notion** and **Google Drive** connectors (and settle where Notion credentials live —
   `integrations.type` has `google` but no `notion`).
2. Build **`gdrive_authors`** mirroring `notion_authors.py`, so a Drive doc carries its owners
   (`owners`/`lastModifyingUser` → `authors[]`) and can be attributed at all. Without it a Drive doc is
   ownerless and this pass will never see it (it only scores attributed items).

## Out of scope
- GitHub repo files as timeline evidence (see "What I got wrong") — a separate, lower-value follow-up that
  must not ship without the heal preserve-list fix and a same-sha collapse.
- Inferring links for **commits** — the deterministic key plus #377's PR inheritance already cover them.
- Linear/Plane mirror "deliverables" — PM rows, not authored documents.
- Changing the active-only nesting rule; `KEY_RE` junk-key tightening.
