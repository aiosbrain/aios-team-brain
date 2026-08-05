# "No history" must not mean "no commits, ever"

**Status:** revised after Fable plan review — 1 HIGH, 2 MEDIUM, 3 LOW, all mine · **Date:** 2026-08-05 · **Owner:** Chetan
· **Task:** `REPOIMP-2` → [AIO-807](https://linear.app/je4light/issue/AIO-807)
· **Follows:** [AIO-798](https://linear.app/je4light/issue/AIO-798) (`repo-import-history-estimate.md`)

## The problem

AIO-798 gave each linked repo a history window chosen at link time. The window reaches the two
windowed fetches by two different routes, and only one of them survives the next tick:

| leg | how the window is applied | at `days: 0` |
|---|---|---|
| issues (`fetchGithubRepoIssues`) | the **stored anchor**, read back verbatim (`run.ts:597`) | nothing before link, **everything after** ✅ |
| commits (`ingestGithubApiScan`) | **`days`**, re-resolved to `now − days·86_400_000` on every tick (`github-api-scan.ts:229`) | `since = now`, every tick ❌ |

At `days: 0` — the panel's **"No history"** chip (`github-repos-panel.tsx:46`) — the commit scan asks
GitHub for commits since *this instant*, every hour, forever. A commit pushed between two scheduler
runs is newer than run N's cutoff and older than run N+1's, so it is never fetched by either. The
repo's `code_contributions` stay permanently empty while `ingestGithubApiScan` keeps upserting the
`codebases` identity row, so the repo appears on the Codebases page with no contributors and nothing
reports an error.

This is not the reading the feature intended. `run.ts:634-636` already says so in a comment:

> `windowDays`: an explicit 0 empties the backfill while STILL upserting the codebase identity row …
> **"no history" must never mean "no contributor graphs ever"**.

The comment states the intent; the argument beneath it doesn't deliver it. Commits are also priced at
**$0** in the estimator (they create no episodes — AIO-798's own plan-review finding #2), so there is
no cost argument for the permanent-off reading either.

**Scope of the defect: `days === 0` only.** At `days: 90` (and the no-entry default) the sliding
window is fine — each tick re-fetches the last 90 days, `code_contributions` upserts are idempotent,
and rows already written are never deleted. A fix that "makes commits anchored like issues" without
noticing this would replace a bounded per-tick fetch with an unbounded one on every legacy repo.

## The decision

Resolve the commit-scan cutoff from the **stored anchor, floored at the repo's own window**:

```
commitSinceIso(history, now) =
  W      = max(history?.days ?? 90, 90) days
  floor  = now − W
  anchor = Date.parse(history.sinceIso)

  history === null                    →  floor        // legacy repos: byte-identical to today
  anchor unparseable OR anchor > now  →  floor        // unusable data degrades to the window
  otherwise                           →  later_of(anchor, floor)
```

`later_of` is what makes this bounded rather than merely correct. `now − W` increases monotonically,
so the rule tracks the anchor exactly while the anchor is recent (which is when honouring the admin's
choice actually matters) and degrades to a sliding window of the repo's own width once the link is old
enough that the anchor would ask for an unbounded page walk. It can never widen past the anchor, so a
repo linked with "2 weeks" never retro-imports commits from before its window.

**`W = max(days, 90)`, not a flat 90** (plan-review HIGH — this would have shipped broken). The panel
offers 0/14/30/90, but the write path does not cap there: the server action and the config schema both
accept `days` up to **3650** (`actions.ts:261`, `schemas.ts:615`), and the estimator quotes the admin a
commit count over the *full* window (`github-estimate.ts:130`). A flat-90 floor would silently truncate
a 365-day link to 90 days **on its very first sync**, after quoting the 365-day number. Deriving the
floor from the repo's own `days` keeps the quote honest and stays bounded (the walk is capped by
`maxPages` regardless).

**A future or unparseable anchor falls through to the floor** (plan-review MEDIUM). `resolveRepoHistory`
type-checks `sinceIso` as a string but never as a *past* instant, and the schema accepts any datetime —
so clock skew at link time or any non-panel config write can store an anchor in 2030, and `since` in
the future makes GitHub return `[]` forever: the exact silent-empty failure this spec exists to kill,
reintroduced by the fix. Note the fallback is the **floor**, not `now`: clamping a future anchor to
`now` would rebuild the `days: 0` bug one tick at a time. Unparseable takes the same path rather than
propagating `NaN` through a comparison.

What each case yields:

| history | age of link | `since` | why it's right |
|---|---|---|---|
| none | — | `now − 90d` | unchanged legacy behaviour |
| `days: 0` | 1 hour | the anchor (link time) | no backfill, and the gap between ticks is covered |
| `days: 0` | 200 days | `now − 90d` | ⊇ everything since the previous tick; bounded work |
| `days: 14` | 5 days | the anchor (link − 14d) | exactly the chosen window |
| `days: 14` | 200 days | `now − 90d` | later than link − 14d, so it never widens the choice |
| `days: 365` | 1 hour | `now − 365d` (the floor, an hour after the anchor) | the 365-day backfill the estimate quoted actually happens; a flat-90 floor would have cut it to 90 |
| `days: 365` | 500 days | `now − 365d` | floors at the repo's own width, not a flat 90 |
| anchor in the future / unparseable | any | `now − W` | a future `since` returns `[]` forever; clamping to `now` would rebuild the bug |

### Shape

- **`lib/codebases/github-api-scan.ts`** — `ingestGithubApiScan` takes **`sinceIso?: string`** in place
  of `windowDays?: number`, defaulting to `now − DEFAULT_COMMIT_WINDOW_DAYS` (the exported constant,
  still 90). One parameter, one meaning: the callee no longer owns a window policy it can't see the
  inputs for. There is exactly one caller (`run.ts:637`), so this is a rename, not a migration.
- **`lib/integrations/github-link.ts`** — a pure exported `commitSinceIso(history, nowMs)` next to
  `resolveRepoHistory`, which is the module that already owns history semantics. It imports the
  constant from `github-api-scan`; the dependency runs one way only and there is no cycle today
  (`lib/integrations` → `lib/codebases` is a new but acyclic edge).
- **`lib/ingest/run.ts`** — `sinceIso: commitSinceIso(history, Date.now())` at the one call site. Note
  the existing guard's negative pin `not.toMatch(/sinceIso:\s*new Date\(/)`
  (`repo-history-threading.test.ts:31`) now polices this line too, which is the point: it forces the
  shared helper over an inline `new Date(Math.max(…))`. If a draft reddens it, fix the draft.
- **`docs/ARCHITECTURE.md`** — line 76 currently states the sentence this change falsifies
  ("`ingestGithubApiScan` (`windowDays`, explicit even at 0 …)"). Rewritten in the same PR, per
  CLAUDE.md §1. No `drift:*` block moves — no route, table, or source changes.

Deliberately not changed, each with its reason:

- **The estimator.** `github-estimate.ts` counts commits over `now − historyDays` at link time, which
  is the honest pre-link number (`days: 0` → "0 commits", because there is no backfill). The estimate
  describes the import; this spec describes every tick after it. The `W = max(days, 90)` floor exists
  precisely so the estimate stays true of the first sync.
- **The panel copy** ("No history" / the "no history" badge, `github-repos-panel.tsx:46,311-313`). The
  window has always been a *backfill* control — the predecessor spec says so outright
  (`repo-import-history-estimate.md:155`: "The repo still syncs **forward** — history is about the
  past, not ongoing sync") — so the label describes the choice correctly once the code matches it.
  Relabelling to "no backfill" is a defensible follow-up, not part of this fix.

## What would falsify this

1. **If "No history" is meant to mean "never collect commits for this repo at all"**, this change is
   wrong and the fix is a UI relabel instead. Evidence against: the panel prices the commit leg at
   "$0 · contributor graphs · no extraction cost" rather than offering it as an opt-out, and
   `run.ts:634-636` states the opposite intent in prose.
2. **If the anchor floor is the wrong bound** — i.e. if a repo linked 200 days ago at `days: 0` should
   still fetch its whole post-link history each tick — then `later_of` is wrong and the rule is just
   the anchor. I've chosen bounded-and-complete-since-last-tick over complete-since-link because
   `fetchCommitsSince` already caps at `maxPages = 10` (1000 newest commits), so the unbounded version
   silently truncates the *oldest* end anyway rather than failing. The bound assumes the importer ticks
   far more often than `W` (it runs hourly); an outage longer than `W` loses the commits older than
   `now − W` in that gap, and no window rule short of the unbounded anchor avoids that.

## Tests (spec-derived, red before the fix)

- **unit — `test/repo-history.test.ts`**: `commitSinceIso` over every row of the table above. The
  load-bearing one is `days: 0, linked at T0, now = T0 + 2h → since ≤ T0`, so a commit authored at
  `T0 + 1h` is inside the window; today's expression yields `T0 + 2h`. Plus the `days: 365` row (the
  plan-review HIGH) and the future/unparseable anchor rows — each is a *distinct* assertion, not one
  fixture tripping several terms at once.
- **unit — `test/github-api-scan.test.ts`**: the cutoff reaches GitHub **verbatim** — assert the
  `since=` query param off a stubbed `fetch`, on page 1 and on page 2. Stated honestly: this leg is
  **green today** (`fetchCommitsSince` already forwards what it's given); it pins the wire so that
  moving the window's owner to the caller can't quietly reintroduce a callee-side re-derivation.
- **guard — `test/guards/repo-history-threading.test.ts`**: repin the commit call site to the new
  argument, and assert `run.ts` no longer derives a commit window from `days`. **This is the pin that
  carries the regression**, with `commitSinceIso`'s unit rows: both are red today (the current file
  matches `windowDays: history?.days`, line 35). Each new term mutation-tested individually (one
  condition per fixture) so no term is vacuous.

Tier: unit. The failure is in a pure cutoff expression and one call site's argument — a real-Postgres
test would exercise the write path this change doesn't touch.

The existing data-mechanics tests for `ingestGithubApiScan` must stay green **unedited** through the
`windowDays → sinceIso` rename, which pins call-shape compatibility and nothing more: their GitHub
stub answers any `/commits` URL regardless of `since=`
(`github-api-scan.datamechanics.test.ts:28-37`), so they would stay green under any default. The
default is pinned by the unit test above, not by them — recorded here so nobody later mistakes their
green for coverage of the window.

## Out of scope

- **AIO-806** (the root README tells you to leave a Railway custom start command alone; the graphiti
  Dockerfile requires it empty) — a separate docs-only PR, no spec.
- **Admission control on github/linear issue bodies** — 70% of graph episodes, and the real cost
  lever, but a product decision, not a defect.
