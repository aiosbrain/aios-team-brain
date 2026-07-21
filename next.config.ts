import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { lstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, sep } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Deepest directory that contains both paths (component-wise longest common prefix). Used to pick a
// Turbopack root that encloses both the worktree and its out-of-tree node_modules.
function commonAncestor(a: string, b: string): string {
  const as = a.split(sep);
  const bs = b.split(sep);
  const out: string[] = [];
  for (let i = 0; i < Math.min(as.length, bs.length) && as[i] === bs[i]; i++) out.push(as[i]);
  return out.join(sep) || sep;
}

// Worktree dev-ops: agents (and humans) do all work in git worktrees, where node_modules is a
// symlink to the primary checkout's node_modules (shared deps). Turbopack refuses a node_modules
// symlink whose target is OUTSIDE the project root and panics ("Symlink … points out of the
// filesystem root"), breaking `npm run dev` AND `next build`. When node_modules is a symlink, widen
// the Turbopack root to the common ancestor of THIS dir and the symlink's real target, so the shared
// deps are always inside the root — for any layout. (The mandated `<repo>-worktrees/<task>` layout
// points at a sibling `<repo>/node_modules`, whose common ancestor is the grandparent, not `..` —
// the earlier hardcoded `resolve(here, "..")` didn't enclose it and the build failed.) Guarded on the
// symlink so the primary checkout, CI, and prod builds (real node_modules in the repo) are untouched.
const turbopackRoot = (() => {
  try {
    const nm = resolve(here, "node_modules");
    if (!lstatSync(nm).isSymbolicLink()) return null;
    // Canonicalize BOTH sides: if the worktree path itself traverses a symlink (e.g. macOS
    // /tmp → /private/tmp) while the target is already canonical, the common prefix would
    // otherwise collapse toward "/". realpath both so they compare in the same namespace.
    return commonAncestor(realpathSync(here), realpathSync(nm));
  } catch {
    return null;
  }
})();

const nextConfig: NextConfig = {
  // Next 16 dev trusts `localhost` by default and treats `127.0.0.1` as an
  // untrusted cross-origin dev request — which silently breaks the HMR
  // websocket, so pages served on 127.0.0.1 never hydrate (buttons stay dead).
  // Trust both so the dashboard works regardless of which host you open.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  ...(turbopackRoot ? { turbopack: { root: turbopackRoot } } : {}),
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
