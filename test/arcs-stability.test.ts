import { describe, it, expect } from "vitest";
import { canReuseArcs } from "@/lib/graph/arcs";

// Spec: the fact-set-hash STABILITY guard. The background refresh reuses the prior arcs (skips the
// non-deterministic LLM) ONLY when the exact LLM input is byte-identical, there's no human correction,
// and the prior actually had arcs — so arcs change only when the underlying work does.

describe("canReuseArcs (arc stability guard)", () => {
  it("reuses when the hash matches, no corrections, and the prior had arcs", () => {
    expect(canReuseArcs({ factsHash: "abc", arcCount: 3 }, "abc", false)).toBe(true);
  });

  it("re-synthesizes when the fact hash changed (new/edited work — or a re-attribution)", () => {
    expect(canReuseArcs({ factsHash: "abc", arcCount: 3 }, "xyz", false)).toBe(false);
  });

  it("re-synthesizes when a human correction is present, even if the hash matches", () => {
    expect(canReuseArcs({ factsHash: "abc", arcCount: 3 }, "abc", true)).toBe(false);
  });

  it("never reuses a null/absent prior or a prior without a stored hash (pre-migration rows)", () => {
    expect(canReuseArcs(null, "abc", false)).toBe(false);
    expect(canReuseArcs({ factsHash: null, arcCount: 3 }, "abc", false)).toBe(false);
  });

  it("never reuses an empty prior (a prior with 0 arcs isn't worth keeping)", () => {
    expect(canReuseArcs({ factsHash: "abc", arcCount: 0 }, "abc", false)).toBe(false);
  });
});
