import { describe, expect, it } from "vitest";
import {
  visibleItems,
  canSeeAccess,
  visibleDecisions,
  visibleTasks,
  visibleByAccess,
  scopeQueryLog,
  type ViewerTier,
  type QueryLogViewer,
} from "@/lib/auth/visibility";

/**
 * Direct unit coverage for the tier-visibility choke-point (CLAUDE.md §5). There is NO RLS —
 * this module is the SOLE app-code enforcement that an `external`-tier viewer never sees
 * `team`/`admin` content. Until now it had only transitive coverage via test/guards/* (which
 * prove callers route THROUGH the choke-point, not that the choke-point itself behaves
 * correctly for every tier/column). These tests exercise every exported function directly.
 */

// A minimal fake query builder that records every .eq() call, mirroring the supabase-js
// fluent-chain shape the real functions assert onto via their localized cast.
function fakeQuery() {
  const calls: Array<{ column: string; value: string }> = [];
  const self = {
    calls,
    eq(column: string, value: string) {
      calls.push({ column, value });
      return self;
    },
  };
  return self;
}

describe("visibleItems", () => {
  it("team tier: passes the query through unchanged (no filter applied)", () => {
    const q = fakeQuery();
    const out = visibleItems(q, "team");
    expect(out).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("external tier: filters to access='external'", () => {
    const q = fakeQuery();
    const out = visibleItems(q, "external");
    expect(out).toBe(q);
    expect(q.calls).toEqual([{ column: "access", value: "external" }]);
  });
});

describe("canSeeAccess", () => {
  it("team tier sees every access level (team, external, and even 'admin')", () => {
    expect(canSeeAccess("team", "team")).toBe(true);
    expect(canSeeAccess("team", "external")).toBe(true);
    // Documents current behavior: canSeeAccess trusts the caller never to hand it an
    // admin-tier row for a team viewer — admin/private content must never reach this
    // function's `access` column at all (enforced upstream at the ingest 422 boundary in
    // app/api/v1/items/route.ts, NOT here). See the "surprising" note in the PR description.
    expect(canSeeAccess("team", "admin")).toBe(true);
  });

  it("external tier sees ONLY external-access content", () => {
    expect(canSeeAccess("external", "external")).toBe(true);
    expect(canSeeAccess("external", "team")).toBe(false);
    expect(canSeeAccess("external", "admin")).toBe(false);
  });

  it("external tier default-denies unrecognized/empty access values", () => {
    expect(canSeeAccess("external", "")).toBe(false);
    expect(canSeeAccess("external", "bogus-tier")).toBe(false);
  });
});

describe("visibleDecisions", () => {
  it("team tier: passes the query through unchanged", () => {
    const q = fakeQuery();
    const out = visibleDecisions(q, "team");
    expect(out).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("external tier: filters to audience='external' (decisions carry tier in `audience`, not `access`)", () => {
    const q = fakeQuery();
    visibleDecisions(q, "external");
    expect(q.calls).toEqual([{ column: "audience", value: "external" }]);
  });
});

describe("visibleTasks", () => {
  it("team tier: passes the query through unchanged", () => {
    const q = fakeQuery();
    const out = visibleTasks(q, "team");
    expect(out).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("external tier: filters to audience='external'", () => {
    const q = fakeQuery();
    visibleTasks(q, "external");
    expect(q.calls).toEqual([{ column: "audience", value: "external" }]);
  });
});

describe("visibleByAccess (Social Brain content)", () => {
  it("team tier: passes the query through unchanged", () => {
    const q = fakeQuery();
    const out = visibleByAccess(q, "team");
    expect(out).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("external tier: filters to access='external'", () => {
    const q = fakeQuery();
    visibleByAccess(q, "external");
    expect(q.calls).toEqual([{ column: "access", value: "external" }]);
  });
});

describe("scopeQueryLog", () => {
  it("admin viewer: passes the query through unchanged (sees the whole team's log)", () => {
    const q = fakeQuery();
    const viewer: QueryLogViewer = { isAdmin: true, memberId: "mem-1" };
    const out = scopeQueryLog(q, viewer);
    expect(out).toBe(q);
    expect(q.calls).toEqual([]);
  });

  it("non-admin viewer: scopes to their own member_id", () => {
    const q = fakeQuery();
    const viewer: QueryLogViewer = { isAdmin: false, memberId: "mem-2" };
    scopeQueryLog(q, viewer);
    expect(q.calls).toEqual([{ column: "member_id", value: "mem-2" }]);
  });

  it("two non-admin viewers scope to DIFFERENT member_ids (non-vacuity: the filter actually discriminates by viewer)", () => {
    const qa = fakeQuery();
    const qb = fakeQuery();
    scopeQueryLog(qa, { isAdmin: false, memberId: "mem-a" });
    scopeQueryLog(qb, { isAdmin: false, memberId: "mem-b" });
    expect(qa.calls[0]?.value).toBe("mem-a");
    expect(qb.calls[0]?.value).toBe("mem-b");
    expect(qa.calls[0]?.value).not.toBe(qb.calls[0]?.value);
  });
});

describe("unknown/missing tier — fail-closed across the choke-point", () => {
  // `ViewerTier` is typed as the closed union "team" | "external", so a correctly-typed caller
  // can never construct anything else. But every one of these functions is a plain runtime
  // string check, and the real call sites feed them a DB-sourced or request-derived value cast
  // to `ViewerTier` (e.g. `me?.tier ?? "external"` in app/t/[team]/library/[itemId]/page.tsx, or
  // `auth.memberTier` off an API key row) — nothing stops a corrupt/legacy/typo'd tier value from
  // reaching these functions at the type boundary.
  //
  // Only the exact runtime value `team` is trusted with an unfiltered query. Corrupt, legacy,
  // mistyped, or future tiers receive external-only visibility, matching canSeeAccess.
  const unknownTiers = [
    "admin",
    "",
    "TEAM",
    "external ",
    "unknown",
  ] as unknown as ViewerTier[];

  it.each(unknownTiers)(
    "visibleItems filters tier=%j to external rows",
    (tier) => {
      const q = fakeQuery();
      visibleItems(q, tier);
      expect(q.calls).toEqual([{ column: "access", value: "external" }]);
    },
  );

  it.each(unknownTiers)(
    "visibleDecisions filters tier=%j to external rows",
    (tier) => {
      const q = fakeQuery();
      visibleDecisions(q, tier);
      expect(q.calls).toEqual([{ column: "audience", value: "external" }]);
    },
  );

  it.each(unknownTiers)(
    "visibleTasks filters tier=%j to external rows",
    (tier) => {
      const q = fakeQuery();
      visibleTasks(q, tier);
      expect(q.calls).toEqual([{ column: "audience", value: "external" }]);
    },
  );

  it.each(unknownTiers)(
    "visibleByAccess filters tier=%j to external rows",
    (tier) => {
      const q = fakeQuery();
      visibleByAccess(q, tier);
      expect(q.calls).toEqual([{ column: "access", value: "external" }]);
    },
  );

  it.each(unknownTiers)(
    "canSeeAccess(tier=%j, 'team') denies team-tier content",
    (tier) => {
      expect(canSeeAccess(tier, "team")).toBe(false);
    },
  );

  it.each(unknownTiers)(
    "canSeeAccess(tier=%j, 'external') still grants external-access content regardless of tier (by design — external content is universally readable)",
    (tier) => {
      expect(canSeeAccess(tier, "external")).toBe(true);
    },
  );
});
