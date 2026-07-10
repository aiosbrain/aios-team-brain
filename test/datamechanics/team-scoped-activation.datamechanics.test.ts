import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  activateInvitedMembership,
  adminSetPassword,
  issueMagicToken,
  loginWithPassword,
  redeemMagicToken,
} from "@/lib/auth/pg-login";
import { db, seedTeam, type Seed } from "./helpers";

// Spec (audit fix #1): activation is TEAM-SCOPED. One email can be a member of several teams in
// the same DB; signing in with team context (a magic link minted for /t/<team>) must activate
// ONLY that team's invited row, and a context-free password login must activate none — the other
// teams' rows flip to active on the member's own first visit (activateInvitedMembership, called
// by the team layout). Identity linking (auth_user_id) is per-email and applies to every row.

async function inviteTo(seed: Seed, email: string): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email,
      display_name: "Two Teams",
      actor_handle: `dual-${randomUUID().slice(0, 8)}`,
      role: "member",
      tier: "team",
      status: "invited",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`invite seed failed: ${error?.message}`);
  return data.id;
}

async function memberState(id: string): Promise<{ status: string; auth_user_id: string | null }> {
  const { data } = await db()
    .from("members")
    .select("status, auth_user_id")
    .eq("id", id)
    .maybeSingle();
  return data as { status: string; auth_user_id: string | null };
}

describe("team-scoped activation (real Postgres)", () => {
  it("redeeming a magic link for team A activates A only — team B stays invited (but linked)", async () => {
    const teamA = await seedTeam();
    const teamB = await seedTeam();
    const email = `dual-${randomUUID().slice(0, 8)}@test.local`;
    const idA = await inviteTo(teamA, email);
    const idB = await inviteTo(teamB, email);

    const raw = await issueMagicToken(email, `/t/${teamA.teamSlug}`);
    expect(raw).toBeTruthy();
    const redeemed = await redeemMagicToken(raw!);
    expect(redeemed).toBeTruthy();
    expect(redeemed!.firstLogin).toBe(true);

    const a = await memberState(idA);
    const b = await memberState(idB);
    expect(a.status).toBe("active");
    expect(a.auth_user_id).toBe(redeemed!.user.id);
    expect(b.status).toBe("invited"); // the isolation invariant under test
    expect(b.auth_user_id).toBe(redeemed!.user.id); // identity linking is per-email
  });

  it("a password login (no team context) links identity but activates nothing", async () => {
    const teamA = await seedTeam();
    const teamB = await seedTeam();
    const email = `pw-${randomUUID().slice(0, 8)}@test.local`;
    const idA = await inviteTo(teamA, email);
    const idB = await inviteTo(teamB, email);

    await adminSetPassword(email, "a-strong-enough-password");
    const login = await loginWithPassword(email, "a-strong-enough-password");
    expect(login).toBeTruthy();
    expect(login!.firstLogin).toBe(true);

    for (const id of [idA, idB]) {
      const row = await memberState(id);
      expect(row.status).toBe("invited");
      expect(row.auth_user_id).toBe(login!.user.id);
    }

    // First visit to team B activates B only (the layout's deferred half).
    await activateInvitedMembership(teamB.teamId, login!.user.id);
    expect((await memberState(idB)).status).toBe("active");
    expect((await memberState(idA)).status).toBe("invited");
  });

  it("activateInvitedMembership only touches the caller's own membership", async () => {
    const team = await seedTeam();
    const emailMine = `mine-${randomUUID().slice(0, 8)}@test.local`;
    const emailOther = `other-${randomUUID().slice(0, 8)}@test.local`;
    const idMine = await inviteTo(team, emailMine);
    const idOther = await inviteTo(team, emailOther);

    await adminSetPassword(emailMine, "a-strong-enough-password");
    const login = await loginWithPassword(emailMine, "a-strong-enough-password");
    await activateInvitedMembership(team.teamId, login!.user.id);

    expect((await memberState(idMine)).status).toBe("active");
    expect((await memberState(idOther)).status).toBe("invited");
  });
});
