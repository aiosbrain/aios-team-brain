import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { BASE_URL, issueKeyFor, keyHeaders, seedMemberEmail, seedTeam } from "./http-helpers";

// HTTP auth edges that the in-process tier can't reach: the login route sets a
// real Set-Cookie session, and /api/v1/me round-trips Bearer + X-AIOS-Team headers.

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
