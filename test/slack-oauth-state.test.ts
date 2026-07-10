import { describe, expect, it, beforeAll } from "vitest";
import { SignJWT } from "jose";
import type { DbClient } from "@/lib/db/types";
import { consumeSlackOAuthState } from "@/lib/auth/slack-oauth-state";

// Pure-logic guard for the state JWT layer (no DB): a forged or tampered `state` must be rejected
// by jwtVerify BEFORE any DB consume — that is the CSRF/forgery property. We pass a Supabase stub
// that throws on any access to prove the rejection paths never reach Postgres.

const SECRET = "test-auth-secret-which-is-long-enough";

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

// Any DB access fails the test → proves these tokens are rejected purely on the JWT.
const noDb = new Proxy({}, {
  get() {
    throw new Error("consumeSlackOAuthState must reject this token before touching the DB");
  },
}) as unknown as DbClient;

function sign(secret: string, claims: Record<string, unknown>, exp = "600s") {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(new TextEncoder().encode(secret));
}

const validClaims = { memberId: "m1", teamId: "t1", nonce: "n1" };

describe("consumeSlackOAuthState — JWT rejection (no DB)", () => {
  it("rejects a null/garbage token", async () => {
    expect(await consumeSlackOAuthState(noDb, null)).toBeNull();
    expect(await consumeSlackOAuthState(noDb, "not-a-jwt")).toBeNull();
  });

  it("rejects a token signed with a different secret (forgery)", async () => {
    const forged = await sign("a-totally-different-secret-key!!", validClaims);
    expect(await consumeSlackOAuthState(noDb, forged)).toBeNull();
  });

  it("rejects a structurally-tampered token", async () => {
    const good = await sign(SECRET, validClaims);
    const tampered = good.slice(0, -3) + (good.endsWith("a") ? "bbb" : "aaa");
    expect(await consumeSlackOAuthState(noDb, tampered)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await sign(SECRET, validClaims, "-1s");
    expect(await consumeSlackOAuthState(noDb, expired)).toBeNull();
  });

  it("rejects a validly-signed token missing required claims", async () => {
    const missing = await sign(SECRET, { memberId: "m1" }); // no teamId/nonce
    expect(await consumeSlackOAuthState(noDb, missing)).toBeNull();
  });
});
