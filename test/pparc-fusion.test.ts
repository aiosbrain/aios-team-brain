import { describe, expect, it } from "vitest";
import { fuseArcRows, FUSED_PANEL_MAX } from "@/lib/graph/arc-fusion";
import type { ArcCacheEntry } from "@/lib/graph/arc-cache";
import type { NarrativeArc } from "@/lib/graph/arcs";

/**
 * PPARC-3 — the fusion core is PROSE-FREE and panel-stable (design §2.2; criterion 6). Pure
 * function, unit tier.
 */

const arc = (id: string): NarrativeArc =>
  ({ id, title: `t-${id}`, confidence: "high", summary: `s-${id}`, participants: [], supporting_sources: [], evidence: [], derived_at: "2026-08-16T00:00:00Z" }) as NarrativeArc;
const entry = (arcs: NarrativeArc[], computedAt = 1000, degraded = false): ArcCacheEntry => ({ arcs, computedAt, factsHash: "h", degraded });

describe("PPARC-3 — fuseArcRows (criterion 6)", () => {
  it("output arcs are FIELD-IDENTICAL to their rows' arcs modulo sourceGroup — no field rewritten, no prose computed", () => {
    const a = [arc("a1"), arc("a2")];
    const b = [arc("b1")];
    const { arcs } = fuseArcRows([
      { group: "A", entry: entry(a) },
      { group: "B", entry: entry(b) },
    ]);
    for (const fused of arcs) {
      const source = (fused.sourceGroup === "A" ? a : b).find((x) => x.id === fused.id)!;
      const { sourceGroup: _sourceGroup, ...rest } = fused;
      expect(rest).toEqual(source); // field-identical modulo the annotation
    }
  });

  it("round-robin interleave in rank order — one busy partition cannot evict the others", () => {
    const busy = Array.from({ length: 20 }, (_, i) => arc(`busy-${i}`));
    const quiet = [arc("q1"), arc("q2")];
    const { arcs } = fuseArcRows([
      { group: "BUSY", entry: entry(busy) },
      { group: "QUIET", entry: entry(quiet) },
    ]);
    expect(arcs).toHaveLength(FUSED_PANEL_MAX);
    expect(arcs.filter((a2) => a2.sourceGroup === "QUIET")).toHaveLength(2); // both survive the cap
    expect(arcs[0].sourceGroup).toBe("BUSY"); // rank order leads
    expect(arcs[1].sourceGroup).toBe("QUIET"); // …but interleaves immediately
  });

  it("a byte-stable input produces a byte-stable panel (design Medium 8 — no churn when nothing changed)", () => {
    const rows = [
      { group: "A", entry: entry([arc("a1"), arc("a2")]) },
      { group: "B", entry: entry([arc("b1")]) },
    ];
    expect(JSON.stringify(fuseArcRows(rows))).toBe(JSON.stringify(fuseArcRows(rows)));
  });

  it("the envelope inputs: as_of is the OLDEST row, degraded is any-row-true", () => {
    const { asOf, anyDegraded } = fuseArcRows([
      { group: "A", entry: entry([arc("a1")], 5000, false) },
      { group: "B", entry: entry([arc("b1")], 1000, true) },
    ]);
    expect(asOf).toBe(1000);
    expect(anyDegraded).toBe(true);
  });
});
