import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db, seedTeam, type Seed } from "./helpers";
import {
  EVERYONE_SLUG,
  addMemberToGroup,
  removeMemberFromGroup,
  ensureBuiltins,
  materializeBuiltinMembershipOnce,
} from "@/lib/access/groups";
import { resolveViewerPosture, _resetPostureConfirmationForTests } from "@/lib/access/posture";
import { visibleProjects } from "@/lib/access/oracle";
import { createMember } from "@/lib/admin/members";

// PRET-4 AC1 (docs/design/pret4-tier-wall-teardown.md §4.1): the posture cutover on a
// PERMISSIVE team. Posture — membership in the `everyone` built-in — replaces members.tier as
// the two-bucket wall input, with the enumerated principal classes byte-identical at cutover
// (posture == materialized tier), the recompute retired (no resurrection), and the deliberate
// membership actions live (including the M3 tier mirror). The cold-read H1 class (an ACTIVE
// TEAM-TIER CONNECTOR, which authenticates and reads the corpus today) is seeded explicitly —
// it is the class a naive humans-only materialization silently narrows.

async function seedMemberRow(
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

async function builtinGroupId(seed: Seed, slug: string): Promise<string> {
  const { data } = await db()
    .from("groups")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("slug", slug)
    .eq("is_builtin", true)
    .single();
  if (!data) throw new Error(`builtin ${slug} missing`);
  return data.id as string;
}

async function memberTierColumn(seed: Seed, memberId: string): Promise<string> {
  const { data } = await db()
    .from("members")
    .select("tier")
    .eq("team_id", seed.teamId)
    .eq("id", memberId)
    .single();
  return (data as { tier: string }).tier;
}

beforeEach(async () => {
  // Fresh fleet per test: the materialization is one-time PER FLEET (marker-guarded), and the
  // shared test DB carries the marker across tests — clear it so each test's teams get their
  // own materialization pass. Direct marker delete is legal test plumbing (the single-writer
  // guard covers the access edge tables, not migration_markers).
  await db().from("migration_markers").delete().eq("name", "pret4_builtin_materialize");
  _resetPostureConfirmationForTests();
});

describe("PRET-4 AC1 — posture equals the materialized tier for every principal class (permissive team)", () => {
  it("materializes every member kind per tier, and posture matches the pre-cutover tier byte-for-byte", async () => {
    const seed = await seedTeam(); // active team-tier human
    const externalHuman = await seedMemberRow(seed, { tier: "external" });
    const teamConnector = await seedMemberRow(seed, { is_connector: true, tier: "team" }); // H1's class
    const agent = await seedMemberRow(seed, { kind: "agent", tier: "team" });
    const invitedHuman = await seedMemberRow(seed, { status: "invited", tier: "team" });
    const externalAgent = await seedMemberRow(seed, { kind: "agent", tier: "external" });

    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);

    // Posture per class == the tier column that seeded it. The connector and agent arms are
    // the classes the old recompute NEVER admitted — their posture must still be their tier
    // (grant-inert rows carrying posture), or permissive reads narrow at deploy (H1).
    expect(await resolveViewerPosture(db(), seed.teamId, seed.memberId)).toBe("team");
    expect(await resolveViewerPosture(db(), seed.teamId, externalHuman)).toBe("external");
    expect(await resolveViewerPosture(db(), seed.teamId, teamConnector)).toBe("team");
    expect(await resolveViewerPosture(db(), seed.teamId, agent)).toBe("team");
    expect(await resolveViewerPosture(db(), seed.teamId, invitedHuman)).toBe("team");
    expect(await resolveViewerPosture(db(), seed.teamId, externalAgent)).toBe("external");
  });

  it("materialized non-human builtin rows are GRANT-inert: the oracle still resolves agents/connectors to their explicit placements only", async () => {
    const seed = await seedTeam();
    const agent = await seedMemberRow(seed, { kind: "agent", tier: "team" });
    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);

    // The slice-2 planted-agent property survives the materialization verbatim: the agent's
    // everyone row carries posture, never General.
    const vis = await visibleProjects(db(), { teamId: seed.teamId, memberId: agent });
    expect(vis.projectIds.size).toBe(0);
  });

  it("a member with no builtin row resolves external — default-deny, no tier fallback after confirmation", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);

    // Post-materialization, a NEW row inserted directly (bypassing createMember's explicit
    // write) has no builtin membership: posture is external even though tier says team —
    // the row, not the record, is the access input now.
    const orphan = await seedMemberRow(seed, { tier: "team" });
    expect(await resolveViewerPosture(db(), seed.teamId, orphan)).toBe("external");
  });
});

describe("PRET-4 AC1 — the recompute is retired: deliberate membership edits are never resurrected", () => {
  it("removing a human from everyone flips posture to external on the next read, mirrors members.tier, and NOTHING re-adds the row (mutation target M-A)", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);
    expect(await resolveViewerPosture(db(), seed.teamId, seed.memberId)).toBe("team");

    const everyoneId = await builtinGroupId(seed, EVERYONE_SLUG);
    const r = await removeMemberFromGroup(db(), seed.teamId, everyoneId, seed.memberId, seed.memberId);
    expect(r.ok, r.error).toBe(true);

    expect(await resolveViewerPosture(db(), seed.teamId, seed.memberId)).toBe("external");
    // The M3 mirror: the invite-default record follows the deliberate move, so the token
    // layer and Linear provisioning can never diverge from posture.
    expect(await memberTierColumn(seed, seed.memberId)).toBe("external");

    // The retirement's observable: the paths that used to recompute-and-resurrect (bootstrap's
    // ensure, a second materialize call — marker-guarded) leave the deliberate edit standing.
    await ensureBuiltins(db(), seed.teamId);
    const again = await materializeBuiltinMembershipOnce(db());
    expect(again.ok).toBe(true);
    expect(await resolveViewerPosture(db(), seed.teamId, seed.memberId)).toBe("external");
  });

  it("adding an external-invited human to everyone grants team posture and mirrors tier to team (the new deliberate action)", async () => {
    const seed = await seedTeam();
    const collaborator = await seedMemberRow(seed, { tier: "external" });
    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);
    expect(await resolveViewerPosture(db(), seed.teamId, collaborator)).toBe("external");

    const everyoneId = await builtinGroupId(seed, EVERYONE_SLUG);
    const r = await addMemberToGroup(db(), seed.teamId, everyoneId, collaborator, seed.memberId);
    expect(r.ok, r.error).toBe(true);

    expect(await resolveViewerPosture(db(), seed.teamId, collaborator)).toBe("team");
    expect(await memberTierColumn(seed, collaborator)).toBe("team");
  });

  it("builtin adds stay humans-only: an agent cannot be added to everyone through the deliberate-action door (cold-read H3)", async () => {
    const seed = await seedTeam();
    const agent = await seedMemberRow(seed, { kind: "agent", tier: "external" });
    await ensureBuiltins(db(), seed.teamId);
    const everyoneId = await builtinGroupId(seed, EVERYONE_SLUG);
    const r = await addMemberToGroup(db(), seed.teamId, everyoneId, agent, seed.memberId);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/human/i);
  });
});

describe("PRET-4 §1c — createMember writes the invite default as explicit state", () => {
  it("a created member holds their tier's builtin row from CREATE (invited, inert until active), for every kind", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);

    const human = await createMember(db(), seed.teamId, {
      email: `${randomUUID()}@test.local`,
      displayName: "Invited External",
      actorHandle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "external",
    });
    expect(await resolveViewerPosture(db(), seed.teamId, human.id)).toBe("external");

    const internal = await createMember(db(), seed.teamId, {
      email: `${randomUUID()}@test.local`,
      displayName: "Invited Internal",
      actorHandle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
    });
    // default tier=team → everyone row exists from CREATE, before any activation
    expect(await resolveViewerPosture(db(), seed.teamId, internal.id)).toBe("team");
    const everyone = await builtinGroupId(seed, EVERYONE_SLUG);
    const { data: row } = await db()
      .from("group_members")
      .select("member_id")
      .eq("team_id", seed.teamId)
      .eq("group_id", everyone)
      .eq("member_id", internal.id)
      .maybeSingle();
    expect(row).not.toBeNull();
  });

  it("an upsert that CHANGES tier reconciles the builtin row; an unchanged upsert never clobbers a deliberate cross-enrollment", async () => {
    const seed = await seedTeam();
    await ensureBuiltins(db(), seed.teamId);
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);

    const email = `${randomUUID()}@test.local`;
    const created = await createMember(db(), seed.teamId, {
      email,
      displayName: "Mover",
      actorHandle: `h-${randomUUID().slice(0, 10)}`,
      role: "member",
      tier: "external",
    });
    expect(await resolveViewerPosture(db(), seed.teamId, created.id)).toBe("external");

    // Deliberate cross-enrollment: promote posture without touching the record's invite path.
    // (Activate first — the deliberate-action door's isPrincipal gate refuses 'invited'
    // members by design; their pre-activation state is the invite default's job.)
    await db().from("members").update({ status: "active" }).eq("id", created.id).eq("team_id", seed.teamId);
    const everyoneId = await builtinGroupId(seed, EVERYONE_SLUG);
    const add = await addMemberToGroup(db(), seed.teamId, everyoneId, created.id, seed.memberId);
    expect(add.ok, add.error).toBe(true);
    expect(await resolveViewerPosture(db(), seed.teamId, created.id)).toBe("team");

    // A NO-CHANGE upsert (tier now reads team via the mirror; upsert passes team) must not move rows.
    await createMember(
      db(),
      seed.teamId,
      { email, displayName: "Mover", actorHandle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "team" },
      { upsert: true }
    );
    expect(await resolveViewerPosture(db(), seed.teamId, created.id)).toBe("team");

    // A CHANGED-tier upsert is a deliberate posture move: external again.
    await createMember(
      db(),
      seed.teamId,
      { email, displayName: "Mover", actorHandle: `h-${randomUUID().slice(0, 10)}`, role: "member", tier: "external" },
      { upsert: true }
    );
    expect(await resolveViewerPosture(db(), seed.teamId, created.id)).toBe("external");
    const { data: gone } = await db()
      .from("group_members")
      .select("member_id")
      .eq("team_id", seed.teamId)
      .eq("group_id", everyoneId)
      .eq("member_id", created.id)
      .maybeSingle();
    expect(gone).toBeNull();
  });
});

describe("PRET-4 §1a/§3.2 — the marker-keyed window fails CLOSED (cold-read H2)", () => {
  it("BEFORE the materialization marker, a stale everyone row is inert (legacy tier semantics); AFTER, rows are authoritative", async () => {
    const seed = await seedTeam();
    const { ensureAccessBootstrap } = await import("@/lib/access/bootstrap");
    const boot = await ensureAccessBootstrap(db(), seed.teamId);
    expect(boot.ok, boot.error).toBe(true);
    // Simulate the recompute-era stale-row class: the member's tier is downgraded but the
    // everyone row survives (a failed hook sync). Direct writes, as the incident would leave.
    const everyoneId = await builtinGroupId(seed, EVERYONE_SLUG);
    await db()
      .from("group_members")
      .upsert({ team_id: seed.teamId, group_id: everyoneId, member_id: seed.memberId }, { onConflict: "group_id,member_id" });
    await db().from("members").update({ tier: "external" }).eq("id", seed.memberId).eq("team_id", seed.teamId);

    // Pre-marker: legacy semantics — posture is the TIER (external), the stale row is not live.
    expect(await resolveViewerPosture(db(), seed.teamId, seed.memberId)).toBe("external");
    // And the oracle's builtin acceptance applies the same legacy conjunct pre-marker.
    const preVis = await visibleProjects(db(), { teamId: seed.teamId, memberId: seed.memberId });
    const { data: generalGrantRows } = await db()
      .from("projects")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("slug", "general")
      .single();
    expect(preVis.projectIds.has((generalGrantRows as { id: string }).id)).toBe(false);

    // The sweep DROPS the stale row (the tier predicate refutes it) and sets the marker.
    const ran = await materializeBuiltinMembershipOnce(db());
    expect(ran.ok, ran.error).toBe(true);
    _resetPostureConfirmationForTests(); // fresh process-cache read against the now-present marker
    expect(await resolveViewerPosture(db(), seed.teamId, seed.memberId)).toBe("external");
    const { data: staleRow } = await db()
      .from("group_members")
      .select("member_id")
      .eq("team_id", seed.teamId)
      .eq("group_id", everyoneId)
      .eq("member_id", seed.memberId)
      .maybeSingle();
    expect(staleRow).toBeNull();
  });
});
