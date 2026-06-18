import { describe, expect, it } from "vitest";
import { loginByEmail } from "@/lib/auth/pg-login";
import { db, seedTeam } from "./helpers";

// Spec: direct (passwordless) login is invite-only. An email with a non-disabled member
// signs in (and is force-linked + activated); anything else is rejected. Verified to the
// observable outcome — the members row read back from real Postgres.

describe("loginByEmail (real Postgres, invite-only)", () => {
  it("rejects an email with no member", async () => {
    await seedTeam();
    expect(await loginByEmail("stranger@nowhere.test")).toBeNull();
  });

  it("rejects a disabled member", async () => {
    const seed = await seedTeam();
    const email = "gone@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Gone",
      actor_handle: "gone", role: "member", tier: "team", status: "disabled",
    });
    expect(await loginByEmail(email)).toBeNull();
  });

  it("signs in a recognized member, force-links the auth user, activates invited", async () => {
    const seed = await seedTeam();
    const email = "invitee@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Invitee",
      actor_handle: "invitee", role: "member", tier: "team", status: "invited",
    });

    const user = await loginByEmail(email);
    expect(user).not.toBeNull();
    expect(user!.email).toBe(email);

    // Outcome in the DB: activated + linked to the same auth user the session carries.
    const { data } = await db()
      .from("members")
      .select("auth_user_id, status")
      .eq("email", email)
      .maybeSingle();
    expect(data!.status).toBe("active");
    expect(data!.auth_user_id).toBe(user!.id);
  });
});
