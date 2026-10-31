import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AIO-1167 R45 (AC-08) — the refused-automatic-link diagnostic is an Admin → Members surface ONLY.
 *
 * Astra's boundary: session-admin, team-tier only, and NEVER exposed through the ordinary/external API.
 * The projection's owner re-checks the viewer itself; this guard keeps it from acquiring any other
 * caller — in particular any `app/api` route, which an API key (ordinary or external) can reach.
 * Type-only imports (the presentational component) carry no runtime edge and are allowed.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const MODULE = /from\s+["']@\/lib\/identity\/discovery-conflicts["']/;
const TYPE_ONLY = /import\s+type\s+[^;]*from\s+["']@\/lib\/identity\/discovery-conflicts["']/;
const ALLOWED_RUNTIME = new Set(["app/t/[team]/admin/members/page.tsx"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

const importers = ["app", "components", "lib", "scripts"]
  .flatMap((root) => walk(join(ROOT, root)))
  .map((path) => ({ rel: relative(ROOT, path), code: readFileSync(path, "utf8") }))
  .filter(({ code }) => MODULE.test(code));

describe("refused-link diagnostic surface (R45 AC-08)", () => {
  it("only the Admin → Members page imports it at runtime; no API route imports it at all", () => {
    const runtime = importers.filter(({ code }) => !TYPE_ONLY.test(code) || code.match(new RegExp(MODULE, "g"))!.length > 1);
    expect(runtime.map(({ rel }) => rel).sort()).toEqual([...ALLOWED_RUNTIME].sort());
    expect(importers.filter(({ rel }) => rel.startsWith("app/api/")).map(({ rel }) => rel)).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(MODULE.test('import { listIdentityDiscoveryConflicts } from "@/lib/identity/discovery-conflicts";')).toBe(true);
    expect(TYPE_ONLY.test('import type { IdentityConflictPage } from "@/lib/identity/discovery-conflicts";')).toBe(true);
    expect(TYPE_ONLY.test('import { listIdentityDiscoveryConflicts } from "@/lib/identity/discovery-conflicts";')).toBe(false);
    expect(importers.some(({ rel }) => rel === "app/t/[team]/admin/members/page.tsx")).toBe(true);
  });
});
