import { describe, expect, it } from "vitest";
import { rowVisibleByProvenance } from "@/lib/access/provenance";

// ENFB-1 AC3 (as re-specified): the settled provenance rule has ONE owner; every arm pinned
// here, and the body-surface pages' WIRING to it is pinned by the dashboard-tier-filter
// guard's oracle layer (a page dropping the call reddens the guard, not this file).
//
// AUDITFIX-1 threaded a 4th argument, `principal`, through this contract. Every assertion below
// states MEMBER behaviour — the settled ENFB-2 hand-typed rule, which that slice deliberately does
// NOT change — so "member" is passed EXPLICITLY. It is not defaulted: an omitted discriminator is
// `undefined` and closes the hand-typed arm, and a permissive default obtainable by saying nothing
// is the exact defect AUDITFIX-1 exists to remove. The token/absent/foreign inputs are pinned in
// test/access-provenance-principal.test.ts.

const vis = new Set(["visible-item"]);

describe("rowVisibleByProvenance — every arm", () => {
  it("sourced + visible source → true", () => {
    expect(rowVisibleByProvenance({ source_item_id: "visible-item", created_by: null }, vis, "team", "member")).toBe(true);
  });
  it("sourced + invisible source → false (restricted basis walled), even for team posture and even hand-typed", () => {
    expect(rowVisibleByProvenance({ source_item_id: "hidden-item", created_by: null }, vis, "team", "member")).toBe(false);
    expect(rowVisibleByProvenance({ source_item_id: "hidden-item", created_by: "someone" }, vis, "team", "member")).toBe(false);
  });
  it("sourced + NO visibility set → false (fail closed, never fail open)", () => {
    expect(rowVisibleByProvenance({ source_item_id: "visible-item", created_by: null }, null, "team", "member")).toBe(false);
  });
  it("null-source + created_by + team posture → true (the hand-typed round-trip)", () => {
    expect(rowVisibleByProvenance({ source_item_id: null, created_by: "author" }, vis, "team", "member")).toBe(true);
    expect(rowVisibleByProvenance({ created_by: "author" }, null, "team", "member")).toBe(true); // vis not needed on this branch
  });
  it("null-source + created_by + EXTERNAL posture → false (no membership axis — the audience wall survives)", () => {
    expect(rowVisibleByProvenance({ source_item_id: null, created_by: "author" }, vis, "external", "member")).toBe(false);
  });
  it("null-source + NO created_by → false in every posture (the purged-restricted-basis class)", () => {
    expect(rowVisibleByProvenance({ source_item_id: null, created_by: null }, vis, "team", "member")).toBe(false);
    expect(rowVisibleByProvenance({}, vis, "team", "member")).toBe(false);
    expect(rowVisibleByProvenance({ source_item_id: null }, vis, "external", "member")).toBe(false);
  });
});
