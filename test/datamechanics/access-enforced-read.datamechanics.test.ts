import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as itemsGET } from "@/app/api/v1/items/route";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { issueApiKey } from "@/lib/admin/keys";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { createGroup, grantProjectToGroup, addMemberToGroup } from "@/lib/access/groups";

// Phase B slice 1 (spec §5/§11) — the first ENFORCED read, behind teams.access_enforcement.
// The load-bearing proofs: permissive = byte-identical to today; enforcing = oracle ∧ legacy-tier
// (a team member still sees all backfilled General content, but a member outside a restricting
// group cannot see an item tagged only into that restricted project). Fail-closed on no-groups.

function req(key: string): NextRequest {
  return new Request("http://test/api/v1/items", { headers: { authorization: `Bearer ${key}` } }) as unknown as NextRequest;
}

async function paths(key: string): Promise<string[]> {
  const res = await itemsGET(req(key));
  expect(res.status).toBe(200);
  return ((await res.json()).items as { path: string }[]).map((i) => i.path);
}

async function memberKey(seed: Seed, memberId: string): Promise<string> {
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "k");
  return key;
}

async function setEnforcement(seed: Seed, mode: "permissive" | "enforcing") {
  await db().from("teams").update({ access_enforcement: mode }).eq("id", seed.teamId);
}

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "M",
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "team",
      status: "active",
    })
    .select("id")
    .single();
  return data!.id as string;
}

describe("access enforcement flag", () => {
  it("permissive (default) is byte-identical to today — even for a member in NO groups (the discriminating case)", async () => {
    // Deliberately NOT converged / groupless: under enforcing this member would see nothing; under
    // permissive they must see everything. This is the case that distinguishes the modes — a
    // backfilled admin sees everything either way and wouldn't catch enforcement leaking on.
    const seed = await seedTeam();
    await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    await ingest(seed, { path: "b.md", body: "b", access: "team", project: "src" });
    const groupless = await seedMember(seed);
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").maybeSingle();
    if (everyone) await db().from("group_members").delete().eq("group_id", everyone.id).eq("member_id", groupless);
    const got = await paths(await memberKey(seed, groupless)); // team stays permissive (default)
    expect(got).toContain("a.md");
    expect(got).toContain("b.md");
  });

  it("enforcing: a team member still sees ALL backfilled General content (byte-identical when converged)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "x.md", body: "x", access: "team", project: "src" });
    await ingest(seed, { path: "y.md", body: "y", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    await setEnforcement(seed, "enforcing");
    const key = await memberKey(seed, seed.memberId);
    const got = await paths(key);
    expect(got).toContain("x.md");
    expect(got).toContain("y.md");
  });

  it("enforcing: an outsider SEES General content but NOT a restricted-project item — pins the .in filter, not just the empty short-circuit (Fable HIGH)", async () => {
    const seed = await seedTeam(); // seed.memberId = admin, in Everyone
    const outsider = await seedMember(seed); // also in Everyone, but NOT in the restricting group
    const item = await ingest(seed, { path: "secret.md", body: "restricted", access: "team", project: "src" });
    // A second item that STAYS in General → the outsider's visible set is NON-empty, so the read
    // goes through `.in("id", ids)` (not the empty short-circuit) AND must include this one.
    await ingest(seed, { path: "shared.md", body: "shared", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);

    // Restrict: a project only a specific group can see; MOVE the item's membership there (out of
    // General), so it's no longer General-visible. (Curation UI does this in Phase D; done by hand here.)
    const restricted = await db().from("projects").insert({ team_id: seed.teamId, slug: "restricted", name: "R", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "leadership", "Leadership", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, seed.memberId, seed.memberId); // admin is in it
    await grantProjectToGroup(db(), seed.teamId, restricted.data!.id, g.groupId!, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    // move: close General membership, open restricted
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: restricted.data!.id, context_unit_id: unit!.id, method: "manual" });

    await setEnforcement(seed, "enforcing");
    // The admin (in Leadership → sees restricted) sees both; the outsider sees General but not secret.
    expect(await paths(await memberKey(seed, seed.memberId))).toContain("secret.md");
    const outsiderPaths = await paths(await memberKey(seed, outsider));
    expect(outsiderPaths, "the .in filter must still admit General content").toContain("shared.md");
    expect(outsiderPaths, "an outsider must not see restricted-project content").not.toContain("secret.md");
  });

  it("enforcing: the legacy-tier conjunct still applies — an external member never sees a team item (oracle ∧ tier)", async () => {
    const seed = await seedTeam();
    const extMember = await seedMember(seed);
    await db().from("members").update({ tier: "external" }).eq("id", extMember).eq("team_id", seed.teamId);
    await ingest(seed, { path: "team-only.md", body: "team", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    // Plant the team item into external-shared too (so the ORACLE would admit it for an external
    // member) — the TIER conjunct must still exclude it: a team-access item never reaches external.
    const teamItemId = (await db().from("items").select("id").eq("path", "team-only.md").single()).data!.id;
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", teamItemId).single();
    const { data: extShared } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "external-shared").single();
    // Move the item's membership to external-shared (close the General one first — the unit has one
    // current row per project) so the ORACLE genuinely admits it for an external member.
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id);
    const insErr = (await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: extShared!.id, context_unit_id: unit!.id, method: "manual" })).error;
    expect(insErr, "the planted external-shared membership must actually persist").toBeNull();
    const { data: extGroup } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "external").single();
    await db().from("group_members").upsert({ team_id: seed.teamId, group_id: extGroup!.id, member_id: extMember }, { onConflict: "group_id,member_id" });

    // POSITIVE control: the oracle WOULD admit this item for the external member (its membership is
    // in a project they can see) — so the route excluding it proves the TIER conjunct is what cuts
    // it, not the oracle (Codex Medium — the test was otherwise green-if-oracle-never-admits).
    const { visibleItemIdsForProjects } = await import("@/lib/access/enforce");
    const { visibleProjects } = await import("@/lib/access/oracle");
    const vp = await visibleProjects(db(), { teamId: seed.teamId, memberId: extMember });
    const admitted = await visibleItemIdsForProjects(db(), seed.teamId, vp.projectIds);
    expect(admitted.ids.has(teamItemId), "oracle must admit the item — so the tier filter is the sole excluder").toBe(true);

    await setEnforcement(seed, "enforcing");
    const got = await paths(await memberKey(seed, extMember));
    expect(got, "the legacy tier conjunct must exclude a team-access item from an external principal").not.toContain("team-only.md");
  });

  it("enforcing: a delegated agent token is membership-filtered too — cannot exceed its launcher (Fable HIGH H3)", async () => {
    const { mintAgentToken } = await import("@/lib/access/agent-tokens");
    const seed = await seedTeam();
    // Two items in the SAME ingestion project; one gets moved to a restricted project the launcher
    // cannot see. Under the Phase-A project_id proxy the agent would see BOTH (same project_id);
    // the membership filter must cut it to only the General one.
    const shared = await ingest(seed, { path: "ag-shared.md", body: "s", access: "team", project: "src" });
    const secret = await ingest(seed, { path: "ag-secret.md", body: "x", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const restricted = await db().from("projects").insert({ team_id: seed.teamId, slug: "r2", name: "R2", kind: "initiative" }).select("id").single();
    const g = await createGroup(db(), seed.teamId, "lead2", "Lead2", seed.memberId); // launcher NOT added
    await grantProjectToGroup(db(), seed.teamId, restricted.data!.id, g.groupId!, seed.memberId);
    const { data: su } = await db().from("project_context_units").select("id").eq("source_item_id", secret.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", su!.id);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: restricted.data!.id, context_unit_id: su!.id, method: "manual" });

    // Agent launched by the admin (self, unattenuated) — inherits the admin's visibility.
    const agent = await seedMember(seed); // agent principal row
    const g2 = await createGroup(db(), seed.teamId, "agents", "Agents", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g2.groupId!, agent, seed.memberId);
    // grant the agent's group General so it can see shared, but NOT restricted
    const { data: gen } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", "general").single();
    await grantProjectToGroup(db(), seed.teamId, gen!.id, g2.groupId!, seed.memberId);
    const minted = await mintAgentToken(db(), seed.teamId, { memberId: agent }, seed.memberId);

    await setEnforcement(seed, "enforcing");
    const got = await paths(minted.token!);
    expect(got, "the agent sees General content").toContain("ag-shared.md");
    expect(got, "the agent must NOT see the restricted item its launcher can't (no project_id proxy under enforcing)").not.toContain("ag-secret.md");
    void shared;
  });

  it("enforcing: a member in NO groups sees nothing (fail closed, not an unfiltered query)", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "z.md", body: "z", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    // A member deliberately removed from Everyone (planted state — the writer wouldn't, but a
    // mid-transition gap could): enforcing must serve zero rows, never fall back to unfiltered.
    const lonely = await seedMember(seed);
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", "everyone").single();
    await db().from("group_members").delete().eq("group_id", everyone!.id).eq("member_id", lonely);
    await setEnforcement(seed, "enforcing");
    expect(await paths(await memberKey(seed, lonely))).toEqual([]);
  });
});
