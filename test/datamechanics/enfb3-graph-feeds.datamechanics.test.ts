import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { visibleProjects, visibleProjectsWithError } from "@/lib/access/oracle";
import { selectEnforcedGraphPartitions } from "@/lib/graph/partition-read";
import { visibleTierGroupIds } from "@/lib/graph/tier-groups";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";

// ENFB-3 AC3 (docs/design/enfb3-meetings-graph-feeds.md): the graph FEEDS resolve the
// member's ORACLE partitions through the stored pointers — stock parity with the legacy pair
// (the POSITIVE no-op pin), granted-in/ungranted-out, arm:false does not trigger arming, the
// General restriction-debt suppression holds UNDER arm:false (the design round-1 blocker's
// regression arm), and a renamed team still resolves (the rename-doctrine proof moves with
// the serving path).

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@t.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  await placeMemberByTier(seed.teamId, data!.id as string, "team");
  return data!.id as string;
}

async function feedScope(seed: Seed, memberId: string) {
  const { set } = await visibleProjectsWithError(db(), { teamId: seed.teamId, memberId });
  return selectEnforcedGraphPartitions(db(), {
    teamId: seed.teamId,
    visibleProjectIds: [...set.projectIds],
    k: Number.MAX_SAFE_INTEGER,
    arm: false,
  });
}

describe("ENFB-3 — the graph feeds' partition scope (the feeds' exact resolver call)", () => {
  it("STOCK PARITY: a stock member's feed scope equals the legacy tier pair (the measured no-op pin), and a renamed team still resolves through the stored pointers", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const stock = await seedMember(seed);

    const legacy = await visibleTierGroupIds(db(), { teamId: seed.teamId, teamSlug: seed.teamSlug, tier: "team" });
    const scope = await feedScope(seed, stock);
    expect([...scope.groups].sort(), "the oracle scope IS the legacy pair for a stock member").toEqual([...legacy].sort());
    expect(scope.generalSuppressed).toBe(false);

    // Rename: the slug changes; the stored pointers keep resolving the SAME partitions.
    await db().from("teams").update({ slug: `renamed-${randomUUID().slice(0, 6)}` }).eq("id", seed.teamId);
    const renamed = await feedScope(seed, stock);
    expect([...renamed.groups].sort(), "rename-safe: pointers, not slugs, resolve").toEqual([...legacy].sort());
  });

  it("granted-in / ungranted-out: an ARMED initiative's pointer joins only the grantee's feed scope; arm:false never arms a cold one", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const insider = await seedMember(seed);
    const outsider = await seedMember(seed);

    // A restricted initiative with a stored pointer, granted to the insider.
    const groupId = `g_${randomUUID().replace(/-/g, "")}_p_${randomUUID().replace(/-/g, "")}`;
    const { data: proj } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: `init-${randomUUID().slice(0, 6)}`, name: "I", kind: "initiative", graph_group_id: groupId })
      .select("id")
      .single();
    const g = await createGroup(db(), seed.teamId, `gg-${randomUUID().slice(0, 8)}`, "G", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, insider, seed.memberId);
    // ARM it via the readiness latch's own writer (a real reader signal), so the feed's
    // arm:false read finds it ready WITHOUT arming anything itself.
    const { armProjectsForPrincipal } = await import("@/lib/graph/arming");
    await armProjectsForPrincipal(db(), { teamId: seed.teamId, projectIds: [proj!.id as string] });

    const insiderScope = await feedScope(seed, insider);
    const outsiderScope = await feedScope(seed, outsider);
    expect(insiderScope.groups, "the grantee's feed includes the armed initiative partition").toContain(groupId);
    expect(outsiderScope.groups, "the non-grantee's never does").not.toContain(groupId);

    // arm:false is non-arming: a SECOND cold initiative granted to the insider stays cold
    // (absent from scope) after the feed read — the read left no arming trace.
    const coldGroup = `g_${randomUUID().replace(/-/g, "")}_p_${randomUUID().replace(/-/g, "")}`;
    const { data: cold } = await db()
      .from("projects")
      .insert({ team_id: seed.teamId, slug: `cold-${randomUUID().slice(0, 6)}`, name: "C", kind: "initiative", graph_group_id: coldGroup })
      .select("id")
      .single();
    await grantProjectToGroup(db(), seed.teamId, cold!.id as string, g.groupId!, seed.memberId);
    const before = await db().from("graph_project_arming").select("project_id").eq("team_id", seed.teamId).eq("project_id", cold!.id as string);
    const s1 = await feedScope(seed, insider);
    const after = await db().from("graph_project_arming").select("project_id").eq("team_id", seed.teamId).eq("project_id", cold!.id as string);
    expect(s1.groups, "a cold initiative is not served").not.toContain(coldGroup);
    expect((after.data ?? []).length, "the feed read must not create an arming row").toBe((before.data ?? []).length);
  });

  it("General restriction-debt suppression HOLDS under arm:false (the round-1 blocker's regression arm) and surfaces as generalSuppressed, not a wiring fault", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const stock = await seedMember(seed);

    // Plant restriction debt in General: a live graph episode for General's partition whose
    // source item's unit is in a restriction move (the probe's own substrate discriminator).
    const { data: general } = await db().from("projects").select("id, graph_group_id").eq("team_id", seed.teamId).eq("slug", "general").single();
    const { generalHoldsRestrictedContent } = await import("@/lib/projects/context/fanout-targets");
    // Drive the REAL probe's inputs: seed an episode + a mid-restriction membership state.
    const { ingest } = await import("./helpers");
    const item = await ingest(seed, { path: `p-${randomUUID().slice(0, 6)}.md`, body: "b", access: "team", project: "srcp" });
    await backfillTeamContext(db(), seed.teamId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).maybeSingle();
    expect(unit, "the ingested item must have materialized a unit").toBeTruthy();
    const { error: epErr } = await db().from("graph_episodes").insert({ team_id: seed.teamId, group_id: general!.graph_group_id as string, source_table: "items", source_id: item.id, content_sha256: "abc" });
    expect(epErr, "the episode fixture must insert").toBeNull();
    // Retire the general membership mid-move (valid_to set, no confirmed purge) → debt.
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
    const debt = await generalHoldsRestrictedContent({ teamId: seed.teamId, generalProjectId: general!.id as string, generalGroupId: general!.graph_group_id as string });
    // NON-VACUITY: the fixture must actually read as in-debt, or this whole arm is decorative
    // (the conditional-green trap). If this reddens, the fixture no longer matches the probe's
    // substrate discriminator — fix the fixture, not the assertion.
    expect(debt, "the planted mid-restriction state must register as General debt").toBe(true);
    const scope = await feedScope(seed, stock);
    if (debt) {
      expect(scope.groups, "General suppressed under arm:false — the decoupled probe fired").not.toContain(general!.graph_group_id);
      expect(scope.generalSuppressed, "the flag names the suppression (the loud-arm discriminator)").toBe(true);
    } else {
      expect(scope.generalSuppressed).toBe(false);
      expect(scope.groups).toContain(general!.graph_group_id);
    }
  });

  it("the error-visible oracle discriminates: a substrate failure reports error (degraded JSON), never a silent empty scope", async () => {
    const seed = await seedTeam();
    // A broken db shim: every group_members read fails; everything else is the real db.
    const failure = { data: null, error: { message: "boom" } };
    const failingChain = (): unknown => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "is", "not", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve(failure);
      chain.single = () => Promise.resolve(failure);
      chain.then = (resolve: (v: unknown) => void) => resolve(failure);
      return chain;
    };
    const broken = { from: (table: string) => (table === "group_members" ? failingChain() : db().from(table)) };
    const r = await visibleProjectsWithError(broken as never, { teamId: seed.teamId, memberId: seed.memberId });
    expect(r.error, "the feeds can tell failure from none").toBe(true);
    expect(r.set.projectIds.size, "error implies empty, never widens").toBe(0);
    // And the silent variant still fails closed (unchanged callers).
    const silent = await visibleProjects(broken as never, { teamId: seed.teamId, memberId: seed.memberId });
    expect(silent.projectIds.size).toBe(0);
  });
});
