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

  // PRET-4 one-time builtin materialization (spec §3.2, cold-read H2/L1): run at BOOT, awaited
  // BEFORE the scheduler starts, so on a healthy boot the fleet's builtin posture rows are
  // explicit before any tick assesses or serves against them. Failure is loud but never fails
  // boot — the marker stays unclaimed, the oracle/posture legacy conjunct keeps the window
  // fail-closed, and the scheduler-tick slot retries until it succeeds.
  try {
    const { adminClient } = await import("@/lib/db/admin");
    const { materializeBuiltinMembershipOnce } = await import("@/lib/access/groups");
    const m = await materializeBuiltinMembershipOnce(adminClient());
    if (!m.ok) console.error(`[boot] pret4 builtin materialization failed (tick will retry): ${m.error}`);
    else if (m.ran) console.info("[boot] pret4 builtin materialization ran (explicit posture state live)");
  } catch (err) {
    console.error(`[boot] pret4 builtin materialization threw (tick will retry): ${err instanceof Error ? err.message : String(err)}`);
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
