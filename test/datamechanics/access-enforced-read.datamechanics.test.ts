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
  it("permissive (default) is byte-identical to today — the enforced read contributes nothing", async () => {
    const seed = await seedTeam();
    await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    await ingest(seed, { path: "b.md", body: "b", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId); // substrate populated, but flag is permissive
    const key = await memberKey(seed, seed.memberId);
    const got = await paths(key);
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

  it("enforcing: a member OUTSIDE a restricting group cannot see an item tagged only into that project (the actual gate)", async () => {
    const seed = await seedTeam(); // seed.memberId = admin, in Everyone
    const outsider = await seedMember(seed); // also in Everyone, but NOT in the restricting group
    const item = await ingest(seed, { path: "secret.md", body: "restricted", access: "team", project: "src" });
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
    // The admin (in Leadership → sees restricted) sees it; the outsider (only Everyone) does not.
    expect(await paths(await memberKey(seed, seed.memberId))).toContain("secret.md");
    expect(await paths(await memberKey(seed, outsider)), "an outsider must not see restricted-project content").not.toContain("secret.md");
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
