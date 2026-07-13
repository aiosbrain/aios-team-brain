import "server-only";

import type { DbClient } from "@/lib/db/types";
import { recordIngestRun, type IngestRunRow, type IngestTrigger } from "@/lib/ingest/runs";
import { isStale } from "@/lib/ingest/runs-format";
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
  const synced = counts.synced ?? 0;
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

export interface ProjectionHealth {
  status: ProjectionHealthStatus;
  lastRun: IngestRunRow | null;
  ageMs: number | null;
}

export function computeProjectionHealth(lastRun: IngestRunRow | null, now = Date.now()): ProjectionHealth {
  if (!lastRun) return { status: "never_run", lastRun: null, ageMs: null };
  const finishedAtMs = new Date(lastRun.finished_at).getTime();
  const ageMs = now - finishedAtMs;
  if (!lastRun.ok) return { status: "failed", lastRun, ageMs };
  if (isStale(finishedAtMs, now, PROJECTION_STALE_AFTER_HOURS)) return { status: "stale", lastRun, ageMs };
  return { status: "ok", lastRun, ageMs };
}

/** Convenience: last run + derived health in one round trip. */
export async function getProjectionHealth(db: DbClient, teamId: string): Promise<ProjectionHealth> {
  const runs = await listRecentProjectionRuns(db, teamId, 1);
  return computeProjectionHealth(runs[0] ?? null);
}
