import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// Spec: dev-login is a bypass-auth footgun — mint a session for ANY email with no credential
// check. It must be unconditionally unreachable in production; the guard is checked FIRST, before
// any DB/session work, so this is testable purely (no DB mocking needed — the 404 return happens
// before ensureAuthUser/linkMemberByEmail/signSession are ever called).
const { GET } = await import("@/app/auth/dev-login/route");

function request(url: string): NextRequest {
  return new Request(url) as unknown as NextRequest;
}

describe("GET /auth/dev-login — hard prod guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 404 unconditionally in production, with no escape hatch", async () => {
    vi.stubEnv("NODE_ENV", "production");
    // Previously ALLOW_DEV_LOGIN=1 re-enabled this in prod — must no longer have any effect.
    vi.stubEnv("ALLOW_DEV_LOGIN", "1");

    const res = await GET(request("http://test.local/auth/dev-login?email=alex@demo.aios.local"));
    expect(res.status).toBe(404);
  });

  it("stays reachable outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");

    // Non-production: the route proceeds past the guard into ensureAuthUser/DB work, which throws
    // in this unit context (no DATABASE_URL) — proving the guard did NOT short-circuit here. The
    // guard's job is only to block production; DB behavior is out of scope for this unit test.
    await expect(
      GET(request("http://test.local/auth/dev-login?email=alex@demo.aios.local"))
    ).rejects.toThrow();
  });
});
