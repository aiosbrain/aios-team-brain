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

  // Background pollers only run in the Node.js server runtime (not edge, not build).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Say something at boot about SECRETS_KEY, which is otherwise read for the first time when a
  // connector secret is SAVED — so a missing or wrong-width value has always surfaced as a 500 in
  // Admin → Integrations, hours after deploy, to whoever had just finished minting a token.
  //
  // A warning, deliberately, not a throw: the key is only needed for connectors and plenty of
  // installs never add one, so failing boot would turn an optional feature's misconfiguration into
  // a total outage. Loud enough to find in deploy logs, ignorable if you don't use connectors.
  const { secretsKeyStatus } = await import("@/lib/secrets/crypto");
  const keyStatus = secretsKeyStatus();
  if (!keyStatus.ok) {
    console.warn(
      `[boot] ${keyStatus.message} Connector secrets cannot be saved or read until this is fixed ` +
        `(Admin → Integrations will 500). Generate one with: ` +
        `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" — ` +
        `everything else works without it.`
    );
  }

  if (process.env.INGEST_POLL_ENABLED !== "false") {
    const { startIngestScheduler } = await import("@/lib/ingest/scheduler");
    startIngestScheduler();
  }
  // Graphiti projector poller — self-gates to a no-op unless GRAPHITI_URL is set.
  const { startGraphScheduler } = await import("@/lib/graph/scheduler");
  startGraphScheduler();

  // Social Brain durable job poller — opt-in (inert unless SOCIAL_JOBS_ENABLED=true) while the
  // feature is pre-launch, so a deploy without it never polls. Import the publish module first so
  // its `publish` job handler is registered before the poller can claim a publish job.
  await import("@/lib/social/publish");
  const { startSocialJobsScheduler } = await import("@/lib/jobs/scheduler");
  startSocialJobsScheduler();
}

// Forward Next.js server-side request errors to Sentry. Sentry's
// `captureRequestError` matches the Next `onRequestError` signature.
export const onRequestError = Sentry.captureRequestError;
