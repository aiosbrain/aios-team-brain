import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Integrations tier/role-isolation guard (CLAUDE.md §5). Integrations are admin-tier config with
 * NO per-row `access` column and NO RLS in postgres mode, so the app-code role gate is the SOLE
 * enforcement for dashboard reads. This guard enforces two structural facts (modeled on the
 * codebases-tier-filter guard):
 *   (a) dashboard PAGES never read the `integrations` table directly — they go through
 *       lib/integrations/read (so the gate can't be skipped per-page);
 *   (b) every exported helper in lib/integrations/read.ts that reads the `integrations` table
 *       applies the `canManageIntegrations(...)` gate.
 * The real proof is the data-mechanics isolation test; this fails fast in review.
 *
 * The API-key selection read (`listEnabledIntegrationSelections`) and the secret-bearing runner
 * read (`getEnabledIntegrationsWithSecrets`) deliberately live in manage.ts, NOT read.ts: they are
 * gated by the connector key at the route, not a dashboard role — so they are outside this guard.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const PAGES_DIR = join(ROOT, "app", "t");
const HELPER = join(ROOT, "lib", "integrations", "read.ts");
const TABLE = /from\(\s*["']integrations["']\s*\)/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("integrations tier/role isolation", () => {
  it("dashboard pages never read the integrations table directly (only via lib/integrations/read)", () => {
    const offenders = walk(PAGES_DIR)
      .filter((f) => TABLE.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(f.indexOf("app/")));
    expect(
      offenders,
      `Dashboard files read the integrations table directly (no role gate / no RLS backstop). ` +
        `Read through lib/integrations/read (admin-gated) instead:\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the dashboard read helper applies the canManageIntegrations gate", () => {
    const src = readFileSync(HELPER, "utf8");
    expect(src).toMatch(/canManageIntegrations\s*\(/);
  });

  it("EVERY exported helper that reads the integrations table gates on canManageIntegrations", () => {
    const src = readFileSync(HELPER, "utf8");
    // Each chunk is one exported function body (up to the next export / EOF).
    const ungated = src
      .split(/export async function /)
      .slice(1)
      .filter((chunk) => TABLE.test(chunk) && !/canManageIntegrations\s*\(/.test(chunk))
      .map((chunk) => chunk.slice(0, chunk.indexOf("(")));
    expect(
      ungated,
      `helper fn(s) read the integrations table without a canManageIntegrations gate: ${ungated.join(", ")}`
    ).toEqual([]);
  });

  it("the matcher discriminates (non-vacuity)", () => {
    expect(TABLE.test('db.from("integrations").select("x")')).toBe(true);
    expect(TABLE.test('db.from("items").select("x")')).toBe(false);
  });
});
