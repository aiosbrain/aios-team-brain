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
 */
const STALE_MS_BY_SOURCE: Record<string, number | null> = {
  llm: null, // event-driven (also surfaced on the retrieval-health card)
  scan: null, // manual / CI
  pm_sync: null, // reactive — its own staleness heuristic lives in lib/pm-sync/runs
  auth_cleanup: 26 * 60 * 60 * 1000, // 24h cadence + 2h grace (genuinely-stuck still surfaces)
  // Record-only-when-active legs: their scheduler writes an `ingest_runs` row ONLY when the tick did
  // something (indexed/projected/applied) or errored — a quiet pass writes nothing. So the newest
  // row's age reflects "last time there was work", NOT "last time the poller ran", and an age-based
  // staleness check cries wolf on any normal quiet window (a weekend, an idle board). Real failures
  // still surface via `ok=false` on their actual runs, plus the residual probes on the retrieval-health
  // card: `dense` via its `pendingItems` backlog, `graph_project` via `isGraphStale` (6h-no-writes →
  // degraded). `linear_inbound` has no dedicated probe (a silently-wedged inbound lock is invisible) —
  // an accepted tradeoff since it's per-team opt-in and any throw records `ok=false`.
  // (Contrast slack/plane/linear/github AND meeting_notes, which record EVERY tick — the first four via
  // scheduler.runImport "still record configured sources (proves the poller ran)", meeting_notes
  // unconditionally per team (scheduler.ts:222) — so last-SCHEDULER-row age == last-poll age and the 3h
  // default is meaningful there; nulling meeting_notes would have removed a real dead-scheduler
  // heartbeat. Note "scheduler row", not "last row": meeting_notes ALSO runs on demand from `aios push`
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
   * deliberately absent — it stays visible on the retrieval card and in the runs table. `stale` is
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
 * `ok=false` row and an instance-wide row on every tick (`lib/ingest/scheduler.ts`). A source-level
 * streak is therefore broken by global heartbeat rows that say nothing about this team's health.
 * The codebase has been bitten by the same mixing before — `context_backfill_all` exists as its own
 * source precisely because a global row masked per-team rows under `distinct on`. Found in spec review.
 * The leg is then taken from the partition holding the newest row, which preserves today's "the newest
 * row is the leg's state" semantics exactly.
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
  newest as (
    select distinct on (source) source, team_id, ok, errors, finished_at
      from scoped where rn = 1
     order by source, finished_at desc, id desc
  )
  select n.source, n.ok, n.errors, n.finished_at,
         coalesce(s.streak_length, 0) as streak_length,
         s.failing_since
    from newest n
    left join lateral (
      select count(*)::int as streak_length, min(finished_at) as failing_since
        from scoped c
       where c.source = n.source
         and c.team_id is not distinct from n.team_id
         and not c.ok and c.ok_after = 0
    ) s on true`;

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
    const legs: PipelineLeg[] = res.rows.filter((r) => r.source !== GRAPH_HEALTH_SOURCE).map((r) => {
      const at = iso(r.finished_at);
      // Stale only past THIS source's own cadence — a 24h job isn't stale at 3h (would cry wolf).
      const threshold = staleThresholdMs(r.source);
      // Age the POLLER, not the leg. A source with rows but no scheduler row yet (a brand-new team
      // whose first tick hasn't landed, or an on-demand-only leg) has no heartbeat to judge, so it is
      // not aged at all — consistent with this file's standing "never cry wolf" bias.
      const clock = beatAt === null ? at : beatAt.get(r.source);
      const stale = threshold !== null && clock !== undefined && now - Date.parse(clock) > threshold;
      // BANNERFLAP-1. `streak_length` is the current unbroken failure run ending at this newest row;
      // `Number(...) || 0` because pg returns bigint-ish counts as strings through some drivers and a
      // NaN here would silently classify every failure as unconfirmed — i.e. silence the banner.
      const failureClass = classifyFailure({
        ok: r.ok,
        streakLength: Number(r.streak_length) || 0,
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
    // A lone `unconfirmed` failure is absent from here by design — it is still on the retrieval card
    // and in the runs table, just not in a banner that says the brain isn't getting fresh data.
    const failing = legs.filter(
      (l) => (l.failureClass === "confirmed" || l.stale) && !isOrphanedConnector(l.source, enabledTypes)
    );
    return { legs, failing, healthy: failing.length === 0 };
  } catch {
    return empty;
  }
}
