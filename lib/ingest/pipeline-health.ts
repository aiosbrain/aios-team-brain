import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { getGraphExtractionHealth, GRAPH_HEALTH_SOURCE } from "@/lib/graph/extraction-health";
import { classifyFailure, type FailureClass } from "@/lib/ingest/failure-streak";

/**
 * Aggregate ingestion-pipeline health for a LOUD admin surface. Every pipeline leg (slack/plane/
 * linear/github ingest, dense index, graph projection, meeting-notes backfill, linear-inbound, …)
 * records its outcome to `ingest_runs`. The retrieval-health card + runs table already show detail,
 * but a persistent failure (the graph projector 422'ing for WEEKS) hid as one red row nobody watched.
 * This collapses the pipeline to a single "is anything broken?" verdict + the offending legs, so a
 * broken pipeline is impossible to miss instead of buried.
 *
 * Best-effort: a healthy/empty verdict on any error, so it never breaks a page render.
 */

/** A leg is stale if its newest run is older than its cadence — it was running, then went quiet
 *  (poller wedged / a source that silently stopped). Default comfortably past the 30m ingest + 60m
 *  graph cadence. */
const STALE_MS = 3 * 60 * 60 * 1000; // 3h default

/**
 * Per-source staleness overrides. A blanket 3h threshold cries wolf on legs that legitimately run
 * less often (a 24h housekeeping job is "stale" 21h/day under 3h). So each infrequent/irregular leg
 * gets its OWN threshold = its cadence + grace, and `null` means "never flag on age" (unscheduled /
 * reactive / event-driven — real failures still surface via `ok=false`). Anything not listed uses the
 * 3h default. `auth_cleanup` runs every 24h (`lib/ingest/scheduler` housekeeping) — 3h was the bug
 * that fired this banner on a healthy job.
 *
 * BANNERFLAP-2 (`docs/design/staleness-threshold-fit.md`). Staleness has NO debounce — the failure
 * side got one in BANNERFLAP-1, but `stale` is derived from a single timestamp per page load, so one
 * late tick reddens the banner immediately. That makes a mis-fitted threshold here directly visible
 * to the user as "N ingestion legs are broken", and it has now happened six times. The thresholds
 * below marked "fitted" were set from MEASURED prod cadence (7 days, `trigger='scheduler'` rows only
 * — the same filter the staleness clock uses), not from a guess.
 *
 * WHAT THE TAIL ACTUALLY IS — measured, because the obvious answer was wrong. It is NOT each leg's
 * own cadence, and it is NOT chain congestion (a slow upstream stage delaying downstream recording),
 * which is what an earlier draft of this claimed. Counting scheduler rows inside the single worst gap
 * (2026-08-17 04:27→09:18 UTC): `slack`/`linear`/`linear_inbound` recorded 13 times,
 * `github`/`access_bootstrap` 7, and `context_backfill`/`context_backfill_all`/`meeting_notes`/
 * `doc_task_infer`/`dense` recorded ZERO. The loop was alive and ticking the whole time — congestion
 * would have delayed `slack` too, and it did not. The tick was being TRUNCATED partway down the
 * chain, eight passes in a row.
 *
 * Two consequences worth having in front of you before you touch these numbers:
 *   1. The tail moves with deploy/restart churn, NOT corpus size. A bar fitted to it is fitted to how
 *      often a tick fails to finish.
 *   2. These three are therefore weaker heartbeats than they look: their age is "last time a tick got
 *      this far", not "last time the poller ran". They are kept finite anyway because a genuinely
 *      dead scheduler is caught at 3h by the UPSTREAM legs regardless — so widening them costs no
 *      dead-scheduler detection, and nulling them would delete the only deep-chain-wedge signal.
 *
 * The real defect underneath (the deep half of the chain silently not recording when a pass does not
 * complete) is DEFERRED, not dismissed — it is instrumentation work that changes what every leg's row
 * means, and it wants its own measurement of restart frequency. See the spec's §Scope.
 */
const STALE_MS_BY_SOURCE: Record<string, number | null> = {
  llm: null, // event-driven; not a banner leg at all since LLMOBS-1 — see NOT_PIPELINE_LEGS
  scan: null, // manual / CI
  pm_sync: null, // reactive — its own staleness heuristic lives in lib/pm-sync/runs
  // One-time marker-guarded materialization (PRET-4): the tick retry writes a row ONLY on
  // failure (success is the boot log + the marker), so "no row for N hours" is its healthy
  // steady state forever — a staleness threshold can only cry wolf; a recorded FAILURE row
  // still reddens via the failing set. (pret3_sweep's entry lives below with main's fuller
  // account of the class.)
  pret4_materialize: null,
  auth_cleanup: 26 * 60 * 60 * 1000, // 24h cadence + 2h grace (genuinely-stuck still surfaces)
  // FITTED, NOT NULLED (BANNERFLAP-2) — and fitted UNIFORMLY, which is the part that matters. All
  // three sit in the deep half of the tick chain and their large gaps are THE SAME EVENT: measured to
  // the second, they go quiet together (04:26:21 / 04:26:26 / 04:26:21) and resume together
  // (09:19:30 / 09:19:35 / 09:19:30). There is one tail here, so there is one number.
  //
  // 6h = the measured 293-min worst gap + ~67 min. An earlier fit gave `context_backfill` 5h from a
  // measurement window taken hours earlier that happened to miss the largest gap — 7 minutes of
  // grace, which would have reproduced this ticket within days. Re-measure before narrowing any of
  // these, and fit the SHARED tail, not a single window's maximum per leg.
  //
  // Widening is cheap here and that is checkable: a dead scheduler still reddens the banner within 3h
  // via slack/linear/github/access_bootstrap, which are upstream and on the default. What these three
  // uniquely detect is a wedge confined to the deep chain.
  //
  // KNOWN COST, stated not buried: `runMeetingNotesBackfill`'s OUTER catch (`lib/ingest/scheduler.ts`)
  // records no row at all, so if its `teams` read throws, staleness is the only detector — and 3h→6h
  // doubles that blind window. Deliberately not fixed here (it is a failure-path change, and the spec
  // scopes the failure path out); bounded because reaching that catch takes a DB-wide fault that
  // reddens the upstream legs at 3h anyway. Tracked as the next slice with the truncation defect.
  meeting_notes: 6 * 60 * 60 * 1000,
  context_backfill: 6 * 60 * 60 * 1000,
  // Written by the SAME `runContextBackfill` invocation as `context_backfill`, milliseconds later
  // (`lib/ingest/scheduler.ts`), so its gaps are identical BY CONSTRUCTION — measurement confirms it
  // (identical 276 runs / 293min worst / 78min p95). It must move with its sibling or the banner keeps
  // flapping on the leg alone. The spec's first draft fitted only two legs and would have shipped
  // leaving this one firing.
  context_backfill_all: 6 * 60 * 60 * 1000,
  // A LATENT recurrence, fixed pre-emptively rather than as the 7th instance. `runAutoFlip`
  // (`lib/ingest/scheduler.ts`) records ONLY when it flips, defers, or errors — a quiet pass returns
  // before `recordIngestRun`. It has zero rows today, so it is absent from `legs` entirely and is not
  // firing; but the first row it ever writes would age past the 3h default it would otherwise inherit
  // and pin the banner red forever on a healthy leg. That is the `doc_task_infer` class exactly.
  // PRET-6: the auto-flip subsystem retired — prod's ingest_runs history holds auto_flip rows
  // forever, and deleting this entry would re-inherit the 3h default and pin the banner red on
  // a dead leg (the doc_task_infer class). HISTORICAL source: kept null, written by nothing.
  auto_flip: null,
  // Records ONLY on failure — `runPret3BootSweep`'s caller (`lib/ingest/scheduler.ts`) writes a row
  // inside `if (s.error)` plus exactly ONE `ok:true` row when it ran cleanly, and the sweep is
  // marker-guarded so it no-ops forever after its first run that got past the marker insert — whether
  // that run then succeeded OR failed. Its newest row's age is therefore "time since the last
  // failure", never "last poll": on the 3h default a single error row would age past the bar and pin
  // the banner red PERMANENTLY, with no success path able to write a newer row to clear it. Same
  // class as `doc_task_infer`. Caught by `test/guards/ingest-leg-ledger` on the first leg added after
  // that guard shipped — which is the whole reason it scans call sites instead of trusting a list.
  pret3_sweep: null,
  // Record-only-when-active legs: their scheduler writes an `ingest_runs` row ONLY when the tick did
  // something (indexed/projected/applied) or errored — a quiet pass writes nothing. So the newest
  // row's age reflects "last time there was work", NOT "last time the poller ran", and an age-based
  // staleness check cries wolf on any normal quiet window (a weekend, an idle board). Real failures
  // still surface via `ok=false` on their actual runs, plus the residual probes on the retrieval-health
  // card: `dense` via its `pendingItems` backlog, `graph_project` via `isGraphStale` (6h-no-writes →
  // degraded). `linear_inbound` has no dedicated probe (a silently-wedged inbound lock is invisible) —
  // an accepted tradeoff since it's per-team opt-in and any throw records `ok=false`.
  // (Contrast the legs that record on every tick THEY REACH, which is a different and weaker property
  // than "every tick" — see the truncation note above. `runImport` records each CONFIGURED connector
  // (slack/plane/linear/github) "to prove the poller ran"; `runAccessBootstrap` writes an
  // unconditional instance-wide heartbeat; `runContextBackfill` writes a per-team row per succeeded
  // team PLUS an instance-wide `context_backfill_all` heartbeat; `runMeetingNotesBackfill` writes one
  // row per team unconditionally inside its loop. For all of those an age threshold IS meaningful.
  // What differs is only its VALUE: the connectors and access_bootstrap sit inside the 3h default
  // (worst observed 30–95min), the three fitted above are deep in the chain and share a 293min tail.
  // Nulling any of them would delete a real signal rather than fix a threshold bug.
  // Caveat on the connectors: `runImport` records only when that integration type is CONFIGURED, so a
  // connector with no enabled integration writes nothing — it is `isOrphanedConnector` (not this map)
  // that stops it crying wolf.
  // Note "scheduler row", not "last row": meeting_notes ALSO runs on demand from `aios push`
  // (trigger `api`), so the staleness clock below reads scheduler-triggered rows only — an on-demand run
  // must never be mistaken for proof that the poller is alive.)
  dense: null,
  linear_inbound: null,
  graph_project: null,
  // `arcs` records the narrative-arc CONTINUITY of a synthesis, and only when the model actually ran —
  // a hash-skip (unchanged facts) and a served-from-cache view both write nothing. So its newest row's
  // age is "last time arcs were re-synthesized", not "last time the poller ran", and any age threshold
  // would flag a team whose work simply hasn't changed. A failed synthesis records `ok=false` (tracking
  // `untrustworthy`, NOT `payloadDegraded` — the bytes served on that branch are the good prior that was
  // correctly kept, so payload health would have reported the failure as success).
  arcs: null,
  // The record-only-when-active rule in its strongest form. `doc_task_infer` IS polled reliably — the
  // scheduler calls it every tick for every team (`lib/ingest/scheduler.ts`), alongside the timeline's
  // background rebuild — so this is NOT a case of "maybe nothing triggered it". It is that FIVE of its
  // eight outcomes write no `ingest_runs` row at all: `cooldown` (12h, `DOC_TASK_INFER_INTERVAL_HOURS`),
  // `no-llm`, `no-candidates`, `nothing-to-score`, and `unchanged` all return before `record()`. So on a
  // quiet corpus — no new scoreable docs in the 7-day window — a perfectly healthy leg polled every 30
  // minutes still writes nothing for days, and its newest row's age is unbounded at ANY threshold. That
  // is why this is `null` rather than "12h + grace": no finite number is correct.
  //
  // Observed in prod flagging a leg that had never failed, on a measured 12.1–12.4h cadence, while every
  // connector was running on time — the banner said the brain wasn't getting fresh data when it was.
  // Real failures still surface: the model-null and thrown-error paths DO record (`ok=false`), and since
  // the cooldown counts failed runs too, a persistent failure keeps re-recording and stays the newest
  // row. Shortfalls also show as `workers_failed` in the run meta.
  doc_task_infer: null,
};

/** The age past which `source` is considered stale, or `null` to never flag it on age. Exported for
 *  unit tests (a wrong threshold here fires the loud banner on a healthy job — the auth_cleanup bug). */
export function staleThresholdMs(source: string): number | null {
  return source in STALE_MS_BY_SOURCE ? STALE_MS_BY_SOURCE[source] : STALE_MS;
}

/**
 * The ingestion legs that map 1:1 to a configured `integrations` row (source slug == integration
 * `type`). When such an integration is DELETED or DISABLED, the scheduler stops polling it and
 * (per `runImport`) records no new `ingest_runs` row — so its LAST row is frozen forever. If that
 * frozen row was a failure (a timeout, a since-revoked key), `distinct on (source)` keeps surfacing
 * it and the loud banner cries wolf about a source the team intentionally removed. These sources are
 * therefore suppressed from `failing` when no ENABLED integration of that type remains. Already-
 * ingested `items` are untouched — we only stop EXPECTING fresh syncs. Non-connector legs (llm,
 * dense, graph_*, meeting_notes, …) aren't integration-scoped and are never suppressed here.
 */
const CONNECTOR_SOURCES: ReadonlySet<string> = new Set(["slack", "plane", "linear", "github"]);

/**
 * Sources this banner does NOT speak for (LLMOBS-1). The banner's sentence is "N ingestion legs are
 * broken — the brain isn't getting fresh data", and that is FALSE for a generation leg: ingestion is
 * fine, a model failed.
 *
 * `llm` is here for a second, sharper reason review supplied: keeping it DOUBLE-COUNTS every arcs
 * failure. A failed synthesis writes a `source='arcs'` ingest row AND, via `record:`, a `source='llm'`
 * row (`lib/graph/arcs.ts:485-495`) — so one event lit two legs, which is literally the
 * "2 ingestion legs are broken" of the 2026-08-11 incident BANNERFLAP-1 was raised for. The codebase
 * already worked around the symptom instead of the cause: `arcs.ts:487` tunes a timeout specifically
 * so "a slow-but-healthy reasoning model" does not "fire the loud pipeline banner".
 *
 * Pulse loses nothing it had — the `arcs` leg stays and already covered those failures — and the
 * answering model now has its own truthful home-page banner fed by `getLlmHealth`
 * (`components/admin/generation-health-banner`), which names the failing feature, its model and its
 * error instead of implying the pipeline stopped.
 *
 * `graph_health` is excluded for an unrelated pre-existing reason (it is a transition ledger, not a
 * leg); the two are kept in one place so the banner's leg set is readable as a set.
 */
export const NOT_PIPELINE_LEGS: ReadonlySet<string> = new Set([GRAPH_HEALTH_SOURCE, "llm"]);

/** A connector leg is "orphaned" when its integration type is no longer enabled (deleted/disabled).
 *  Its frozen last-failure row is a fossil the scheduler can't overwrite — not a live break.
 *  `enabledTypes === null` means the config read FAILED — we don't know what's configured, so we fail
 *  OPEN (suppress nothing, keep every failing leg loud) rather than silencing a genuine break. */
function isOrphanedConnector(source: string, enabledTypes: ReadonlySet<string> | null): boolean {
  if (enabledTypes === null) return false;
  return CONNECTOR_SOURCES.has(source) && !enabledTypes.has(source);
}

export interface PipelineLeg {
  source: string;
  ok: boolean;
  error: string | null;
  at: string; // finished_at ISO
  stale: boolean; // ran before, but not recently
  /**
   * Is the failure standing evidence, or one sample (BANNERFLAP-1)? `ok` when the newest run
   * succeeded; `unconfirmed` for a lone failure — real and shown, but not loud; `confirmed` once the
   * streak reaches `FAILURES_TO_CONFIRM`. The synthetic `graph_extract` leg is `confirmed` by
   * construction: it has no runs to streak and is already debounced by its own detector.
   */
  failureClass: FailureClass;
  /**
   * The OLDEST failure in the current unbroken streak — what "failing since" must actually render.
   * Null when the leg is not failing, and null for `graph_extract`, which is not a point-in-time
   * failure and must not be given a fabricated instant.
   */
  failingSince: string | null;
}

export interface PipelineHealth {
  legs: PipelineLeg[];
  /**
   * Legs the loud banner names: a CONFIRMED failure or a stale poller. A lone unconfirmed failure is
   * deliberately absent — it is still `ok:false` on the leg and listed in Admin → Recent
   * ingestion runs. (NOT on the retrieval-health card: that card has no per-ingestion-source leg. It
   * has an answering-model leg, but `llm` is no longer a pipeline leg at all — see NOT_PIPELINE_LEGS.) `stale` is
   * independent of the classification and still loud on its own, including on a leg whose newest run
   * succeeded, because it answers a different question ("is the poller still ticking").
   */
  failing: PipelineLeg[];
  healthy: boolean;
}

type Row = {
  source: string;
  ok: boolean;
  errors: unknown;
  finished_at: string | Date;
  streak_length: number | string;
  failing_since: string | Date | null;
};

/**
 * Newest run per source, PLUS its current failure streak — one query, so the verdict and the duration
 * cannot disagree (BANNERFLAP-1).
 *
 * WHY A WINDOW FUNCTION AND NOT `distinct on`. `distinct on (source)` structurally returns one row per
 * source, which is exactly the single-sample read this slice exists to replace. The streak needs every
 * failure back to the last success, and it needs the OLDEST of them — a bounded two-row window cannot
 * express that (the graph projector 422'ing for weeks is ~144 rows at a 30m cadence, and two rows
 * would report "failing for 30 minutes" about a three-day outage).
 *
 * WHY THE PARTITION IS `(source, team_id)` AND NOT `source`. The outer scope is `team_id = $1 or
 * team_id is null`, and at least one source writes BOTH: `access_bootstrap` records a per-team
 * `ok=false` row for each FAILING team, plus an unconditional instance-wide heartbeat every tick (`lib/ingest/scheduler.ts`). A source-level
 * streak is therefore broken by global heartbeat rows that say nothing about this team's health.
 * The codebase has been bitten by the same mixing before — `context_backfill_all` exists as its own
 * source precisely because a global row masked per-team rows under `distinct on`. Found in spec review.
 * The leg is then taken from the partition holding the newest row, which preserves today's "the newest
 * row is the leg's state" semantics exactly.
 *
 * ONE GROUPED PASS FOR THE STREAK, not a lateral subquery. The first version re-scanned the whole
 * `scoped` CTE once per source: measured against prod (12,661 rows, ~299 new rows/day, and nothing in
 * this repo prunes `ingest_runs`) that was 17 loops x 12,661 rows ≈ 215k row visits for a 44ms query —
 * O(sources × history) on a table that only grows. It runs on EVERY admin Home + Integrations render
 * and sits inside `catch { return empty }`, so the end state of that trajectory is not a slow page: it
 * is a banner that silently reports healthy forever, which is the alarm-death this whole family of
 * tickets exists to prevent. Review flagged the shape. The grouped form is one pass (measured 32ms on
 * the same data), changes no behaviour, and needs no time-window clamp — a clamp would have made a leg
 * whose newest row fell outside the window vanish from `legs` entirely, trading a performance problem
 * for a correctness one. What remains and is NOT solved here: `scoped` still sorts the team's whole
 * history, so retention (or a bounded window with a deliberate answer for old legs) is a real
 * follow-up, recorded in the spec rather than left implicit.
 *
 * `ok_after` counts successes at-or-newer than each row; the current streak is the failures with none.
 * Ordering is `finished_at desc, id desc` — two runs can share a millisecond (a fast fail then a retry
 * in the same tick), and `id` is the bigserial PK, so the most-recently-inserted wins deterministically.
 * `llm-health` already documented this tie-break; the pipeline query did NOT have it, so it is new here.
 * Runs of ANY trigger count, matching today's verdict read — only the STALENESS clock is
 * scheduler-only, and a scheduler-only streak would return zero rows for `llm` (all `trigger: 'api'`).
 */
const STREAK_SQL = `
  with scoped as (
    select id, source, team_id, ok, errors, finished_at,
           sum(case when ok then 1 else 0 end) over (
             partition by source, team_id
             order by finished_at desc, id desc
             rows between unbounded preceding and current row
           ) as ok_after,
           row_number() over (
             partition by source, team_id order by finished_at desc, id desc
           ) as rn
      from ingest_runs
     where team_id = $1 or team_id is null
  ),
  streaks as (
    -- ONE grouped pass, deliberately NOT a lateral subquery. See the note above the constant for the
    -- measurement; the short version is that the lateral form re-scanned the whole scoped CTE once
    -- per source, which is O(sources x history) on a table that only grows.
    -- (No backticks in here: this is inside a JS template literal, and one of them terminated the
    -- string. tsc caught it; worth the reminder since SQL comments read like prose.)
    select source, team_id, count(*)::int as streak_length, min(finished_at) as failing_since
      from scoped
     where not ok and ok_after = 0
     group by source, team_id
  ),
  newest as (
    select distinct on (source) source, team_id, ok, errors, finished_at
      from scoped where rn = 1
     order by source, finished_at desc, id desc
  )
  select n.source, n.ok, n.errors, n.finished_at,
         coalesce(s.streak_length, 0) as streak_length,
         s.failing_since
    from newest n
    left join streaks s
      on s.source = n.source
     and s.team_id is not distinct from n.team_id`;

function firstError(errors: unknown): string | null {
  const arr = Array.isArray(errors)
    ? errors
    : typeof errors === "string"
      ? (() => {
          try {
            const p = JSON.parse(errors);
            return Array.isArray(p) ? p : [];
          } catch {
            return [];
          }
        })()
      : [];
  return typeof arr[0] === "string" ? (arr[0] as string) : null;
}

export async function getPipelineHealth(teamId: string): Promise<PipelineHealth> {
  const empty: PipelineHealth = { legs: [], failing: [], healthy: true };
  try {
    const now = Date.now();
    // Latest run per source for this team (team-scoped rows) OR global (team_id is null, e.g. dense).
    // The graph-extraction probe hits Neo4j, so run it concurrently with the ledger read. Also read
    // the team's currently-enabled integration types, so a connector leg whose integration was
    // deleted/disabled (its last run frozen as a failure) is suppressed instead of crying wolf.
    const [res, beats, extraction, enabled] = await Promise.all([
      runSql<Row>(STREAK_SQL, [teamId]),
      // The POLLER heartbeat, deliberately separate from the newest-row-of-any-trigger above.
      // Staleness answers "is the scheduler still ticking", and only a `scheduler` row is evidence of
      // that. A leg that is ALSO runnable on demand — `meeting_notes` now runs on every `aios push`
      // (trigger `api`) — would otherwise keep refreshing its own newest-row age while the poller was
      // wedged, masking a dead scheduler for exactly the teams that push most. `ok`/`error` still come
      // from the newest row of ANY trigger, so a real failure stays loud whoever caused it.
      runSql<{ source: string; finished_at: string | Date }>(
        `select distinct on (source) source, finished_at
           from ingest_runs
          where (team_id = $1 or team_id is null) and trigger = 'scheduler'
          order by source, finished_at desc`,
        [teamId]
      ).catch(() => null),
      getGraphExtractionHealth(teamId).catch(() => null),
      runSql<{ type: string }>(
        `select distinct type from integrations where team_id = $1 and status = 'enabled'`,
        [teamId]
      ).catch(() => null),
    ]);
    // null = the enabled-integrations read failed → unknown config → fail OPEN (suppress nothing).
    const enabledTypes: ReadonlySet<string> | null = enabled ? new Set(enabled.rows.map((r) => r.type)) : null;
    const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : String(v));
    // source → newest SCHEDULER-triggered finish. Null when that read failed (fail open: fall back to
    // the newest row of any trigger rather than inventing staleness from missing data).
    const beatAt: Map<string, string> | null = beats
      ? new Map(beats.rows.map((r) => [r.source, iso(r.finished_at)]))
      : null;
    // The dedupe-pollution alarm's transition LEDGER (lib/graph/extraction-alert) is not a leg: it
    // writes a row only when the alarm flips (weeks apart), so any age-based read of it is
    // meaningless — an ok=true recovery row would go "stale" 3h later and redden the banner on a
    // healthy graph forever (review finding). Its live state already surfaces through the synthetic
    // `graph_extract` leg below, fed by the same detector; the ledger rows remain visible in the
    // Recent-runs panel as the alarm's audit trail.
    const legs: PipelineLeg[] = res.rows.filter((r) => !NOT_PIPELINE_LEGS.has(r.source)).map((r) => {
      const at = iso(r.finished_at);
      // Stale only past THIS source's own cadence — a 24h job isn't stale at 3h (would cry wolf).
      const threshold = staleThresholdMs(r.source);
      // Age the POLLER, not the leg. A source with rows but no scheduler row yet (a brand-new team
      // whose first tick hasn't landed, or an on-demand-only leg) has no heartbeat to judge, so it is
      // not aged at all — consistent with this file's standing "never cry wolf" bias.
      const clock = beatAt === null ? at : beatAt.get(r.source);
      const stale = threshold !== null && clock !== undefined && now - Date.parse(clock) > threshold;
      // BANNERFLAP-1. `streak_length` is the current unbroken failure run ending at this newest row.
      // The coercion is DEFENSIVE, not a driver workaround — an earlier comment here claimed the
      // latter and was wrong: `count(*)::int` is int4, which node-postgres already returns as a
      // number, and `lib/db/pg/pool` overrides the date parsers so timestamps arrive as strings.
      // What it is really for is the direction of the failure: any non-number would fall to 0 →
      // `unconfirmed` → a silenced banner, so the fallback is written explicitly rather than left to
      // `|| 0`, and the zero is what a missing streak legitimately means.
      const failureClass = classifyFailure({
        ok: r.ok,
        streakLength: Number.isFinite(Number(r.streak_length)) ? Number(r.streak_length) : 0,
        failingSince: r.failing_since === null ? null : iso(r.failing_since),
      });
      return {
        source: r.source,
        ok: r.ok,
        error: r.ok ? null : firstError(r.errors),
        at,
        stale,
        failureClass,
        failingSince: r.ok || r.failing_since === null ? null : iso(r.failing_since),
      };
    });

    // Synthetic leg for the ONE failure ingest_runs structurally can't see: the projector records
    // graph_project=OK on a 202, but Graphiti then fails entity extraction asynchronously, so
    // episodes are accepted while zero facts are created. Append it as a failing leg so the loud
    // banner names it just like a real broken poller.
    // Either extraction failure earns the leg: a stall (no facts) or census pollution (bad facts —
    // same-name entity splits over the group's own baseline, ALARMFIX-1). Keyed on both so a model
    // that extracts confidently-wrong knowledge is as loud as one that extracts nothing — the
    // 2026-07-30 incident was the second kind and nothing announced it.
    if (extraction?.stalled || extraction?.censusPolluted) {
      legs.push({
        source: "graph_extract",
        ok: false,
        error: extraction.reason,
        at: "", // not a point-in-time failure — the banner shows the cause, not a "since" time
        stale: false,
        // EXEMPT FROM CONFIRMATION, deliberately (BANNERFLAP-1). This leg has NO `ingest_runs` rows —
        // it is synthesised from a Neo4j/ledger probe — so it can never accumulate a streak, and
        // `Date.parse("")` is NaN. Run through the classifier uniformly it would be `unconfirmed`
        // FOREVER and drop out of the loud banner silently, with every other test in this slice still
        // green. Spec review caught that. It needs no second debounce anyway: its own detector already
        // requires a 6h lag budget / an episode floor / a census sample floor before it says anything.
        failureClass: "confirmed",
        // Null, not a fabricated instant. The extraction lag boundary and the newest-episode time are
        // both to hand and both would be a made-up "since" for a condition that is explicitly not a
        // point-in-time failure. An admitted unknown beats a number that reads as a measurement.
        failingSince: null,
      });
    }

    // A leg is loud when its failure is CONFIRMED (streak ≥ 2) or its poller went stale — EXCEPT an
    // orphaned connector (integration deleted/disabled), whose frozen last-failure isn't a live break.
    // `stale` is deliberately OR'd, not gated on the classification: it answers "is the poller still
    // ticking", so a leg whose newest run SUCCEEDED but whose scheduler went quiet must stay loud.
    // A lone `unconfirmed` failure is absent from here by design — it is still `ok:false` on the leg
    // and listed in Admin → Recent ingestion runs, just not in a banner that says the brain isn't
    // getting fresh data. (No source here has a retrieval-health-card leg: `llm` had one and is no
    // longer a pipeline leg at all — LLMOBS-1.)
    const failing = legs.filter(
      (l) => (l.failureClass === "confirmed" || l.stale) && !isOrphanedConnector(l.source, enabledTypes)
    );
    return { legs, failing, healthy: failing.length === 0 };
  } catch {
    return empty;
  }
}
