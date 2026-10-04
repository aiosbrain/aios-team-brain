import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminSetPassword, issueMagicToken } from "@/lib/auth/pg-login";
import { runSql } from "@/lib/db/pg/pool";
import { BASE_URL, db, issueKeyFor, keyHeaders, seedMemberEmail, seedTeam } from "./http-helpers";

// HTTP auth edges that the in-process tier can't reach: cookie-setting routes need a
// real Set-Cookie response, and /api/v1/me round-trips Bearer + X-AIOS-Team headers.
//
// Two sign-in paths: email+password (POST /api/auth/login) is the DEFAULT, always available.
// The magic-link request+confirm pair is an OPTIONAL secondary path, surfaced by the login form
// only when a domain + mail provider are configured — but the route itself stays reachable
// regardless (see request-magic-link/route.ts), so it's tested here unconditionally too.

describe("POST /api/auth/login (HTTP)", () => {
  it("rejects an unknown email with a uniform 401 (not enumerable)", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `nobody-${randomUUID().slice(0, 8)}@nope.test`,
        password: "whatever-password",
      }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rejects a recognized email with the wrong password — same 401 shape as an unknown email", async () => {
    const seed = await seedTeam();
    const { email } = await seedMemberEmail(seed);

    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "not-the-real-password" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_credentials");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // AIO-1208 AC-11: existing normative behaviour (lib/auth/pg-login emailHasMember) at the wire.
  // The email is unique to this test, so its ONLY membership is the row below — no other fixture
  // row can make the premise false. adminSetPassword stores the credential whatever the member's
  // status (it returns nothing to assert), so a 401 alone would not show the password was ever
  // usable. The control is the SAME email + password — set once, never reset — admitted as soon as
  // that same row is active again: the only thing that differs between 401 and 200 is its status.
  it("rejects the CORRECT password when every membership of the email is disabled: 401, no session — and admits the same password once that row is reactivated", async () => {
    const seed = await seedTeam();
    const email = `all-disabled-${randomUUID()}@test.local`;
    const password = `correct-password-${randomUUID().slice(0, 12)}`;
    const { data: created, error: createError } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email,
        display_name: "Disabled Member",
        actor_handle: `disabled-${randomUUID().slice(0, 8)}`,
        role: "admin",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    if (createError || !created) throw new Error(`sole member seed failed: ${createError?.message}`);
    const memberId = (created as { id: string }).id;

    const login = () =>
      fetch(`${BASE_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
    const memberships = async () =>
      (await db().from("members").select("id, status, auth_user_id").eq("email", email)).data;
    const storedHashes = async () =>
      (await runSql<{ password_hash: string | null }>(`select password_hash from auth_users where email = $1`, [email]))
        .rows.map((row) => row.password_hash);
    const setStatus = async (status: "disabled" | "active") => {
      const updated = await db().from("members").update({ status }).eq("id", memberId).eq("team_id", seed.teamId);
      expect(updated.error).toBeNull();
    };

    await adminSetPassword(email, password);
    // Compared as booleans throughout, so a failure never prints the hash.
    const hashes = await storedHashes();
    expect(hashes.length === 1 && typeof hashes[0] === "string" && hashes[0].length > 0).toBe(true);

    await setStatus("disabled");
    expect(await memberships()).toEqual([{ id: memberId, status: "disabled", auth_user_id: null }]);

    const refused = await login();
    expect(refused.status).toBe(401);
    expect((await refused.json()).error).toBe("invalid_credentials");
    expect(refused.headers.get("set-cookie")).toBeNull();

    // Refusal linked nothing: the disabled row stays disabled and unbound.
    expect(await memberships()).toEqual([{ id: memberId, status: "disabled", auth_user_id: null }]);

    // Admitted control: reactivate the SAME row. The credential is untouched in between.
    await setStatus("active");
    expect(await memberships()).toEqual([{ id: memberId, status: "active", auth_user_id: null }]);
    const unchanged = await storedHashes();
    expect(unchanged.length === 1 && unchanged[0] === hashes[0]).toBe(true);

    const admitted = await login();
    expect(admitted.status).toBe(200);
    expect((await admitted.json()).ok).toBe(true);
    expect(admitted.headers.get("set-cookie") ?? "").toContain("aios_session");

    // Admission is what links identity, so the null above was the refusal's doing, not a fixture default.
    expect(await memberships()).toEqual([{ id: memberId, status: "active", auth_user_id: expect.any(String) }]);
  });

  it("signs in a known member with the correct password: 200 + a session cookie", async () => {
    const seed = await seedTeam();
    const { email, password } = await seedMemberEmail(seed);

    const res = await fetch(`${BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(res.headers.get("set-cookie") ?? "").toContain("aios_session");
  });
});

describe("POST /api/auth/request-magic-link (HTTP)", () => {
  it("accepts an unknown email with the same 200 shape and never sets a cookie", async () => {
    const res = await fetch(`${BASE_URL}/api/auth/request-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `nobody-${randomUUID().slice(0, 8)}@nope.test` }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("accepts a known member's email with 200 but never sets a session cookie itself", async () => {
    const seed = await seedTeam();
    const { email } = await seedMemberEmail(seed);

    const res = await fetch(`${BASE_URL}/api/auth/request-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    // The link still has to be clicked (GET /auth/confirm) before any session exists.
    expect(res.headers.get("set-cookie")).toBeNull();

    // The token is issued in the route's after() job, which runs post-response on the real server.
    // Poll the shared test DB so we actually exercise that deferred path end-to-end (not just a
    // mocked after()) and confirm a single-use token row appears for the recognized member.
    const issued = await pollForAuthToken(email);
    expect(issued).toBe(true);
  });

  it("does NOT issue a token for an unknown email (after-job stops at the member lookup)", async () => {
    const email = `nobody-${randomUUID().slice(0, 8)}@nope.test`;
    const res = await fetch(`${BASE_URL}/api/auth/request-magic-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    // Give the after() job the same window the positive test polls, then assert nothing was minted.
    const issued = await pollForAuthToken(email);
    expect(issued).toBe(false);
  });
});

/** Poll the shared test DB for a magic-link token row for `email` (issued by the route's after-job). */
async function pollForAuthToken(email: string, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await db().from("auth_tokens").select("token_hash").eq("email", email);
    if (data && data.length > 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("GET /auth/confirm (HTTP) — full magic-link round trip", () => {
  it("redeems a token minted for a known member, sets the session cookie, and routes a first login through /auth/welcome", async () => {
    const seed = await seedTeam();
    const { email } = await seedMemberEmail(seed);
    // seedMemberEmail creates the member pre-activated (status: "active"), so this is
    // a repeat-login redemption — mint the token the same way the real request route
    // does, bypassing the outbound email (which isn't observable over HTTP here).
    const raw = await issueMagicToken(email, `/t/${seed.teamSlug}`);
    expect(raw).not.toBeNull();

    const res = await fetch(`${BASE_URL}/auth/confirm?token=${raw}`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie") ?? "").toContain("aios_session");
    expect(res.headers.get("location")).toContain(`/t/${seed.teamSlug}`);
  });

  it("routes an actual first login (invited member) through /auth/welcome, not straight to the team", async () => {
    const seed = await seedTeam();
    const email = `first-login-${randomUUID()}@test.local`;
    await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email,
        display_name: "First Login",
        actor_handle: `first-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "invited",
      });

    const raw = await issueMagicToken(email, `/t/${seed.teamSlug}`, 1440);
    const res = await fetch(`${BASE_URL}/auth/confirm?token=${raw}`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("set-cookie") ?? "").toContain("aios_session");
    expect(res.headers.get("location")).toContain("/auth/welcome");
  });

  it("rejects an invalid token", async () => {
    const res = await fetch(`${BASE_URL}/auth/confirm?token=not-a-real-token`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=invalid_link");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // AIO-1208 AC-11: the token is single-use and time-bound AT THE WIRE — a second redemption and
  // an expired token both end at the login error with no session cookie.
  it("sets no session cookie when a redeemed token is replayed", async () => {
    const seed = await seedTeam();
    const { email } = await seedMemberEmail(seed);
    const raw = await issueMagicToken(email, `/t/${seed.teamSlug}`);
    expect(raw).not.toBeNull();

    const first = await fetch(`${BASE_URL}/auth/confirm?token=${raw}`, { redirect: "manual" });
    expect(first.status).toBe(307);
    expect(first.headers.get("set-cookie") ?? "").toContain("aios_session");

    const replay = await fetch(`${BASE_URL}/auth/confirm?token=${raw}`, { redirect: "manual" });
    expect(replay.status).toBe(307);
    expect(replay.headers.get("location")).toContain("/login?error=invalid_link");
    expect(replay.headers.get("set-cookie")).toBeNull();
  });

  it("sets no session cookie for an expired token, and never consumes it", async () => {
    const seed = await seedTeam();
    const { email } = await seedMemberEmail(seed);
    const raw = await issueMagicToken(email, `/t/${seed.teamSlug}`);
    expect(raw).not.toBeNull();
    const expired = await db()
      .from("auth_tokens")
      .update({ expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("email", email);
    expect(expired.error).toBeNull();

    const res = await fetch(`${BASE_URL}/auth/confirm?token=${raw}`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?error=invalid_link");
    expect(res.headers.get("set-cookie")).toBeNull();
    // Opportunistic cleanup may already have swept the expired row; what must never exist is a
    // redemption of it.
    const { data } = await db().from("auth_tokens").select("used_at").eq("email", email);
    expect(((data ?? []) as { used_at: string | null }[]).filter((row) => row.used_at !== null)).toEqual([]);
  });
});

describe("GET /api/v1/me (HTTP)", () => {
  it("returns the caller's role/tier for a valid API key", async () => {
    const seed = await seedTeam();
    const { key } = await issueKeyFor(seed, "team");

    const res = await fetch(`${BASE_URL}/api/v1/me`, { headers: keyHeaders(key, seed.teamSlug) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ role: "member", tier: "team", team: seed.teamId });
    expect(typeof body.actor).toBe("string");
  });

  it("rejects an invalid API key with 401", async () => {
    const seed = await seedTeam();
    const res = await fetch(`${BASE_URL}/api/v1/me`, {
      headers: keyHeaders("aios_deadbeef_notarealsecret", seed.teamSlug),
    });
    expect(res.status).toBe(401);
  });
});
