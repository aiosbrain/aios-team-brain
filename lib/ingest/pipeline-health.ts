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
};

/** The age past which `source` is considered stale, or `null` to never flag it on age. Exported for
 *  unit tests (a wrong threshold here fires the loud banner on a healthy job — the auth_cleanup bug). */
export function staleThresholdMs(source: string): number | null {
  return source in STALE_MS_BY_SOURCE ? STALE_MS_BY_SOURCE[source] : STALE_MS;
}

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
      // Stale only past THIS source's own cadence — a 24h job isn't stale at 3h (would cry wolf).
      const threshold = staleThresholdMs(r.source);
      const stale = threshold !== null && now - Date.parse(at) > threshold;
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
