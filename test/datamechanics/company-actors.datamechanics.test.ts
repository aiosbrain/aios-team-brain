import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  syncMemberActor,
  removeMemberActor,
  memberEntityId,
} from "@/lib/graph/company-actors";
import { db, seedTeam } from "./helpers";

// Spec: a real member joining Team Brain is loaded into the company graph as an actor entity
// (not left fixture-only), a connector service-account never is, and the org-chart source
// (manager_member_id) stays reflected in BOTH representations the two consumers read —
// graph_relationships REPORTS_TO edges (lib/query/retrieve's chat context) and
// attrs.reports_to on the entity (GET /api/v1/company-graph). Verified on real Postgres.

async function addMember(
  teamId: string,
  opts: { role?: "admin" | "lead" | "member"; connector?: boolean } = {},
): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Extra",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: opts.role ?? "member",
      tier: "team",
      status: "active",
      is_connector: Boolean(opts.connector),
    })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function entityOf(teamId: string, memberId: string) {
  const { data } = await db()
    .from("graph_entities")
    .select("entity_id, name, attrs")
    .eq("team_id", teamId)
    .eq("entity_id", memberEntityId(memberId))
    .maybeSingle();
  return data as {
    entity_id: string;
    name: string;
    attrs: Record<string, unknown>;
  } | null;
}

async function reportsToEdges(teamId: string, memberId: string) {
  const { data } = await db()
    .from("graph_relationships")
    .select("from_id, to_id, relationship_type")
    .eq("team_id", teamId)
    .eq("from_id", memberEntityId(memberId))
    .eq("relationship_type", "REPORTS_TO");
  return data ?? [];
}

describe("syncMemberActor (data-mechanics)", () => {
  it("creates an actor entity with the expected attrs (member_role, not role)", async () => {
    const seed = await seedTeam();
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    const entity = await entityOf(seed.teamId, seed.memberId);
    expect(entity).not.toBeNull();
    expect(entity?.attrs).toMatchObject({
      member_role: "member",
      tier: "team",
      status: "active",
    });
    // role/job_family are never populated from members.role — that's a job title we have no source
    // for; a permission level under `role` would misrepresent the brain-api v1.5 contract.
    expect(entity?.attrs.role).toBeUndefined();
  });

  it("updates attrs.member_role in place on a re-sync (no duplicate row)", async () => {
    const seed = await seedTeam();
    await syncMemberActor(db(), seed.teamId, seed.memberId);
    await db()
      .from("members")
      .update({ role: "admin" })
      .eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    const { data: rows } = await db()
      .from("graph_entities")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("entity_id", memberEntityId(seed.memberId));
    expect(rows).toHaveLength(1);
    const entity = await entityOf(seed.teamId, seed.memberId);
    expect(entity?.attrs.member_role).toBe("admin");
  });

  it("is a no-op for a connector service-account", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    await syncMemberActor(db(), seed.teamId, connector);
    expect(await entityOf(seed.teamId, connector)).toBeNull();
  });

  it("keeps the REPORTS_TO edge and attrs.reports_to in lock-step across manager reassignment", async () => {
    const seed = await seedTeam();
    const managerB = await addMember(seed.teamId);
    const managerC = await addMember(seed.teamId);

    await db()
      .from("members")
      .update({ manager_member_id: managerB })
      .eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);
    expect((await entityOf(seed.teamId, seed.memberId))?.attrs.reports_to).toBe(
      memberEntityId(managerB),
    );
    expect(await reportsToEdges(seed.teamId, seed.memberId)).toEqual([
      {
        from_id: memberEntityId(seed.memberId),
        to_id: memberEntityId(managerB),
        relationship_type: "REPORTS_TO",
      },
    ]);

    await db()
      .from("members")
      .update({ manager_member_id: managerC })
      .eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);
    const edgesAfter = await reportsToEdges(seed.teamId, seed.memberId);
    expect(edgesAfter).toHaveLength(1); // old edge replaced, not duplicated
    expect(edgesAfter[0]).toMatchObject({ to_id: memberEntityId(managerC) });
    expect((await entityOf(seed.teamId, seed.memberId))?.attrs.reports_to).toBe(
      memberEntityId(managerC),
    );
  });

  it("clears both representations when the manager is unset", async () => {
    const seed = await seedTeam();
    const manager = await addMember(seed.teamId);
    await db()
      .from("members")
      .update({ manager_member_id: manager })
      .eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    await db()
      .from("members")
      .update({ manager_member_id: null })
      .eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    expect(await reportsToEdges(seed.teamId, seed.memberId)).toEqual([]);
    expect(
      (await entityOf(seed.teamId, seed.memberId))?.attrs.reports_to,
    ).toBeNull();
  });

  it("persists the entity with attrs.status='disabled' on soft-disable (kept for history)", async () => {
    const seed = await seedTeam();
    await syncMemberActor(db(), seed.teamId, seed.memberId);
    await db()
      .from("members")
      .update({ status: "disabled" })
      .eq("id", seed.memberId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);

    const entity = await entityOf(seed.teamId, seed.memberId);
    expect(entity).not.toBeNull();
    expect(entity?.attrs.status).toBe("disabled");
  });
});

describe("removeMemberActor (data-mechanics)", () => {
  it("deletes the entity and every relationship touching it in either direction", async () => {
    const seed = await seedTeam();
    const report = await addMember(seed.teamId);
    await syncMemberActor(db(), seed.teamId, seed.memberId);
    await db()
      .from("members")
      .update({ manager_member_id: seed.memberId })
      .eq("id", report);
    await syncMemberActor(db(), seed.teamId, report); // report now reports to seed.memberId

    // Simulate what the caller (deleteMember's hard path) must do: capture direct reports
    // BEFORE the hard delete clears their manager_member_id via the FK cascade, then delete the
    // member row itself (mirroring lib/admin/members.ts's deleteMember), then clean up the graph.
    await db().from("members").delete().eq("id", seed.memberId);
    await removeMemberActor(db(), seed.teamId, seed.memberId, [report]);

    expect(await entityOf(seed.teamId, seed.memberId)).toBeNull();
    // The removed member's own entity's inbound edge (report -> removed) is gone...
    const { data: anyEdgeToRemoved } = await db()
      .from("graph_relationships")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("to_id", memberEntityId(seed.memberId));
    expect(anyEdgeToRemoved).toEqual([]);
    // ...and the direct report was re-synced: no longer reports to the now-gone manager.
    expect(await reportsToEdges(seed.teamId, report)).toEqual([]);
    expect((await entityOf(seed.teamId, report))?.attrs.reports_to).toBeNull();
  });
});
