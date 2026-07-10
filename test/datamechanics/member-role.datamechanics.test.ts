import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db, seedTeam } from "./helpers";
import { updateMemberRole } from "@/lib/admin/members";

// Spec: an admin can change an existing member's role. Verified to the observable outcome on
// real Postgres — the row's role actually changes, the audit trail records it, and a team can
// never lock itself out by demoting its last admin.

async function addMember(teamId: string, role: "admin" | "lead" | "member", status = "active") {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: teamId,
      email: `${randomUUID()}@test.local`,
      display_name: "Extra",
      actor_handle: `actor-${randomUUID().slice(0, 8)}`,
      role,
      tier: "team",
      status,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seed extra member failed: ${error?.message}`);
  return (data as { id: string }).id;
}

async function roleOf(memberId: string): Promise<string> {
  const { data } = await db().from("members").select("role").eq("id", memberId).maybeSingle();
  return (data as { role: string }).role;
}

async function auditRows(teamId: string, targetId: string) {
  const { data } = await db()
    .from("audit_log")
    .select("action, meta")
    .eq("team_id", teamId)
    .eq("target_id", targetId)
    .eq("action", "member.role_changed");
  return (data ?? []) as { action: string; meta: Record<string, unknown> }[];
}

describe("updateMemberRole (data-mechanics)", () => {
  it("promotes a member to admin and persists it", async () => {
    const seed = await seedTeam(); // seeded member defaults to role=member
    const res = await updateMemberRole(db(), seed.teamId, seed.memberId, "admin", {
      actor: { kind: "member", memberId: seed.memberId },
    });
    expect(res).toMatchObject({ updated: true, role: "admin" });
    expect(await roleOf(seed.memberId)).toBe("admin");

    const audits = await auditRows(seed.teamId, seed.memberId);
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ from: "member", to: "admin" });
  });

  it("demotes a lead to member when another admin still exists", async () => {
    const seed = await seedTeam();
    await updateMemberRole(db(), seed.teamId, seed.memberId, "admin"); // now the team's admin
    const leadId = await addMember(seed.teamId, "lead");

    const res = await updateMemberRole(db(), seed.teamId, leadId, "member");
    expect(res).toMatchObject({ updated: true, role: "member" });
    expect(await roleOf(leadId)).toBe("member");
  });

  it("refuses to demote the LAST active admin (no lockout)", async () => {
    const seed = await seedTeam();
    await updateMemberRole(db(), seed.teamId, seed.memberId, "admin"); // promotion: 1 audit row

    const res = await updateMemberRole(db(), seed.teamId, seed.memberId, "member");
    expect(res).toMatchObject({ updated: false, reason: "last-admin" });
    expect(await roleOf(seed.memberId)).toBe("admin"); // unchanged

    // Still just the one promotion row — the refused demotion wrote nothing.
    const audits = await auditRows(seed.teamId, seed.memberId);
    expect(audits).toHaveLength(1);
    expect(audits[0].meta).toMatchObject({ from: "member", to: "admin" });
  });

  it("allows demoting an admin when a second active admin exists", async () => {
    const seed = await seedTeam();
    await updateMemberRole(db(), seed.teamId, seed.memberId, "admin");
    const secondAdminId = await addMember(seed.teamId, "admin");

    const res = await updateMemberRole(db(), seed.teamId, seed.memberId, "member");
    expect(res).toMatchObject({ updated: true, role: "member" });
    expect(await roleOf(seed.memberId)).toBe("member");
    expect(await roleOf(secondAdminId)).toBe("admin"); // untouched
  });

  it("does not count a disabled admin against the last-admin guard", async () => {
    const seed = await seedTeam();
    await updateMemberRole(db(), seed.teamId, seed.memberId, "admin");
    await addMember(seed.teamId, "admin", "disabled"); // can't administer — shouldn't "cover" the demotion

    const res = await updateMemberRole(db(), seed.teamId, seed.memberId, "member");
    expect(res).toMatchObject({ updated: false, reason: "last-admin" });
  });

  it("is a no-op (not an error) when the role is already the requested one", async () => {
    const seed = await seedTeam();
    const res = await updateMemberRole(db(), seed.teamId, seed.memberId, "member");
    expect(res).toMatchObject({ updated: false, reason: "unchanged" });
  });

  it("returns 'absent' for an unknown member id (never throws)", async () => {
    const seed = await seedTeam();
    const res = await updateMemberRole(db(), seed.teamId, randomUUID(), "admin");
    expect(res).toMatchObject({ updated: false, reason: "absent" });
  });
});
