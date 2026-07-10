import { describe, expect, it } from "vitest";
import { adminSetPassword, loginWithPassword } from "@/lib/auth/pg-login";
import { db, seedTeam } from "./helpers";

// Spec (audit M1/M2b): email+password login is invite-only AND requires a password an admin has
// actually set. An email with a non-disabled member and the correct password signs in (force-linked
// + activated); anything else — unknown email, disabled member, no password set, wrong password —
// is rejected. Verified to the observable outcome — the members row read back from real Postgres.

describe("loginWithPassword (real Postgres, invite-only, password-gated)", () => {
  it("rejects an email with no member", async () => {
    await seedTeam();
    expect(await loginWithPassword("stranger@nowhere.test", "whatever-password")).toBeNull();
  });

  it("rejects a disabled member even with a correct password", async () => {
    const seed = await seedTeam();
    const email = "gone@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Gone",
      actor_handle: "gone", role: "member", tier: "team", status: "disabled",
    });
    await adminSetPassword(email, "correct-horse-battery");
    expect(await loginWithPassword(email, "correct-horse-battery")).toBeNull();
  });

  it("rejects a recognized member with NO password set yet", async () => {
    const seed = await seedTeam();
    const email = "nopass@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "No Pass",
      actor_handle: "nopass", role: "member", tier: "team", status: "invited",
    });
    expect(await loginWithPassword(email, "anything-at-all")).toBeNull();
  });

  it("rejects the wrong password for a recognized member", async () => {
    const seed = await seedTeam();
    const email = "wrongpass@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Wrong Pass",
      actor_handle: "wrongpass", role: "member", tier: "team", status: "invited",
    });
    await adminSetPassword(email, "the-real-password-123");
    expect(await loginWithPassword(email, "not-the-real-password")).toBeNull();
  });

  it("signs in with the correct password, force-links the auth user, activates invited, and reports firstLogin", async () => {
    const seed = await seedTeam();
    const email = "invitee@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Invitee",
      actor_handle: "invitee", role: "member", tier: "team", status: "invited",
    });
    await adminSetPassword(email, "the-real-password-123");

    const result = await loginWithPassword(email, "the-real-password-123");
    expect(result).not.toBeNull();
    expect(result!.user.email).toBe(email);
    // Was 'invited' before this login — this is the activation, so the caller should route
    // through the one-time welcome screen (audit-adjacent: matches redeemMagicToken's behavior).
    expect(result!.firstLogin).toBe(true);

    // Outcome in the DB: activated + linked to the same auth user the session carries.
    const { data } = await db()
      .from("members")
      .select("auth_user_id, status")
      .eq("email", email)
      .maybeSingle();
    expect(data!.status).toBe("active");
    expect(data!.auth_user_id).toBe(result!.user.id);

    // A second login is NOT a first login — the member is already active.
    const second = await loginWithPassword(email, "the-real-password-123");
    expect(second!.firstLogin).toBe(false);
  });
});
