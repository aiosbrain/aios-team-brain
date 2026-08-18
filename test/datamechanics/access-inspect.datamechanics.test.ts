import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { explainItemVisibility, auditVisibilityAgainstItemIds } from "@/lib/access/inspect";
import { visibleItemIds } from "@/lib/access/enforce";
import { canSeeAccess } from "@/lib/auth/visibility";
import { createGroup, grantProjectToGroup, addMemberToGroup, ensurePersonSingleton } from "@/lib/access/groups";

// Phase B slice 6 (spec §15.6/§5.8). The inspector must reflect the FULL enforced read —
// legacy-tier ∧ (enforcing ? oracle : allow), mode-aware — not just the oracle conjunct (Fable B6
// High). Proofs: the WHY chain + provenance; `visible` AGREES with the enforced read in BOTH modes
// and BOTH conjuncts; the leak-check sees tier leaks too; §5.7 never names the restricted project.

async function seedMember(seed: Seed, tier: "team" | "external" = "team"): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({ team_id: seed.teamId, email: `${randomUUID()}@test.local`, display_name: "M", actor_handle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier, status: "active" })
    .select("id")
    .single();
  // PRET-4 explicit state: every real member holds their builtin-posture row from creation.
  const { placeMemberByTier } = await import("./helpers");
  await placeMemberByTier(seed.teamId, data!.id as string, tier);
  return data!.id as string;
}
async function setEnforcement(seed: Seed, mode: "permissive" | "enforcing") {
  await db().from("teams").update({ access_enforcement: mode }).eq("id", seed.teamId);
}
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
  it("enforcing + General item: VISIBLE to an Everyone member via the everyone→General→unit chain", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "gen.md", body: "general work", access: "team", project: "src" });
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await setEnforcement(seed, "enforcing");

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: member, itemId: item.id });
    expect(v.mode).toBe("enforcing");
    expect(v.visible).toBe(true);
    const everyoneChain = v.chains.find((c) => c.group.kind === "everyone");
    expect(everyoneChain, "the path runs through the Everyone built-in").toBeDefined();
    expect(everyoneChain!.membership.via).toBe("builtin"); // PRET-4: the tier-derived label is retired
    expect(everyoneChain!.unit.method).toBeTruthy();
  });

  it("enforcing + restricted item: VISIBLE to a member IN the group — chain shows the add + grant provenance", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "sec.md", body: "secret work", access: "team", project: "src" });
    const insider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { projectId, groupId } = await restrictInto(seed, item.id, insider);
    await setEnforcement(seed, "enforcing");

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: insider, itemId: item.id });
    expect(v.visible).toBe(true);
    const chain = v.chains.find((c) => c.projectId === projectId && c.group.id === groupId);
    expect(chain!.membership.via).toBe("added");
    expect(chain!.membership.addedBy).toBe(seed.memberId);
    expect(chain!.grant.addedBy).toBe(seed.memberId);
    expect(chain!.unit.decidedBy).toBe(seed.memberId);
  });

  it("enforcing + restricted item: NOT visible to an outsider — no chain, coarse reason that never names the project (§5.7)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "sec2.md", body: "secret", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { projectId } = await restrictInto(seed, item.id);
    await setEnforcement(seed, "enforcing");

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: outsider, itemId: item.id });
    expect(v.visible).toBe(false);
    expect(v.chains).toEqual([]);
    expect(v.reason).toBeTruthy();
    expect(JSON.stringify(v), "the not-visible answer must NOT leak the restricted project id").not.toContain(projectId);
  });

  it("PERMISSIVE team: the outsider CAN see the restricted item (enforcement off — by tier), mode=permissive, no false 'not visible'", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "p.md", body: "p", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, item.id); // outsider not in the group
    // access_enforcement defaults to permissive — do NOT flip it.

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: outsider, itemId: item.id });
    expect(v.mode).toBe("permissive");
    expect(v.visible, "on a permissive team a team-tier member sees team content — the oracle is inactive").toBe(true);
    expect(v.chains, "no project gate is active under permissive").toEqual([]);
  });

  it("PRET-4 (inverts Fable B6 High): an external-posture member in an ordinary group granted a TEAM-access item IS visible under enforcing — the inspector agrees with the ruling-2 read", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "t.md", body: "team-only", access: "team", project: "src" });
    const external = await seedMember(seed, "external");
    await backfillTeamContext(db(), seed.teamId);
    // The external member IS in the restricting ordinary group → the oracle grants the project,
    // and since PRET-4 the oracle ALONE decides under enforcing (the wall conjunct is retired —
    // an inspector still applying it would report this legitimate read as invisible/leaked).
    const { projectId, groupId } = await restrictInto(seed, item.id, external);
    await setEnforcement(seed, "enforcing");

    const teammate = await seedMember(seed);
    await addMemberToGroup(db(), seed.teamId, groupId, teammate, seed.memberId);
    const control = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: teammate, itemId: item.id });
    expect(control.visible, "control: a team-posture member in the same group sees it").toBe(true);

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: external, itemId: item.id });
    expect(v.visible, "ruling 2: membership grants the read; the inspector must agree").toBe(true);
    const chain = v.chains.find((c) => c.projectId === projectId);
    expect(chain, "the visibility chain names the granting project").toBeDefined();
  });

  it("a NON-PRINCIPAL member (disabled) is NOT visible in permissive mode — the oracle can't catch it there (Codex B6 Medium)", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "np.md", body: "n", access: "team", project: "src" });
    const disabled = await seedMember(seed);
    await db().from("members").update({ status: "disabled" }).eq("id", disabled);
    await backfillTeamContext(db(), seed.teamId);
    // Permissive team (default) — a naive tier-only verdict would say visible=true.
    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: disabled, itemId: item.id });
    expect(v.mode).toBe("permissive");
    expect(v.visible, "a disabled member is not an active principal → sees nothing").toBe(false);
    expect(v.reason).toMatch(/principal/i);
    // …and the leak check treats every id as a leak for a non-principal.
    expect(await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: disabled }, [item.id])).toEqual([item.id]);
  });

  it("the `visible` verdict AGREES with the FULL enforced read (tier ∧ oracle) in enforcing mode", async () => {
    const seed = await seedTeam();
    const open = await ingest(seed, { path: "o.md", body: "o", access: "team", project: "src" });
    const secret = await ingest(seed, { path: "s.md", body: "s", access: "team", project: "src" });
    const member = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secret.id);
    await setEnforcement(seed, "enforcing");

    const { ids: oracleVisible } = await visibleItemIds(db(), { teamId: seed.teamId, memberId: member });
    for (const it of [open, secret]) {
      const { data: row } = await db().from("items").select("access").eq("id", it.id).single();
      const enforced = canSeeAccess("team", (row!.access as string) ?? "team") && oracleVisible.has(it.id);
      const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: member, itemId: it.id });
      expect(v.visible, `inspector must match the enforced read for ${it.path}`).toBe(enforced);
    }
  });

  it("enforcing + a singleton (direct person add) renders as a singleton membership", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "d.md", body: "d", access: "team", project: "src" });
    const person = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { data: proj } = await db().from("projects").insert({ team_id: seed.teamId, slug: `d-${randomUUID().slice(0, 8)}`, kind: "initiative" }).select("id").single();
    const singleton = await ensurePersonSingleton(db(), seed.teamId, person, seed.memberId);
    expect(singleton.ok, singleton.error).toBe(true);
    await grantProjectToGroup(db(), seed.teamId, proj!.id as string, singleton.groupId!, seed.memberId);
    const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", item.id).single();
    await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
    await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: proj!.id as string, context_unit_id: unit!.id, method: "manual", decided_by: seed.memberId });
    await setEnforcement(seed, "enforcing");

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: person, itemId: item.id });
    expect(v.visible).toBe(true);
    const chain = v.chains.find((c) => c.projectId === (proj!.id as string));
    expect(chain!.group.kind).toBe("singleton");
    expect(chain!.membership.via).toBe("singleton");
  });

  it("enforcing: a RETRACTED (non-active) unit membership does NOT confer visibility — pins the state='active' predicate", async () => {
    const seed = await seedTeam();
    const item = await ingest(seed, { path: "ret.md", body: "r", access: "team", project: "src" });
    const insider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    const { projectId } = await restrictInto(seed, item.id, insider);
    // Retract the unit: the member is in the granting group, the membership is include+valid, but the
    // UNIT is no longer active — the enforced read (state='active') drops it, so the inspector must too.
    await db().from("project_context_units").update({ state: "retracted" }).eq("source_item_id", item.id);
    await setEnforcement(seed, "enforcing");

    const v = await explainItemVisibility(db(), { teamId: seed.teamId, memberId: insider, itemId: item.id });
    expect(v.visible, "a retracted unit confers no visibility").toBe(false);
    void projectId;
  });
});

describe("permission inspector — auditVisibilityAgainstItemIds (§5.8 runtime cache-leak check)", () => {
  it("enforcing: returns exactly the oracle-restricted ids the principal must NOT see, [] when clean", async () => {
    const seed = await seedTeam();
    const open = await ingest(seed, { path: "a.md", body: "a", access: "team", project: "src" });
    const secret = await ingest(seed, { path: "b.md", body: "b", access: "team", project: "src" });
    const outsider = await seedMember(seed);
    await backfillTeamContext(db(), seed.teamId);
    await restrictInto(seed, secret.id);
    await setEnforcement(seed, "enforcing");

    expect(await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: outsider }, [open.id, secret.id])).toEqual([secret.id]);
    expect(await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: outsider }, [open.id])).toEqual([]);
    expect(await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: outsider }, [])).toEqual([]);
  });

  it("sees the TIER leak class too: an external member + a team-access item is a leak in ANY mode (the leak the oracle set alone would miss, Fable B6 High)", async () => {
    const seed = await seedTeam();
    const teamItem = await ingest(seed, { path: "team.md", body: "t", access: "team", project: "src" });
    const extItem = await ingest(seed, { path: "ext.md", body: "e", access: "external", project: "src" });
    const external = await seedMember(seed, "external");
    await backfillTeamContext(db(), seed.teamId);
    // PERMISSIVE team (default) — the oracle is inactive, so ONLY the tier conjunct is the enforcement.
    const leaks = await auditVisibilityAgainstItemIds(db(), { teamId: seed.teamId, memberId: external }, [teamItem.id, extItem.id]);
    expect(leaks, "the team-access item is a tier leak; the external-access one is not").toEqual([teamItem.id]);
  });
});
