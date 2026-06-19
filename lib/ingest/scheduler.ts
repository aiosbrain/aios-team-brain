import "server-only";
import { runSlackIngestion } from "./run";

/**
 * In-process poller — the single-service alternative to a separate cron worker.
 * Started once from instrumentation.register() on server boot (Node runtime only).
 * Idle (never starts the interval) when SLACK_BOT_TOKEN is unset, so a fresh deploy
 * without Slack configured is silent.
 */

let started = false;

export function startIngestScheduler(): void {
  if (started) return;
  const token = process.env.SLACK_BOT_TOKEN ?? process.env.slack_bot_token;
  if (!token) {
    console.info("[ingest] scheduler idle — SLACK_BOT_TOKEN not set");
    return;
  }
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
      console.error("[ingest] tick failed:", err instanceof Error ? err.message : err);
    }
  };

  // Delay the first run so boot isn't blocked; then poll on the interval.
  setTimeout(tick, 20_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  console.info(`[ingest] scheduler started — Slack every ${minutes}m`);
}
