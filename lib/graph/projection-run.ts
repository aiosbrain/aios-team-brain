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
      // EPISODES pushed, the denominator for calls-per-episode on the Costs page. `created` above is
      // ITEMS, which is a different unit: chunking splits one item into up to 16 episodes, so a ratio
      // over items moves with the corpus's chunk mix and can read a content shift as a model change.
      episodes: summary.episodes,
      // Per-group split of `episodes` (PCCC-3, design §3): the append-only substrate the Phase C
      // cost gate prices from. ingest_runs rows are never updated, so summing this key across runs
      // gives episodes-actually-pushed per partition — the denominator graph_episodes row counts
      // cannot provide (a row is one ITEM, and its projected_at mutates).
      episodesByGroup: summary.episodesByGroup,
      // Fan-out pushes withheld by the per-pass budget (PCCC-5) — a cap that saturates must never
      // be silent; persistent non-zero means arming outpaces GRAPH_FANOUT_PUSH_MAX_PER_PASS.
      fanoutThrottled: summary.fanoutThrottled,
      // Rule-2 exposure population (PCCC-6): items restricted out of General whose move has not
      // completed — non-zero for many runs means the copy leg is stuck, and the exposure is REAL.
      restrictionMovesPending: summary.restrictionMovesPending,
      scanned: summary.scanned,
      teams: summary.teams,
      reconciled: summary.reconciled,
      requeued: summary.requeued,
      cleaned: summary.cleaned,
      // Outstanding tier cleanups — old-tier episodes still purgeable-but-unpurged. Non-zero here is a
      // tier-isolation signal (B2), so it belongs in the durable record, not just an ephemeral log.
      pendingCleanups: summary.pendingCleanups,
      // Groups that outgrew the reconcile scan window — self-healing has stopped for them. A cap that
      // saturates must never be silent.
      saturatedGroups: summary.saturatedGroups,
      // Re-queues declined because a mass disappearance reads as a wedged Graphiti (H7). Recorded so a
      // throttle that persists across runs is visible rather than inferred from logs.
      requeueThrottled: summary.requeueThrottled,
    },
    startedAt,
    finishedAt,
  };
}
