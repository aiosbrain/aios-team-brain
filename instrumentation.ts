/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * We use it to start the in-process ingestion poller so the brain self-schedules
 * connector syncs inside the single Railway service (no separate cron worker).
 */
export async function register() {
  // Only in the Node.js server runtime (not edge, not build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.INGEST_POLL_ENABLED === "false") return;
  const { startIngestScheduler } = await import("@/lib/ingest/scheduler");
  startIngestScheduler();
}
