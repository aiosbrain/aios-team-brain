import { describe, expect, it } from "vitest";
import { createMember, rollbackMemberCreation, MemberExistsError } from "@/lib/admin/members";
import { db, seedTeam } from "./helpers";

// Spec: inviteMember's manual-password branch calls createMember then adminSetPassword; the two
// can't share a SQL transaction (different write paths — see rollbackMemberCreation's docblock).
// If adminSetPassword fails after createMember succeeded, the caller must compensate with
// rollbackMemberCreation so no orphaned 'invited' member (with no password, unable to ever sign
// in) is left behind. This exercises exactly that compensating action against real Postgres —
// the same primitive inviteMember calls on an adminSetPassword failure — and asserts the
// observable outcome: the member row is gone and the rollback is audited.
describe("rollbackMemberCreation (real Postgres) — invite compensating delete", () => {
  it("leaves no orphaned member row after a simulated adminSetPassword failure", async () => {
    const seed = await seedTeam();
    const created = await createMember(db(), seed.teamId, {
      email: "orphan-risk@test.local",
      displayName: "Orphan Risk",
      actorHandle: "orphanrisk",
      role: "member",
    });
    expect(created.status).toBe("invited");

    // Simulate: adminSetPassword threw after createMember succeeded — the caller (inviteMember)
    // reacts by rolling back instead of leaving the member row in place.
    await rollbackMemberCreation(db(), seed.teamId, created.id, {
      actor: { kind: "member", memberId: seed.memberId },
    });

    const { data: after } = await db().from("members").select("id").eq("id", created.id).maybeSingle();
    expect(after).toBeNull(); // no orphan left behind

    const { data: audits } = await db()
      .from("audit_log")
      .select("action, target_id, meta")
      .eq("team_id", seed.teamId)
      .eq("target_id", created.id)
      .eq("action", "member.deleted");
    const rollbackAudit = (audits ?? [])[0] as { action: string; meta: { reason?: string } } | undefined;
    expect(rollbackAudit).toBeTruthy();
    expect(rollbackAudit!.meta.reason).toBe("invite-rollback");
  });

  it("a rolled-back email can be re-invited afterward (no lingering unique-constraint conflict)", async () => {
    const seed = await seedTeam();
    const created = await createMember(db(), seed.teamId, {
      email: "retry-me@test.local",
      displayName: "Retry Me",
      actorHandle: "retryme",
      role: "member",
    });
    await rollbackMemberCreation(db(), seed.teamId, created.id);

    const retried = await createMember(db(), seed.teamId, {
      email: "retry-me@test.local",
      displayName: "Retry Me",
      actorHandle: "retryme",
      role: "member",
    });
    expect(retried.status).toBe("invited");
    expect(retried.id).not.toBe(created.id);
  });
});

// Spec (fix E): createMember must turn a raw pg unique-constraint violation into a dedicated,
// friendly MemberExistsError — not the raw "create member failed: duplicate key..." pg text —
// for both the team+email and team+actor_handle constraints.
describe("createMember duplicate detection (real Postgres)", () => {
  it("throws MemberExistsError on a duplicate email within the same team", async () => {
    const seed = await seedTeam();
    await createMember(db(), seed.teamId, {
      email: "dupe@test.local",
      displayName: "First",
      actorHandle: "first-handle",
      role: "member",
    });

    await expect(
      createMember(db(), seed.teamId, {
        email: "dupe@test.local",
        displayName: "Second",
        actorHandle: "second-handle",
        role: "member",
      })
    ).rejects.toBeInstanceOf(MemberExistsError);
  });

  it("throws MemberExistsError on a duplicate actor handle within the same team", async () => {
    const seed = await seedTeam();
    await createMember(db(), seed.teamId, {
      email: "handle-a@test.local",
      displayName: "First",
      actorHandle: "shared-handle",
      role: "member",
    });

    await expect(
      createMember(db(), seed.teamId, {
        email: "handle-b@test.local",
        displayName: "Second",
        actorHandle: "shared-handle",
        role: "member",
      })
    ).rejects.toBeInstanceOf(MemberExistsError);
  });

  it("the same email is fine on a DIFFERENT team (team-scoped uniqueness)", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    await createMember(db(), seedA.teamId, {
      email: "cross-team@test.local",
      displayName: "A",
      actorHandle: "cross-a",
      role: "member",
    });

    const onB = await createMember(db(), seedB.teamId, {
      email: "cross-team@test.local",
      displayName: "B",
      actorHandle: "cross-b",
      role: "member",
    });
    expect(onB.status).toBe("invited");
  });
});
