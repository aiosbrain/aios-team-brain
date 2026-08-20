import "server-only";
import { GraphitiClient } from "./graphiti-client";
import { PROJECTION_INTERVAL_MS, PROJECTION_MINUTES } from "./project";
import { runGraphProjection } from "./run";
import { projectionRunInput } from "./projection-run";
import { recordIngestRun } from "@/lib/ingest/runs";
import { adminClient } from "@/lib/db/admin";

/**
 * In-process projector poller — the automated half of the graph trigger (the admin action is the
 * on-demand half). Mirrors `lib/ingest/scheduler.ts`: started once from instrumentation.register()
 * on server boot (Node runtime only). Self-gating and inert by default: it does NOTHING unless
 * GRAPHITI_URL is set, so a deploy with the graph off never schedules anything. Opt out explicitly
 * with GRAPH_PROJECT_ENABLED=false.
 */

/** TICKFIT-2: a quiet walk slower than this records a durable run row anyway — the spec's
 *  revisit trigger reads `walkMs` from ingest_runs, and an ephemeral log cannot drive that
 *  decision. */
export const SLOW_WALK_RECORD_MS = 60_000;

/**
 * Which projection ticks earn a durable `ingest_runs` row. Every clause is a SIGNAL (the
 * no-silent-caps rule); TICKFIT-2 added the last two — a failing batched ledger read and a
 * slow quiet walk must reach the dashboard, not just logs, or the 10.5-minute stage could
 * silently return. Exported pure so the gate itself is testable (the round-2 review's
 * caller-gate requirement — the AC pins THIS function, not just the meta builder).
 */
export function shouldRecordProjectionRun(s: {
  projected: number; errors: string[]; requeued: number; cleaned: number;
  pendingCleanups: number; saturatedGroups: number; requeueThrottled: number;
  partialItems: number; probeFallbackPages: number; walkMs: number;
}): boolean {
  return Boolean(
    s.projected || s.errors.length || s.requeued || s.cleaned || s.pendingCleanups ||
    s.saturatedGroups || s.requeueThrottled || s.partialItems ||
    s.probeFallbackPages || s.walkMs > SLOW_WALK_RECORD_MS
  );
}

let started = false;

export function startGraphScheduler(): void {
  if (started) return;
  if (process.env.GRAPH_PROJECT_ENABLED === "false") return;
  // No point polling when there's nowhere to project — stay inert until GRAPHITI_URL is configured.
  if (!new GraphitiClient().configured) return;
  started = true;

  // One owner for the cadence (`lib/graph/project`): reconcile derives its "never landed" grace from
  // this same number (H7), and a second local parse of the env is how those two silently disagree.
  const minutes = PROJECTION_MINUTES;
  const intervalMs = PROJECTION_INTERVAL_MS;

  const tick = async () => {
    const startedAt = Date.now();
    try {
      const s = await runGraphProjection();
      if (s.projected || s.errors.length || s.pendingCleanups || s.saturatedGroups || s.requeueThrottled || s.partialItems) {
        console.info(
          `[graph] projected +${s.projected} =${s.skipped} (${s.scanned} scanned, ${s.teams} teams)` +
            (s.cleaned || s.pendingCleanups
              ? ` tier-cleanup: ${s.cleaned} done, ${s.pendingCleanups} outstanding`
              : "") +
            (s.saturatedGroups ? ` ${s.saturatedGroups} group(s) past the reconcile scan window` : "") +
            (s.partialItems ? ` ${s.partialItems} partially-landed item(s)` : "") +
            (s.requeueThrottled ? ` ${s.requeueThrottled} re-queue(s) throttled — Graphiti may be wedged` : "") +
            (s.probeFallbackPages ? ` ${s.probeFallbackPages} page(s) fell back to per-item ledger probes` : "") +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
      // Record any tick with a signal (projected / errors / requeued / an outstanding-or-completed tier
      // cleanup) to ingest_runs so a silently-failing projector — e.g. Graphiti 422'ing every write, or
      // a tier cleanup that never converges — is visible on the dashboard, not just in ephemeral logs.
      // A cleanup-only tick used to record nothing at all. recordIngestRun is best-effort.
      if (shouldRecordProjectionRun(s)) {
        await recordIngestRun(adminClient(), projectionRunInput(s, "scheduler", startedAt, Date.now()));
      }
    } catch (err) {
      console.error("[graph] projection tick failed:", err instanceof Error ? err.message : err);
      await recordIngestRun(adminClient(), {
        source: "graph_project",
        trigger: "scheduler",
        ok: false,
        errors: [err instanceof Error ? err.message : String(err)],
        startedAt,
        finishedAt: Date.now(),
      }).catch(() => {});
    }
  };

  // Delay the first run so boot isn't blocked; then poll on the interval.
  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.info(`[graph] projector scheduler started — every ${minutes}m`);
}
