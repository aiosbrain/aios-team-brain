import { describe, expect, it } from "vitest";
import { createOpportunity } from "@/lib/social/store";
import { TierLeakError } from "@/lib/social/tier";
import { db, ingest, seedTeam } from "./helpers";

/**
 * Spec for the evidence→tier-leak invariant on real Postgres (CLAUDE.md §5). Derived from the
 * leak we're preventing: an opportunity generated from `team`-tier brain knowledge must never be
 * created at `external` (publicly visible) tier, because content derived from it could then be
 * published publicly. There is no RLS backstop — createOpportunity is the sole guard. Proven to
 * the observable outcome: the create THROWS (no row written) when it would over-expose.
 */
describe("social opportunity evidence→tier-leak (real Postgres)", () => {
  it("refuses an external opportunity whose evidence is a team item", async () => {
    const seed = await seedTeam();
    const teamItem = await ingest(seed, { body: "internal roadmap note", path: "notes/roadmap.md", access: "team" });

    await expect(
      createOpportunity(db(), seed.teamId, {
        access: "external",
        sourceType: "manual",
        title: "Leak attempt",
        evidence: [{ itemId: teamItem.id }],
      })
    ).rejects.toBeInstanceOf(TierLeakError);

    // No row was written.
    const { count } = await db()
      .from("social_opportunities")
      .select("id", { count: "exact", head: true })
      .eq("team_id", seed.teamId);
    expect(count).toBe(0);
  });

  it("allows a team opportunity on the same team evidence", async () => {
    const seed = await seedTeam();
    const teamItem = await ingest(seed, { body: "internal note", path: "notes/x.md", access: "team" });
    const opp = await createOpportunity(db(), seed.teamId, {
      access: "team",
      sourceType: "manual",
      title: "Internal-only opportunity",
      evidence: [{ itemId: teamItem.id }],
    });
    expect(opp.access).toBe("team");
  });

  it("allows an external opportunity when all evidence is external", async () => {
    const seed = await seedTeam();
    const extItem = await ingest(seed, { body: "public blog post", path: "blog/launch.md", access: "external" });
    const opp = await createOpportunity(db(), seed.teamId, {
      access: "external",
      sourceType: "manual",
      title: "Public opportunity",
      evidence: [{ itemId: extItem.id }],
    });
    expect(opp.access).toBe("external");
  });

  it("fails closed on a dangling evidence id", async () => {
    const seed = await seedTeam();
    await expect(
      createOpportunity(db(), seed.teamId, {
        access: "external",
        sourceType: "manual",
        title: "Bogus evidence",
        evidence: [{ itemId: "00000000-0000-0000-0000-000000000000" }],
      })
    ).rejects.toBeInstanceOf(TierLeakError);
  });

  it("allows a manual external opportunity with no item evidence", async () => {
    const seed = await seedTeam();
    const opp = await createOpportunity(db(), seed.teamId, {
      access: "external",
      sourceType: "manual",
      title: "Untied public idea",
    });
    expect(opp.access).toBe("external");
  });
});
