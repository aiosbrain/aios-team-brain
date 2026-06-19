import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Worktree dev-ops: agents (and humans) do all work in git worktrees, where node_modules is
// a symlink to ../<primary>/node_modules (shared deps). Turbopack refuses a node_modules
// symlink that points OUTSIDE the project root and panics ("Symlink … points out of the
// filesystem root"), breaking `npm run dev`. When node_modules is a symlink, widen the
// Turbopack root to the parent dir that contains both the worktree and the symlink target.
// Guarded on the symlink so the primary checkout, CI, and prod builds (real node_modules
// inside the repo) are completely unaffected — the root stays the repo there.
const nodeModulesIsSymlink = (() => {
  try {
    return lstatSync(resolve(here, "node_modules")).isSymbolicLink();
  } catch {
    return false;
  }
})();

const nextConfig: NextConfig = {
  // Next 16 dev trusts `localhost` by default and treats `127.0.0.1` as an
  // untrusted cross-origin dev request — which silently breaks the HMR
  // websocket, so pages served on 127.0.0.1 never hydrate (buttons stay dead).
  // Trust both so the dashboard works regardless of which host you open.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  ...(nodeModulesIsSymlink ? { turbopack: { root: resolve(here, "..") } } : {}),
};

// Wrap with Sentry. This build-time wrapper enables source-map upload (so
// stack traces in Sentry are un-minified). It is env-driven and inert without
// credentials: with no SENTRY_AUTH_TOKEN, the build skips the upload step and
// proceeds normally — so local/CI builds need no Sentry secrets.
//
// Source-map upload works under Turbopack with @sentry/nextjs >= 10.13.
// There are no custom webpack plugins in this config (Turbopack ignores them),
// so nothing here depends on the webpack pipeline.
export default withSentryConfig(nextConfig, {
  // Org/project for source-map upload. Also read from SENTRY_ORG / SENTRY_PROJECT.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  // Auth token for uploading source maps at build time. MUST come from env;
  // never commit it. Also read from SENTRY_AUTH_TOKEN if omitted here.
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Quiet the build logs unless explicitly debugging.
  silent: !process.env.CI,
  // Don't send build-tool telemetry to Sentry.
  telemetry: false,
});
