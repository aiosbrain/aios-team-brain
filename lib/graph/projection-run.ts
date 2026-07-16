import type { IngestRunInput, IngestTrigger } from "@/lib/ingest/runs";
import type { GraphProjectionSummary } from "./run";

/**
 * Map a graph-projection summary → an `ingest_runs` record so the projector is as observable as every
 * other ingestion leg. This is the fix for the 2026-07 silent stall: the projector wrote NOTHING
 * durable, so a Graphiti `422` on writes wedged it for days with only ephemeral log lines. Recording
 * to `ingest_runs` surfaces it in Admin → Integrations → Recent ingestion runs (and makes an alert
 * possible). Pure so the mapping is unit-tested without a timer or a DB.
 *
 * `source: "graph_project"` is the stable ledger key for this leg. `ok` is false whenever a team
 * errored — that's what turns the row red in the panel.
 */
export function projectionRunInput(
  summary: GraphProjectionSummary,
  trigger: IngestTrigger,
  startedAt: number,
  finishedAt: number
): IngestRunInput {
  return {
    source: "graph_project",
    trigger,
    ok: summary.errors.length === 0,
    created: summary.projected,
    unchanged: summary.skipped,
    errors: summary.errors,
    meta: {
      scanned: summary.scanned,
      teams: summary.teams,
      reconciled: summary.reconciled,
      requeued: summary.requeued,
    },
    startedAt,
    finishedAt,
  };
}
