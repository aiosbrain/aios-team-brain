import { describe, expect, it } from "vitest";
import { adminSetPassword, ensureAuthUser, hasPasswordSet, loginWithPassword, setPasswordIfUnset } from "@/lib/auth/pg-login";
import { db, seedTeam } from "./helpers";

/**
 * Spec: a magic-link-only account (no password yet) can set one exactly once — this is a
 * first-time SET, not a reset, so once a password exists, a second call must be a no-op rather
 * than silently overwriting it (that's `changePassword`'s job, and it requires the current
 * password). Verified to the observable outcome on real Postgres: password_hash state and whether
 * login with the attempted password actually works.
 */

describe("setPasswordIfUnset / hasPasswordSet (real Postgres)", () => {
  it("sets a password for an account with none yet, and hasPasswordSet reflects it", async () => {
    const seed = await seedTeam();
    const email = "magiconly@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Magic Only",
      actor_handle: "magiconly", role: "member", tier: "team", status: "invited",
    });
    const authUserId = await ensureAuthUser(email);
    expect(await hasPasswordSet(authUserId)).toBe(false);

    const set = await setPasswordIfUnset(authUserId, "first-time-password");
    expect(set).toBe(true);
    expect(await hasPasswordSet(authUserId)).toBe(true);
    expect(await loginWithPassword(email, "first-time-password")).not.toBeNull();
  });

  it("is a no-op once a password already exists — does not overwrite it", async () => {
    const seed = await seedTeam();
    const email = "already-has-one@test.local";
    await db().from("members").insert({
      team_id: seed.teamId, email, display_name: "Already Has One",
      actor_handle: "alreadyhasone", role: "member", tier: "team", status: "active",
    });
    await adminSetPassword(email, "original-password");
    const authUserId = await ensureAuthUser(email);

    const set = await setPasswordIfUnset(authUserId, "attempted-overwrite");
    expect(set).toBe(false);

    // The original password still works; the attempted one does not.
    expect(await loginWithPassword(email, "original-password")).not.toBeNull();
    expect(await loginWithPassword(email, "attempted-overwrite")).toBeNull();
  });
});
