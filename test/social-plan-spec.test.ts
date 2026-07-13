import { describe, expect, it } from "vitest";
import { buildPlanSpec } from "@/lib/social/plan";

/**
 * Spec for the deterministic plan shape derived from the Brand Brain. Derived from intent (planning
 * should honor brand voice/audience), not the implementation.
 */
describe("buildPlanSpec", () => {
  it("maps brand formality to a tone and takes the first audience", () => {
    const spec = buildPlanSpec({ voice: { formality: "formal" }, knowledge: { audiences: ["CTOs", "devs"] } });
    expect(spec.tone).toBe("authoritative");
    expect(spec.audience).toBe("CTOs");
    expect(spec.variants.map((v) => v.platform)).toEqual(["x", "linkedin"]);
  });

  it("falls back to neutral tone and empty audience with no brand", () => {
    const spec = buildPlanSpec(null);
    expect(spec.tone).toBe("neutral");
    expect(spec.audience).toBe("");
    expect(spec.objective).toBe("awareness");
  });

  it("ignores non-string audiences", () => {
    const spec = buildPlanSpec({ knowledge: { audiences: [42, "founders"] as unknown as string[] } });
    expect(spec.audience).toBe("founders");
  });
});
