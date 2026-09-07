# Turn the staging extraction hazard into a refusal (STGENV-3)

Status: **revised through four review rounds, eight reviews (Fable + Codex `gpt-6-astra`, independently
each round).** The bolt-to-bolt graph copy was DECLINED and is kept at `docs/design/staging-graph-copy.md`.
Then, in order: the bound moved off `synced_at` (it bounds nothing — every sync tick re-dates); off
SELECTION (any selection filter re-opens the B2 tier-cleanup leak) onto the PUSH; off "no ledger row"
onto "no HOME row" (`runFanout` writes a deferred row before any extraction); and the fan-out gate was
replaced by a REFUSAL after measurement showed the whole fan-out lifecycle is empty. Both reviewers
report no remaining design finding
· Owner: chetan · Tier build-with: unit (the pure decision + guards) + data-mechanics (the push gate)

**Deps:** STGENV-1 merged (`c8123c1a`). **No Railway change is required** on either environment.

**Increment:** ONE PR = a refusal in the projection entrypoint, a per-run `work_at` window that gates
the *push*, the refusal made observable at every entrypoint, and their guards. **No cron, no button,
and `GRAPHITI_URL`/`NEO4J_URL` are still NOT set on staging.**

> **This PR alone renders no arcs on staging.** With `GRAPHITI_URL` unset, `runGraphProjection`
> returns at `lib/graph/run.ts:209` before the new precondition is ever reached, so staging's runtime
> is byte-identical after merge. Arcs additionally need `NEO4J_URL` (`lib/graph/learning.ts:76`).
> Both are Railway changes and both belong to **STGENV-4**, which is also where the operator runbook
> lives (see "Handed to STGENV-4"). The sequence is **guard → wire → arcs**.

---

## Problem

Staging shows **no narrative arcs**, because `NEO4J_URL` is unset there: `recentFacts` returns
`{facts: [], ok: true}` (`lib/graph/learning.ts:76`) and synthesis returns empty before generating
prose (`lib/graph/arcs.ts:760-769`).

The obvious fix — set `GRAPHITI_URL` — is a **~$190 trap**, and it is armed right now:

| measured (prod, 2026-09-06) | value |
|---|---|
| staging `graph_episodes` | **0** — STAGING-1's refresh empties the ledger |
| staging `GRAPH_PROJECT_ENABLED` | **`true`** (documented `false` — see D9) |
| corpus | **3,070 items, 3,049 ledger rows, 2 `group_id`s** |
| initiatives with a graph group | **0** |
| fan-out ledger rows (`deferred` / armed) | **0 / 0** — all 3,049 rows are home rows |
| graph share of LLM spend since 2026-07-24 | **$189.80 of $199.53 — 95.1%** |
| planning unit cost | **~$0.062 per item** ($189.80 / 3,049) |

An emptied ledger makes **every restored item look unprojected**. So wiring Graphiti makes the whole
corpus eligible for fresh extraction — with nobody pressing anything. STAGING-1 recorded this hazard
in prose and left it unguarded. **This slice makes it a refusal.**

> **$0.062 is a planning estimate, not a measured fresh-extraction price** — it is historical spend
> over a mixed period divided by current ledger rows, and item cost varies by kind — an item chunks up
> to `MAX_EPISODE_CHUNKS`, **default 80** (`lib/graph/project.ts:120`), not the "1..16" that
> `lib/graph/run.ts:30`'s docstring still claims (stale; corrected as a drive-by in this PR since the
> summary field is being touched anyway). A window skewed to long items lands well off that mean.

### Why not the copy

Declined. Three reasons, each sufficient: the "run inside production" inversion was **backwards** (a
laptop reaches neither graph, so a wrong URL writes nothing; inside production is the one place *both*
are writable) and there is no staging-only credential to fall back on — `NEO4J_AUTH` is byte-identical
across environments and Community edition has no RBAC; **no runner was ever named**; and the copy has
**no consumer** — arcs and the learning panel read most-recent-N, while `graph-query` and retrieval
need `GRAPHITI_URL`.

### Why not `synced_at` — the draft-2 blocker

`since` filters **`synced_at`** (`lib/graph/project.ts:725`), and `synced_at` is re-dated by every sync
tick on unchanged items (`lib/ingest/index.ts:200-227`; `postgres/schema.sql:1122-1127` says so in
prose). It is the wrong axis *semantically*: a tier heal or a re-attribution on a 2024 item pulls that
item into a "recent" window.

Measured, the two axes differ by an order of magnitude:

| bound | items | ≈ cost at $0.062/item |
|---|---|---|
| `work_at` ≥ now − 1 day | **33** | ~$2 |
| `work_at` ≥ now − 7 days | **83** | ~$5 |
| `work_at` ≥ now − 30 days | **727** | ~$45 |
| **`synced_at` ≥ now − 7 days** | **869 (28% of the corpus)** | **~$54** |

**Correction to draft 2's framing.** It said the `synced_at` population would rise toward the full
~$190 because staging's own ingest scheduler keeps re-dating. That is wrong: the refresh excludes
`integrations` and `member_secrets` **data** (`scripts/staging-refresh-decision.mjs:76-85`), so staging
has no connector credentials and the restored scheduler cannot re-sync (even Slack's env-token
fallback needs an integration row, `lib/ingest/run.ts:173`) — **staging's `synced_at` distribution is
frozen at refresh time and only ages, ABSENT subsequent item writes.** It is an operating assumption,
not a database invariant: the refresh deliberately retains API-key data (`docs/OPS.md:741`), and an
authenticated push still runs ingestion (`app/api/v1/items/route.ts:116`), which bumps `synced_at` on
an unchanged body. The blocker's magnitude was overstated on both environments.
It does not change the decision: 869 vs 83 is still an order of magnitude, on an axis that means the
wrong thing.

### Why not a SELECTION filter — the draft-3 blocker, found by both reviewers

Draft 3 restricted *which rows the projector selects* (by item id, justified by a claim that a
`gte("work_at", floor)` predicate would truncate the paging walk). Two independent reviews rejected it:

**The justification was false.** `.gte` compiles to a SQL `WHERE` predicate applied before `ORDER BY`
and `LIMIT` (`lib/db/pg/query-builder.ts:245`), exactly like the `q.in("kind", …)` the same query
already carries. A short page therefore still means "tail reached". There was no truncation hazard, so
the id-set — and the `GRAPH_WINDOW_MAX_ITEMS` cap that existed only to patch it — were machinery
around a non-bug. *(One reviewer's supporting scenario was itself weaker than stated: it posited 727
items sharing a `synced_at`. Measured on prod, all 3,070 items have distinct `synced_at`, max tie = 1.
The tie hazard is real in principle and pre-existing in the unbounded walk; it is not what breaks the
design. What breaks it is that I built it on a misreading.)*

**And the real defect survives any selection filter.** The per-row loop is not only "push". It is where
a tier reclassification records the old group as pending-delete (`lib/graph/project.ts:1382-1392` — the
B2 durability fix), where a kind change reaches cleanup (which is why the default projection
deliberately scans EVERY kind, `:719-723`), where redaction tombstones and restriction moves are
driven. **An item excluded from selection is never scanned, so its tier flip never sets
`pending_delete_group_id`, and reconcile has nothing to retry** — old-tier content stays searchable
forever, the exact leak B2 closes. The "staging's ledger is empty" argument expires after the first
bounded run, and D6 would have made this live on production too.

---

## Decision

**D1. On a database carrying `staging_marker`, an UNBOUNDED projection is REFUSED.**
`runGraphProjection` (`lib/graph/run.ts:137`) gains a precondition: staging marker present and no valid
window configured ⇒ refuse and return.

**Why keyed on the marker and not on an environment name.** `staging_marker` is the repo's
purpose-built discriminator, deliberately absent from `schema.sql` and every migration
(`lib/access/materialize-command.ts:31-35`; measured `t` on staging, `f` on prod; pinned by
`test/guards/staging-refresh.test.ts:558-562`). An environment name is operator-renameable — the
weakness STGENV-1's banner documents about itself.

**D2. The bound is a PER-RUN WINDOW on `work_at`.** `GRAPH_PROJECT_WINDOW_DAYS` (a positive integer).
The floor is `clock() − windowDays`, where `clock` is an **injectable parameter of the decision
function**, not a module-load constant — an absolute date would grow with every refresh (a floor set in
September re-extracts September→now in October, then September→November) while satisfying D1 the whole
time.

**D3. The window gates the PUSH, not the SELECTION — and "push" means the FIRST HOME push.**
The query, the ordering, the `synced_at` cursor and the paging loop are **completely unchanged**. Every
row the projector scans today is still scanned. Inside the per-row loop, when a window is active:

> an item with **no HOME row** — `existingRow === null` (`lib/graph/project.ts:931`) — whose
> **`work_at` is older than the floor** is **HELD**: no home push. (Fan-out is not held — D3e
> refuses the run outright if any fan-out surface exists.)

**Why `existingRow`, and not "no ledger row at all".** Draft 4 said "no existing ledger row", which is
ambiguous, and one reading leaks the whole bound. `rowsForItem` (declared `:899`) holds *all* of an item's
rows. `runFanout` inserts a **deferred** fan-out row (`:953-964`, `deferred: true`, `''` sha, zero LLM)
for every initiative membership — so under `rowsForItem.length === 0` a held item acquires a row on
pass 1 and is exempt on pass 2, and pushes. No content change, no timestamp change, nobody pressing
anything. `existingRow` is derived from `homeWorld`, which filters `!r.deferred` and
`group_id ∈ {home, otherHome}` (`:926-931`), so **neither a deferred row nor an armed initiative row
can make it non-null** — the discriminator is stable across passes, which is exactly the property the
bound needs. *(One reviewer found this leak and then prescribed `rowsForItem` as the fix — the
vulnerable reading. The other named `existingRow`. Recorded because "the reviewer that found the bug"
and "the reviewer that got the fix right" were not the same reviewer.)*

**Exact placement**, because a gate one line late is a different feature:

- `held` is computed **right after `existingRow` is derived** (`:931`).
- In the main flow, the hold exits **immediately after the redaction block's `continue` (`:1303`)**,
  which is before the reservation INSERT (`:1533`) — everything from `tierChanged` (`:1305`) to that
  INSERT is already a no-op when `existingRow === null`, so this is the single point where the builder
  need not re-derive that the retract/purge/delta branches are unreachable. Shape:
  `windowHeld++; continue;`.
  **A held item must leave zero home rows behind.** A gate placed after the reservation writes a
  `''`+`[]` sentinel row that reconcile deliberately skips as "never pushed"
  (`lib/graph/reconcile.ts:642`) — silent — and makes `existingRow` non-null on pass 2, so the item
  pushes. C18 pins both the absence of the row and the survival of the hold across two passes.

**Everything else about that row proceeds normally**: tier-change cleanup (`:1383-1418`), kind-change
cleanup (`:719-723`), redaction tombstoning, restriction moves, and reconcile.

**Why the discriminator holds — an INSPECTION of today's writers, NOT a guarantee from a guard.**
Every `graph_episodes` INSERT/UPSERT in the tree is in `lib/graph/project.ts` (`:468`, `:953`, `:1247`,
`:1533`, `:1592`). Each was checked against the predicate: the deferred insert and
`recoverUnledgeredFanoutPush` (`:468`) write only initiative groups (`resolveFanoutTargets` diverts
General/external-shared into their own buckets, `lib/projects/context/fanout-targets.ts:81-90`);
redaction and the tier move require `existingRow`; reconcile only UPDATEs existing rows; arming flips
`deferred` without touching `group_id`. `work_at` is `NOT NULL` (`schema.sql:1130`), so there is no NULL
admission hole.

**Two corrections, because an earlier draft got both backwards and they change what is load-bearing.**
(1) The reservation does NOT require `existingRow` — `:1532` inserts **precisely when
`existingRow === null`**. Its safety depends entirely on the hold at `:1303` running first, which makes
the placement load-bearing rather than tidy. (2) `test/guards/single-writer-graph-episodes.test.ts` does
NOT confine writes to `project.ts`: its `OWNER` is `lib/graph` (`:13`), so it exempts that whole
directory. It proves no FOREIGN module writes `graph_episodes`; it proves nothing about a future file
under `lib/graph`. The claim "a future writer must defeat that guard first" was false and is withdrawn —
this list is an inspection with a date on it, and C12's single-call-site pin is the part that is enforced.

**This is what keeps D6 safe**: the gate removes an item from *extraction*, never from *repair*.

- **Fan-out is NOT gated. It is REFUSED — see D3e.** Draft 5 gated it on the same flag, and review
  showed that holding a fan-out push wedges the partition it belongs to: an armed-but-held row is an
  unlanded obligation `readyPartitions` counts (`lib/graph/arming.ts:137,153`), readers exclude an
  unready initiative (`lib/graph/partition-read.ts:116`), and reconcile deliberately preserves the
  never-pushed sentinel (`lib/graph/reconcile.ts:642`) — so ONE held item makes the whole initiative
  unreadable, including for items that DID land. Measurement then made the choice obvious: the path
  has no rows.
- **Postgres reads are not the $190.** A full scan of 3,070 rows is ~7 item-selection *pages* an hour
  (each page also does the pointer read, the chunked ledger prefetch and `resolveFanoutTargets` — so
  more than 7 queries, and still no LLM cost). Extraction is the cost, and extraction is what stops.
- **`work_at` being mutable stops mattering.** It is healed on an unchanged ingest re-push
  (`lib/ingest/index.ts:302-320`), so an id snapshot taken at run start could go stale. Reading it per
  row at scan time has no snapshot to go stale.
- **No `GRAPH_WINDOW_MAX_ITEMS`.** It existed only to bound an id list.

**D3a. ONE counter: `windowHeld`.**
It counts held items. It rides `partialSummary()` (`:791`), the abort merge in `run.ts:347-360`, the
per-page and per-team sums, and `projectionRunInput`'s enumerated meta. Draft 5 had a second counter
for held fan-out pushes; D3e removes the thing it counted.

**D3e. Whenever a WINDOW IS ACTIVE — on any database, marker or not — a fan-out surface is a REFUSAL.**

**Marker-independent, and that is the fix for a contradiction.** An earlier draft headed this
"on a staging database" while its body promised production refuses too. Under the heading's reading,
production with a window proceeds despite initiatives — and an initiative-only item reaches
`runFanout()` at `lib/graph/project.ts:1209-1214`, **before** the home hold at `:1303`, so an armed row
pushes at `:1059` and its content enters Graphiti with no home push. Exactly the hole this exists to
close, left open by two sentences that could not both hold.

**The predicate, in stored terms, with no notion of "home".** For each team, refuse if either:

- **(a)** a `projects` row has `kind = 'initiative'` AND `graph_group_id IS NOT NULL`; or
- **(b)** any `graph_episodes` row for the team has `deferred = true`.

Derivation: `resolveFanoutTargets` emits targets only from `initiativeGroupByProject`
(`lib/projects/context/fanout-targets.ts:89-90`), so ¬(a) ⇒ no targets ⇒ no deferred inserts
(`project.ts:951-964`); and `fanoutRows` is `r.deferred || initiativeGroups.has(r.group_id)`
(`:932-934`), so ¬(a)∧¬(b) ⇒ `fanoutRows` is empty ⇒ the push loop at `:1044-1061` never iterates.
`runFanout` is then a provable no-op — a state check, not a reachability argument.

**Term (b) is not redundant, and the reason is sharper than "belt and braces".** For preventing
EXTRACTION, (a) alone suffices: the push loop does `if (r.deferred) continue` (`:1041`), so a deferred
row cannot push, and an armed row needs `initiativeGroups.has(r.group_id)`. But (b) is what makes
`runFanout` write nothing: without it, an orphan deferred row (its initiative deleted) enters the untag
cleanup branch and issues a **DELETE** at `:978-985`. "No extraction" and "no writes" are different
guarantees, and D3e claims the second.

**Deliberately NOT "any non-home ledger row".** That over-approximates and refuses forever on three
benign states, none of which is a spend surface: PCCC-6 orphans in a deleted initiative's group
(`deferred = false`, touched by neither `homeWorld` nor `fanoutRows`), the PCCC-5 rename residual — a
home row under an old slug's legacy id (`project.ts:826-833`) — and any team whose built-ins are
unpointed, where "home" would have to mean the fallback id or every row reads as non-home. The tighter
predicate needs no definition of "home" at all, so none of those can trigger it.

**Where it runs, and what it costs.** Two `limit 1` existence queries **per team, once per run**, after
`resolveTeams` and before the lease. Nothing on the paging path. **No window ⇒ the queries do not
run at all** — not merely "do not refuse"; production without a window is byte-identical.

**A thrown read REFUSES**, reason `fanout-state-unknown`, D4's three rules verbatim: fail closed on
every database, preserve the underlying error, and give it its own text that does NOT instruct a
production admin to touch a staging knob. `catch → false` is the failure this sentence exists to
forbid.

**Scope: RUN-LEVEL.** Every team is checked, then the run refuses — rather than one team refusing while
others project. Chosen because "the run refuses" is what D7's consumers report and a partial run whose
summary says `refused` would misdescribe itself.

**The cost of refusing, stated because it is heavier than the hold it replaced.** A D3e refusal
suspends *everything* for the run — home maintenance, B2 tier cleanup, reconcile — not just admission.
On production with a window and one dashboard-created initiative, projection for the team stops until
the window is unset (D3d's recovery). That is the trade; "safe" must not be read into it.

**TOCTOU: bookkeeping-only within a run, and named rather than waved away.** Initiatives are minted
*with* a pointer (`app/actions/projects.ts:39,85`), and pointer writes do not take the projection lease
(`lib/graph/project-pointer.ts:119-137`, called from `lib/ingest/index.ts:147`), so one created mid-run
makes a later page's `resolveFanoutTargets` emit targets ⇒ deferred inserts, **zero LLM**. A push needs
an armed row already in that page's prefetch snapshot, and a row inserted this pass cannot be armed and
pushed in the same pass. The next run refuses on (b). Residual: an item re-visited on a later page after
a mid-run `synced_at` bump plus a reader arm (`lib/graph/arming.ts:103`) — bounded by
`FANOUT_PUSH_MAX_PER_PASS`.

**Measured on prod, 2026-09-06 (staging is a byte copy): 0 initiatives, 0 initiative graph groups,
0 deferred rows, 0 armed fan-out rows. All 3,049 ledger rows are home rows, across 2 groups.**

So the fan-out lifecycle is empty, and two drafts spent a gate, a counter, two criteria and four
mutations on a code path with no rows — while review kept finding real defects in the *interaction*
between the window and that lifecycle: a held fan-out push leaves an unlanded obligation
`readyPartitions` counts (`lib/graph/arming.ts:137,153`) so readers exclude the whole initiative
(`lib/graph/partition-read.ts:116`) *including items that landed*; and initiative-only items never get a
home row, so their maintenance is held forever.

**One of those three was mis-attributed and the correction matters.** The restricted-from-ingest exit at
`:1209-1214`, where `windowHeld` never counts the item, needs only a closed General include — **not** an
initiative — so it is not "a state that does not exist". It is a non-defect for a different reason: such
an item has no home push today either, the exit is restriction-owned and window-independent, and C22
still partitions because the item lands in `skipped`.

Refusing is the repo's own doctrine applied to itself: prefer the design where the dangerous action is
**unreachable** over one where it is merely **checked**, and make an unspecified interaction a refusal
rather than a guess. Today it never fires. The day someone creates an initiative, they get a loud,
documented refusal instead of a leak or a silently unreadable partition — and that is the moment to
specify the interaction, with a real population to measure.

**D3b. `shouldRecordProjectionRun` gains `windowHeld` — and NOT `refused`.**
In steady state a bounded pass has `projected === 0`, so without a held clause no `ingest_runs` row
lands at all and the coverage check below has nothing to read. `refused` is deliberately **not** added:
`errors.length` already carries every refusal, and adding `refused` would make the mutation that empties
`errors` stop reddening the recording criterion — the clause would mask its own test. Stated so a later
"no silent caps" reflex does not helpfully add it.

**D3c. "Bounded" means ADMISSION-limited. It is not a cap on spend, and the doc must not imply one.**
The window bounds *first* home pushes. An item already carrying a HOME row re-extracts, regardless of window,
on: a body change; a tier flip (`:1305`, `:1383`+); a chunk-config change (`owesChunks`, `:1325`); a
reconcile re-queue via the `''` sentinel (`:1493`); `GRAPH_DEEP_REQUEUE`; and armed fan-out copies
(`:1378`) — moot under D3e today. So admitting 83
items and then arming several initiative copies can exceed the ~$5 estimate without admitting anything
new; the fan-out budget caps a run's *rate*, not eventual spend.

On staging this is small and nameable: the corpus does not churn (see the `synced_at` note), so what
remains is admin-driven (a tier correction, an arc correction — cents) plus **one case that can
re-price the whole in-ledger set at once: a deploy that raises `MAX_EPISODE_CHUNKS`**
(`lib/graph/project.ts:120`, default **80**), which pushes the newly-admitted tails of the rows the old
cap clipped (`owesChunks`, `:1325`) — a delta, not every row, and an upper bound of |ledger| rather than
a prediction. With D3e that ledger is home rows only, so at a 30-day window it is ≤ 727 admitted items
under the stated operating assumptions. On production with a window, the maintained set is the
whole 3,049-row ledger, which is the intent.

**D3d. The admission policy has a completeness cost on production. Named, not hidden.**
With a window set, an item with **no home row and an old `work_at` is held forever** as the floor
advances. A `synced_at` bump cannot rescue it, because `synced_at` is not the axis — though the
`work_at` heal on an unchanged re-push (`lib/ingest/index.ts:302-320`) CAN, if the source later supplies
an in-window work-time. Concretely: production
sets a 7-day window, then connects an archive of older material; that material never enters graph
retrieval. This is the predicate working as designed, not a cleanup bug, but D6 calling itself "safe"
was hiding it. **Recovery is: unset the window and run once** (no marker + no window ⇒ unbounded), which
is why D5's refusal is keyed on the marker rather than on the window's absence. The operator-facing
version of this goes in STGENV-4's runbook.

**D4. The detector is REUSED, INJECTABLE, and FAILS CLOSED.**
`lib/access/materialize-command.ts:106-109` already asks
`select to_regclass('public.staging_marker') is not null`. This slice extracts it into a shared reader
under `lib/` and has both callers use it.

- **It runs AFTER the `client.configured` gate** (`run.ts:209`), or `lib/graph/run.test.ts:9` ("never
  touches the DB when unconfigured") reddens.
- **It is an injectable option** (`stagingMarker?: () => Promise<boolean>`), the same seam pattern as
  `lease`/`lookup` at `run.ts:145-148`. The read is raw SQL on the pool — `DbClient`
  (`lib/db/types.ts:49-55`) cannot express `to_regclass` — so without a seam it bypasses the injected
  `db` fake and `getPool()` throws with no `DATABASE_URL` (`lib/db/pg/pool.ts:50-54`).
- **A thrown read REFUSES on both environments**, reason `staging-state-unknown`, preserving the
  underlying database error. **Its text is its own** and must NOT tell the reader to set
  `GRAPH_PROJECT_WINDOW_DAYS` — a production admin hitting the button during a DB blip would otherwise
  be instructed to configure a staging knob.
- **Honest about the cost:** a *persistently* failing detector refuses *every* run, not "one tick".
  That is accepted — failing open defeats the guard — and it is loud by D7. Likewise, absence from
  migrations does not prove a `staging_marker`-shaped table can never appear on production (an
  independently created table, a staging-derived dump); if it does, projection refuses and the reason
  says which table it saw. The shared comment's "a restore cannot carry it to production" is narrowed
  to what it actually claims: *`pg_restore` of a prod dump cannot*, because the marker is not in it.

**D5. There is NO DEFAULT window, and an INVALID one is a refusal.** Unset on a staging database means
*refuse*, not "pick something sensible" — a default silently decides how much money to spend. A value
that is not a positive integer refuses with its own reason; it never falls back to unbounded.

**A trimmed-EMPTY value is UNSET, not invalid** — and this is a criteria pair that would otherwise ship
wrong. Railway and `.env` both render an unset variable as `""`. If `""` were "invalid", a production
instance with a blank `GRAPH_PROJECT_WINDOW_DAYS=` would refuse **every** run — the production refusal
D8 says cannot happen — while both tests stayed green, because the unbounded-production fixture would
naturally use `undefined`. `""` therefore falls into D6's case split as "no window".

**D6. The window is HONOURED EVERYWHERE; it is REQUIRED only on staging.** Four cases: marker + window
⇒ bounded; marker + no window ⇒ refuse; no marker + window ⇒ **bounded**; no marker + no window ⇒
unbounded (production today, unchanged). An env var that silently does nothing on one environment is a
class this repo keeps recording. **Safe only because of D3** — under a selection filter this clause was
the one that took the tier-cleanup narrowing to production. Its completeness cost on production is
D3d, stated rather than implied by the word "safe".

**D7. The refusal is OBSERVABLE AT EVERY ENTRYPOINT.** It returns `ok: false`, `configured: true` (it
is after the gate, and `projectToGraphNow` checks `configured` first), a discriminating
`refused: <reason>`, and `errors: [<text>]`. Verified against each consumer:

- `shouldRecordProjectionRun` (`lib/graph/projection-run.ts:40`) returns **true** via `errors.length`,
  and `projectionRunInput` sets `ok = errors.length === 0`, so a **red row lands every tick** until the
  window is set. `projectionRunInput` **enumerates** its meta fields (`projection-run.ts:81`) and would
  drop `refused` — this slice adds it explicitly, so the discriminator is durable and not only prose
  inside an error string.
- `projectToGraphNow` (`app/t/[team]/admin/integrations/actions.ts:439`, condition ~`:461`) surfaces
  the reason to the admin.
- The battery script prints `[battery] ERRORS:` (`scripts/graph-window-battery/run-projection.ts:33`)
  and exits non-zero (`:36`). **The exit code is not a criterion**: that line is already
  `process.exit(!s.episodes || s.errors.length ? 1 : 0)`, so a refusal exits 1 on HEAD today with no
  reason attached. The criterion is the *reason reaching a human*.
- **Known limit, stated not hidden:** the `ingest_runs` write is best-effort and swallowed, so C14/C15
  prove the refusal is *eligible* to be recorded, not that the write *succeeded*. A refusal caused by
  an unreachable Postgres will not persist a row; the scheduler log and the admin UI are the paths that
  still work.
- **It does not poison the Costs ratio:** scheduler rows carry `team_id = null` while
  `lib/metrics/graph-efficiency.ts:204-210` selects the team's rows, and a refusal contributes zero
  episodes rather than a phantom denominator.

**D8. Production behaviour is UNCHANGED.** No marker and no window ⇒ no refusal, no gate, the same
unbounded backfill that built the existing corpus — and, under D3, the same cleanup coverage even when
a window IS set.

**D9. The "no code here closes it" contract moves — all FIVE sites.** After this slice, code here does
close it. `scripts/staging-refresh-decision.mjs:499-501` (the completion message),
`test/guards/staging-refresh.test.ts:546` (which asserts message fragments; its title also names the
old framing) and **`docs/OPS.md:750`** ("The residual hazard, which no code here closes") all change to
name the refusal and the variable that lifts it — **plus the two explanatory docstrings in the same
module that still state the old unconditional-extraction contract**,
`scripts/staging-refresh-decision.mjs:92-97` and `:488-493` ("a hazard NO CODE HERE CAN CLOSE"). Five
sites, not three; an operator who reads only the docstring learns the wrong contract.

`STAGING_VARIABLES` is **unchanged** — `GRAPHITI_URL` and `NEO4J_URL` are still expected unset after
this PR. Two things stated rather than papered over:

- **`GRAPH_PROJECT_WINDOW_DAYS` is documented as PROSE in OPS §11, deliberately not as a table row.**
  The guard at `test/guards/staging-refresh.test.ts:564-589` parses every `| \`NAME\` |` row from
  `## 11.` to end-of-file, requires the count to equal `STAGING_VARIABLES.length`, and requires each
  expectation to be `unset` or `` `false` ``. The window is an operator knob with neither expectation,
  so a row would fail the build. The OPS text says why, so nobody "fixes" it into a row.
- **The operator runbook does NOT go in OPS §11 in this PR.** It says "set `GRAPHITI_URL`" and "leave
  `GRAPH_PROJECT_ENABLED` true" twenty lines under a table declaring the opposite, and the guard
  compares the table to the script, not prose to table. §11 gains one sentence saying the table
  describes the pre-STGENV-4 state and that STGENV-4 re-frames it; the runbook itself ships with
  STGENV-4. Recorded while here: **`GRAPH_PROJECT_ENABLED` is documented `false` and measured `true`**
  on staging, so the documented set was never fully applied.

**D10. `projectSlackToGraph` is DELETED.** It is an exported wrapper around `projectItemsToGraph`
(`lib/graph/project.ts:1640`) with **zero non-test callers** — and it is a bypass door for this
precondition, because the floor is computed in `run.ts` and a direct caller passes none. Its four dm
call sites move to `projectItemsToGraph` with an explicit `kinds`. The stale docstring at
`lib/graph/run.ts:12` ("the on-ramp that actually drives `projectSlackToGraph`") is corrected in the
same change.

**D11. NOT in this slice** — see "Handed to STGENV-4" below, plus: any change to what production
projects, and the arc-correction write-back at `lib/graph/arcs.ts:1489`, which bypasses
`runGraphProjection` to push one small episode per human correction — cents, not the trap, named here
so it is a decision rather than an oversight.

---

## Scope

**In:** a shared `staging_marker` reader under `lib/`; the pure precondition + refusal in
`runGraphProjection`; `GRAPH_PROJECT_WINDOW_DAYS`; the `workAtFloor` push gate + `windowHeld` counter
in `projectItemsToGraph` (home push only); `windowHeld` on `GraphProjectionSummary`,
`partialSummary()`, the abort merge, `shouldRecordProjectionRun` and `projectionRunInput`'s meta; `refused` on the summary and in that meta; the stale `1..16` docstring at
`lib/graph/run.ts:30`; the D3e fan-out refusal; deleting `projectSlackToGraph`; the five-site hazard-wording change from D9; **the `docs/ARCHITECTURE.md` projection-flow update CLAUDE.md §1 requires**; a new guard file under
`test/guards/`; data-mechanics tests for the push gate and the real detector; an OPS §11 paragraph.

**Cut:** everything in D11 and "Handed to STGENV-4", and the declined copy.

---

## Handed to STGENV-4, explicitly

Named so the boundary is a boundary and not a gap:

1. **The Railway wiring** — `NEO4J_URL`, `GRAPHITI_URL`, `GRAPH_PROJECT_ENABLED`, and the window value.
2. **The operator runbook**, and the OPS §11 table re-framing D9 defers.
3. **The graph lifecycle across a SECOND refresh — a real hole, found at review.** The refresh script
   is Postgres-only: it empties `graph_episodes` but **nothing resets Neo4j**, and `addEpisodes` does
   not overwrite by name (`lib/graph/reconcile.ts:134`). So a second refresh after a bounded run leaves
   previously extracted content in the graph with no ledger owner, and re-extracts the overlap.
   Stopping projection around a refresh, draining async extraction, and restoring graph/ledger
   consistency all belong there.

---

## Acceptance criteria

**The decision (unit, pure, injectable clock)**

1. Marker + no window ⇒ REFUSE, and the reason text names BOTH `staging_marker` and
   `GRAPH_PROJECT_WINDOW_DAYS`. Run with the window `undefined` AND with `""`/whitespace — D5 says
   those are the same input, and a blank Railway variable is the realistic one.
2. Marker + valid window ⇒ PROCEED with floor `clock − windowDays`.
3. The SAME window at two different clocks yields two DIFFERENT floors, each exactly `clock − days`.
   Both clock arms asserted **independently**, so a mutation that breaks floor arithmetic fails C2 and
   a mutation that freezes the clock fails C3 — not one assertion doing both jobs.
4. An invalid window REFUSES with its own reason, **asserted per input as its own case**: `0`,
   negative, fractional, non-numeric, and **scientific notation (`1e3`)**. Never an unbounded proceed.
   (A single NaN fixture is not enough: an implementation can handle non-numeric and still mishandle
   `0` or `2.5`.) **`""` and whitespace are NOT in this list** — D5 makes them UNSET, and C1/C5 carry
   them as fixtures.

   > **`1e3` was found by writing this criterion before the code.** The obvious implementation is
   > `Number(raw)` + `Number.isInteger` + `> 0`, and `Number("1e3")` is 1000 — an integer, positive,
   > silently accepted as a 1000-day window. The parser therefore requires a plain decimal digit
   > string (`/^\d+$/`). A window is a spending decision typed on purpose, so the value stored in
   > Railway must read as what it means: `1000` is a legitimate deliberate choice, `1e3` is almost
   > certainly a mistake, and there is no reason for the two to be the same input.
5. No marker + no window ⇒ PROCEED **unbounded**, asserted with `undefined` AND with `""` — the pair
   C4 would otherwise contradict, and the one a production instance actually holds.
6. No marker + valid window ⇒ PROCEED **bounded**.
7. A marker read that THROWS ⇒ REFUSE `staging-state-unknown`, asserted on BOTH the window-set and
   window-unset inputs (when the read throws there is no marker state, so those are the two arms), the
   database error preserved, and the text does **not** instruct setting `GRAPH_PROJECT_WINDOW_DAYS`.
8. Each refusal reason has an input that triggers **only** it. *(Structural: proved by construction of
   the fixture set, reviewable, but no single mutation reddens it.)*

**The wiring — the class of bug this repo has recorded (unit)**

9. The GLOBAL precondition runs before `resolveTeams` and before any projector call: on a
   `no-window` / `invalid-window` / `staging-state-unknown` refusal the injected `db.from` is never
   called (the seam `lib/graph/run.test.ts:11` already uses). **Scoped to those three reasons on
   purpose** — D3e's refusal necessarily follows team resolution and *must* call `db.from`, so an
   unscoped version of this criterion and C19 could not both hold.
10. It runs AFTER the `client.configured` early return: with `GRAPHITI_URL` unset, **the injected
    `stagingMarker` seam records zero calls** and no database access occurs. (Naming the observable
    matters — "no marker read" is otherwise unfalsifiable.)
11. **`run.ts` FORWARDS the floor, on every page.** A bounded run driven through `runGraphProjection`
    end to end, on real Postgres, with an explicit `limit` that forces **at least two pages** and the
    held item placed on **page 2** (page 1 all in-window) — so forwarding the floor to the first page
    only reddens, which a fixture with the held item on page 1 cannot detect. Deleting the
    `workAtFloor:` argument at `run.ts:249` reddens too. Without this, C2/C6 pin that the decision
    *produces* a floor and C18 pins that the projector *honours* one, and nothing pins that the first
    reaches the second.
12. `projectItemsToGraph(` has **exactly one** non-test call site (`run.ts:249`) — true only once D10
    lands; it is **two** on HEAD.
13. `to_regclass('public.staging_marker')` appears in exactly ONE module under `lib/`. Scoped to `lib/`
    on purpose: `scripts/staging-refresh.sh:121` is a second, deliberate one, because the refresh
    script must not import app code. *(`staging-refresh-decision.mjs:55` is a table-NAME constant, not
    a query — draft 3 miscited it.)*

**The refusal being seen (unit)**

14. `shouldRecordProjectionRun(<refusal summary>) === true`.
15. `projectionRunInput(<refusal summary>)` yields `ok: false` **and** carries `refused` in its meta.
16. `projectToGraphNow` returns `{ok: false, error}` naming both `staging_marker` and
    `GRAPH_PROJECT_WINDOW_DAYS` (`app/t/[team]/admin/integrations/actions.ts:465`).
17. The battery script's printed output carries the reason (not merely a non-zero exit).

**The push gate (data-mechanics, real Postgres, stubbed Graphiti)**

18. **The discriminating pair, over TWO passes, driven through `runGraphProjection`.** Window active,
    empty ledger, **no initiatives** (so D3e does not refuse and no fan-out branch is reachable):
    - **A** — `work_at` OLDER than the floor, `synced_at` NEWER: not pushed on pass 1, **zero
      `graph_episodes` rows for A after pass 1** (so a gate placed after the reservation INSERT
      reddens — the reservation at `:1532` fires on `existingRow === null || groupMoveMatchedNothing`,
      which is exactly a held item), and **still not pushed on pass 2**; `windowHeld` counts it on both
      passes. *(The pass-2 arm proves the hold is durable. It does NOT distinguish the two candidate
      discriminators — with an empty ledger they agree; that is the orphan arm's job.)*
    - **B** — `work_at` INSIDE the window, `synced_at` OLDER than the floor: pushed.
    - **O, the orphan arm** — `work_at` OLDER than the floor, carrying exactly ONE `graph_episodes`
      row in a group that is neither home candidate, `deferred = false`, with no initiative pointing
      at that group. D3e permits this state by design (it is the PCCC-6 orphan / PCCC-5 rename
      residual the predicate deliberately does not refuse on), and it is the ONLY fixture inside that
      permitted space where `rowsForItem.length === 0` and `existingRow === null` disagree: O must be
      **HELD** and counted in `windowHeld`. This is what kills MU22.
    A and B are chosen so a `synced_at` gate gets **both** arms backwards, not just one; O is chosen so
    the home-row discriminator is proved rather than argued.
19. **D3e's refusal, both predicate terms, both outcomes, and its throw path** (dm — the fixtures seed
    `projects` and `graph_episodes` directly). With a window active:
    - **(a) arm** — a `projects` row with `kind='initiative'` and a non-null `graph_group_id`, and NO
      deferred ledger rows ⇒ REFUSE.
    - **(b) arm** — a `graph_episodes` row with `deferred = true` and NO pointed initiative ⇒ REFUSE.
      Without this arm, an implementation that checks only initiatives passes every other assertion.
    - **negative arm** — neither term true (home rows only, no initiative, no deferred row) ⇒ PROCEED
      bounded. The fixture must explicitly contain no deferred rows: "no initiative" alone does not
      establish permission.
    - **throw arm** — the detection read throws ⇒ REFUSE `fanout-state-unknown`, error preserved.
    - **no window** ⇒ the detection is **not issued at all**, not merely "no refusal" — observed on an
      injected `fanoutSurface` seam, WITH a positive control (the same run *with* a window does call
      it) so "never called" cannot pass because the seam was never wired. It cannot be observed on
      table names: the projector reads `projects` on every page for its pointer lookup, so a table spy
      can never express this criterion. The first version of this test asserted exactly that and was
      wrong; the seam exists because the criterion demanded an observable the code did not have.
    The refusal shape is asserted here too: `ok:false`, `configured:true`,
    `refused:"window-with-fanout"`, and `errors[0]` naming the team and the recovery (unset the window).
20. **Repair survives the window.** An item OUTSIDE the window that HAS a home row and whose tier
    changed still gets the durable move at `lib/graph/project.ts:1404`: the ledger row lands in the
    **new** group with `pending_delete_group_id` naming the **old** one. *(Asserted in that shape —
    draft 4 said "recorded on its old group", which would have contradicted unchanged behaviour.)*
    Run independently of C18, so a mutation that reddens C18 cannot be mistaken for proving this.
21. With **no** window and **no** marker, both A and B are pushed — production's unbounded behaviour.
22. **The counters partition a completed pass**: `scanned === projected + skipped + windowHeld` on a
    bounded, **non-aborted**, multi-item pass whose fixture actually holds something. Stated as
    non-aborted because `partialSummary()` reports `scanned: rows.length` (`:791`) while the counters
    stop at the aborting row — the identity is a coverage tool, not an invariant.
23. **`windowHeld` survives an ABORT.** Its own fixture, ordered the OPPOSITE way to C18's pair: on one
    page, A′ (held, `synced_at` OLDER so it is processed first) then B′ whose home push the stubbed
    Graphiti throws on ⇒ `ProjectionAbortError` ⇒ `runGraphProjection` still reports
    `windowHeld === 1`. Without a staged abort, dropping `windowHeld` from `partialSummary()` or from
    the abort merge (`run.ts:347-360`) is unobservable and MU30's first two runs redden nothing.
    Separately, at unit level: `windowHeld` appears in `projectionRunInput`'s meta, and a completed,
    otherwise-quiet **hold-only** run (`projected 0`, `errors []`) still records — the witness that
    isolates the recording clause from `errors.length`.
24. The REAL reader returns `true` with `staging_marker` present and `false` without — the one thing
    the unit tier cannot prove. The table is created and dropped in `finally`: the dm harness truncates
    rows, not DDL (`test/datamechanics/setup.ts:75`), so a leaked marker turns every later projector dm
    test into a refusal that reads like a product bug. C18/C21 use **separate fixtures** and do not
    plant the marker (D6: no marker + window ⇒ bounded), so C21 cannot collide with C1's refusal or
    inherit C18's ledger rows.

**The docs contract (unit)**

25. `docs/OPS.md` §11 documents `GRAPH_PROJECT_WINDOW_DAYS`: unset on a staging database means
    **refuse**, **no default is promised**, the measured cost per window, why it is prose rather than a
    table row, and that the §11 table describes the pre-STGENV-4 state. The clauses are asserted
    separately, so deleting the "refuse" sentence and deleting the "no default" sentence redden
    different assertions.
26. **All five** "no code here closes it" sites are updated: the completion message and the two
    docstrings in `scripts/staging-refresh-decision.mjs` (`:92-97`, `:488-493`), its guard
    (`test/guards/staging-refresh.test.ts:546`), and `docs/OPS.md:750`.
27. `docs/ARCHITECTURE.md`'s projection flow names **both** the refusal and the window — asserted as
    two clauses, since either can regress alone.

---

## Mutation table

Rewritten twice. Draft 3's aimed six mutations at criteria they could not redden; draft 4's had no
mutation on `run.ts` at all, so the bound could be left un-wired with every row green. Each row names
the criterion that **must** redden; where a sibling also reddens, it is named, because a shared kill
does not establish the intended criterion unless the criterion is exercised in isolation.

| # | mutation | must redden | also reddens |
|---|---|---|---|
| MU1 | delete the refusal branch entirely | C1 | — |
| MU2 | drop the `marker` term (refuse whenever the window is unset) | C5 | — |
| MU3 | drop the `!window` term (refuse whenever the marker is present) | C2 | — |
| MU4 | default the window to 7 days when unset | C1 | C5 |
| MU5 | freeze the clock at a module-load constant | C3 | C2 — run C3's arms independently |
| MU6 | accept `0` as a valid window | C4 (`0` case) | — |
| MU7 | accept a fractional window (`2.5`) | C4 (fractional case) | — |
| MU8 | `Number()` a non-numeric window and proceed unbounded on `NaN` | C4 (non-numeric case) | — |
| MU9 | treat `""` as INVALID rather than unset | C5 (`""` arm) | C1's `""` arm |
| MU10 | ignore the window when the marker is absent | C6 | — |
| MU11 | swallow the marker read's throw and treat it as `false` | C7 | — |
| MU12 | make the unknown-state reason reuse C1's text | C7 (text arm) | — |
| MU13 | move the decision ABOVE the `client.configured` return | C10 | — |
| MU14 | move the decision below `resolveTeams`, into the team loop | C9 | — |
| MU15 | **delete `workAtFloor:` from the call at `run.ts:249`** | C11 | C18, if C18 also drives `runGraphProjection` — so C11 states its own `limit` and page layout |
| MU16 | forward the floor on the FIRST page only | C11 (page-2 arm) | — |
| MU17 | set `errors: []` on the refusal, keeping `ok:false` (behavioural — deleting the field may not compile) | C14 | C15's `ok` arm, C16, C17 — exercise each consumer directly (C17 = the battery script) |
| MU18 | drop `refused` from `projectionRunInput`'s meta | C15 | — |
| MU19 | re-add a `projectSlackToGraph`-shaped exported wrapper calling `projectItemsToGraph` | C12 | — |
| MU20 | add a second `to_regclass('public.staging_marker')` query under `lib/graph/` | C13 | — |
| MU21 | gate on `synced_at` instead of `work_at` | C18 (BOTH arms — that is what the pair is for) | — |
| MU22 | define `held` as `rowsForItem.length === 0` | C18 (**orphan** arm — see below) | — |
| MU23 | place the hold AFTER the reservation INSERT (`:1533`) | C18 (zero-rows arm) | — |
| MU24 | **drop the D3e refusal entirely** (proceed bounded with an initiative present) | C19 (a) arm | — |
| MU25 | make the D3e refusal fire whenever a window is set, fan-out surface or not | C19 (negative arm) | C18, C11 — both are bounded runs and redden first, so run C19's negative arm alone |
| MU25a | check term (a) only — ignore `deferred = true` rows | C19 (b) arm | — |
| MU25b | check term (b) only — ignore initiative pointers | C19 (a) arm | — |
| MU25c | `catch → false` on the detection read | C19 (throw arm) | — |
| MU25d | issue the detection queries even with no window configured | C19 (no-window arm) | — |
| MU26 | apply the floor as `gte("work_at", floor)` on the SELECT instead of gating the push | C20 | C18's count arm — run C20 independently |
| MU27 | apply a floor of "now" when no window is configured (a concrete fallback, not `undefined`) | C21 | — |
| MU28 | return `windowHeld` as `0` while still holding (behavioural, not a deleted field) | C18 (count arm) | C22 |
| MU29 | also `skipped++` on the held exit | C22 | — |
| MU30 | drop `windowHeld` from `partialSummary()`; separately from the abort merge (two runs) | C23 (abort fixture) | — |
| MU31 | drop `windowHeld` from `projectionRunInput`'s meta | C23 (meta arm) | — |
| MU32 | remove `windowHeld` from `shouldRecordProjectionRun` | C23 (hold-only witness) | — |
| MU33 | make the shared reader return a constant `false` | C24 | — |
| MU34 | delete the OPS §11 "refuse" sentence; separately, add "defaults to 30 days" (two runs) | C25 | — |
| MU35 | revert any ONE of the five hazard-wording sites (five runs, one each) | C26 | — |
| MU36 | remove "refusal" from `ARCHITECTURE.md`; separately remove the window (two runs) | C27 | — |

**MU22 needs a fixture the obvious one cannot supply — and I retracted it once, wrongly.** An earlier
pass claimed the two predicates are *equivalent* under D3e (no fan-out surface ⇒ a held item has no rows
at all ⇒ nothing can distinguish them) and struck MU22 out. That is false, and review caught the
over-correction: **D3e deliberately permits non-deferred orphan rows and old-slug home residuals** — the
benign states the tighter predicate exists not to refuse on. For an item carrying only such a row,
neither (a) nor (b) holds, so D3e permits the run, and yet `rowsForItem.length === 1` while
`existingRow === null` (the row matches neither home candidate, `project.ts:926-931`, and is excluded
from `fanoutRows` too). The correct predicate holds the item; MU22's replacement **admits it and reaches
the home `addEpisodes`**. So MU22 is live — it just cannot be killed by an empty-ledger fixture, which is
why C18 carries an explicit orphan arm and no longer claims its pass-2 arm does the job.

**Not mutation-testable, and said so rather than implied:** C8 (each refusal fires alone) is a property
of how the fixture set is constructed — MU2/MU3/MU10/MU11/MU24 each prove one reason is separable, and C8 is
the statement that the set covers all of them; it stays reviewable, not provable by mutation. C24's
`finally` drop is hygiene whose failure mode is a *later* test failing, which no mutation of this PR's
code produces.

---

## What would falsify this

- **A staging database extracting the full corpus** — the refusal did not reach the run (C9/C10), a
  default window crept in (C1/C4), or **the floor never reached the projector** (C11, the failure every
  other criterion stays green through).
- **A held item pushing on a later pass** — the gate sits after the reservation, so a `''` sentinel
  makes `existingRow` non-null (C18's zero-rows arm), or `held` keys on `rowsForItem` and an item
  carrying only an orphan row is admitted (C18's orphan arm).
- **A window running at all where a fan-out surface exists** — D3e's refusal did not fire (C19), on
  either term: a pointed initiative (a) or a `deferred` row (b). The interaction it guards is
  unspecified in both directions — a held fan-out push leaves an unlanded obligation that makes the
  whole partition unreadable, and an initiative-only item's maintenance is held forever.
- **A detection read failing OPEN** — `catch → false` read as "no fan-out" (C19's throw arm), which
  converts a database blip into the extraction it exists to prevent.
- **The detection queries running on a windowless production instance** — C19's no-window arm; D3e
  claims byte-identical behaviour there, and an unconditional query is not that.
- **A bounded run holding an item and not saying so** — `windowHeld` missing from a page sum, the abort
  merge, the meta, or the recording gate (C22/C23); the operator sees a quiet no-op. *(`projected == 0`
  on a healthy SECOND bounded run is CORRECT — everything eligible is already in the ledger. Coverage is
  read off `scanned`/`skipped`/`windowHeld` on a **non-aborted** pass, never off `projected`.)*
- **An out-of-window item whose tier flip leaves old-group episodes searchable** — C20 regressed and the
  B2 leak is back.
- **Production refusing, or behaving differently, with no marker and no window** — C5/C21 failed.
- **The window inert on production** — C6 regressed.
- **An invalid window silently becoming unbounded** — C4 regressed and the trap is re-armed.
- **A production admin told to set a staging knob during a DB outage** — C7's text arm regressed.
- **Two answers to "am I staging" inside `lib/`** — C13 drifted.

**Explicitly NOT falsifiers**, because draft 4 wrote them as such and they contradict D3/D3c:
an in-ledger item older than the floor re-extracting on a body change, a tier flip, a chunk-cap raise
or an armed fan-out copy is the **designed** behaviour — the window bounds admission, not maintenance.
An item held forever on production because its `work_at` predates the floor (D3d) is likewise the
predicate working, with "unset the window and run once" as the recovery.
