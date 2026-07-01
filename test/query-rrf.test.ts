import { describe, expect, it } from "vitest";
import { fuseByRrf } from "@/lib/query/dense-search";
import type { Source } from "@/lib/query/provider";

/**
 * Spec for Reciprocal-Rank Fusion of keyword + dense rankings: an item in BOTH lists ranks above one
 * in a single list, which ranks above unranked padding; ties keep prior order; sids are reassigned in
 * final order. Derived from what fusion must guarantee, not the implementation.
 */

function src(id: string): Source {
  return { sid: "", item_id: id, project: "", path: `p/${id}`, kind: "deliverable", synced_at: "", text: id };
}

describe("fuseByRrf", () => {
  it("ranks an item in both lists above single-list items, above unranked", () => {
    // sources arrive in FTS order [a,b,c] plus a dense-only [d]; dense order [d,a].
    const sources = [src("a"), src("b"), src("c"), src("d")];
    const fused = fuseByRrf(sources, ["a", "b", "c"], ["d", "a"]);
    const order = fused.map((s) => s.item_id);
    // 'a' is in both (fts rank 0 + dense rank 1) → highest; 'd' dense-only rank 0; then b, c.
    expect(order[0]).toBe("a");
    expect(order).toContain("d");
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    // sids reassigned in final order
    expect(fused.map((s) => s.sid)).toEqual(["S1", "S2", "S3", "S4"]);
  });

  it("keeps unranked / item_id-less sources but sinks them below ranked ones (stable)", () => {
    const augment: Source = { sid: "", item_id: null, project: "", path: "gbrain:1", kind: "brain", synced_at: "", text: "x" };
    const sources = [augment, src("a")];
    const fused = fuseByRrf(sources, ["a"], []);
    expect(fused[0].item_id).toBe("a"); // ranked first
    expect(fused[1].path).toBe("gbrain:1"); // padding retained, last
  });

  it("is a no-op ordering when neither list has the items (stable, just re-sids)", () => {
    const sources = [src("a"), src("b")];
    const fused = fuseByRrf(sources, [], []);
    expect(fused.map((s) => s.item_id)).toEqual(["a", "b"]);
    expect(fused.map((s) => s.sid)).toEqual(["S1", "S2"]);
  });
});
