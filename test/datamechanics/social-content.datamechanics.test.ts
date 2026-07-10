import { describe, expect, it } from "vitest";
import {
  addVariant,
  createOpportunity,
  createPlan,
  getOpportunity,
  listOpportunities,
  listVariants,
} from "@/lib/social/store";
import { db, seedTeam } from "./helpers";

/**
 * Spec for the Social Brain content domain on real Postgres (M2 foundation). Derived from the
 * product invariants, not the impl:
 *  1. the opportunity → plan → variant chain persists with provenance preserved, and
 *  2. TIER ISOLATION (CLAUDE.md §5) — an `external` viewer never sees a `team`-sourced opportunity,
 *     and tier PROPAGATES down the chain (a team opportunity can't spawn an external plan/variant).
 * This is the §5-critical proof: there is no RLS backstop, so the store's app-code enforcement is
 * the only thing standing between internal knowledge and a public post.
 */
describe("social content domain (real Postgres)", () => {
  it("persists the opportunity → plan → variant chain with provenance", async () => {
    const { teamId, memberId } = await seedTeam();
    const opp = await createOpportunity(
      db(),
      teamId,
      {
        access: "team",
        sourceType: "item",
        title: "Shipped durable job queue",
        summary: "M0 landed",
        evidence: [{ itemId: "abc", path: "commits/x.md", note: "the PR" }],
        topics: ["infra"],
        noveltyScore: 0.8,
        relevanceScore: 0.6,
      },
      { memberId }
    );
    expect(opp.status).toBe("discovered");
    expect(opp.evidence).toEqual([{ itemId: "abc", path: "commits/x.md", note: "the PR" }]);
    expect(opp.novelty_score).toBeCloseTo(0.8);

    const plan = await createPlan(db(), teamId, opp.id, { objective: "awareness", audience: "devs" }, { memberId });
    expect(plan.opportunity_id).toBe(opp.id); // provenance link preserved
    expect(plan.access).toBe("team");

    const variant = await addVariant(db(), teamId, plan.id, { platform: "x", format: "text", body: "we shipped it" });
    expect(variant.plan_id).toBe(plan.id);
    expect(variant.status).toBe("planned");
    expect(variant.access).toBe("team"); // inherited from plan
  });

  it("propagates tier down the chain — a team opportunity yields team plan + variant", async () => {
    const { teamId } = await seedTeam();
    const opp = await createOpportunity(db(), teamId, { access: "team", sourceType: "manual", title: "internal only" });
    const plan = await createPlan(db(), teamId, opp.id);
    const variant = await addVariant(db(), teamId, plan.id, { platform: "linkedin", format: "text" });
    expect(plan.access).toBe("team");
    expect(variant.access).toBe("team");
  });

  it("isolates tiers — an external viewer never sees a team-sourced opportunity", async () => {
    const { teamId } = await seedTeam();
    await createOpportunity(db(), teamId, { access: "team", sourceType: "manual", title: "internal roadmap" });
    await createOpportunity(db(), teamId, { access: "external", sourceType: "manual", title: "public launch" });

    const asTeam = await listOpportunities(db(), teamId, "team");
    const asExternal = await listOpportunities(db(), teamId, "external");

    expect(asTeam.map((o) => o.title).sort()).toEqual(["internal roadmap", "public launch"]);
    // The external principal sees ONLY the external-tier opportunity — no team leak.
    expect(asExternal.map((o) => o.title)).toEqual(["public launch"]);
  });

  it("filters variants by tier too", async () => {
    const { teamId } = await seedTeam();
    const opp = await createOpportunity(db(), teamId, { access: "team", sourceType: "manual", title: "x" });
    const plan = await createPlan(db(), teamId, opp.id);
    await addVariant(db(), teamId, plan.id, { platform: "x", format: "text" });

    // The team-tier variant is invisible to an external viewer.
    expect(await listVariants(db(), teamId, plan.id, "external")).toEqual([]);
    expect((await listVariants(db(), teamId, plan.id, "team")).length).toBe(1);
  });

  it("is idempotent by dedup key", async () => {
    const { teamId } = await seedTeam();
    const a = await createOpportunity(db(), teamId, { access: "team", sourceType: "item", title: "dupe", dedupKey: "item:abc" });
    const b = await createOpportunity(db(), teamId, { access: "team", sourceType: "item", title: "dupe again", dedupKey: "item:abc" });
    expect(b.id).toBe(a.id);
    expect((await getOpportunity(db(), teamId, a.id))!.title).toBe("dupe"); // first write wins
  });

  it("scopes opportunities to the team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    await createOpportunity(db(), b.teamId, { access: "external", sourceType: "manual", title: "team b public" });
    expect(await listOpportunities(db(), a.teamId, "team")).toEqual([]);
  });
});
