# Repo import: choose the history window, priced before anything runs

**Status:** revised after plan review — 3 blockers, all mine · **Date:** 2026-08-04 · **Owner:** Chetan
· **Task:** `REPOIMP-1` → [AIO-798](https://linear.app/je4light/issue/AIO-798)

## The problem

Linking a GitHub repo today imports on the next tick with no forewarning of scope or cost, and the
scope is hardcoded three different ways (`lib/ingest/run.ts:591-628`):

- **markdown files** — the current tree snapshot, `*.md`/`*.mdx` ≤800KB (`sources/github-files.ts:14-17`);
- **issues** — `state=all`, i.e. the repo's ENTIRE issue history (`sources/github.ts:46`);
- **commits** — a 90-day contribution window hardcoded by default (`lib/codebases/github-api-scan.ts:207`).

Imported markdown and issues become graph episodes, so linking a repo is a spend decision made
blind. The graph bill is per-episode and now measured (~$0.017/episode after #452/#485/#488/#490),
so the price is knowable **at link time** — nobody should discover it on the Costs page afterwards.

## What plan review corrected (3 blockers, each would have shipped broken)

1. **A sliding window mass-deletes imported issues.** My draft stored only `days` per repo, so the
   importer would compute `since = now − days` every tick. Issues are ONE diff-synced item per repo
   (`github-normalize.ts`), and `lib/ingest/tasks.ts:229-232` deletes any synced task absent from
   the incoming payload — so as issues aged out of the sliding fetch they would be **diff-deleted
   from the brain**, tick after tick, while the ever-changing body re-projected up to 16 episodes
   per repo per tick. The window must be **anchored**: the absolute `sinceIso` is resolved once at
   link time and stored. An anchored fetch grows monotonically (`updated_at` never decreases), so
   diff-sync stays safe exactly as today.
2. **Commits create no episodes, so pricing them was fiction.** `ingestGithubApiScan` writes only
   `codebases` + `code_contributions` aggregates — no items, no LLM calls. (`commits-to-items` runs
   only on the CLI-scanner path, which this feature doesn't touch.) My estimate charged dollars for
   a fetch that costs ~nothing. The commit window is **contributor-graph scope, priced at $0** and
   labelled that way.
3. **The persistence shape couldn't save.** `config.repoHistory: Record<full_name, days>` fails
   `upsertIntegration` twice: the github config schema is a `.strict()` allowlist
   (`lib/api/schemas.ts:594-604`) that rejects unknown keys, and the secret-key scan walks **nested
   object keys** (`schemas.ts:655-688`) — so linking any repo named like `acme/token-service` would
   make the whole config unsavable with a misleading "secret-like key" error. The shape must be an
   **array of objects** (keys `repo`/`days`/`sinceIso` are scan-safe) plus an explicit allowlist
   extension.

## What this builds

At **Admin → Integrations → GitHub repositories**, adding a repo becomes a two-step flow — for the
typed input AND the one-click scan-suggestion chips (both paths route through the estimate; a chip
is exactly the blind-spend path this feature exists to close):

1. Pick `owner/repo` → the panel shows an **estimate**: md files → episodes and a **dollar figure**
   priced from this team's own extraction ledger, plus — per selectable **history window** (none /
   2 weeks / 30 days / 90 days) — the issue count in that window (adds episodes) and the commit
   count (contributor graphs, $0).
2. The admin picks the window and confirms. The choice persists per repo, anchored, and the
   importer honours it.

Nothing is fetched into the brain until step 2. The estimate is ~3 GitHub API metadata calls, no
file contents.

## Design

### The estimator — `lib/integrations/github-estimate.ts`

`estimateGithubImport({ owner, repo, token, historyDays })`, called by an admin-gated server action:

- **Files:** `GET /repos/{o}/{r}/git/trees/{default_branch}?recursive=1` — every blob's path + byte
  size in one call. Filter by the importer's own globs (`DEFAULT_FILE_GLOBS` / `config.fileGlobs`),
  drop >800KB blobs (the importer's own skip), then
  `episodes(file) = min(ceil(bytes / CHUNK_CHARS), MAX_EPISODE_CHUNKS)`.
  **Chunk constants are imported from `lib/graph/project.ts`**, never re-declared, so the estimator
  cannot drift from what the projector does. (Bytes ≈ chars for markdown; labelled an estimate.)
  A `"truncated": true` tree (~100k entries) → the estimate reports `atLeast: true` and the UI says
  "at least N" — never a silently-low number.
- **Issues in window:** `GET /search/issues?q=repo:{o}/{r}+type:issue+updated:>={date}&per_page=1`
  → `total_count`. The Search API **excludes pull requests**, which the plain `/issues` endpoint
  counts and the importer then drops (`github-normalize.ts` filters PRs) — a plain-endpoint count
  would run 2–4× hot on active repos and blow the acceptance band by itself. One call; Search's
  30-req/min authenticated limit is irrelevant at one call per estimate.
  Issue rows land in one diff-synced item, so their episode estimate is
  `min(ceil(count / ISSUES_PER_EPISODE_EST), MAX_EPISODE_CHUNKS)` — a named constant, an honest
  floor, labelled as such.
- **Commits in window:** `GET /repos/{o}/{r}/commits?since=<window>&per_page=1` — the `Link`
  header's `rel="last"` page number is the count (no `rel="last"` → the count is the returned page's
  length, not zero). Shown as "N commits → contributor graphs · no extraction cost".
- **Unreachable repo (no PAT + private, or a fine-grained PAT not scoped to it):** the estimate
  step surfaces the existing `RepoAccessState` vocabulary (`github-validate.checkRepoAccess`, the
  single-repo primitive — `checkGithubAccess` is the linked-repos server action) —
  a `no_access` badge, estimate marked unavailable, and the admin may still link (today's
  behaviour) with the copy "cost unknown until access works". Estimating token-free burns the
  shared-IP 60/hr unauthenticated limit, so the action prefers the stored PAT and says when it had
  none.

### The price — reusing the cost dashboard's own reader

`episodes × costPerEpisode`, from **`getGraphEfficiency(db, teamId, "30d", viewer)`**
(`lib/metrics/graph-efficiency.ts` — the calls-per-episode panel's module): its whole-window
`costPerEpisode` is "what this install actually pays per episode", on its actual model, measured
from `llm_usage` + `ingest_runs.meta.episodes`. `"30d"` because that is a real `Range`
(`lib/metrics/range.ts` — there is no 14d; my draft cited one). No second pricing path, no drift
from the Costs page.

- `costPerEpisode === null`: episodes shown, price withheld — "no local price history yet". This is
  also what a non-admin viewer gets (the metric is admin-gated internally); the action's own
  `requireAdmin` makes that unreachable, but the estimator treats null as "unpriceable", never
  "free". **Never a fabricated dollar figure.**
- **In-scope metric change:** `GraphEfficiency` gains a `truncated` flag (its `ingest_runs` fetch
  currently caps at 20,000 rows **silently** — the cap binds in exactly the degraded regime where
  the price understates). The estimator withholds the price when set, the same
  show-nothing-over-wrong rule #471's review forced on the panel. Small: cap+1 detection on the
  existing fetch, mirrored in the panel.

### Persistence — per-repo, anchored

`config.repoHistory: Array<{ repo: string; days: number; sinceIso: string }>` on the canonical
github integration row, written through the existing single-writer (`github-link.writeRepos`
pattern → `upsertIntegration`), **with the github config allowlist extended** to accept it
(`lib/api/schemas.ts` — `.strict()` rejects unknown keys; this is a required schema edit, not an
incidental one). `sinceIso` is resolved once at link (`now − days`, date precision) and never
recomputed. `config.repos` stays `string[]` — every existing reader keeps working.

- **No entry = today's behaviour** (issues: all, commits: 90d), and the schema keeps `repoHistory`
  **`.optional()`, never defaulted** — an absent key stays absent, so legacy rows are byte-identical
  and the existing `validateIntegrationConfig("github", {})` pin stays green. Post-ship the default
  applies to exactly two populations: repos linked before the feature, and repos added by any path
  that edits `config.repos` outside the panel. The linked-repos list shows each repo's window, with
  legacy repos labelled "full history (linked before windows)" — the most expensive default in the
  system must not be the one invisible in the UI.
- **Re-linking a previously imported repo with a narrower window is destructive**, and the flow says
  so: unlink never purged items/tasks (`github-link` edits config only), so a re-link's first
  windowed fetch diff-deletes every previously imported task outside the window. The estimate step
  warns with the count ("a 2-week window will remove N previously imported tasks") when the target
  project already holds tasks.
- Entries are pruned when a repo is unlinked, and capped (one entry per linked repo, repos already
  cap at 200). Date-precision `sinceIso` keeps the worst-case config comfortably under the 8KB
  config byte cap (`schemas.ts:657`); the cap failure, if ever hit, is `upsertIntegration`'s
  existing clear error.

### The importer honours the anchor

In `lib/ingest/run.ts`'s github leg, per repo with an entry:

- `fetchGithubRepoIssues({ …, sinceIso })` — new optional param → the API's `since=` **alongside
  the existing `state=all`** (closing an issue bumps `updated_at`, so closed-in-window issues import
  only because both params are kept). Absent entry → today's unbounded fetch. Anchored, so the
  fetched set only grows — no diff-delete, no churn re-projection. (An issue deleted/transferred on
  GitHub's side still diff-deletes — that is the documented source-mirroring intent in
  `github-normalize.ts:11-12`, identical to today's behaviour, and deliberately not floored.)
- `ingestGithubApiScan({ …, windowDays: days })` — the param exists (`github-api-scan.ts:205`);
  today no caller passes it. **The scan call is never skipped** (plan-review position, adopted):
  it costs no LLM money and it upserts the repo's `codebases` identity row, which "contributor
  graphs fill from future syncs" depends on. `days = 0` passes `windowDays: 0` explicitly — the
  destructuring default only applies to `undefined`, so 0 → `since = now` → empty backfill, row
  still created. Exactly "no history".
- Files are a current-state snapshot — the window does not apply, and the UI copy says so ("Docs
  are imported as they are now; the window applies to issues and commit history").

`days = 0` ("no history"): files yes, issues since link time, zero commit backfill. The repo still
syncs *forward* — history is about the past, not ongoing sync.

### UI copy: the figure is the initial import

Issue churn after link re-projects the issues item (chunk-delta bounds this, but it is not zero).
The estimate is labelled "initial import ≈ $X"; ongoing sync lands on the Costs page like every
other source. Without this label, normal churn reads as "the estimate was wrong".

## What this deliberately does not do

- **No graph-scope picker** (import files but keep them out of the graph). Real lever, separate
  decision — the L1 call in the cost strategy, not this UI.
- **No estimate/actual reconciliation surface.** The Costs page shows actuals; a reconciliation can
  cite this doc later.

## Guards (CLAUDE.md §7)

- **Estimator math pure + unit-tested** against recorded tree/Link/Search fixtures — the 800KB
  skip, the 16-chunk cap, `atLeast` on truncated trees, a Link header with no `rel="last"`.
- **Live coupling, not literal-grep:** a test overrides `GRAPH_CHUNK_CHARS` (the constants are
  env-resolved) and asserts the estimate **moves accordingly** — proving the import is load-bearing,
  which a "no numeric literal in the file" grep cannot (my draft's version was near-vacuous:
  `ISSUES_PER_EPISODE_EST` is itself a numeric literal).
- **Call site pinned:** the github import leg threads the anchor into BOTH `fetchGithubRepoIssues`
  and `ingestGithubApiScan` — deleting either argument turns a test red while every estimator test
  stays green.
- **Existing-behaviour pin:** a repo with no entry imports exactly as today, asserted on the same
  seam.
- **Anchor immutability:** re-running the importer never rewrites `sinceIso` — pinned, because a
  recomputed anchor IS the sliding-window bug coming back.
- **Admin gate** on the estimate action (it reads the stored PAT).

## Surfaces to update in the same PR

`docs/ARCHITECTURE.md` GitHub-import row; the repos panel help text; the github config schema
allowlist. No new tables, routes, or ingestion sources → no drift-block changes; the guard run
confirms.

## How we will know it worked

Linking the next real repo shows "initial import ≈ N episodes ≈ $X at your current model" with a
window choice before anything imports, on both link paths — and the Costs page's actuals for that
import land within ±30% of the figure (achievable now that PRs are out of the issue count and
commits are not priced).
