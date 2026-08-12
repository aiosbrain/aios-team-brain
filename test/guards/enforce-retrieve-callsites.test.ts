import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin the enforcement wiring at BOTH query routes (Phase B slice 2). retrieve() enforces only when
 * the caller passes `enforce`; a route that forgot to compute+pass it would silently serve an
 * enforcing team unfiltered retrieval — the leak this slice closes. Deleting the wiring must
 * redden here (the repo's recurring "call site pinned by nothing" failure).
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

for (const route of ["app/api/v1/query/route.ts", "app/api/dashboard/query/route.ts"]) {
  describe(`enforcement wired in ${route}`, () => {
    const src = read(route);
    it("checks the enforcement flag", () => {
      expect(src).toMatch(/teamEnforcesAccess\s*\(/);
    });
    it("resolves the member's visible items and passes enforce to retrieve", () => {
      expect(src).toMatch(/visibleItemIds\s*\(/);
      // retrieve is called WITH the enforce arg (not the 5-arg permissive form).
      expect(src).toMatch(/retrieve\([^)]*enforce\s*\)/);
    });
    it("fails closed on a flag-read error (500, never unfiltered)", () => {
      expect(src).toMatch(/enforcement check failed/);
    });
  });
}
