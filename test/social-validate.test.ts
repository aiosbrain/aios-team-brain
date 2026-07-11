import { describe, expect, it } from "vitest";
import { governanceFromBrand, validateContent } from "@/lib/social/validate";

/**
 * Spec for the governance gate. Policy: prohibited phrases + confidential topics BLOCK; claims
 * needing verification WARN. Case-insensitive substring match. Derived from the policy, not impl.
 */
describe("content validation gate", () => {
  const rules = {
    prohibitedPhrases: ["synergy"],
    confidentialTopics: ["unreleased pricing"],
    claimsNeedingVerification: ["fastest"],
  };

  it("passes clean content", () => {
    const r = validateContent("We shipped a durable job queue today.", rules);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("blocks a prohibited phrase (case-insensitive)", () => {
    const r = validateContent("Unlock Synergy with our platform.", rules);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ rule: "prohibited_phrase", term: "synergy" });
  });

  it("blocks a confidential topic", () => {
    const r = validateContent("Sneak peek at our unreleased pricing tiers.", rules);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.rule === "confidential_topic")).toBe(true);
  });

  it("warns but does not block on an unverified claim", () => {
    const r = validateContent("We are the fastest brain on the market.", rules);
    expect(r.ok).toBe(true);
    expect(r.warnings[0]).toMatchObject({ rule: "unverified_claim", term: "fastest" });
  });

  it("derives rules from a brand profile record", () => {
    const g = governanceFromBrand({
      voice: { prohibitedPhrases: ["synergy"] },
      governance: { confidentialTopics: ["roadmap"] },
      knowledge: { claimsNeedingVerification: ["best"] },
    });
    expect(g.prohibitedPhrases).toEqual(["synergy"]);
    expect(g.confidentialTopics).toEqual(["roadmap"]);
    expect(g.claimsNeedingVerification).toEqual(["best"]);
  });
});
