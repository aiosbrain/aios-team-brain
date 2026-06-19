/**
 * Client-side instrumentation — runs in the browser before React hydrates.
 * Next.js loads this file automatically (the `instrumentation-client` file
 * convention, v15.3+). We use it to initialize the Sentry browser SDK so
 * client-side errors are captured and tied to source maps.
 *
 * DSN is env-driven (NEXT_PUBLIC_SENTRY_DSN). When unset, init is a no-op and
 * nothing is sent — so dev/CI builds without a DSN are fully inert.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Adjust trace sampling to taste; 0 disables performance tracing entirely.
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0),
  // Surface SDK debug logs only when explicitly requested.
  debug: false,
});

// Required for App Router navigation instrumentation (client-side transactions).
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
