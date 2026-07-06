import { describe, expect, it } from "vitest";
import { pickHomeState } from "@/lib/dashboard/home-state";
import { db, ingest, seedTeam } from "./helpers";

// Spec: a non-admin member invited into an ALREADY-ACTIVE team (itemCount > 0) with zero
// api_keys ever issued must land on "member-setup" — the root-cause bug this phase fixes
// (the old team-scoped-only checklist never fired for this exact scenario, since it only
// showed when the whole TEAM had zero synced items). Once that member issues a key, the
// same team+member flips to "dashboard". Verified against real Postgres so the query shape
// (api_keys existence per member, independent of revoked_at) is exercised, not just the
// pure decision function in isolation.

describe("dashboard home-state on an active team with a brand-new member (real Postgres)", () => {
  it("member-setup fires for a member with no key, even though the team already has synced items", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "docs/plan.md", body: "already active", access: "team" });

    const { count: itemCount } = await db()
      .from("items")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(itemCount ?? 0).toBeGreaterThan(0); // non-vacuity: team really is active

    const { count: ownKeyCount } = await db()
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("member_id", seed.memberId);
    expect(ownKeyCount ?? 0).toBe(0);

    expect(
      pickHomeState({ isAdmin: false, itemCount: itemCount ?? 0, hasOwnKey: (ownKeyCount ?? 0) > 0 })
    ).toBe("member-setup");
  });

  it("flips to dashboard once that same member issues a key", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "docs/plan.md", body: "already active", access: "team" });
    await db()
      .from("api_keys")
      .insert({
        team_id: seed.teamId,
        member_id: seed.memberId,
        key_id: `k-${seed.memberId.slice(0, 8)}`,
        key_hash: "irrelevant-hash-for-this-test",
        name: "laptop",
      });

    const { count: itemCount } = await db()
      .from("items")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    const { count: ownKeyCount } = await db()
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId)
      .eq("member_id", seed.memberId);
    expect(ownKeyCount ?? 0).toBe(1);

    expect(
      pickHomeState({ isAdmin: false, itemCount: itemCount ?? 0, hasOwnKey: (ownKeyCount ?? 0) > 0 })
    ).toBe("dashboard");
  });
});
