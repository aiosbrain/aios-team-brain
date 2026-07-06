import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMember } from "@/lib/admin/members";
import { issueMagicToken, redeemMagicToken } from "@/lib/auth/pg-login";
import { getWelcomeContext } from "@/lib/auth/welcome-context";
import { db, seedTeam } from "./helpers";

// Spec: a member's first magic-link redemption (activating an invite) reports
// firstLogin=true; a later redemption for the same member reports false. The welcome
// screen's inviter name is derived from the append-only audit_log — no invited_by
// column needed — and degrades to null for members created with no audited actor.
// Verified to the observable outcome against real Postgres.

describe("first-login welcome flow (real Postgres)", () => {
  it("reports firstLogin=true on an invited member's first redemption, false on the next", async () => {
    const seed = await seedTeam();
    const email = `invitee-${randomUUID()}@test.local`;
    await createMember(
      db(),
      seed.teamId,
      { email, displayName: "Nina Invitee", actorHandle: `nina-${randomUUID().slice(0, 8)}`, role: "member" },
      { actor: { kind: "member", memberId: seed.memberId } }
    );

    const firstToken = await issueMagicToken(email, `/t/${seed.teamSlug}`, 1440);
    const firstResult = await redeemMagicToken(firstToken!);
    expect(firstResult).not.toBeNull();
    expect(firstResult!.firstLogin).toBe(true);

    const secondToken = await issueMagicToken(email, `/t/${seed.teamSlug}`, 1440);
    const secondResult = await redeemMagicToken(secondToken!);
    expect(secondResult).not.toBeNull();
    expect(secondResult!.firstLogin).toBe(false);
  });

  it("resolves the inviting admin's display name from the audit log", async () => {
    const seed = await seedTeam();
    const email = `invitee-${randomUUID()}@test.local`;
    await createMember(
      db(),
      seed.teamId,
      { email, displayName: "Nina Invitee", actorHandle: `nina-${randomUUID().slice(0, 8)}`, role: "member" },
      { actor: { kind: "member", memberId: seed.memberId } }
    );

    const ctx = await getWelcomeContext(seed.teamSlug, email);
    expect(ctx).not.toBeNull();
    expect(ctx!.inviteeName).toBe("Nina Invitee");
    expect(ctx!.inviterName).toBe("Tester"); // seedTeam()'s seeded actor's display_name
    expect(ctx!.teamName).toBe("Test Team");
  });

  it("resolves inviterName=null for a member created with no audited actor", async () => {
    const seed = await seedTeam();
    const email = `system-created-${randomUUID()}@test.local`;
    await createMember(db(), seed.teamId, {
      email,
      displayName: "System Made",
      actorHandle: `sysmade-${randomUUID().slice(0, 8)}`,
      role: "member",
    }); // no actor passed -> audit_log.member_id is null for this member.created event

    const ctx = await getWelcomeContext(seed.teamSlug, email);
    expect(ctx).not.toBeNull();
    expect(ctx!.inviterName).toBeNull();
  });

  it("returns null for an email with no member in this team", async () => {
    const seed = await seedTeam();
    expect(await getWelcomeContext(seed.teamSlug, "nobody@nowhere.test")).toBeNull();
  });
});
