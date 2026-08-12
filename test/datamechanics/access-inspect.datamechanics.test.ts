import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { explainItemVisibility, auditVisibilityAgainstItemIds } from "@/lib/access/inspect";
import { visibleItemIds } from "@/lib/access/enforce";
import { createGroup, grantProjectToGroup, addMemberToGroup, ensurePersonSingleton } from "@/lib/access/groups";

// Phase B slice 6 (spec §15.6/§5.8) — the permission inspector. The load-bearing proofs: the WHY
// chain names the real person→group→project→unit path with provenance; the `visible` verdict AGREES
// with the enforcement oracle (never a second opinion); the leak-check returns exactly the ids a
// principal must not see; and a not-visible answer never names the restricted project (§5.7).

async function seedMember(seed: Seed): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team", status: "active" })
    .select("id")
    .single();
  return data!.id as string;
}
/** Move an item into a fresh restricted project granted to a fresh group; return {projectId, groupId}. */
async function restrictInto(seed: Seed, itemId: string, memberInGroup?: string): Promise<{ projectId: string; groupId: string }> {
  const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "Vault", kind: "initiative" }).select("id").single();
  const g = await createGroup(db(), seed.teamId, `rg-${randomUUID().slice(0, 8)}`, "Vault group", seed.memberId);
  await grantProjectToGroup(db(), seed.teamId, proj!.id as string, g.groupId!, seed.memberId);
  if (memberInGroup) await addMemberToGroup(db(), seed.teamId, g.groupId!, memberInGroup, seed.memberId);
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual", decided_by: seed.memberId });
  return { projectId: proj!.id as string, groupId: g.groupId! };
}

describe("permission inspector — explainItemVisibility (Phase B slice 6)", () => {
  it("a General item: VISIBLE to an Everyone member, with the everyone→General→unit chain", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "gen.md", body: "general work", access: "team", project: "src" });
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: member, itemId: item.id });
    expect(v.visible).toBe(true);
    expect(v.chains.length).toBeGreaterThanOrEqual(1);
    const everyoneChain = v.chains.find((c) => c.group.kind === "everyone");
    expect(everyoneChain, "the path runs through the Everyone built-in").toBeDefined();
    expect(everyoneChain!.membership.via, "a built-in is held by TIER, no group_members row").toBe("builtin_tier");
    expect(everyoneChain!.unit.method, "the unit edge carries its provenance").toBeTruthy();
  });

  it("a restricted item: VISIBLE to a member IN the restricting group — chain shows the explicit add + grant provenance", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "sec.md", body: "secret work", access: "team", project: "src" });
    const insider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { projectId, groupId } = await restrictInto(seed, item.id, insider);

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: insider, itemId: item.id });
    expect(v.visible).toBe(true);
    const chain = v.chains.find((c) => c.projectId === projectId && c.group.id === groupId);
    expect(chain, "the path runs through the restricting group").toBeDefined();
    expect(chain!.membership.via, "an ordinary group add is 'added'").toBe("added");
    expect(chain!.membership.addedBy, "who added the member is recorded").toBe(seed.memberId);
    expect(chain!.grant.addedBy, "who granted the project to the group is recorded").toBe(seed.memberId);
    expect(chain!.unit.decidedBy).toBe(seed.memberId);
  });

  it("a restricted item: NOT visible to an outsider — no chain, coarse reason that never names the project (§5.7)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "sec2.md", body: "secret", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { projectId } = await restrictInto(seed, item.id); // outsider NOT added

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: outsider, itemId: item.id });
    expect(v.visible).toBe(false);
    expect(v.chains).toEqual([]);
    expect(v.reason).toBeTruthy();
    expect(JSON.stringify(v), "the not-visible answer must NOT leak the restricted project id").not.toContain(projectId);
  });

  it("the inspector's `visible` verdict AGREES with the enforcement oracle for the same principal", async () => {
    const seed = await seedTeam();
    const open = await ingest(seed, { path: "o.md", body: "o", access: "team", project: "src" });
    const secret = await ingest(seed, { path: "s.md", body: "s", access: "team", project: "src" });
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secret.id); // member is an outsider to the restriction

    const { ids: enforced } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });
    for (const it of [open, secret]) {
      const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: member, itemId: it.id });
      expect(v.visible, `inspector must match the oracle for ${it.path}`).toBe(enforced.has(it.id));
    }
  });

  it("a singleton (direct person add) renders as a singleton membership", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "d.md", body: "d", access: "team", project: "src" });
    const person = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    // A restricted project granted to the person's SINGLETON group (the "direct person add", §4).
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `d-${randomUUID().slice(0, 8)}`, kind: "initiative" }).select("id").single();
    const singleton = await ensurePersonSingleton(db(), seed.teamId, person, seed.memberId);
    expect(singleton.ok, singleton.error).toBe(true);
    await grantProjectToGroup(db(), seed.teamId, proj!.id as string, singleton.groupId!, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual", decided_by: seed.memberId });

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: person, itemId: item.id });
    expect(v.visible).toBe(true);
    const chain = v.chains.find((c) => c.projectId === (proj!.id as string));
    expect(chain!.group.kind).toBe("singleton");
    expect(chain!.membership.via).toBe("singleton");
  });
});

describe("permission inspector — auditVisibilityAgainstItemIds (§5.8 runtime cache-leak check)", () => {
  it("returns exactly the ids the principal must NOT see, [] when clean", async () => {
    const seed = await seedTeam();
    const open = await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    const secret = await ingest(seed, { path: "b.md", body: "b", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secret.id);

    const leaks = await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: outsider }, [open.id, secret.id]);
    expect(leaks, "the restricted item is a leak; the General one is not").toEqual([secret.id]);

    const clean = await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: outsider }, [open.id]);
    expect(clean).toEqual([]);
    expect(await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: outsider }, []), "empty in → empty out").toEqual([]);
  });
});
