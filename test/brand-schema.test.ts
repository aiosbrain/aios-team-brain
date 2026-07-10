import { describe, expect, it } from "vitest";
import { validateBrandProfile, BrandProfileError, MAX_BRAND_BYTES } from "@/lib/brand/schema";

/**
 * Spec for Brand Brain validation: accept a well-formed profile, and reject the three ways a
 * config can be malformed — an unknown key (allowlist), a bad enum value, and an oversized blob.
 * Derived from the guardrail intent (a brand config is trusted downstream), not the impl.
 */
describe("brand profile validation", () => {
  it("accepts and normalizes a well-formed profile", () => {
    const out = validateBrandProfile({
      voice: { formality: "formal", prohibitedPhrases: ["synergy", "leverage"] },
      knowledge: { products: ["AIOS"], roadmapVisibility: "hint" },
      governance: { confidentialTopics: ["unreleased pricing"] },
    });
    expect(out.voice?.formality).toBe("formal");
    expect(out.voice?.prohibitedPhrases).toEqual(["synergy", "leverage"]);
    expect(out.knowledge?.roadmapVisibility).toBe("hint");
  });

  it("accepts an empty profile", () => {
    expect(validateBrandProfile({})).toEqual({});
    expect(validateBrandProfile(undefined)).toEqual({});
  });

  it("rejects an unknown key (allowlist / strict)", () => {
    expect(() => validateBrandProfile({ voice: { tone: "snarky" } })).toThrow(BrandProfileError);
    expect(() => validateBrandProfile({ secretApiKey: "x" })).toThrow(BrandProfileError);
  });

  it("rejects a bad enum value", () => {
    expect(() => validateBrandProfile({ voice: { formality: "sarcastic" } })).toThrow(BrandProfileError);
  });

  it("rejects an oversized profile", () => {
    const huge = { knowledge: { history: "x".repeat(MAX_BRAND_BYTES + 100) } };
    expect(() => validateBrandProfile(huge)).toThrow(/too large/);
  });
});
