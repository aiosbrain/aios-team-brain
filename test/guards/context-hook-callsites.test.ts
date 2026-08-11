import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Pin the §11 context-partition CALL SITES (slice 5). The reconcile core is shared by the
 * backfill, the ingest hook, and the scheduler leg; deleting any wiring must redden here, not
 * stay green (the repo's recurring "call site pinned by nothing" failure). Fire-and-forget /
 * after() paths can't be deterministically dm-tested, so this source-level pin is their guard;
 * the reconcile CORE gets its outcome test in the data-mechanics tier.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("§11 context-partition call sites", () => {
  it("the items push route reconciles context after the response", () => {
    const src = read("app/api/v1/items/route.ts");
    expect(src).toMatch(/reconcileItemContext/);
    // the reconcile must be INSIDE an after() block (not merely that the file uses after()
    // somewhere — pm-sync already does): require after(async ...) with reconcileItemContext in it.
    expect(src, "must run in after(), not inline (never blocks the push)").toMatch(/after\(async[\s\S]{0,400}reconcileItemContext/);
  });

  it("the scheduler tick runs the context-backfill convergence leg", () => {
    const src = read("lib/ingest/scheduler.ts");
    expect(src).toMatch(/await runContextBackfill\(db\);/);
    expect(src).toMatch(/backfillAllTeams/);
  });

  it("the admin action wires to the backfill through the admin guard", () => {
    const src = read("app/t/[team]/admin/access/actions.ts");
    expect(src).toMatch(/backfillTeamContext\s*\(/);
    expect(src).toMatch(/requireAdmin\s*\(/);
    expect(src, "must gate execution on the admin check").toMatch(/if \(!ctx\) return/);
  });

  it("the backfill and the ingest hook share ONE reconcile core (no divergent partitioning)", () => {
    // Both must go through reconcileItemContext — if the backfill re-inlined its own routing,
    // the two paths could partition an item differently. Pin the shared dependency.
    expect(read("lib/projects/context/backfill.ts")).toMatch(/reconcileItemContext/);
    expect(read("lib/projects/context/reconcile-item.ts")).toMatch(/closeOtherMemberships/);
  });
});
