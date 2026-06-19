/**
 * Edge runtime Sentry initialization (proxy / edge route handlers).
 * Loaded by `instrumentation.ts` `register()` when NEXT_RUNTIME === "edge".
 *
 * DSN is env-driven (SENTRY_DSN). When unset, init is a no-op.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
  debug: false,
});
