import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Attribution-health is an ADMIN-ONLY read (CLAUDE.md §5). `lib/attribution/health` spans ALL access
 * tiers — it exposes per-member names + per-source counts of team/admin-tier content — and there is no
 * RLS backstop. Any surface that CALLS the read must be admin-gated in its own code (a Next layout is
 * not an auth boundary — the page must self-check; see `app/t/[team]/admin/attribution/page.tsx`). This
 * guard fails the build if any file under `app/` (pages AND api routes) or `components/` performs a
 * VALUE import of the read from OUTSIDE `app/t/[team]/admin/`. Type-only imports are fine (a
 * presentational component may take the shape without touching the DB).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const SCAN_DIRS = [join(ROOT, "app"), join(ROOT, "components")];
const ADMIN_PREFIX = join("app", "t", "[team]", "admin") + "/";
// The single non-page exception — the admin-gated attribution API route (posix path for matching). It's
// allowlisted ONLY because it self-gates to a team-tier ADMIN key (asserted in the last test below), so
// the CLI/LLM can read the same data as the web view (brain-api v1.13) without opening a non-admin leak.
const ADMIN_API_ROUTE = "app/api/v1/attribution/route.ts";
const posix = (f: string): string => f.replaceAll("\\", "/");
const isAllowed = (f: string): boolean =>
  posix(f).includes(posix(ADMIN_PREFIX)) || posix(f).endsWith(ADMIN_API_ROUTE);
// A VALUE import of the health module — `import { getAttributionHealth } …`. Excludes `import type …`
// (a component taking the AttributionHealth shape never touches the tier-spanning read).
const VALUE_IMPORT = /import\s+(?!type\s)[^;]*?from\s+["']@\/lib\/attribution\/health["']/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue; // dangling symlink etc. — skip, never crash the guard
    }
    if (isDir) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("attribution-health read is admin-gated", () => {
  const files = SCAN_DIRS.flatMap((d) => walk(d));
  const valueImporters = files.filter((f) => VALUE_IMPORT.test(readFileSync(f, "utf8")));

  it("scans a non-trivial number of files (guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("is actually called somewhere (the admin attribution page reads it)", () => {
    expect(valueImporters.some((f) => f.includes(join("admin", "attribution")))).toBe(true);
  });

  it("is CALLED only from the allowlist (self-gated admin pages + the admin-gated attribution API route)", () => {
    const offenders = valueImporters.filter((f) => !isAllowed(f));
    expect(offenders).toEqual([]);
  });

  it("the attribution API route exception genuinely gates to a team-tier ADMIN key (the allowlist can't become a leak)", () => {
    const route = valueImporters.find((f) => posix(f).endsWith(ADMIN_API_ROUTE));
    // If the route is present in the tree, it MUST self-gate; if it's absent, the allowlist entry is
    // simply dormant (no leak). Either way the tier-spanning read stays admin-only.
    if (route) {
      const src = readFileSync(route, "utf8");
      expect(src).toMatch(/memberRole\s*!==\s*["']admin["']/);
      expect(src).toMatch(/memberTier\s*!==\s*["']team["']/);
    }
  });
});
