import { describe, expect, it } from "vitest";
import { creditedContributorIds, creditedPrimaryId, resolveItemCreditIds } from "@/lib/attribution/contributor-credit";
import type { DbClient } from "@/lib/db/types";

/** Minimal chainable fake db: each `from(table)` resolves to a preset `{data, error}` for that table. */
function fakeDb(byTable: Record<string, { data: unknown; error: unknown }>): DbClient {
  return {
    from(table: string) {
      const result = byTable[table] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order"]) chain[m] = () => chain;
      (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => resolve(result);
      return chain;
    },
  } as unknown as DbClient;
}

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

describe("creditedPrimaryId — the single BALANCING representative", () => {
  it("keeps the current owner when they actually worked (unchanged normal case)", () => {
    expect(creditedPrimaryId({ locked: false, currentMemberId: A, versionMemberIds: [A], latestWorkerId: A })).toBe(A);
    expect(creditedPrimaryId({ locked: false, currentMemberId: B, versionMemberIds: [A, B], latestWorkerId: B })).toBe(B);
  });

  it("shifts to the LATEST actual worker when the current owner did NO work (a pure reassignment)", () => {
    // Owner is B (reassigned) but only A ever produced a version → A gets the balancing share, not B.
    expect(creditedPrimaryId({ locked: false, currentMemberId: B, versionMemberIds: [A], latestWorkerId: A })).toBe(A);
  });

  it("LOCKED → the corrected owner regardless of who worked", () => {
    expect(creditedPrimaryId({ locked: true, currentMemberId: B, versionMemberIds: [A], latestWorkerId: A })).toBe(B);
  });

  it("leaves an unattributed item unattributed (no owner → null, unchanged balancing behavior)", () => {
    expect(creditedPrimaryId({ locked: false, currentMemberId: null, versionMemberIds: [A], latestWorkerId: A })).toBe(null);
  });

  it("falls back to the current owner when there is no work ledger", () => {
    expect(creditedPrimaryId({ locked: false, currentMemberId: A, versionMemberIds: [], latestWorkerId: null })).toBe(A);
  });
});

describe("resolveItemCreditIds strict vs best-effort error handling", () => {
  const items = { data: [{ id: "i1", member_id: "m1", member_id_locked: false }], error: null };
  const members = { data: [{ id: "m1", display_name: "Alex", actor_handle: "alex", is_connector: false }], error: null };
  const versionsError = { data: null, error: { message: "pool timeout" } };

  it("STRICT mode throws on a DB error (so the timeline never caches an empty ledger as fresh)", async () => {
    const db = fakeDb({ items, item_versions: versionsError, members });
    await expect(resolveItemCreditIds(db, "team", ["i1"], { strict: true })).rejects.toThrow(/resolveItemCredit/);
  });

  it("best-effort mode does NOT throw on a DB error (arcs/admin degrade instead of failing)", async () => {
    const db = fakeDb({ items, item_versions: versionsError, members });
    const out = await resolveItemCreditIds(db, "team", ["i1"]); // no strict
    // Versions unreadable → treated as no version history → credit falls back to the current owner.
    expect(out.get("i1")?.primaryId).toBe("m1");
  });
});
