import { describe, expect, it } from "vitest";
import { createOpportunity, listVariants } from "@/lib/social/store";
import { planOpportunity } from "@/lib/social/plan";
import { saveBrandProfile } from "@/lib/brand/manage";
import { db, seedTeam } from "./helpers";

/**
 * Spec for planning on real Postgres. Derived from intent: an opportunity becomes a plan + brand-
 * aware platform variants, tier propagates down the chain, the opportunity advances to `planned`,
 * and re-planning is idempotent (no duplicate plan/variants).
 */
describe("content planning (real Postgres)", () => {
  it("plans an opportunity into tier-inherited, brand-aware variants and advances it", async () => {
    const seed = await seedTeam();
    await saveBrandProfile(db(), seed.teamId, { voice: { formality: "formal" }, knowledge: { audiences: ["CTOs"] } }, { memberId: seed.memberId });
    const opp = await createOpportunity(db(), seed.teamId, {
      access: "team",
      sourceType: "manual",
      title: "Shipped the job queue",
    });

    const r = await planOpportunity(db(), seed.teamId, opp.id, { memberId: seed.memberId });
    expect(r.created).toBe(true);
    expect(r.plan.access).toBe("team"); // inherited from opportunity
    expect(r.plan.audience).toBe("CTOs"); // brand-aware
    expect(r.variants.length).toBe(2);
    expect(r.variants.every((v) => v.access === "team")).toBe(true); // tier propagates
    expect(r.variants.every((v) => v.tone === "authoritative")).toBe(true); // from brand formality
    expect(r.variants.map((v) => v.platform).sort()).toEqual(["linkedin", "x"]);

    // Opportunity advanced to planned.
    const { data: after } = await db().from("social_opportunities").select("status").eq("id", opp.id).maybeSingle();
    expect(after.status).toBe("planned");
  });

  it("is idempotent — re-planning returns the same plan with no duplicate variants", async () => {
    const seed = await seedTeam();
    const opp = await createOpportunity(db(), seed.teamId, { access: "team", sourceType: "manual", title: "x" });

    const first = await planOpportunity(db(), seed.teamId, opp.id);
    const second = await planOpportunity(db(), seed.teamId, opp.id);
    expect(second.created).toBe(false);
    expect(second.plan.id).toBe(first.plan.id);

    const { count: planCount } = await db()
      .from("content_plans")
      .select("id", { count: "exact", head: true })
      .eq("opportunity_id", opp.id);
    expect(planCount).toBe(1);

    const variants = await listVariants(db(), seed.teamId, first.plan.id, "team");
    expect(variants.length).toBe(2); // not doubled
  });
});
