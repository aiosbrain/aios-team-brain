/**
 * Next.js instrumentation hook — runs once when the server process boots.
 * We use it to (1) initialize Sentry for the active server runtime and
 * (2) start the in-process ingestion poller so the brain self-schedules
 * connector syncs inside the single Railway service (no separate cron worker).
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  // Initialize the runtime-appropriate Sentry SDK. Each config is a no-op
  // unless its DSN env var is set, so this is inert without configuration.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }

  // Ingestion scheduler only runs in the Node.js server runtime (not edge, not build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.INGEST_POLL_ENABLED === "false") return;
  const { startIngestScheduler } = await import("@/lib/ingest/scheduler");
  startIngestScheduler();
}

// Forward Next.js server-side request errors to Sentry. Sentry's
// `captureRequestError` matches the Next `onRequestError` signature.
export const onRequestError = Sentry.captureRequestError;
