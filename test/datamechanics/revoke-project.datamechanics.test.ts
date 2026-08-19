import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, ingest, seedTeam, placeMemberByTier, type Seed } from "./helpers";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { ensureAccessBootstrap, GENERAL_SLUG } from "@/lib/access/bootstrap";
import {
  createGroup,
  grantProjectToGroup,
  revokeProjectFromGroup,
  addMemberToGroup,
  EVERYONE_SLUG,
} from "@/lib/access/groups";
import { visibleItemIds } from "@/lib/access/enforce";

// REVOKE-1 ACs (docs/design/revoke1-project-audit-actor.md): the revoke verb's sole writer —
// the observable enforcement narrowing, the honest operator audit shape (round 1 BLOCKER:
// never launder the authorizer into the actor field), the writer-held refusals in D2c order
// (system kind → principal → probe → delete+audit), and the no-op-no-audit rule.

async function member(seed: Seed, opts: { role?: string; status?: string; posture?: "team" | "external" | "none" } = {}): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: `${randomUUID()}@t.local`,
      display_name: "M",
      actor_handle: `m-${randomUUID().slice(0, 10)}`,
      role: opts.role ?? "admin",
      tier: "team",
      status: opts.status ?? "active",
    })
    .select("id")
    .single();
  const id = data!.id as string;
  const posture = opts.posture ?? "team";
  if (posture !== "none") await placeMemberByTier(seed.teamId, id, posture);
  return id;
}

/** A restricted initiative P holding one item's context unit, granted to `groups`. */
async function restrictedProject(seed: Seed, itemId: string, groupIds: string[], granter: string) {
  const { data: proj } = await db()
    .from("projects")
    .insert({ team_id: seed.teamId, slug: `r-${randomUUID().slice(0, 8)}`, name: "R", kind: "initiative" })
    .select("id")
    .single();
  const projectId = proj!.id as string;
  for (const g of groupIds) {
    const r = await grantProjectToGroup(db(), seed.teamId, projectId, g, granter);
    expect(r.ok).toBe(true);
  }
  const { data: unit } = await db().from("project_context_units").select("id").eq("source_item_id", itemId).single();
  await db().from("project_context_memberships").update({ valid_to: new Date().toISOString() }).eq("context_unit_id", unit!.id).is("valid_to", null);
  const { error } = await db().from("project_context_memberships").insert({ team_id: seed.teamId, project_id: projectId, context_unit_id: unit!.id, method: "manual" });
  expect(error).toBeNull();
  return projectId;
}

async function grp(seed: Seed, actorId: string) {
  const g = await createGroup(db(), seed.teamId, `g-${randomUUID().slice(0, 8)}`, "G", actorId);
  expect(g.ok).toBe(true);
  return g.groupId!;
}

const revokedAuditRows = async (seed: Seed) => {
  const { data } = await db()
    .from("audit_log")
    .select("actor_kind, member_id, meta")
    .eq("team_id", seed.teamId)
    .eq("action", "access.project_revoked");
  return (data ?? []) as { actor_kind: string; member_id: string | null; meta: Record<string, unknown> }[];
};

const edgeExists = async (seed: Seed, projectId: string, groupId: string) => {
  const { data } = await db()
    .from("project_groups")
    .select("project_id")
    .eq("team_id", seed.teamId)
    .eq("project_id", projectId)
    .eq("group_id", groupId)
    .maybeSingle();
  return !!data;
};

const visOf = async (seed: Seed, memberId: string) => {
  const v = await visibleItemIds(db(), { teamId: seed.teamId, memberId });
  expect(v.error).toBeFalsy();
  return v.ids;
};

describe("REVOKE-1 — enforcement narrows, the audit is honest, no-ops do not audit", () => {
  it("revoking the ONLY granting group removes the item from the member's enforced read; a second granted group keeps it; operator audit = system actor + authorizedBy meta; member-kind audit = member actor; no-op and double revokes audit nothing extra", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    const admin = await member(seed); // active team-posture admin — the authorizer
    const viewer = await member(seed, { role: "member" });

    const item = await ingest(seed, { path: "s.md", body: "secret body", access: "team", project: "src" });
    const item2 = await ingest(seed, { path: "s2.md", body: "second secret", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);

    // P1: viewer holds it through ONE group. P2: through TWO groups.
    const g1 = await grp(seed, admin);
    const g2a = await grp(seed, admin);
    const g2b = await grp(seed, admin);
    await addMemberToGroup(db(), seed.teamId, g1, viewer, admin);
    await addMemberToGroup(db(), seed.teamId, g2a, viewer, admin);
    await addMemberToGroup(db(), seed.teamId, g2b, viewer, admin);
    const p1 = await restrictedProject(seed, item.id, [g1], admin);
    const p2 = await restrictedProject(seed, item2.id, [g2a, g2b], admin);

    expect((await visOf(seed, viewer)).has(item.id), "granted → visible (the pre-state)").toBe(true);
    expect((await visOf(seed, viewer)).has(item2.id)).toBe(true);

    // The operator revoke: the observable outcome is the enforced read narrowing.
    const r1 = await revokeProjectFromGroup(db(), seed.teamId, p1, g1, { kind: "operator", authorizedByMemberId: admin });
    expect(r1.ok).toBe(true);
    expect(r1.revoked).toBe(true);
    expect((await visOf(seed, viewer)).has(item.id), "revoked → gone from the enforced read").toBe(false);

    // Set semantics (D4): one of TWO grants revoked → still visible through the other.
    const r2 = await revokeProjectFromGroup(db(), seed.teamId, p2, g2a, { kind: "operator", authorizedByMemberId: admin });
    expect(r2.revoked).toBe(true);
    expect((await visOf(seed, viewer)).has(item2.id), "the second group still grants it").toBe(true);

    // The honest audit shape (D1): operator revokes are SYSTEM acts with a named authorizer —
    // never the authorizer in the actor field (the round-1 laundering blocker).
    const rows = await revokedAuditRows(seed);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.actor_kind).toBe("system");
      expect(row.member_id).toBeNull();
      expect(row.meta.authorizedByMemberId).toBe(admin);
      expect(row.meta.via).toBe("cli");
      expect(typeof row.meta.groupId).toBe("string");
    }

    // The member kind (the future UI's own act) audits as the member.
    const r3 = await revokeProjectFromGroup(db(), seed.teamId, p2, g2b, { kind: "member", memberId: admin });
    expect(r3.revoked).toBe(true);
    const after = await revokedAuditRows(seed);
    expect(after.length).toBe(3);
    const memberRow = after.find((r) => r.actor_kind === "member");
    expect(memberRow, "the member-kind act carries the member actor").toBeTruthy();
    expect(memberRow!.member_id).toBe(admin);

    // No-op (D3): revoking the already-gone edge reports revoked:false and audits NOTHING.
    const again = await revokeProjectFromGroup(db(), seed.teamId, p1, g1, { kind: "operator", authorizedByMemberId: admin });
    expect(again.ok).toBe(true);
    expect(again.revoked).toBe(false);
    expect((await revokedAuditRows(seed)).length, "a revoke that revoked nothing writes no trail").toBe(3);
  });

  it("the writer refuses in D2c order with the edge INTACT: system projects; non-admin, inactive, external-posture, and unknown principals (same refusal with or without an edge — no existence oracle); grant meta records the authorizer without laundering", async () => {
    const seed = await seedTeam();
    await backfillTeamContext(db(), seed.teamId);
    expect((await ensureAccessBootstrap(db(), seed.teamId)).ok).toBe(true);
    const admin = await member(seed);

    // D2: the system wiring is unrevokable THROUGH THE WRITER (prod's only edges are exactly
    // these — severing general↔everyone is a substrate outage).
    const { data: gen } = await db().from("projects").select("id").eq("team_id", seed.teamId).eq("slug", GENERAL_SLUG).eq("kind", "system").single();
    const { data: everyone } = await db().from("groups").select("id").eq("team_id", seed.teamId).eq("slug", EVERYONE_SLUG).eq("is_builtin", true).single();
    const sysProject = gen!.id as string;
    const sysGroup = everyone!.id as string;
    expect(await edgeExists(seed, sysProject, sysGroup), "bootstrap wired the system edge").toBe(true);
    const sys = await revokeProjectFromGroup(db(), seed.teamId, sysProject, sysGroup, { kind: "operator", authorizedByMemberId: admin });
    expect(sys.ok).toBe(false);
    expect(sys.error).toMatch(/system/);
    expect(await edgeExists(seed, sysProject, sysGroup), "the substrate edge survives the refusal").toBe(true);

    // A real initiative edge for the principal arms.
    const item = await ingest(seed, { path: "p.md", body: "restricted", access: "team", project: "src" });
    await backfillTeamContext(db(), seed.teamId);
    const g = await grp(seed, admin);
    const project = await restrictedProject(seed, item.id, [g], admin);

    // D2b (round 2 B2): the principal must pass the APP's admin predicate — role AND status
    // AND non-external posture. Each refusal leaves the edge intact.
    const nonAdmin = await member(seed, { role: "member" });
    const inactive = await member(seed, { status: "disabled" });
    const externalAdmin = await member(seed, { posture: "external" }); // role=admin, active — the representable principal every app gate denies
    const unknown = randomUUID();
    for (const [label, principal] of [
      ["a non-admin", nonAdmin],
      ["an inactive admin", inactive],
      ["an external-posture admin", externalAdmin],
      ["an unknown id", unknown],
    ] as const) {
      const viaOperator = await revokeProjectFromGroup(db(), seed.teamId, project, g, { kind: "operator", authorizedByMemberId: principal });
      expect(viaOperator.ok, `${label} must not authorize an operator revoke`).toBe(false);
      const viaMember = await revokeProjectFromGroup(db(), seed.teamId, project, g, { kind: "member", memberId: principal });
      expect(viaMember.ok, `${label} must not perform a member revoke`).toBe(false);
      expect(await edgeExists(seed, project, g), `the edge survives ${label}`).toBe(true);
    }

    // D2c — no existence oracle: an invalid principal gets the SAME refusal against an
    // ABSENT edge as against the present one (the probe runs only after authority).
    const withEdge = await revokeProjectFromGroup(db(), seed.teamId, project, g, { kind: "operator", authorizedByMemberId: nonAdmin });
    const noEdgeProject = await restrictedProject(seed, item.id, [], admin); // no grant at all
    const withoutEdge = await revokeProjectFromGroup(db(), seed.teamId, noEdgeProject, g, { kind: "operator", authorizedByMemberId: nonAdmin });
    expect(withEdge.ok).toBe(false);
    expect(withoutEdge.ok).toBe(false);
    expect(withoutEdge.error, "identical refusal — edge presence is not observable without authority").toBe(withEdge.error);

    // And no audit row came from any refusal.
    expect((await revokedAuditRows(seed)).length).toBe(0);

    // D1b — the grant flag records the authorizer in META only: system actor, no added_by.
    const g3 = await grp(seed, admin);
    const r = await grantProjectToGroup(db(), seed.teamId, project, g3, null, { authorizedByMemberId: admin });
    expect(r.ok).toBe(true);
    const { data: grantRows } = await db()
      .from("audit_log")
      .select("actor_kind, member_id, meta")
      .eq("team_id", seed.teamId)
      .eq("action", "access.project_granted");
    const flagged = ((grantRows ?? []) as { actor_kind: string; member_id: string | null; meta: Record<string, unknown> }[]).filter(
      (row) => row.meta.authorizedByMemberId === admin
    );
    expect(flagged.length).toBe(1);
    expect(flagged[0].actor_kind, "the authorizer is NOT laundered into the actor").toBe("system");
    expect(flagged[0].member_id).toBeNull();
    const { data: edge } = await db().from("project_groups").select("added_by").eq("team_id", seed.teamId).eq("project_id", project).eq("group_id", g3).single();
    expect(edge!.added_by, "the authorizer is NOT laundered into added_by").toBeNull();

    // The unflagged path is unchanged: system actor, no authorizedBy key.
    const g4 = await grp(seed, admin);
    await grantProjectToGroup(db(), seed.teamId, project, g4, null);
    const { data: plainRows } = await db()
      .from("audit_log")
      .select("meta")
      .eq("team_id", seed.teamId)
      .eq("action", "access.project_granted");
    const plain = ((plainRows ?? []) as { meta: Record<string, unknown> }[]).filter((row) => (row.meta.groupId as string) === g4);
    expect(plain.length).toBe(1);
    expect("authorizedByMemberId" in plain[0].meta).toBe(false);

    // A non-admin authorizedBy on the GRANT flag refuses too (the D1b validation arm).
    const g5 = await grp(seed, admin);
    const bad = await grantProjectToGroup(db(), seed.teamId, project, g5, null, { authorizedByMemberId: nonAdmin });
    expect(bad.ok).toBe(false);
    expect(await edgeExists(seed, project, g5)).toBe(false);
  });
});
