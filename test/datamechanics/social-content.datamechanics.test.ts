import { describe, expect, it } from "vitest";
import {
  addVariant,
  createOpportunity,
  createPlan,
  getOpportunity,
  listOpportunities,
  listVariants,
} from "@/lib/social/store";
import { db, ingest, seedTeam } from "./helpers";

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
    const seed = await seedTeam();
    const { teamId } = seed;
    const ev = await ingest(seed, { path: "evidence/chain.md", body: "the evidence body", access: "team", project: "src" });
    const opp = await createOpportunity(db(), teamId, { access: "team", sourceType: "manual", title: "internal only", evidence: [{ itemId: ev.id }] });
    const plan = await createPlan(db(), teamId, opp.id);
    const variant = await addVariant(db(), teamId, plan.id, { platform: "linkedin", format: "text" });
    expect(plan.access).toBe("team");
    expect(variant.access).toBe("team");
  });

  it("isolates tiers — an external viewer never sees a team-sourced opportunity", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    const teamEv = await ingest(seed, { path: "evidence/t.md", body: "team evidence", access: "team", project: "src" });
    const extEv = await ingest(seed, { path: "evidence/e.md", body: "ext evidence", access: "external", project: "src" });
    await createOpportunity(db(), teamId, { access: "team", sourceType: "manual", title: "internal roadmap", evidence: [{ itemId: teamEv.id }] });
    await createOpportunity(db(), teamId, { access: "external", sourceType: "manual", title: "public launch", evidence: [{ itemId: extEv.id }] });

    // ENFB-4: the viewer set holds ALL evidence, so the POSTURE TIER stays this arm's only
    // discriminator (the membership axis has its own pins in enfb4-social.datamechanics).
    const allEv: ReadonlySet<string> = new Set([teamEv.id, extEv.id]);
    const asTeam = await listOpportunities(db(), teamId, "team", 50, allEv);
    const asExternal = await listOpportunities(db(), teamId, "external", 50, allEv);

    expect(asTeam.map((o) => o.title).sort()).toEqual(["internal roadmap", "public launch"]);
    // The external principal sees ONLY the external-tier opportunity — no team leak.
    expect(asExternal.map((o) => o.title)).toEqual(["public launch"]);
  });

  it("filters variants by tier too", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    const ev = await ingest(seed, { path: "evidence/v.md", body: "the evidence body", access: "team", project: "src" });
    const opp = await createOpportunity(db(), teamId, { access: "team", sourceType: "manual", title: "x", evidence: [{ itemId: ev.id }] });
    const plan = await createPlan(db(), teamId, opp.id);
    await addVariant(db(), teamId, plan.id, { platform: "x", format: "text" });

    // The team-tier variant is invisible to an external viewer.
    expect(await listVariants(db(), teamId, plan.id, "external")).toEqual([]);
    expect((await listVariants(db(), teamId, plan.id, "team")).length).toBe(1);
  });

  it("is idempotent by dedup key", async () => {
    const seed = await seedTeam();
    const { teamId } = seed;
    const ev = await ingest(seed, { path: "evidence/dupe.md", body: "the evidence body", access: "team", project: "src" });
    const a = await createOpportunity(db(), teamId, { access: "team", sourceType: "item", title: "dupe", dedupKey: "item:abc", evidence: [{ itemId: ev.id }] });
    const b = await createOpportunity(db(), teamId, { access: "team", sourceType: "item", title: "dupe again", dedupKey: "item:abc", evidence: [{ itemId: ev.id }] });
    expect(b.id).toBe(a.id);
    expect((await getOpportunity(db(), teamId, a.id))!.title).toBe("dupe"); // first write wins
  });

  it("scopes opportunities to the team", async () => {
    const a = await seedTeam();
    const b = await seedTeam();
    const ev = await ingest(b, { path: "evidence/b.md", body: "the evidence body", access: "external", project: "src" });
    await createOpportunity(db(), b.teamId, { access: "external", sourceType: "manual", title: "team b public", evidence: [{ itemId: ev.id }] });
    // A generous viewer set (holding team b's evidence!) still reads nothing across teams.
    expect(await listOpportunities(db(), a.teamId, "team", 50, new Set([ev.id]))).toEqual([]);
  });
});
