import { describe, expect, it } from "vitest";
import { isBuiltinEligible, isPrincipal } from "@/lib/access/eligibility";

// Spec §4: eligibility is TWO named predicates — isPrincipal admits humans AND standing agents
// (a single "verbatim" predicate would deny every agent at RLS); isBuiltinEligible narrows to
// humans only (agents are principals but NEVER auto-admitted to Everyone/External).

const base = { kind: "human", is_connector: false, status: "active" };

describe("isPrincipal", () => {
  it("admits active non-connector humans and agents", () => {
    expect(isPrincipal(base)).toBe(true);
    expect(isPrincipal({ ...base, kind: "agent" })).toBe(true);
  });

  it("rejects offroster, connectors, and non-active members — each condition independently", () => {
    expect(isPrincipal({ ...base, kind: "offroster" })).toBe(false);
    expect(isPrincipal({ ...base, is_connector: true })).toBe(false);
    expect(isPrincipal({ ...base, status: "invited" })).toBe(false);
    expect(isPrincipal({ ...base, status: "disabled" })).toBe(false);
  });

  it("rejects an unknown kind (fail closed, not fall through to human)", () => {
    expect(isPrincipal({ ...base, kind: "robot" })).toBe(false);
  });
});

describe("isBuiltinEligible", () => {
  it("narrows isPrincipal to humans only — an active agent is a principal but not builtin-eligible", () => {
    expect(isBuiltinEligible(base)).toBe(true);
    expect(isBuiltinEligible({ ...base, kind: "agent" })).toBe(false);
  });

  it("never admits what isPrincipal rejects", () => {
    expect(isBuiltinEligible({ ...base, kind: "offroster" })).toBe(false);
    expect(isBuiltinEligible({ ...base, is_connector: true })).toBe(false);
    expect(isBuiltinEligible({ ...base, status: "invited" })).toBe(false);
  });
});
