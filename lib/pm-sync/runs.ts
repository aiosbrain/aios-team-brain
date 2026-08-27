import "server-only";

import type { DbClient } from "@/lib/db/types";
import { recordIngestRun, type IngestRunRow, type IngestTrigger } from "@/lib/ingest/runs";
import { isStale } from "@/lib/ingest/runs-format";
import { withTransaction } from "@/lib/db/pg/tx";
import type { PmProvider } from "@/lib/pm-sync/provider";
import type { ProjectionReport } from "@/lib/pm-sync/project";

/**
 * Observability for the brain→PM projection engine (AIO-357 — "expose last-run timestamp /
 * staleness"). Reuses the existing `ingest_runs` log (lib/ingest/runs.ts) instead of a new table:
 * the row shape (source/trigger/ok/counts/errors/meta/timestamps) already fits a projection run,
 * and Admin → Integrations already has a working reader (`listRecentIngestRuns`) and panel
 * (`IngestRunsPanel`) to reuse as-is. Runs are distinguished by `source: "pm_sync"`; the provider
 * (plane/linear/null) is recorded in `meta.provider` since a team's primary PM provider can change
 * over time and a single run may cover only one.
 *
 * Unlike the ingestion importers (a fixed `scheduler.ts` poll interval), projection is REACTIVE —
 * it fires on every task push / UI edit (`lib/pm-sync/after-write.ts`) and on the manual
 * "Project board now" button / `brain-tasks.ts project` CLI. So "last run" here means "the last
 * time projection code actually executed", not "the last scheduled tick". A long gap despite
 * active task edits is exactly the undiagnosable failure mode AIO-357 was filed to surface.
 */

export const PM_SYNC_SOURCE = "pm_sync";

export interface ProjectionRunSummary {
  ok: boolean;
  synced: number;
  unchanged: number;
  errors: string[];
  meta: Record<string, number>;
}

// Roll a projection report batch (or a single-task report) up into the recordIngestRun shape.
// `synced` = rows the provider actually wrote; `unchanged` = everything else that isn't an
// outright failure (skipped / no_row_key / no_primary_provider — genuinely nothing to do);
// `errors` = one line per failing row so the admin panel / CLI output shows *why*, not just a count.
export function summarizeProjectionReports(reports: ProjectionReport[]): ProjectionRunSummary {
  const counts: Record<string, number> = {};
  const errors: string[] = [];
  for (const r of reports) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.error) errors.push(`${r.row_key}: ${r.error}`);
  }
  const failed = (counts.failed ?? 0) + (counts.missing_integration ?? 0) + (counts.missing_parent ?? 0) + (counts.cycle ?? 0);
  // ADOPTDECL-1 — an adoption IS a provider write, so it counts as synced rather than falling into
  // `unchanged`. `meta: counts` keeps the two distinguishable for anyone who needs the breakdown.
  const adopted = counts.adopted ?? 0;
  const synced = (counts.synced ?? 0) + adopted;
  return {
    ok: failed === 0,
    synced,
    unchanged: Math.max(0, reports.length - synced - failed),
    errors,
    meta: counts,
  };
}

export interface RecordProjectionRunInput {
  /** null = instance-wide (not currently used by any caller, kept for parity with ingest_runs). */
  teamId: string | null;
  provider: PmProvider | null;
  trigger: IngestTrigger;
  reports: ProjectionReport[];
  startedAt: number;
  finishedAt?: number;
  /** Set when projection didn't run at all (e.g. no_primary_provider) — reports is []. */
  reason?: string;
}

/**
 * Record one projection run. Best-effort (delegates to `recordIngestRun`, which never throws) —
 * observability must never fail the projection it describes.
 */
export async function recordProjectionRun(db: DbClient, input: RecordProjectionRunInput): Promise<void> {
  const summary = summarizeProjectionReports(input.reports);
  await recordIngestRun(db, {
    teamId: input.teamId,
    source: PM_SYNC_SOURCE,
    trigger: input.trigger,
    ok: input.reason ? false : summary.ok,
    created: summary.synced,
    unchanged: summary.unchanged,
    errors: input.reason ? [input.reason] : summary.errors,
    meta: { provider: input.provider, ...summary.meta },
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
}

const RUN_COLS =
  "id, team_id, source, trigger, ok, created, updated, unchanged, error_count, errors, meta, started_at, finished_at, duration_ms";

/** Most recent projection runs for a team, newest first (Admin → PM sync panel). */
export async function listRecentProjectionRuns(db: DbClient, teamId: string, limit = 20): Promise<IngestRunRow[]> {
  const { data } = await db
    .from("ingest_runs")
    .select(RUN_COLS)
    .eq("team_id", teamId)
    .eq("source", PM_SYNC_SOURCE)
    .order("finished_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as IngestRunRow[];
}

export type ProjectionHealthStatus = "never_run" | "ok" | "stale" | "failed";

// A last-OK run older than this is flagged stale. Projection is reactive (fires on every push), so
// a healthy, active team accumulates a run roughly whenever a linked task changes — this is a
// heuristic "haven't seen a successful run in a long time" tripwire, not a fixed SLA (there is no
// scheduled tick to compare against, unlike lib/ingest/scheduler.ts's INGEST_POLL_MINUTES). Reuses
// the same `isStale` age check the ingest-runs panel already uses (lib/ingest/runs-format.ts).
export const PROJECTION_STALE_AFTER_HOURS = 24;

/**
 * ADOPTUNIQ-1 — is the one-issue-one-row DB backstop actually installed and CORRECT?
 *
 * `unknown` is not a synonym for `healthy`: a catalog read that fails resolves here, never to
 * `installed`. A probe that reports green when it cannot see is the fail-open shape this repo has
 * already been bitten by.
 */
export type BackstopStatus = "installed" | "missing" | "malformed" | "unknown";

export interface ProjectionHealth {
  status: ProjectionHealthStatus;
  lastRun: IngestRunRow | null;
  ageMs: number | null;
  /**
   * DELIBERATELY A SEPARATE FIELD, not a value folded into `status`. `status` describes the last
   * projection RUN (never_run/failed/stale/ok); the backstop is a schema property with no relation to
   * it, and overloading one enum would make "ok" mean two unrelated things.
   */
  backstop: BackstopStatus;
}

export function computeProjectionHealth(
  lastRun: IngestRunRow | null,
  now = Date.now(),
  backstop: BackstopStatus = "unknown",
): ProjectionHealth {
  if (!lastRun) return { status: "never_run", lastRun: null, ageMs: null, backstop };
  const finishedAtMs = new Date(lastRun.finished_at).getTime();
  const ageMs = now - finishedAtMs;
  if (!lastRun.ok) return { status: "failed", lastRun, ageMs, backstop };
  if (isStale(finishedAtMs, now, PROJECTION_STALE_AFTER_HOURS)) return { status: "stale", lastRun, ageMs, backstop };
  return { status: "ok", lastRun, ageMs, backstop };
}

/**
 * ADOPTUNIQ-1 — classify the catalog row for `task_pm_links_provider_resource_uq`.
 *
 * Pure, so the whole decision table is unit-testable without a database. `indexdef` is Postgres's
 * NORMALIZED rendering from `pg_get_indexdef`, not our source DDL — comparing against the source text
 * would break on whitespace and on Postgres's own parenthesisation of the predicate.
 *
 * `malformed` exists because `create unique index IF NOT EXISTS` accepts ANY existing relation with
 * that name, whatever its columns, order, predicate or uniqueness — so a wrong index of the right name
 * would otherwise read as a successful deploy forever.
 */
export function classifyBackstop(
  row: { indexdef: string; isvalid: boolean } | null,
): BackstopStatus {
  if (!row) return "missing";
  if (!row.isvalid) return "malformed";
  const def = row.indexdef.toLowerCase().replace(/\s+/g, " ").trim();
  /**
   * Matched as a WHOLE definition, not a bag of substrings.
   *
   * A substring check accepted `… (team_id, provider, provider_resource_id) INCLUDE (task_id) WHERE …`
   * as installed, contradicting this function's own promise to validate the exact definition. Anchoring
   * the pattern end-to-end means anything Postgres renders that we did not ask for — INCLUDE columns,
   * a tablespace, `NULLS NOT DISTINCT`, a collation or opclass — falls to `malformed` rather than
   * being quietly tolerated. Erring strict is right: the whole point is that a wrong index of the
   * right NAME must not read as a successful deploy.
   */
  const EXPECTED =
    /^create unique index task_pm_links_provider_resource_uq on public\.task_pm_links using btree \(team_id, provider, provider_resource_id\) where \(provider_resource_id is not null\)$/;
  return EXPECTED.test(def) ? "installed" : "malformed";
}

/**
 * Read the backstop's catalog row. FAIL-CLOSED: any error resolves `unknown`, never `installed`.
 *
 * Raw SQL rather than the query builder because `DbClient` cannot express the `pg_index`/`pg_class`
 * joins — the same reason `lib/pm-sync/inbound.ts` reaches for `withTransaction`.
 */
export async function readBackstopStatus(): Promise<BackstopStatus> {
  try {
    return await withTransaction(async (client) => {
      const res = await client.query(
        `select pg_get_indexdef(i.indexrelid) as indexdef, i.indisvalid as isvalid
           from pg_index i
           join pg_class c on c.oid = i.indexrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'task_pm_links_provider_resource_uq'`,
      );
      const row = (res.rows?.[0] ?? null) as { indexdef: string; isvalid: boolean } | null;
      return classifyBackstop(row);
    });
  } catch {
    return "unknown";
  }
}

/** Convenience: last run + derived health + the DB backstop in one call. */
export async function getProjectionHealth(db: DbClient, teamId: string): Promise<ProjectionHealth> {
  const [runs, backstop] = await Promise.all([
    listRecentProjectionRuns(db, teamId, 1),
    readBackstopStatus(),
  ]);
  return computeProjectionHealth(runs[0] ?? null, Date.now(), backstop);
}
