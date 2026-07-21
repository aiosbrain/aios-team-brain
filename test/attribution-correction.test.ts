import { describe, expect, it } from "vitest";
import { correctionPlanSchema, resolveTarget } from "@/lib/attribution/correction";

/**
 * Spec for the correction plan's SAFETY boundary: the schema is closed, a match must be scoped (never
 * "all items"), and target resolution fails loudly on unknown/ambiguous names rather than mis-applying.
 * The LLM's output flows through this — so these are the guardrails, not the model. Pure, no DB.
 */

describe("correctionPlanSchema — the closed, scoped contract the LLM must produce", () => {
  it("accepts a scoped reassign plan", () => {
    const p = correctionPlanSchema.safeParse({ kind: "reassign", match: { source: "linear" }, toMember: "Fatma" });
    expect(p.success).toBe(true);
  });
  it("REJECTS an unscoped match (no criteria) — refuses an unbounded correction", () => {
    expect(correctionPlanSchema.safeParse({ kind: "reassign", match: {}, toMember: "Fatma" }).success).toBe(false);
  });
  it("rejects unknown top-level keys (strict) and a missing target", () => {
    expect(correctionPlanSchema.safeParse({ kind: "reassign", match: { source: "linear" }, toMember: "x", danger: "drop" }).success).toBe(false);
    expect(correctionPlanSchema.safeParse({ kind: "reassign", match: { source: "linear" } }).success).toBe(false);
  });
});

describe("resolveTarget — fail loud, never mis-apply", () => {
  const members = [
    { id: "m-fatma", name: "Fatma", email: "fatma@corp.com" },
    { id: "m-john", name: "John Ellison", email: "john@corp.com" },
    { id: "m-jon", name: "Jon Smith", email: "jon@corp.com" },
  ];

  it("resolves an exact email and a name (case-insensitive)", () => {
    expect(resolveTarget(members, "fatma@corp.com")).toMatchObject({ memberId: "m-fatma", clear: false });
    expect(resolveTarget(members, "FATMA")).toMatchObject({ memberId: "m-fatma" });
  });
  it("maps 'nobody' synonyms to a CLEAR (attribute to no one)", () => {
    expect(resolveTarget(members, "nobody")).toMatchObject({ memberId: null, clear: true });
    expect(resolveTarget(members, "unattributed")).toMatchObject({ clear: true });
  });
  it("errors on an unknown member (no silent guess)", () => {
    expect(resolveTarget(members, "Mallory").error).toBeTruthy();
    expect(resolveTarget(members, "Mallory").memberId).toBeNull();
  });
  it("errors on an ambiguous name rather than picking one", () => {
    const r = resolveTarget(members, "Jo"); // matches "John Ellison" and "Jon Smith"
    expect(r.error).toBeTruthy();
    expect(r.memberId).toBeNull();
  });
  it("errors on a whitespace-only target instead of matching everyone", () => {
    // "" would make byName.includes("") match all + byEmail match null-email members — must fail loud.
    const r = resolveTarget([...members, { id: "m-x", name: "X", email: null }], "   ");
    expect(r.error).toBeTruthy();
    expect(r.memberId).toBeNull();
  });
});
