import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam, type Seed } from "./helpers";
import {
  EVERYONE_SLUG,
  EXTERNAL_SLUG,
  addMemberToGroup,
  createGroup,
  ensureBuiltins,
  ensurePersonSingleton,
  grantProjectToGroup,
  removeMemberFromGroup,
  syncBuiltinMembership,
} from "@/lib/access/groups";
import { visibleProjects } from "@/lib/access/oracle";

// Phase A slice 1 (spec §4/§5.1) — real-Postgres proofs of the access skeleton's invariants:
// eligibility enforced at write AND read, built-ins auto-admit humans only (both of them —
// the round-3 Codex Critical was agents excluded from Everyone but not External), singleton
// integrity, cross-team edges unrepresentable, and the oracle's NULL-vs-empty scope semantics.

async function seedMember(
  seed: Seed,
  over: Partial<{ kind: string; tier: string; status: string; is_connector: boolean }> = {}
): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@test.local`,
      display_name: `M-${randomUUID().slice(0, 6)}`,
      actor_handle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: over.tier ?? "team",
      status: over.status ?? "active",
      is_connector: over.is_connector ?? false,
      kind: over.kind ?? "human",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed member failed: ${error?.message}`);
  return data.id as string;
}

async function seedProject(seed: Seed): Promise<string> {
  const { data, error } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `p-${randomUUID().slice(0, 8)}` })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed project failed: ${error?.message}`);
  return data.id as string;
}

async function membersOfBuiltin(seed: Seed, slug: string): Promise<Set<string>> {
  const { data: g } = await db()
    .from("groups")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("slug", slug)
    .single();
  const { data: rows } = await db()
    .from("group_members")
    .select("member_id")
    .eq("team_id", seed.teamId)
    .eq("group_id", g!.id);
  return new Set(((rows ?? []) as { member_id: string }[]).map((r) => r.member_id));
}

describe("built-in groups (ensureBuiltins + syncBuiltinMembership)", () => {
  it("auto-admits active humans by tier — and NEITHER built-in admits agents, connectors, or offroster", async () => {
    const seed = await seedTeam(); // seed member: active human, tier=team
    const externalHuman = await seedMember(seed, { tier: "external" });
    const agent = await seedMember(seed, { kind: "agent" });
    const externalAgent = await seedMember(seed, { kind: "agent", tier: "external" });
    const offroster = await seedMember(seed, { kind: "offroster" });
    const connector = await seedMember(seed, { is_connector: true });
    const invited = await seedMember(seed, { status: "invited" });

    const r = await ensureBuiltins(db(), seed.teamId);
    expect(r.ok, r.error).toBe(true);

    const everyone = await membersOfBuiltin(seed, EVERYONE_SLUG);
    const external = await membersOfBuiltin(seed, EXTERNAL_SLUG);

    expect(everyone.has(seed.memberId)).toBe(true);
    expect(external.has(externalHuman)).toBe(true);
    // The Critical class: an external-tier agent auto-admitted to External would inherit
    // external-shared with no explicit grant. Assert absence from BOTH built-ins, per kind.
    for (const excluded of [agent, externalAgent, offroster, connector, invited]) {
      expect(everyone.has(excluded)).toBe(false);
      expect(external.has(excluded)).toBe(false);
    }
    // tier separation: the team human is not in External and vice versa
    expect(external.has(seed.memberId)).toBe(false);
    expect(everyone.has(externalHuman)).toBe(false);
  });

  it("re-sync removes a member who stops qualifying (deactivation) — membership is maintained, not accreted", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    expect((await membersOfBuiltin(seed, EVERYONE_SLUG)).has(seed.memberId)).toBe(true);

    await db().from("members").update({ status: "disabled" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    const r = await syncBuiltinMembership(db(), seed.teamId);
    expect(r.ok, r.error).toBe(true);
    expect((await membersOfBuiltin(seed, EVERYONE_SLUG)).has(seed.memberId)).toBe(false);
  });
});

describe("write-side eligibility (the groups single writer refuses non-principals)", () => {
  it("rejects offroster and connector members; admits an agent to an ordinary group", async () => {
    const seed = await seedTeam();
    const g = await createGroup(db(), seed.teamId, "eng", "Engineering", seed.memberId);
    expect(g.ok, g.error).toBe(true);
    const offroster = await seedMember(seed, { kind: "offroster" });
    const connector = await seedMember(seed, { is_connector: true });
    const agent = await seedMember(seed, { kind: "agent" });

    expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, offroster, seed.memberId)).ok).toBe(false);
    expect((await addMemberToGroup(db(), seed.teamId, g.groupId!, connector, seed.memberId)).ok).toBe(false);
    const asAgent = await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    expect(asAgent.ok, asAgent.error).toBe(true);
  });

  it("refuses ordinary-membership edits against built-ins and singletons", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const other = await seedMember(seed);
    const { data: everyone } = await db()
      .from("groups")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", EVERYONE_SLUG)
      .single();
    expect((await addMemberToGroup(db(), seed.teamId, everyone!.id, other, seed.memberId)).ok).toBe(false);

    const s = await ensurePersonSingleton(db(), seed.teamId, seed.memberId, seed.memberId);
    expect(s.ok, s.error).toBe(true);
    expect((await addMemberToGroup(db(), seed.teamId, s.groupId!, other, seed.memberId)).ok).toBe(false);
  });
});

describe("singleton integrity (direct person adds)", () => {
  it("is idempotent, membership = exactly the person, and heals a foreign row", async () => {
    const seed = await seedTeam();
    const first = await ensurePersonSingleton(db(), seed.teamId, seed.memberId, seed.memberId);
    const second = await ensurePersonSingleton(db(), seed.teamId, seed.memberId, seed.memberId);
    expect(first.groupId).toBe(second.groupId);

    // Plant a foreign membership row directly (bypassing the writer) — re-ensure heals it.
    const intruder = await seedMember(seed);
    await db().from("group_members").insert({ team_id: seed.teamId, group_id: first.groupId!, member_id: intruder });
    await ensurePersonSingleton(db(), seed.teamId, seed.memberId, seed.memberId);
    const { data: rows } = await db()
      .from("group_members")
      .select("member_id")
      .eq("team_id", seed.teamId)
      .eq("group_id", first.groupId!);
    expect(((rows ?? []) as { member_id: string }[]).map((r) => r.member_id)).toEqual([seed.memberId]);
  });

  it("schema: a singleton cannot reference another team's member, nor be a built-in", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const cross = await db()
      .from("groups")
      .insert({ team_id: seedA.teamId, slug: "x", name: "x", person_member_id: seedB.memberId })
      .select("id")
      .single();
    expect(cross.error, "composite FK must reject a cross-team person_member_id").not.toBeNull();

    const builtinSingleton = await db()
      .from("groups")
      .insert({ team_id: seedA.teamId, slug: "y", name: "y", is_builtin: true, person_member_id: seedA.memberId })
      .select("id")
      .single();
    expect(builtinSingleton.error, "CHECK must reject builtin+singleton").not.toBeNull();
  });

  it("schema: a cross-team group_members / project_groups edge is unrepresentable", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const g = await createGroup(db(), seedA.teamId, "a-group", "A", seedA.memberId);
    const crossMember = await db()
      .from("group_members")
      .insert({ team_id: seedA.teamId, group_id: g.groupId!, member_id: seedB.memberId });
    expect(crossMember.error, "composite FK must reject a cross-team member edge").not.toBeNull();

    const projectB = await seedProject(seedB);
    const crossProject = await db()
      .from("project_groups")
      .insert({ team_id: seedA.teamId, project_id: projectB, group_id: g.groupId! });
    expect(crossProject.error, "composite FK must reject a cross-team project edge").not.toBeNull();
  });
});

describe("review-fold regressions (Fable round: hijack, tier, audit)", () => {
  it("reserved slugs: createGroup refuses everyone/external/person-*, and ensureBuiltins refuses to convert a squatter", async () => {
    const seed = await seedTeam();
    for (const slug of [EVERYONE_SLUG, EXTERNAL_SLUG, "person-abc"]) {
      expect((await createGroup(db(), seed.teamId, slug, "X", seed.memberId)).ok).toBe(false);
    }
    // A squatter planted directly (bypassing the writer): ensureBuiltins must fail loudly,
    // not flip it to builtin and expose its grants team-wide (the review-caught hijack).
    const project = await seedProject(seed);
    const { data: squatter } = await db()
      .from("groups")
      .insert({ team_id: seed.teamId, slug: EVERYONE_SLUG, name: "curated" })
      .select("id")
      .single();
    await db().from("project_groups").insert({ team_id: seed.teamId, project_id: project, group_id: squatter!.id });
    const r = await ensureBuiltins(db(), seed.teamId);
    expect(r.ok).toBe(false);
    const { data: after } = await db().from("groups").select("is_builtin").eq("id", squatter!.id).single();
    expect(after!.is_builtin, "squatter must not be converted").toBe(false);
  });

  it("tier consistency is read-side too: a team→external downgrade loses Everyone visibility BEFORE any sync runs", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const project = await seedProject(seed);
    const { data: everyone } = await db()
      .from("groups")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", EVERYONE_SLUG)
      .single();
    await grantProjectToGroup(db(), seed.teamId, project, everyone!.id, seed.memberId);
    const principal = { teamId: seed.teamId, memberId: seed.memberId };
    expect((await visibleProjects(db(), principal)).projectIds.has(project)).toBe(true);

    // Downgrade the tier WITHOUT calling syncBuiltinMembership — the stale Everyone row remains.
    await db().from("members").update({ tier: "external" }).eq("id", seed.memberId).eq("team_id", seed.teamId);
    expect(
      (await visibleProjects(db(), principal)).projectIds.has(project),
      "stale Everyone membership must not serve a downgraded member"
    ).toBe(false);
  });

  it("audit rows land: an admin add writes access.member_added; a builtin sync that changed something writes access.builtin_synced", async () => {
    const seed = await seedTeam();
    const g = await createGroup(db(), seed.teamId, "audited", "A", seed.memberId);
    const other = await seedMember(seed);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, other, seed.memberId);
    const { data: added } = await db()
      .from("audit_log")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("action", "access.member_added");
    expect((added ?? []).length).toBeGreaterThan(0);

    await ensureBuiltins(db(), seed.teamId); // first sync adds the seed member → a change
    const { data: synced } = await db()
      .from("audit_log")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("action", "access.builtin_synced");
    expect((synced ?? []).length).toBeGreaterThan(0);
  });
});

describe("the oracle (visibleProjects)", () => {
  it("resolves the chain for an agent principal; a fresh agent in no groups sees nothing", async () => {
    const seed = await seedTeam();
    const agent = await seedMember(seed, { kind: "agent" });
    const project = await seedProject(seed);
    const g = await createGroup(db(), seed.teamId, "proj-g", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, agent, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, project, g.groupId!, seed.memberId);

    const seen = await visibleProjects(db(), { teamId: seed.teamId, memberId: agent });
    expect([...seen.projectIds]).toEqual([project]);

    const fresh = await seedMember(seed, { kind: "agent" });
    const nothing = await visibleProjects(db(), { teamId: seed.teamId, memberId: fresh });
    expect(nothing.projectIds.size).toBe(0);
  });

  it("read-side eligibility: a planted membership for an offroster row still resolves to nothing", async () => {
    const seed = await seedTeam();
    const offroster = await seedMember(seed, { kind: "offroster" });
    const project = await seedProject(seed);
    const g = await createGroup(db(), seed.teamId, "leak-g", "G", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, project, g.groupId!, seed.memberId);
    // Bypass the writer to plant the row the writer would refuse.
    const planted = await db()
      .from("group_members")
      .insert({ team_id: seed.teamId, group_id: g.groupId!, member_id: offroster });
    expect(planted.error).toBeNull();

    const seen = await visibleProjects(db(), { teamId: seed.teamId, memberId: offroster });
    expect(seen.projectIds.size, "offroster must resolve to ∅ even with a planted membership").toBe(0);
  });

  it("attenuation: NULL scope = full visibility; [] = nothing; a scope naming an invisible project contributes nothing", async () => {
    const seed = await seedTeam();
    const p1 = await seedProject(seed);
    const p2 = await seedProject(seed);
    const hidden = await seedProject(seed);
    const g = await createGroup(db(), seed.teamId, "scope-g", "G", seed.memberId);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, seed.memberId, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, p1, g.groupId!, seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, p2, g.groupId!, seed.memberId);

    const base = { teamId: seed.teamId, memberId: seed.memberId };
    expect((await visibleProjects(db(), { ...base, projectScope: null })).projectIds).toEqual(new Set([p1, p2]));
    expect((await visibleProjects(db(), { ...base, projectScope: [] })).projectIds.size).toBe(0);
    expect((await visibleProjects(db(), { ...base, projectScope: [p1] })).projectIds).toEqual(new Set([p1]));
    // Intersection, not union: scoping to an unvisible project grants nothing.
    expect((await visibleProjects(db(), { ...base, projectScope: [hidden] })).projectIds.size).toBe(0);
  });

  it("live inheritance, both directions: group changes reflect on the next oracle call with an unchanged scope", async () => {
    const seed = await seedTeam();
    const project = await seedProject(seed);
    const g = await createGroup(db(), seed.teamId, "live-g", "G", seed.memberId);
    await grantProjectToGroup(db(), seed.teamId, project, g.groupId!, seed.memberId);

    const principal = { teamId: seed.teamId, memberId: seed.memberId, projectScope: null };
    // gain: the direction a snapshot cannot pass (spec §14 spawn row)
    expect((await visibleProjects(db(), principal)).projectIds.size).toBe(0);
    await addMemberToGroup(db(), seed.teamId, g.groupId!, seed.memberId, seed.memberId);
    expect((await visibleProjects(db(), principal)).projectIds.has(project)).toBe(true);
    // lose — through the writer, so this also exercises removeMemberFromGroup
    const removed = await removeMemberFromGroup(db(), seed.teamId, g.groupId!, seed.memberId, seed.memberId);
    expect(removed.ok, removed.error).toBe(true);
    expect((await visibleProjects(db(), principal)).projectIds.size).toBe(0);
  });
});
