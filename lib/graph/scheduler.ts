import "server-only";
import { GraphitiClient } from "./graphiti-client";
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

let started = false;

export function startGraphScheduler(): void {
  if (started) return;
  if (process.env.GRAPH_PROJECT_ENABLED === "false") return;
  // No point polling when there's nowhere to project — stay inert until GRAPHITI_URL is configured.
  if (!new GraphitiClient().configured) return;
  started = true;

  const minutes = Number(process.env.GRAPH_PROJECT_MINUTES ?? 60);
  const intervalMs = Math.max(1, minutes) * 60_000;

  const tick = async () => {
    const startedAt = Date.now();
    try {
      const s = await runGraphProjection();
      if (s.projected || s.errors.length) {
        console.info(
          `[graph] projected +${s.projected} =${s.skipped} (${s.scanned} scanned, ${s.teams} teams)` +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
      // Record any tick with a signal (projected / errors / requeued) to ingest_runs so a silently-
      // failing projector — e.g. Graphiti 422'ing every write — is visible on the dashboard, not just
      // in ephemeral logs. recordIngestRun is best-effort (swallows its own errors).
      if (s.projected || s.errors.length || s.requeued) {
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
