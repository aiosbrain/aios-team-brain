# The stall probe cannot tell "found nothing" from "could not read" — STALLSCOPE-1

**Status:** spec, draft 3. Drafts 1 and 2 were each BLOCKED by two independent cold reads; every
finding is folded, and the disagreements between the reviewers are resolved explicitly below.
**Rebased onto `origin/main` at `de16085`** — PCCC-3 (#547) and PCCC-4 (#549) merged mid-spec and
they rewrote this slice's central files; draft 2's code model was stale and is re-derived here.
**Related:** `docs/design/graph-stall-probe-liveness.md` (STALLPROBE-1, which introduced the liveness
half and deferred this), `docs/design/census-sample-floor.md` (CENSUSFLOOR-1, the same "never accuse
without standing evidence" rule), `docs/design/phase-c-per-project-graphs.md` (whose §2.1 consumer
audit already repaired one of these reads).
**Code:** `lib/graph/extraction-health.ts`, `lib/query/retrieval-health.ts`,
`lib/ingest/pipeline-health.ts`, `components/admin/retrieval-health-card.tsx`, one additive migration.

---

## 0. What is wrong

Three defects in one predicate, all the same shape — a value that cannot tell an **absence of
evidence** from **evidence of absence**. Two were written down and deferred when STALLPROBE-1 shipped
(`lib/graph/extraction-health.ts:56-66`); the third was found while specifying this slice.

**(a) The liveness read collapses "read fine, found nothing" into `null`.**
`newestEpisodicAtMs(groupIds)` returns `null` for five different situations: Neo4j unconfigured, the
read threw, the ledger scope was unreadable, the team pushed nothing — and *the read succeeded and
this team's groups hold zero ledger-backed episode nodes*. The predicate maps `null` to "can't tell ⇒
not stalled", which is right for four of them and loses the fifth entirely.

**(b) The never-extracted half counts facts GLOBALLY.** `countGraphFacts()` counts every `RELATES_TO`
in the database, so on an install with any other team — or any group the ledger never pushed —
`facts === 0` is false forever and that half is permanently disarmed for the team that is broken.
With (a), a team whose extraction has never once succeeded is silent on both halves.

**(c) The floor does not protect a fresh install, and it is measurably not close.**
`MIN_EPISODES_FOR_EXTRACTION_SIGNAL = 25` exists so a fresh install still mid-first-extraction cannot
be accused. Measured against prod:

| measurement | value | source |
|---|---|---|
| first real push → the 25th | **17 seconds** | `graph_episodes` |
| real ledger rows in the first hour | **175** | `graph_episodes` |
| median gap between consecutive episode extractions | **0.99 min** (≈1 episode/minute) | `llm_usage`, `call_kind='extract_nodes'`, 30d |
| peak episodes extracted in one hour | **75** | same |

At t+17s a healthy install has zero facts and the floor is already cleared, so
`deriveGraphExtractionStalled` returns true (`lib/graph/extraction-health.ts:139-142`), the card leg
goes red (`lib/query/retrieval-health.ts:278-296`) and the loud synthetic `graph_extract` leg is
appended `confirmed` by construction (`lib/ingest/pipeline-health.ts:346-364`).

**Three honesty corrections that lower this defect's severity, all from review:** it is **transient**
(it clears the moment the first completed job writes one fact — at 1 episode/minute, minutes); **no
email fires** (the mailer reads only the census, `lib/graph/extraction-alert.ts:320`, and says so at
`:453` — draft 1 claimed otherwise); and the numbers above are **ledger rows**, one per (item, group)
since PCCC-3, each standing for one or more chunk episodes.

**Reachability.** Prod runs one team (2,395 real rows, groups `aios_team`/`aios_external`, oldest push
2026-07-03), so (a) and (b) change **no verdict on prod today**. They are correctness for the
multi-team case the code documents plus honest per-team numbers; (c) is reachable on every new install.

## 1. Why the shape matters more than the bug

Every uncertain case here returns "not stalled", which is right — "don't know" must never read as
"broken". The cost of expressing that with `null` is that the one case where the graph gave a
definitive answer is indistinguishable from the four where it gave none.

The same applies in the accusing direction. Scoping the fact count to the team's ledger groups is a
**narrowing**, and a narrowed count that reads 0 ACCUSES. Draft 1 hedged the copy with "graphiti
normalises `group_id` characters" — **false on the pinned wheel**: `validate_group_id` checks
`^[a-zA-Z0-9_-]+$` and raises, never rewrites (`graphiti_core/helpers.py:136`); the only character
transform is on the dynamic Entity *label* (`nodes.py:1065`). The ids the projector writes are the ids
the graph stores. A mismatch is reachable only through an app-side scheme change or a stale ledger,
which is why §2f keeps it in the copy — for that reason, not for a normalisation that does not exist.

## 2. The decision

### 2a. A discriminated liveness read

```ts
export type ExtractionLiveness =
  | { kind: "unreadable" }        // unconfigured, threw, unparseable stamp, or no ledger scope
  | { kind: "none" }              // the read SUCCEEDED; these groups hold no ledger-backed episode node
  | { kind: "at"; atMs: number }; // newest completed job (START instant — see newestEpisodicAtMs)
```

| situation | kind |
|---|---|
| Neo4j unconfigured / query threw / stamp unparseable | `unreadable` |
| ledger read failed, or the ledger holds no real rows (no scope to query) | `unreadable` |
| query ran, `max()` over an empty set | **`none`** |
| query ran, timestamp parsed | `at` |

`none` means exactly *"no `items:`-prefixed episode node currently exists in these groups"* — not "the
extractor is dead". §2e and §2f are where that distinction is paid for.

### 2b. Per-team facts, from one read

`countGraphFacts()` and `newestFactAtMs()` (both global) are replaced by ONE group-scoped read
returning both numbers, so the count on the card and the "newest fact" beside it cannot come from two
populations or two instants:

```cypher
MATCH ()-[r:RELATES_TO]->() WHERE r.group_id IN $g
RETURN count(r) AS n, toString(max(r.created_at)) AS at
```

Index-supported (`relation_group_id`, `graphiti_core/graph_queries.py:68`). **No performance claim is
made** — an earlier slice made one and had to withdraw it. `null`, never `0`, when unconfigured, when
the read throws, or when there is no scope: an `IN []` match returns a genuine `0` that would read as
a proven-empty graph.

Facts carry no episode name, so this count includes facts from `correction:<arc_id>` episodes, which
`lib/graph/arcs.ts:1321` posts into the same group with no ledger row. `facts > 0` therefore does NOT
imply item extraction ever ran — §2e gives that state its own cell instead of assuming it away.

### 2c. One ledger read, one snapshot

Today the episode count and the group scope are two concurrent SQL reads
(`lib/graph/extraction-health.ts:463-471`), so an insert, a purge or a sentinel transition between them
can produce `items > 0` with `groups === []`. One statement closes it:

```sql
select count(distinct (source_table, source_id))::int as items,
       min(first_seen_at)::text     as first_seen_at,
       max(projected_at)::text      as newest_push_at,
       array_agg(distinct group_id) as groups
  from graph_episodes
 where team_id = $1 and content_sha256 <> ''
```

Three outcomes, distinct: **unreadable** (threw), **empty** (no real rows), or a reading.
`count(distinct (source_table, source_id))` is PCCC-3's expression, adopted verbatim — that repair
already shipped (`lib/graph/extraction-health.ts:362` on `origin/main`), and draft 2's
`count(distinct source_id)` would have silently narrowed its key. Under PCCC-5 fan-out one item holds
one row per group, so counting rows would inflate the floor by the average partition count.

`content_sha256 <> ''` now excludes **three** kinds of row, not two: redaction tombstones, tier-vacate
rows, and — since PCCC-3's reserve-before-push — **unlanded reservations**. All three are correct to
exclude: none of them was ever accepted by graphiti.

### 2d. The clock the age gate needs does not exist yet, so this slice adds it

Draft 2 gated on `min(projected_at)`. Both reviewers refuted it with the schema's own comment:
`projected_at` is bumped by every content re-push (`postgres/schema.sql`, written at
`lib/graph/project.ts`), so it is a LAST-touched stamp — a re-pushed corpus keeps the minimum inside
the window and silences a dead-from-birth extractor indefinitely.

So `graph_episodes` gains **`first_seen_at timestamptz not null default now()`** — named for what it
is, after review rejected `first_projected_at`: under reserve-before-push the row is created as an
unlanded reservation *before* `addEpisodes`, so this is **when the projector first created the ledger
row**, not when a push was first accepted. If graphiti is down at install time the reservation stands
while pushes fail, so the value can predate the first accepted push by the length of that outage —
stated, and accepted, because it errs toward judging sooner and the copy never quotes it as a
"projected at" time.

**Set-once over all four write paths** — `origin/main` has four, not draft 2's two: the reservation
INSERT (the only row-creating path, which takes the column's default), the group-move explicit UPDATE,
the redaction upsert, and the final upsert. None may name the column in its payload; the adapter's
`ON CONFLICT DO UPDATE SET` lists only provided keys (`lib/db/pg/query-builder.ts:393`), so omission is
sufficient, and a guard pins it rather than trusting that.

**The migration is the load-bearing half, and it needs its own guard.** `schema.sql`'s
`create table if not exists` is a no-op on an existing table, while the dm tier and CI both load from
zero — so a column added ONLY to `schema.sql` passes every test in §3 while **prod never gains it**,
the §2c statement then errors, every read returns unreadable, and the probe goes permanently silent
with nothing announcing it. That is this file's own self-disarming failure class, so §3 pins the
migration's existence and its agreement with `schema.sql`.

**Grace = `LANDED_GRACE_MS`**, imported from `lib/graph/reconcile` rather than invented: it is already
this repo's answer to "an episode legitimately isn't in the graph yet" for this exact seam
(`max(5 min, PROJECTION_INTERVAL_MS)`, 1h at the default cadence) against a measured ~1 minute to first
completion. **Stated coupling:** it tracks `GRAPH_PROJECT_MINUTES`, so an operator tuning the projector
to a 5-minute cadence also cuts this grace to 5 minutes. That is tolerable only because of §2e's
corroboration, which is what actually carries the cold-start case.

### 2e. Loud needs corroboration; the age gate alone cannot bound a cold start

Codex's round-2 blocker, confirmed by measurement: the grace cannot bound time-to-first-completion,
because the worker is serial and a cold team can queue behind another team's backlog. At the measured
~1 episode/minute, prod's own first ingest hour (175 rows) is ~3 hours of queue — a healthy team
arriving behind it has no completion for hours. No fixed constant fixes that; evidence does.

**So the zero-evidence branches go LOUD only when the graph shows no completion ANYWHERE inside the
lag budget** — i.e. the worker itself is idle or dead. When it is provably completing other work, the
same state renders as a **card observation** instead: true, visible, not a banner. This is the
`unconfirmed`-vs-`confirmed` distinction BANNERFLAP-1 introduced, applied to a different signal.

The global read this needs is one `max(Episodic.created_at)` with no group filter — the same shape
STALLPROBE-1 removed as the team's *clock*. It is not the clock here, and it can only ever SUPPRESS
loudness: it never accuses, never feeds the lag branch, and never suppresses the observation. The
masking that made it wrong as a clock is precisely the property that makes it right as a
liveness-of-the-worker corroborator.

**The state table.** `gate` = the team's `first_seen_at` is older than `LANDED_GRACE_MS`; `worker idle`
= global newest `Episodic` is absent or older than `EXTRACTION_LAG_BUDGET_MS`; every row assumes
`items ≥ MIN_ITEMS_FOR_EXTRACTION_SIGNAL` (below it, and for a null/empty ledger, never stalled and no
observation). The lag axis exists only where a completion exists.

| liveness | facts | gate | worker | verdict | cause / output |
|---|---|---|---|---|---|
| `unreadable` | 0 | passed | idle | **stalled** | `no-facts` (makes no completion claim) |
| `unreadable` | 0 | passed | busy | not stalled | observation |
| `unreadable` | 0 | not passed | any | not stalled | — |
| `unreadable` | >0 or null | any | any | not stalled | — |
| `none` | 0 | passed | idle | **stalled** | `no-facts` (adds "and nothing has ever completed") |
| `none` | >0 or null | passed | idle | **stalled** | `never-completed` |
| `none` | any | passed | busy | not stalled | observation |
| `none` | any | not passed | any | not stalled | — |
| `at`, lag ≤ budget | 0 | passed | idle | **stalled** | `no-facts` (adds "jobs are completing") |
| `at`, lag ≤ budget | 0 | passed | busy | not stalled | observation |
| `at`, lag ≤ budget | 0 | not passed | any | not stalled | — |
| `at`, lag ≤ budget | >0 or null | any | any | not stalled | — |
| `at`, lag > budget | any | any | any | **stalled** | `stopped` (`no-facts` copy takes precedence when facts are 0 **and** its own row above fires) |

Three decisions inside that table, each a fold:

- **`facts === 0` can accuse even when liveness is unreadable.** The reviewers disagreed here: Fable
  judged the loss acceptable and asked only that it be named; Codex called it a HIGH, because a
  query-specific timeout on one of two independent `runRead` sessions (`lib/graph/neo4j.ts`) can leave
  a definitive `facts === 0` vetoed by a transient — masking the original 2026-07 shape. Codex's
  direction wins because the cost of following it is only that the copy must not claim anything about
  completions, which the `no-facts` wording already avoids. Draft 2's contradiction ("unreadable can
  never accuse") is resolved by dropping that rule rather than the criterion that collided with it.
- **The lag branch is never gated and never suppressed** — it measures from an actual completion, so
  it has standing evidence by construction. Draft 2's table contradicted its own prose here (a mature
  team is inside the grace for one window after the migration backfill, which must not silence a real
  lag stall).
- **Below the floor, nothing is emitted at all** — not even an observation. That row is the whole of
  defect (c) and it is pinned in §3 rather than assumed.

### 2f. Copy that says only what is known

`ExtractionStallCause` becomes `no-facts | never-completed | stopped` — renamed so every consumer
breaks at compile time and so no name asserts a diagnosis the evidence does not carry (draft 2's
`zero-yield` asserted a yield regression; `never-extracted` asserted a dead worker).

- **`no-facts`** — the scope holds zero facts. It states that, plus a liveness clause chosen by kind:
  "no job has ever completed for this team", "jobs are completing (newest ~Xh ago)", or "whether jobs
  are completing could not be read". Causes offered, none asserted: extraction completing while
  extracting no relations (a prompt/schema change on a graphiti upgrade), content that yields none, a
  group-id/episode-name scheme change, or a graph-store restore.
- **`never-completed`** — no episode in the projector's format has ever completed for this team, while
  the graph holds facts in those groups (arc corrections write facts with no ledger row) or the count
  could not be read. It may not print a fact count when facts are `null` — the `stopped` copy already
  has that rule (`lib/graph/extraction-health.ts:437-440`) and it now applies to all three. Causes
  named: the worker failing every job for this team's groups; **a graph-store wipe or restore, which is
  PERMANENT because the ledger's content hashes suppress re-pushing** (the repair is a forced
  re-projection, not waiting); a scheme change.
- **`stopped`** — unchanged in shape, now quoting team-scoped facts.
- **The observation** (not a cause, never on the banner): "N items projected, no completed extraction
  for this team yet — graphiti is completing other work, so this is most likely queue depth."

No rendered stall string contains a `group_id`; the copy says "this team's graph groups".

### 2g. One producer, and a guard that survives it

`lib/query/retrieval-health.ts` and `getGraphExtractionHealth` each assemble the same signals from the
same reads — two implementations of one verdict, which is how one surface keeps a bug the other fixed
(it happened here: the card missed the liveness field entirely). PCCC-3 has already pulled them apart
again: it changed `countProjectedEpisodes` to count distinct items but left `graphFreshness`
(`lib/query/retrieval-health.ts:380`) counting rows, so under fan-out the card's number and the
predicate's number diverge — the "one number shown, a different one reasoned about" defect this file
fixed once already. Both move to one `readExtractionSignals(teamId)`, whose return shape is part of the
contract (the ledger aggregate, the liveness, the facts, and the derived verdict/cause/observation),
because both surfaces and the dm tier consume it.

That deliberately breaks three existing tests, all named here rather than discovered:
`test/guards/extraction-stall-callsites.test.ts` (its vacuity anchor requires ≥2 direct predicate call
sites), `test/datamechanics/graph-extraction-scope.datamechanics.test.ts` (imports two reads that stop
being exported), and `test/guards/graph-lag-probe-sentinel.test.ts` (string-pins
`export async function newestEpisodeAtMs`).

The replacement guard keeps the property the old one existed for — a NEW surface composing its own
verdict — which an import-allowlist alone cannot do, because a new file can write its own Cypher. It
therefore scans `lib/ app/ components/ scripts/` (the trees `tsconfig` typechecks) for the raw signal
signatures — a `RELATES_TO` count, a `:Episodic` `max`, and the `graph_episodes` aggregate — outside an
allowlist of `lib/graph/extraction-health.ts` (plus `lib/graph/learning.ts`, which legitimately reads
`Episodic` for the Learning panel), comments stripped, plus a real-call-expression pin that both
surfaces obtain the verdict through the producer, plus a non-vacuity fixture proving a planted third
assembler fails.

## Dependencies

**Deps: none to merge; two merged mid-spec and this is rebased onto them.** PCCC-3 (#547) changed
`lib/graph/extraction-health.ts` (distinct-item count), rewrote `lib/graph/project.ts` to reserve the
ledger row before pushing, and moved the ledger identity to per-(item, group); PCCC-4 (#549) dropped the
narrow unique and added stored partition pointers. §2c, §2d and §2g are written against `de16085`, and
the slice deliberately preserves PCCC-3's expression rather than re-deriving one. PR #548 (LLMOBS-2)
touches no file here except `docs/ARCHITECTURE.md`.

## Build-with

**Build-with tier: Fable / high effort.** An alarm predicate where both error directions are expensive
— a false positive is defect (c), a false negative hides a real extraction outage (a/b) — plus an
accusing-direction narrowing whose failure mode is a healthy graph called dead, a schema column whose
contract is "written once, never updated" across four write paths, and a discriminated type every
consumer must handle. Two adversarial review rounds on the spec (both BLOCKED, both folded) and two on
the diff.

## Tier safety

No tier surface changes and no content leaves the graph: counts and timestamps only, never a name, a
body, or a `group_id`. The fact read is NARROWED from global to the team's ledger groups. The one
global read (§2e) returns a single timestamp and can only suppress an alarm. No rendered stall string
contains a group id. The new column carries a timestamp. No new API route, no change to
`visibleItems`/`visibleTasks`/`visibleGroupIds`.

## 3. Acceptance criteria

- `test/graph-extraction-health.test.ts` — the §2e table is asserted row by row (canonical rows, with the lag axis only on `at` rows), verdict AND cause AND observation, so no combination is left to be discovered in production.
- `test/graph-extraction-health.test.ts` — below `MIN_ITEMS_FOR_EXTRACTION_SIGNAL`, and for a null or empty ledger, the result is never stalled and carries no observation — defect (c)'s protection, pinned rather than assumed.
- `test/graph-extraction-health.test.ts` — a definitive `facts === 0` still accuses when liveness is `unreadable` and the worker is idle, and the resulting copy makes no claim about completions.
- `test/graph-extraction-health.test.ts` — a fresh global episodic clock suppresses loudness on every zero-evidence row and turns it into an observation, and it never suppresses the lag branch and never changes a verdict where facts are non-zero.
- `test/graph-extraction-health.test.ts` — a stalled verdict always yields a non-null cause and a non-empty reason; asserted over the whole table, since a null cause renders an empty red banner and a `graph_extract` leg with `error: null`.
- `test/graph-extraction-health.test.ts` — no reason string prints a fact count when facts are `null`, on all three causes, and none contains a `group_id` (fixture groups are distinctive strings). Scoped to the stall copy: the card's census table legitimately renders per-group rows.
- `test/graph-extraction-health.test.ts` — the `never-completed` copy names graph-store loss and states that the content hashes suppress re-pushing; the `no-facts` copy offers causes without asserting that a regression occurred.
- `test/graph-extraction-health.test.ts` — the gate is exercised at `LANDED_GRACE_MS − 1`, `LANDED_GRACE_MS` and `+1` against the value imported from `lib/graph/reconcile`, so a name-only import cannot satisfy it and the two derivations cannot drift.
- `test/graph-extraction-health.test.ts` — with `runRead` mocked, the scoped reads return the unreadable form and issue NO query when there is no scope, so an `IN []` zero can never become an accusation; and the ledger aggregate is one `runSql` call (spied), which is the "one snapshot" property the dm tier cannot observe.
- `test/datamechanics/graph-extraction-scope.datamechanics.test.ts` — real Postgres: `first_seen_at` survives a content re-push that moves `projected_at`, AND survives the group-move UPDATE path (tier flip), proving set-once across the write shapes that exist on `origin/main`.
- `test/datamechanics/graph-extraction-scope.datamechanics.test.ts` — real Postgres: the ledger read returns items/groups/both timestamps in one statement; a team holding only `''` rows (redaction tombstones, tier-vacate rows, or unlanded reservations) reads as empty, so none of them can arm the gate or widen the scope.
- `test/datamechanics/graph-extraction-scope.datamechanics.test.ts` — real Postgres: two ledger rows for one item in two groups (the PCCC-5 fan-out shape) count as ONE item, preserving PCCC-3's repair through the move to the producer.
- `test/guards/graph-episodes-first-seen-migration.test.ts` — a build-failing guard: a `postgres/migrations/*` file adds `first_seen_at` and its column definition matches `schema.sql`'s. Without this, a `schema.sql`-only change passes every test above while prod never gains the column and the probe goes permanently silent.
- `test/guards/extraction-stall-callsites.test.ts` — a build-failing guard: no file in `lib/ app/ components/ scripts/` outside the allowlist contains the raw signal signatures (comments stripped), both surfaces obtain the verdict through `readExtractionSignals` as a real call, and a planted third assembler fixture fails the guard.
- `components/admin/retrieval-health-card.tsx` — the short leg text is a `Record<ExtractionStallCause, …>`-typed map over all three causes, so a fourth cause fails the build instead of rendering the `stopped` wording; the observation renders as a note, never as a red leg.
- `docs/ARCHITECTURE.md` — the graph-extraction row records team-scoped facts, discriminated liveness, the corroborated loud path, the set-once `first_seen_at` gate, and the item-vs-episode naming.

## 4. Deliberately NOT in this slice

- **The band-dependent edge-yield sensor.** `no-facts` catches only exactly-zero facts; detecting yield
  DROPPING needs a measured band (PIPEFF-2's pattern applied to edges).
- **Per-group verdicts.** The team's groups are judged as one population, so a new partition on a
  mature team is inside neither the gate nor a per-group check — that stays the census's job.
- **Re-deriving the floor.** Renamed to `MIN_ITEMS_FOR_EXTRACTION_SIGNAL` because it counts items, not
  episodes (one item is ≥1 episode, so the floor errs long); re-measuring it is empirical work.
- **Repairing a wiped graph.** The copy names the repair; building a "re-project everything" action is
  its own slice with its own cost question.
- **Collapsing the two surfaces.** The producer removes the duplicated derivation; two renderings
  remain, which is a product question.
- **`CDCCHURN-1`**, the next slice.

## 5. What would falsify this

If a healthy install reported `no-facts` or `never-completed` with a full graph, the scoped reads would
be wrong — the ledger's `group_id`s would not be the graph's. The check beside it is the census, which
reads the same ids; note it refuses with `predicate-suspect` in the graph-wipe case too, so it
discriminates a scheme mismatch from a wipe only together with the fact count.

The opposite falsifier: a dead extractor still called healthy. After this change the ways that can
happen are written down rather than discovered — a job completing while extracting nothing when
non-zero facts already exist (out of scope); a Neo4j read that fails rather than answers; a team whose
work is queued behind a busy worker (observation, not alarm — deliberate); and the first
`LANDED_GRACE_MS` of a new install. If the corroboration ever suppresses a real outage for a whole
install, the global clock would have to be fresh while every team's extraction is dead, which requires
something other than `add_episode` writing `Episodic` nodes — the same inversion STALLPROBE-1's source
audit enumerated.
