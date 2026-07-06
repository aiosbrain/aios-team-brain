import { describe, expect, it } from "vitest";
import { adminSetPassword, changePassword, ensureAuthUser, loginWithPassword } from "@/lib/auth/pg-login";
import { db, seedTeam } from "./helpers";

/**
 * Spec (audit M1/M2b): a signed-in user can change their own password, and doing so requires the
 * CURRENT password (never just the target auth_user_id) — so a leaked/forged session id alone can't
 * take over an account's credential. Verified to the observable outcome: the OLD password stops
 * working and the NEW one works, on real Postgres.
 */

describe("changePassword (real Postgres, self-service)", () => {
  it("changes the password when the current one is correct, and the old one stops working", async () => {
    const seed = await seedTeam();
    const email = "changer@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Changer",
      actor_handle: "changer", role: "member", tier: "team", status: "active",
    });
    await adminSetPassword(email, "old-password-123");
    const authUserId = await ensureAuthUser(email);

    const changed = await changePassword(authUserId, "old-password-123", "new-password-456");
    expect(changed).toBe(true);

    expect(await loginWithPassword(email, "old-password-123")).toBeNull();
    const user = await loginWithPassword(email, "new-password-456");
    expect(user).not.toBeNull();
    expect(user!.email).toBe(email);
  });

  it("refuses to change the password when the current one is wrong, and leaves it unchanged", async () => {
    const seed = await seedTeam();
    const email = "protected@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Protected",
      actor_handle: "protected", role: "member", tier: "team", status: "active",
    });
    await adminSetPassword(email, "real-password-789");
    const authUserId = await ensureAuthUser(email);

    const changed = await changePassword(authUserId, "wrong-current-password", "attacker-password");
    expect(changed).toBe(false);

    // The real password still works; the attacker's target password does not.
    expect(await loginWithPassword(email, "real-password-789")).not.toBeNull();
    expect(await loginWithPassword(email, "attacker-password")).toBeNull();
  });
});

describe("adminSetPassword (real Postgres, admin reset)", () => {
  it("sets a password with no prior password required, replacing any existing one", async () => {
    const seed = await seedTeam();
    const email = "reset-me@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Reset Me",
      actor_handle: "reset-me", role: "member", tier: "team", status: "active",
    });
    await adminSetPassword(email, "first-password");
    expect(await loginWithPassword(email, "first-password")).not.toBeNull();

    await adminSetPassword(email, "admin-reset-password");
    expect(await loginWithPassword(email, "first-password")).toBeNull();
    expect(await loginWithPassword(email, "admin-reset-password")).not.toBeNull();
  });
});
