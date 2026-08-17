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

describe("dense-leg enforcement wired in lib/query/retrieve.ts (Codex B3 Medium)", () => {
  const src = read("lib/query/retrieve.ts");
  it("denseSearch receives the visible-item set (in-query, not post-filter-only)", () => {
    expect(src).toMatch(/denseSearch\(\s*teamId\s*,\s*tier\s*,\s*q\s*,\s*projectSlug\s*,\s*undefined\s*,\s*undefined\s*,\s*visArr\s*\)/);
  });
  it("dense grounding counts only VISIBLE hits (an invisible-only match must not suppress abstention)", () => {
    expect(src).toMatch(/denseHits\.some\(\s*\(h\)\s*=>\s*visible\(h\.item_id\)\s*\)/);
    // The unconditional form must be gone.
    expect(src).not.toMatch(/if\s*\(denseHits\.length\)\s*\{\s*grounded\s*=\s*true/s);
  });
});

describe("arc enforcement wiring in app/api/brain/arcs/route.ts (Phase B slice 5, §5.8)", () => {
  const src = read("app/api/brain/arcs/route.ts");
  it("resolves the member's visibility and serves the FILTERED tier arcs, not the raw getArcs output", () => {
    expect(src).toMatch(/memberEnforcement\(\s*admin\s*,\s*\{\s*teamId:\s*team\.id\s*,\s*memberId\s*\}\s*\)/);
    expect(src).toMatch(/const\s+arcs\s*=\s*filterArcsByVisibleItems\(\s*allArcs\s*,\s*enforce\?\.visibleItemIds\s*\?\?\s*null\s*\)/);
  });
  it("fails closed on an enforcement-resolution error (500, never the unfiltered set)", () => {
    expect(src).toMatch(/catch\s*\{\s*return errorResponse\("internal", "enforcement check failed", 500\)/);
  });
  it("the RECOMPUTE route filters too — it returns the tier arc set and is team-tier-gated, not admin-gated (Fable B5 High: an unfiltered bypass otherwise)", () => {
    const rc = read("app/api/brain/arcs/recompute/route.ts");
    expect(rc).toMatch(/memberEnforcement\(\s*admin\s*,\s*\{\s*teamId:\s*team\.id\s*,\s*memberId\s*\}\s*\)/);
    expect(rc).toMatch(/const\s+arcs\s*=\s*filterArcsByVisibleItems\(\s*allArcs\s*,\s*enforce\?\.visibleItemIds\s*\?\?\s*null\s*\)/);
    expect(rc).toMatch(/catch\s*\{\s*return errorResponse\("internal", "enforcement check failed", 500\)/);
  });
  it("the recompute route gates the correction WRITE by visibility BEFORE recomputeArcs (Codex B5 High: arbitrary/invisible corrections poison the shared synthesis)", () => {
    const rc = read("app/api/brain/arcs/recompute/route.ts");
    // reads the CACHED arcs (no synthesis) + filters + rejects an out-of-visibility target …
    expect(rc).toMatch(/readArcCache\(/);
    expect(rc).toMatch(/corrections\.some\(\s*\(c\)\s*=>\s*!visibleIds\.has\(c\.arc_id\)\s*\)/);
    expect(rc).toMatch(/a correction targets an arc outside your visibility/);
    // … and that gate must sit BEFORE the recomputeArcs call (which writes + projects).
    const gateAt = rc.indexOf("outside your visibility");
    const recomputeAt = rc.indexOf("await recomputeArcs(");
    expect(gateAt, "the write gate must precede recomputeArcs").toBeLessThan(recomputeAt);
  });
  it("both arc routes neutralize the response for an enforcing member whose result is empty (§5.7 — no absent-vs-invisible disclosure)", () => {
    // main route: the team-wide diagnostic runs ONLY on a permissive team …
    expect(read("app/api/brain/arcs/route.ts")).toMatch(/if\s*\(arcs\.length === 0 && enforce == null\)/);
    // … and both routes return a neutral envelope on enforcing-empty.
    expect(read("app/api/brain/arcs/route.ts")).toMatch(/enforce != null && arcs\.length === 0/);
    expect(read("app/api/brain/arcs/recompute/route.ts")).toMatch(/enforcingEmpty\s*=\s*enforce != null && arcs\.length === 0/);
  });
});

describe("timeline enforcement wiring (Phase B slice 4, §5.8)", () => {
  it("every timeline surface passes its PRINCIPAL to getCachedWorkTimeline (4th arg — a forgotten one would serve the tier row)", () => {
    expect(read("app/api/v1/timeline/route.ts")).toMatch(/getCachedWorkTimeline\(db,\s*auth\.teamId,\s*auth\.memberTier,\s*auth\.memberId\s*\)/);
    expect(read("app/api/dashboard/team-work/route.ts")).toMatch(/getCachedWorkTimeline\(adminClient\(\),\s*team\.id,\s*tier,\s*\(me as \{ id: string \}\)\.id\s*\)/);
    expect(read("components/learning/timeline-panel.tsx")).toMatch(/getCachedWorkTimeline\(adminClient\(\),\s*teamId,\s*tier,\s*memberId\s*\)/);
  });
  it("the windowed dashboard route enforces BOTH arms (the fresh-build arm bypasses the cache layer)", () => {
    const src = read("app/api/dashboard/timeline/route.ts");
    expect(src).toMatch(/getCachedWorkTimeline\(adminClient\(\),\s*team\.id,\s*tier,\s*memberId\s*\)/);
    expect(src).toMatch(/getWorkTimeline\([^;]*days,\s*await\s+memberEnforcement\(/);
  });
  it("the cache layer fails closed: no principal on an enforcing team throws", () => {
    expect(read("lib/dashboard/timeline-cache.ts")).toMatch(/timeline read without a principal on an enforcing team/);
  });
});

describe("delegated query wiring in app/api/v1/query/route.ts (Phase B slice 3)", () => {
  const src = read("app/api/v1/query/route.ts");
  it("delegated principals get the ALWAYS-attenuated path (flag-independent)", () => {
    // Pin the FULL sequence in one regex (Fable B3 Medium): the agent branch must resolve
    // delegatedVisibleItemIds WITH the agent principal, ASSIGN the result to `enforce`, and the
    // flag-gated member path must be its else-branch — so the agent arm can neither lose the
    // assignment (call kept, enforce stays null → unfiltered retrieve with graph legs live) nor
    // be nested inside teamEnforcesAccess (flag-dependent → permissive team widens the token).
    // QMIR-1 widened the pin: the agent arm must ALSO carry `principal: "token"` — the
    // org-structural mirror legs key on the positive member test, so losing the discriminant
    // here silently costs nothing today but is the field a future refactor must not drop.
    // Comment lines between the resolve and the assignment are permitted; code is not.
    expect(src).toMatch(
      /if\s*\(agent\)\s*\{\s*const\s*\{\s*ids\s*\}\s*=\s*await\s+delegatedVisibleItemIds\(\s*db\s*,\s*agent\s*\)\s*;\s*(?:\/\/[^\n]*\n\s*)*enforce\s*=\s*\{\s*visibleItemIds:\s*ids\s*,\s*principal:\s*"token"\s*\}\s*;\s*\}\s*else\s+if\s*\(await\s+teamEnforcesAccess/
    );
    // No bare `enforce = null` assignment may exist anywhere (Codex B3 Low: the sequence regex
    // above survives a later re-null). The typed declaration (`let enforce: … | null = null`)
    // does not match this pattern, so the legal count is zero.
    expect(src.match(/enforce\s*=\s*null/g) ?? [], "enforce must never be re-nulled after the branch").toHaveLength(0);
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
