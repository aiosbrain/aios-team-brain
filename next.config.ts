import type { NextConfig } from "next";
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

export default nextConfig;
