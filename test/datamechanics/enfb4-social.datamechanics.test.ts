import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { db, ingest, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";
import { visibleItemIds } from "@/lib/access/enforce";
import {
  createOpportunity,
  listOpportunities,
  listPlansForOpportunities,
  listVariantsForPlans,
  opportunityVisible,
  actorSeesChain,
  createPlan,
  addVariant,
} from "@/lib/social/store";

// ENFB-4 ACs (docs/design/enfb4-social-oracle-gate.md): the Social Brain chain gates on the
// membership oracle — the EVERY rule at read, the actor scope at admission, the chain gates
// at the actions, the external-shared conjunct at the public door. Fixture rows carry their
// expected truth; the non-grantee is an ADMIN throughout (role must not bypass).

vi.mock("@/lib/auth/guard", () => ({ currentMember: vi.fn(), requireTeamAdmin: vi.fn() }));

async function seedAdmin(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@t.local`, display_name: "A", actor_handle: `a-${randomUUID().slice(0, 10)}`, role: "admin", tier: "team", status: "active" })
    .select("id")
    .single();
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

async function restrictInto(seed: Seed, itemId: string, memberInGroup: string): Promise<string> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "RG", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  await addMemberToGroup(db(), seed.teamId, g.groupId!, memberInGroup, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual" });
  expect(error).toBeNull();
  return proj!.id as string;
}

const visOf = async (seed: Seed, memberId: string) => {
  const v = await visibleItemIds(db(), { teamId: seed.teamId, memberId });
  expect(v.error).toBeFalsy();
  return v.ids;
};

async function mkOpp(seed: Seed, evidence: { itemId: string }[], access: "team" | "external" = "team") {
  return createOpportunity(db(), seed.teamId, {
    access, sourceType: "deliverable", title: `opp-${randomUUID().slice(0, 6)}`, summary: "s",
    evidence, topics: [], noveltyScore: 0.5, relevanceScore: 0.5, urgencyScore: 0.5, confidenceScore: 0.5,
    dedupKey: `t:${randomUUID()}`,
  }, { memberId: seed.memberId });
}

describe("ENFB-4 — the EVERY read rule + chain inheritance", () => {
  it("a restricted-evidenced opportunity (with plan+variant) hides from a non-grantee ADMIN's reads; the grantee sees it; MIXED evidence requires ALL; evidence-less legacy rows are dark", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const insider = await seedAdmin(seed);
    const outsider = await seedAdmin(seed);

    const openItem = await ingest(seed, { path: "o.md", body: "open body text", access: "team", project: "src" });
    const secretItem = await ingest(seed, { path: "s.md", body: "secret body text", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secretItem.id, insider);

    const openOpp = await mkOpp(seed, [{ itemId: openItem.id }]);
    const secretOpp = await mkOpp(seed, [{ itemId: secretItem.id }]);
    const mixedOpp = await mkOpp(seed, [{ itemId: openItem.id }, { itemId: secretItem.id }]);
    // A legacy evidence-less row (unmintable through the API now) planted RAW:
    const { data: legacy } = await db().from("social_opportunities").insert({
      team_id: seed.teamId, access: "team", source_type: "manual", title: "legacy", summary: "",
      evidence: JSON.stringify([]), topics: JSON.stringify([]), dedup_key: `legacy:${randomUUID()}`,
    }).select("id").single();

    const plan = await createPlan(db(), seed.teamId, secretOpp.id, {}, { memberId: insider });
    await addVariant(db(), seed.teamId, plan.id, { platform: "x", format: "text", tone: "punchy" });

    const insiderVis = await visOf(seed, insider);
    const outsiderVis = await visOf(seed, outsider);

    const insiderList = await listOpportunities(db(), seed.teamId, "team", 100, insiderVis);
    const outsiderList = await listOpportunities(db(), seed.teamId, "team", 100, outsiderVis);
    const ids = (l: { id: string }[]) => l.map((o) => o.id);
    const expected: [string, boolean, boolean][] = [
      [openOpp.id, true, true],
      [secretOpp.id, true, false],
      [mixedOpp.id, true, false], // EVERY: the outsider sees openItem but not secretItem
      [legacy!.id as string, false, false], // evidence-less → dark for everyone
    ];
    for (const [oppId, insiderWants, outsiderWants] of expected) {
      expect(ids(insiderList).includes(oppId), `insider ${oppId}`).toBe(insiderWants);
      expect(ids(outsiderList).includes(oppId), `outsider ${oppId}`).toBe(outsiderWants);
    }
    // A caller with NO oracle set gets nothing (fail closed).
    expect(await listOpportunities(db(), seed.teamId, "team", 100)).toEqual([]);

    // The chain: plans/variants inherit from the visible opportunity set.
    const outsiderPlans = await listPlansForOpportunities(db(), seed.teamId, new Set(ids(outsiderList)));
    expect(outsiderPlans.map((p) => p.id), "the restricted plan never reaches the non-grantee").not.toContain(plan.id);
    const insiderPlans = await listPlansForOpportunities(db(), seed.teamId, new Set(ids(insiderList)));
    expect(insiderPlans.map((p) => p.id)).toContain(plan.id);
    const insiderVariants = await listVariantsForPlans(db(), seed.teamId, new Set(insiderPlans.map((p) => p.id)));
    expect(insiderVariants.length).toBeGreaterThan(0);

    // The action-level chain gate agrees (variant → plan → opportunity), both directions.
    const variantId = insiderVariants[0].id;
    expect(await actorSeesChain(db(), seed.teamId, { variantId }, insiderVis)).toBe(true);
    expect(await actorSeesChain(db(), seed.teamId, { variantId }, outsiderVis), "role does not bypass the chain gate").toBe(false);
    // The predicate agreement pin (the one named rule, both owners of the decision):
    expect(opportunityVisible(secretOpp, insiderVis)).toBe(true);
    expect(opportunityVisible(secretOpp, outsiderVis)).toBe(false);
  });
});

describe("ENFB-4 — admission refusals", () => {
  it("createOpportunity refuses evidence:[]; the arc discover refuses partial/empty evidence; the item discover is actor-scoped", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const insider = await seedAdmin(seed);
    const outsider = await seedAdmin(seed);
    await expect(mkOpp(seed, [])).rejects.toThrow(/evidence is required/);
    // The D1 class's second shape (Fable diff review M1): non-empty evidence with NO item link
    // — zero verifiable provenance, would skip the tier ceiling and be born dark. Refused.
    await expect(mkOpp(seed, [{ note: "free text only" } as unknown as { itemId: string }])).rejects.toThrow(/itemId required/);

    // Arc discovery: a partial arc (one linked, one free-text) refuses; a full one mints.
    const item = await ingest(seed, { path: "a.md", body: "arc source", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const { discoverOpportunitiesFromArcs } = await import("@/lib/social/discover-arcs");
    const mkArc = (id: string, evidence: { fact: string; itemId?: string }[]) => ({
      id, title: id, summary: "s", confidence: "medium" as const, participants: [],
      supporting_sources: [], evidence, derived_at: new Date().toISOString(),
    });
    const arcs = [
      mkArc("arc-partial", [{ fact: "f1", itemId: item.id }, { fact: "free text only" }]),
      mkArc("arc-full", [{ fact: "f1", itemId: item.id }]),
      mkArc("arc-empty", [{ fact: "free text only" }]),
    ];
    const s1 = await discoverOpportunitiesFromArcs(db(), seed.teamId, seed.teamSlug, "team", [], {}, {
      arcs, actor: { memberId: insider },
    });
    expect(s1.created, "only the fully-linked arc mints").toBe(1);
    const { data: minted } = await db().from("social_opportunities").select("dedup_key").eq("team_id", seed.teamId).in("dedup_key", ["arc:arc-partial", "arc:arc-full", "arc:arc-empty"]);
    expect((minted ?? []).map((r) => r.dedup_key)).toEqual(["arc:arc-full"]);

    // Item discovery: actor-scoped — the outsider's scan cannot mint from a restricted item.
    const secret = await ingest(seed, { path: "sec.md", body: "x".repeat(400), access: "team", project: "src", kind: "deliverable" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secret.id, insider);
    const { discoverOpportunities } = await import("@/lib/social/discover");
    const outScan = await discoverOpportunities(db(), seed.teamId, { actor: { memberId: outsider }, visibleItemIds: await visOf(seed, outsider) });
    const { data: fromSecretOut } = await db().from("social_opportunities").select("id").eq("team_id", seed.teamId).eq("dedup_key", `item:${secret.id}`);
    expect((fromSecretOut ?? []).length, "an outsider's scan mints nothing from a restricted item").toBe(0);
    void outScan;
    await discoverOpportunities(db(), seed.teamId, { actor: { memberId: insider }, visibleItemIds: await visOf(seed, insider) });
    const { data: fromSecretIn } = await db().from("social_opportunities").select("id").eq("team_id", seed.teamId).eq("dedup_key", `item:${secret.id}`);
    expect((fromSecretIn ?? []).length, "the grantee's scan mints (non-vacuity)").toBe(1);
    // Fail closed: no set → no scan.
    const bare = await discoverOpportunities(db(), seed.teamId, { actor: { memberId: outsider } });
    expect(bare.scanned).toBe(0);
  });
});

describe("ENFB-4 — generation's EVERY refusal + the public door's membership conjunct", () => {
  it("generation refuses for a partial-visibility actor and proceeds for the grantee; the publish door refuses external-ACCESS-but-initiative-curated evidence and passes external-shared-included evidence", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const insider = await seedAdmin(seed);
    const outsider = await seedAdmin(seed);

    // An EXTERNAL-access item, curated OUT of external-shared into a restricted initiative —
    // the round-1 counterexample: the tier ceiling passes it, membership must not.
    const extItem = await ingest(seed, { path: "e.md", body: "external body", access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, extItem.id, insider);
    const opp = await mkOpp(seed, [{ itemId: extItem.id }], "external");
    const plan = await createPlan(db(), seed.teamId, opp.id, {}, { memberId: insider });
    const variant = await addVariant(db(), seed.teamId, plan.id, { platform: "x", format: "text", tone: "punchy" });

    // Generation: the outsider actor refuses; the insider proceeds (fails later only on LLM absence).
    const { generateVariantText } = await import("@/lib/social/generate");
    await expect(
      generateVariantText(db(), seed.teamId, variant.id, { actorVisibleItemIds: await visOf(seed, outsider) })
    ).rejects.toThrow(/not fully visible/);

    // The publish door: initiative-curated external evidence REFUSES (the counterexample pinned).
    const { publishRefusalReason } = await import("@/lib/social/publish");
    const { getVariant } = await import("@/lib/social/store");
    const vrow = (await getVariant(db(), seed.teamId, variant.id))!;
    const refusal = await publishRefusalReason(db(), seed.teamId, vrow);
    expect(refusal, "membership-blind tier must not pass the public door").toMatch(/external-shared membership/);

    // Non-vacuity: an external item still INCLUDED in external-shared passes the membership leg
    // (the remaining refusal, if any, is about status/governance — never membership).
    const sharedItem = await ingest(seed, { path: "sh.md", body: "shared body", access: "external", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const opp2 = await mkOpp(seed, [{ itemId: sharedItem.id }], "external");
    const plan2 = await createPlan(db(), seed.teamId, opp2.id, {}, { memberId: insider });
    const v2 = await addVariant(db(), seed.teamId, plan2.id, { platform: "x", format: "text", tone: "punchy" });
    const v2row = (await getVariant(db(), seed.teamId, v2.id))!;
    const refusal2 = await publishRefusalReason(db(), seed.teamId, v2row);
    expect(refusal2 ?? "", "external-shared-included evidence passes the membership leg").not.toMatch(/external-shared membership/);
  });
});
