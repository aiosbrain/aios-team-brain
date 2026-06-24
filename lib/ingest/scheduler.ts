import "server-only";
import { runSlackIngestion, runPlaneIngestion } from "./run";

/**
 * In-process poller — the single-service alternative to a separate cron worker.
 * Started once from instrumentation.register() on server boot (Node runtime only).
 * Config-driven: each tick syncs whatever Slack integrations are enabled (tokens
 * come from the dashboard-stored encrypted secret or SLACK_BOT_TOKEN). A deploy
 * with nothing configured polls cheaply and logs nothing. Opt out with
 * INGEST_POLL_ENABLED=false.
 */

let started = false;

export function startIngestScheduler(): void {
  if (started) return;
  started = true;

  const minutes = Number(process.env.INGEST_POLL_MINUTES ?? 30);
  const intervalMs = Math.max(1, minutes) * 60_000;

  const tick = async () => {
    try {
      const s = await runSlackIngestion();
      if (s.created || s.updated || s.errors.length) {
        console.info(
          `[ingest] slack: +${s.created} ~${s.updated} =${s.unchanged} ` +
            `(${s.channels} channels, ${s.integrations} integrations)` +
            (s.errors.length ? ` errors: ${s.errors.join("; ")}` : "")
        );
      }
    } catch (err) {
      console.error("[ingest] slack tick failed:", err instanceof Error ? err.message : err);
    }
    try {
      const p = await runPlaneIngestion();
      if (p.created || p.updated || p.errors.length) {
        console.info(
          `[ingest] plane: +${p.created} ~${p.updated} =${p.unchanged} ` +
            `(${p.items} items, ${p.projects} projects, ${p.integrations} integrations)` +
            (p.errors.length ? ` errors: ${p.errors.join("; ")}` : "")
        );
      }
    } catch (err) {
      console.error("[ingest] plane tick failed:", err instanceof Error ? err.message : err);
    }
  };

  // Delay the first run so boot isn't blocked; then poll on the interval.
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.info(`[ingest] scheduler started — Slack + Plane every ${minutes}m`);
}
