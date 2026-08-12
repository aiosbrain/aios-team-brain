import { describe, expect, it } from "vitest";
import { filterArcsByVisibleItems } from "@/lib/graph/arc-visibility";
import type { NarrativeArc } from "@/lib/graph/arcs";

// Phase B slice 5 (spec §5.8/§5.8b) — the arc read-time visibility filter. An arc is a synthesized
// narrative over its cited evidence, so the gate is all-or-nothing: keep only when EVERY cited item
// is visible; drop a no-itemId arc (pure-graph basis, unpartitioned until Phase C) fail-closed.

const arc = (id: string, itemIds: (string | undefined)[]): NarrativeArc => ({
  id,
  title: `arc ${id}`,
  confidence: "high",
  summary: `summary ${id}`,
  participants: [],
  supporting_sources: [],
  evidence: itemIds.map((itemId) => ({ fact: `fact for ${id}`, itemId })),
  derived_at: "2026-08-12T00:00:00Z",
});

describe("filterArcsByVisibleItems", () => {
  it("permissive (null) is an identity passthrough — byte-identical to today", () => {
    const arcs = [arc("a", ["i1"]), arc("b", ["i2", "i3"]), arc("c", [])];
    expect(filterArcsByVisibleItems(arcs, null)).toBe(arcs);
  });

  it("enforcing: an arc whose EVERY cited item is visible is kept", () => {
    const kept = filterArcsByVisibleItems([arc("a", ["i1", "i2"])], new Set(["i1", "i2", "i3"]));
    expect(kept.map((x) => x.id)).toEqual(["a"]);
  });

  it("enforcing: an arc citing even ONE invisible item is dropped (no partial redaction of a synthesized narrative)", () => {
    const got = filterArcsByVisibleItems([arc("a", ["i1", "SECRET"])], new Set(["i1"]));
    expect(got, "one invisible cited item drops the whole arc").toEqual([]);
  });

  it("enforcing: an arc with NO linkable itemId evidence fails closed (dropped) — pure-graph basis", () => {
    const got = filterArcsByVisibleItems([arc("a", [undefined, undefined])], new Set(["i1"]));
    expect(got).toEqual([]);
  });

  it("enforcing: mixed set — keeps only the fully-visible arcs", () => {
    const arcs = [
      arc("visible", ["i1", "i2"]),
      arc("partly-restricted", ["i1", "SECRET"]),
      arc("no-evidence", []),
      arc("fully-restricted", ["SECRET2"]),
    ];
    const got = filterArcsByVisibleItems(arcs, new Set(["i1", "i2"]));
    expect(got.map((x) => x.id)).toEqual(["visible"]);
  });

  it("enforcing with an EMPTY visible set: everything drops (a member who sees nothing gets no arcs)", () => {
    expect(filterArcsByVisibleItems([arc("a", ["i1"]), arc("b", [])], new Set())).toEqual([]);
  });
});
