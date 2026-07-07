import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { updateMemberManager } from "@/lib/admin/members";
import { db, seedTeam } from "./helpers";

// Spec: manager_member_id is the org-chart source synced into the company graph. Rejects
// self-management, a manager outside the caller's team, a disabled manager, and a connector
// "manager" — none of those make sense as a reporting line. Verified on real Postgres.

async function addMember(
  teamId: string,
  opts: {
    status?: "invited" | "active" | "disabled";
    connector?: boolean;
  } = {},
): Promise<string> {
  const { data } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Extra",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: opts.status ?? "active",
      is_connector: Boolean(opts.connector),
    })
    .select("id")
    .single();
  return (data as { id: string }).id;
}

async function managerOf(memberId: string): Promise<string | null> {
  const { data } = await db()
    .from("members")
    .select("manager_member_id")
    .eq("id", memberId)
    .maybeSingle();
  return (data as { manager_member_id: string | null }).manager_member_id;
}

describe("updateMemberManager (data-mechanics)", () => {
  it("sets and clears a valid manager", async () => {
    const seed = await seedTeam();
    const manager = await addMember(seed.teamId);

    const res = await updateMemberManager(
      db(),
      seed.teamId,
      seed.memberId,
      manager,
    );
    expect(res).toMatchObject({ updated: true, managerMemberId: manager });
    expect(await managerOf(seed.memberId)).toBe(manager);

    const cleared = await updateMemberManager(
      db(),
      seed.teamId,
      seed.memberId,
      null,
    );
    expect(cleared).toMatchObject({ updated: true, managerMemberId: null });
    expect(await managerOf(seed.memberId)).toBeNull();
  });

  it("rejects self-management", async () => {
    const seed = await seedTeam();
    const res = await updateMemberManager(
      db(),
      seed.teamId,
      seed.memberId,
      seed.memberId,
    );
    expect(res).toMatchObject({ updated: false, reason: "self" });
    expect(await managerOf(seed.memberId)).toBeNull();
  });

  it("rejects a manager from a different team", async () => {
    const seed = await seedTeam();
    const other = await seedTeam();
    const res = await updateMemberManager(
      db(),
      seed.teamId,
      seed.memberId,
      other.memberId,
    );
    expect(res).toMatchObject({ updated: false, reason: "manager-not-found" });
  });

  it("rejects a disabled manager", async () => {
    const seed = await seedTeam();
    const disabled = await addMember(seed.teamId, { status: "disabled" });
    const res = await updateMemberManager(
      db(),
      seed.teamId,
      seed.memberId,
      disabled,
    );
    expect(res).toMatchObject({ updated: false, reason: "manager-disabled" });
  });

  it("rejects a connector as manager", async () => {
    const seed = await seedTeam();
    const connector = await addMember(seed.teamId, { connector: true });
    const res = await updateMemberManager(
      db(),
      seed.teamId,
      seed.memberId,
      connector,
    );
    expect(res).toMatchObject({
      updated: false,
      reason: "manager-is-connector",
    });
  });

  it("returns 'absent' for an unknown member id", async () => {
    const seed = await seedTeam();
    const manager = await addMember(seed.teamId);
    const res = await updateMemberManager(
      db(),
      seed.teamId,
      randomUUID(),
      manager,
    );
    expect(res).toMatchObject({ updated: false, reason: "absent" });
  });
});

describe("members.manager_member_id migration (data-mechanics)", () => {
  it("FK on delete set null: deleting a manager clears dependents' manager_member_id", async () => {
    const seed = await seedTeam();
    const manager = await addMember(seed.teamId);
    await updateMemberManager(db(), seed.teamId, seed.memberId, manager);
    expect(await managerOf(seed.memberId)).toBe(manager);

    await db().from("members").delete().eq("id", manager);
    expect(await managerOf(seed.memberId)).toBeNull();
  });
});
