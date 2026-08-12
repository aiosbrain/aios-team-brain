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

describe("delegated query wiring in app/api/v1/query/route.ts (Phase B slice 3)", () => {
  const src = read("app/api/v1/query/route.ts");
  it("delegated principals get the ALWAYS-attenuated path (flag-independent)", () => {
    // Pin the FULL sequence in one regex (Fable B3 Medium): the agent branch must resolve
    // delegatedVisibleItemIds WITH the agent principal, ASSIGN the result to `enforce`, and the
    // flag-gated member path must be its else-branch — so the agent arm can neither lose the
    // assignment (call kept, enforce stays null → unfiltered retrieve with graph legs live) nor
    // be nested inside teamEnforcesAccess (flag-dependent → permissive team widens the token).
    expect(src).toMatch(
      /if\s*\(agent\)\s*\{\s*const\s*\{\s*ids\s*\}\s*=\s*await\s+delegatedVisibleItemIds\(\s*db\s*,\s*agent\s*\)\s*;\s*enforce\s*=\s*\{\s*visibleItemIds:\s*ids\s*\}\s*;\s*\}\s*else\s+if\s*\(await\s+teamEnforcesAccess/
    );
  });
  it("the Phase A 403 refusal is gone — delegated tokens authenticate instead", () => {
    expect(src).not.toMatch(/delegation_not_supported/);
    expect(src).toMatch(/authenticateAgentToken\s*\(/);
  });
  it("delegated queries are stateless: conversation_id refused, no thread reads/writes", () => {
    expect(src).toMatch(/agent\s*&&\s*conversation_id/);
    // Conversation store access hangs off `owner`, which is null for agents.
    expect(src).toMatch(/const\s+owner\s*=\s*auth\s*\?/);
  });
});
