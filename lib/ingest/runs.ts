import "server-only";
import type { DbClient } from "@/lib/db/types";

/**
 * The ingestion run log (`ingest_runs`) — the single home for "did this import work, and if not,
 * why". Every scheduler tick, manual /sync, and codebase scan records one row here so failures are
 * diagnosable after the fact instead of vanishing into container logs. This module is the SINGLE
 * WRITER (recordIngestRun) plus the readers the Admin → Integrations panel uses.
 *
 * Best-effort: recording a run must never take an ingestion down, so the writer swallows its own
 * errors (a broken log is still better than a failed sync). Callers pass whatever they know; the
 * caller-facing shape is plain fields so this module needn't import the ImportSummary type.
 */

/** How the run was triggered. Free-form-ish but these are the known kinds. */
export type IngestTrigger = "scheduler" | "manual" | "merge" | "cli" | "api";

export interface IngestRunInput {
  /** null = instance-wide (a scheduler aggregate across all teams); set for per-team runs. */
  teamId?: string | null;
  source: string; // 'slack' | 'linear' | 'plane' | 'github' | 'scan' | …
  trigger: IngestTrigger;
  ok: boolean;
  created?: number;
  updated?: number;
  unchanged?: number;
  errors?: string[];
  meta?: Record<string, unknown>;
  /** epoch ms; duration is derived from finishedAt (defaults to now). */
  startedAt: number;
  finishedAt?: number;
}

export interface IngestRunRow {
  id: number;
  team_id: string | null;
  source: string;
  trigger: string;
  ok: boolean;
  created: number;
  updated: number;
  unchanged: number;
  error_count: number;
  errors: string[];
  meta: Record<string, unknown>;
  started_at: string;
  finished_at: string;
  duration_ms: number | null;
}

/** Cap stored error text so a pathological run can't bloat the row. */
const MAX_ERRORS = 25;
const MAX_ERROR_CHARS = 500;

/**
 * Append one ingestion run. Never throws — a logging failure must not fail the ingestion it
 * describes. `ok` is derived to false whenever there are errors, even if the caller passed true.
 */
export async function recordIngestRun(db: DbClient, run: IngestRunInput): Promise<void> {
  try {
    const errors = (run.errors ?? []).slice(0, MAX_ERRORS).map((e) => String(e).slice(0, MAX_ERROR_CHARS));
    const finishedAt = run.finishedAt ?? Date.now();
    await db.from("ingest_runs").insert({
      team_id: run.teamId ?? null,
      source: run.source,
      trigger: run.trigger,
      ok: run.ok && errors.length === 0,
      created: run.created ?? 0,
      updated: run.updated ?? 0,
      unchanged: run.unchanged ?? 0,
      error_count: errors.length,
      // jsonb columns must be JSON-serialized for the pg adapter (matches lib/codebases/ingest).
      errors: JSON.stringify(errors),
      meta: JSON.stringify(run.meta ?? {}),
      started_at: new Date(run.startedAt).toISOString(),
      finished_at: new Date(finishedAt).toISOString(),
      duration_ms: Math.max(0, finishedAt - run.startedAt),
    });
  } catch {
    // Observability must never take ingestion down.
  }
}

/**
 * Most recent runs relevant to a team: the team's own per-team runs PLUS instance-wide scheduler
 * aggregates (team_id null). Newest first. Read-only; the Admin page gates access (CLAUDE.md §5).
 */
export async function listRecentIngestRuns(
  db: DbClient,
  teamId: string,
  limit = 50
): Promise<IngestRunRow[]> {
  const cols =
    "id, team_id, source, trigger, ok, created, updated, unchanged, error_count, errors, meta, started_at, finished_at, duration_ms";
  // Two queries + JS merge: the postgres adapter has no `.or()`, and this is the team's own runs
  // PLUS instance-wide scheduler aggregates (team_id null). Newest first, capped at `limit`.
  const [own, aggregate] = await Promise.all([
    db.from("ingest_runs").select(cols).eq("team_id", teamId).order("finished_at", { ascending: false }).limit(limit),
    db.from("ingest_runs").select(cols).is("team_id", null).order("finished_at", { ascending: false }).limit(limit),
  ]);
  return [...((own.data ?? []) as IngestRunRow[]), ...((aggregate.data ?? []) as IngestRunRow[])]
    .sort((a, b) => (a.finished_at < b.finished_at ? 1 : a.finished_at > b.finished_at ? -1 : 0))
    .slice(0, limit);
}
