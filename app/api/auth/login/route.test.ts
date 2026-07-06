import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "./route";

// Spec: this route is now a DEV-ONLY convenience (direct-by-email, no ownership proof) —
// the real sign-in path is POST /api/auth/request-magic-link. It must 404 in production
// unless explicitly re-enabled via ALLOW_DEV_LOGIN=1, mirroring app/auth/dev-login exactly.
// Both cases short-circuit before any DB call (gate closes first; an empty body fails zod
// validation next), so this stays in the unit tier — no Postgres needed.

afterEach(() => {
  vi.unstubAllEnvs();
});

function postReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/login — dev-only gate", () => {
  it("404s in production when ALLOW_DEV_LOGIN is unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEV_LOGIN", "");

    const res = await POST(postReq({ email: "someone@test.local" }));
    expect(res.status).toBe(404);
  });

  it("does not gate in development, regardless of ALLOW_DEV_LOGIN", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_DEV_LOGIN", "");

    const res = await POST(postReq({})); // invalid body -> proves we got PAST the gate
    expect(res.status).toBe(422);
  });

  it("does not gate in production when ALLOW_DEV_LOGIN=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_DEV_LOGIN", "1");

    const res = await POST(postReq({})); // invalid body -> proves we got PAST the gate
    expect(res.status).toBe(422);
  });
});
