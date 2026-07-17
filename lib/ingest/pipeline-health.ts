import "server-only";
import { runSql } from "@/lib/db/pg/pool";
import { getGraphExtractionHealth } from "@/lib/graph/extraction-health";

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

/** A leg is stale if its newest run is older than this — it was running, then went quiet (poller
 *  wedged / a source that silently stopped). Comfortably past the 30m ingest + 60m graph cadence. */
const STALE_MS = 3 * 60 * 60 * 1000; // 3h

/** Sources WITHOUT a fixed poll schedule — a long gap is normal, not a stall (would cry wolf). Their
 *  real failures still surface via `ok=false`; we just don't flag them on age. `llm` is event-driven
 *  (already on the retrieval card); `scan` is manual/CI; `pm_sync` is reactive (its own staleness
 *  heuristic lives in `lib/pm-sync/runs`). Everything else is a scheduled poller and IS stale-able. */
const UNSCHEDULED_SOURCES = new Set(["llm", "scan", "pm_sync"]);

export interface PipelineLeg {
  source: string;
  ok: boolean;
  error: string | null;
  at: string; // finished_at ISO
  stale: boolean; // ran before, but not recently
}

export interface PipelineHealth {
  legs: PipelineLeg[];
  /** Legs that failed (latest run ok=false) or went stale — what the loud banner names. */
  failing: PipelineLeg[];
  healthy: boolean;
}

type Row = { source: string; ok: boolean; errors: unknown; finished_at: string | Date };

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
    // The graph-extraction probe hits Neo4j, so run it concurrently with the ledger read.
    const [res, extraction] = await Promise.all([
      runSql<Row>(
        `select distinct on (source) source, ok, errors, finished_at
           from ingest_runs
          where team_id = $1 or team_id is null
          order by source, finished_at desc`,
        [teamId]
      ),
      getGraphExtractionHealth(teamId).catch(() => null),
    ]);
    const legs: PipelineLeg[] = res.rows.map((r) => {
      const at = r.finished_at instanceof Date ? r.finished_at.toISOString() : String(r.finished_at);
      // Only SCHEDULED pollers can be "stale" — a reactive/manual source with a long gap is normal.
      const stale = !UNSCHEDULED_SOURCES.has(r.source) && now - Date.parse(at) > STALE_MS;
      return { source: r.source, ok: r.ok, error: r.ok ? null : firstError(r.errors), at, stale };
    });

    // Synthetic leg for the ONE failure ingest_runs structurally can't see: the projector records
    // graph_project=OK on a 202, but Graphiti then fails entity extraction asynchronously, so
    // episodes are accepted while zero facts are created. Append it as a failing leg so the loud
    // banner names it just like a real broken poller.
    if (extraction?.stalled) {
      legs.push({
        source: "graph_extract",
        ok: false,
        error: extraction.reason,
        at: "", // not a point-in-time failure — the banner shows the cause, not a "since" time
        stale: false,
      });
    }

    const failing = legs.filter((l) => !l.ok || l.stale);
    return { legs, failing, healthy: failing.length === 0 };
  } catch {
    return empty;
  }
}
