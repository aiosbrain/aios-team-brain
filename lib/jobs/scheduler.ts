import "server-only";
import { runDueJobs } from "./run";

/**
 * In-process job poller — the durable-work half of the Social Brain, the single-service
 * alternative to a separate worker/cron. Started once from instrumentation.register() on server
 * boot (Node runtime only), mirroring lib/ingest/scheduler and lib/graph/scheduler.
 *
 * OPT-IN while the feature is pre-launch: it stays inert unless SOCIAL_JOBS_ENABLED === "true",
 * so a deploy without the Social Brain never polls. (When the feature ships, flip this to the
 * opt-out convention the ingest poller uses.) The runner itself is a cheap indexed SELECT when
 * the queue is empty.
 */

let started = false;

export function startSocialJobsScheduler(): void {
  if (started) return;
  if (process.env.SOCIAL_JOBS_ENABLED !== "true") return;
  started = true;

  const seconds = Number(process.env.SOCIAL_JOBS_POLL_SECONDS ?? 30);
  const intervalMs = Math.max(1, seconds) * 1_000;

  const tick = async () => {
    try {
      const s = await runDueJobs();
      if (s.claimed) {
        console.info(
          `[jobs] ran ${s.claimed}: ${s.succeeded} ok, ${s.requeued} requeued, ${s.dead} dead` +
            (s.errors.length ? ` — ${s.errors.join("; ")}` : "")
        );
      }
    } catch (err) {
      console.error("[jobs] tick failed:", err instanceof Error ? err.message : err);
    }
  };

  // Delay the first run so boot isn't blocked; then poll on the interval.
  setTimeout(tick, 15_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.info(`[jobs] scheduler started — every ${seconds}s`);
}
