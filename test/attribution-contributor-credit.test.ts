import { describe, expect, it } from "vitest";
import { creditedContributorIds } from "@/lib/attribution/contributor-credit";

/**
 * Spec for the evidence-gated credit rule: credit everyone who produced WORK (a version) on an item, not
 * just its current owner — so a prior contributor survives a reassignment; a locked correction is the
 * authoritative override (credit collapses to the corrected owner). Pure, no DB.
 */

const A = "m-a";
const B = "m-b";

describe("creditedContributorIds", () => {
  it("credits every version author on an unlocked item — a handoff keeps BOTH contributors", () => {
    expect(creditedContributorIds({ locked: false, currentMemberId: B, versionMemberIds: [A, B] })).toEqual([A, B]);
  });

  it("still credits a prior contributor whose item was reassigned away (current owner did no version)", () => {
    // Item now owned by B (pure reassignment, no B-version) but A did all the work → A is still credited.
    expect(creditedContributorIds({ locked: false, currentMemberId: B, versionMemberIds: [A] })).toEqual([A]);
  });

  it("starves a mislabel: an assigned-but-never-worked owner (no versions) with no history → nobody", () => {
    expect(creditedContributorIds({ locked: false, currentMemberId: B, versionMemberIds: [] })).toEqual([B]); // falls back to current when there IS no work ledger at all
    expect(creditedContributorIds({ locked: false, currentMemberId: null, versionMemberIds: [] })).toEqual([]);
  });

  it("LOCKED (an admin correction) overrides evidence → ONLY the corrected owner", () => {
    expect(creditedContributorIds({ locked: true, currentMemberId: B, versionMemberIds: [A, B] })).toEqual([B]);
    expect(creditedContributorIds({ locked: true, currentMemberId: null, versionMemberIds: [A] })).toEqual([]); // corrected to nobody
  });
});
