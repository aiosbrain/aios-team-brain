import { afterEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import type { DbClient } from "@/lib/db/types";
import { createGoogleDriveOAuthState, consumeGoogleDriveOAuthState } from "@/lib/auth/gdrive-oauth-state";

class OAuthStateDb {
  row: Record<string, unknown> | null = null;
  updatePayload: Record<string, unknown> | null = null;

  from() { return this; }
  async insert(row: Record<string, unknown>) { this.row = row; return { error: null }; }
  update(row: Record<string, unknown>) { this.updatePayload = row; return this; }
  eq() { return this; }
  is() { return this; }
  gt() { return this; }
  select() { return this; }
  async maybeSingle() {
    if (!this.row || this.row.used_at || !this.updatePayload) return { data: null, error: null };
    this.row.used_at = this.updatePayload.used_at;
    return { data: { team_id: this.row.team_id, member_id: this.row.member_id }, error: null };
  }
}

const SECRET = "aio-1167-test-secret-at-least-sixteen";
const CONTEXT = { teamId: "team-a", memberId: "admin-a", integrationName: "docs", teamSlug: "alpha" };

const previousSecret = process.env.AUTH_SECRET;
afterEach(() => { process.env.AUTH_SECRET = previousSecret; });

describe("AIO-1167 Google Drive OAuth state", () => {
  it("AC-01: binds team/admin/name and consumes the nonce exactly once, from the initiating browser", async () => {
    process.env.AUTH_SECRET = SECRET;
    const fake = new OAuthStateDb();
    const db = fake as unknown as DbClient;
    const state = await createGoogleDriveOAuthState(db, { ...CONTEXT, browserBinding: "browser-a" });
    await expect(consumeGoogleDriveOAuthState(db, state, "browser-a")).resolves.toEqual(CONTEXT);
    await expect(consumeGoogleDriveOAuthState(db, state, "browser-a")).resolves.toBeNull();
  });

  it("AC-01: rejects malformed callback state before trusting any callback association", async () => {
    process.env.AUTH_SECRET = SECRET;
    await expect(consumeGoogleDriveOAuthState({} as DbClient, "not-a-jwt", "browser-a")).resolves.toBeNull();
  });

  it.each([
    ["no binding cookie", undefined],
    ["a null binding", null],
    ["an empty binding", ""],
    ["another browser's binding", "browser-b"],
  ])("AC-01: a state presented with %s is refused WITHOUT consuming its nonce", async (_case, presented) => {
    process.env.AUTH_SECRET = SECRET;
    const fake = new OAuthStateDb();
    const db = fake as unknown as DbClient;
    const state = await createGoogleDriveOAuthState(db, { ...CONTEXT, browserBinding: "browser-a" });

    await expect(consumeGoogleDriveOAuthState(db, state, presented)).resolves.toBeNull();
    // The nonce row was never touched: a leaked state cannot be redeemed elsewhere, nor burned.
    expect(fake.updatePayload).toBeNull();
    expect(fake.row?.used_at).toBeUndefined();
    // The browser that started the connection still redeems it.
    await expect(consumeGoogleDriveOAuthState(db, state, "browser-a")).resolves.toEqual(CONTEXT);
  });

  it("AC-01: the state carries only a hash of the binding, never the binding itself", async () => {
    process.env.AUTH_SECRET = SECRET;
    const binding = "binding-that-must-stay-in-the-cookie";
    const state = await createGoogleDriveOAuthState(new OAuthStateDb() as unknown as DbClient, {
      ...CONTEXT, browserBinding: binding,
    });
    const payload = JSON.parse(Buffer.from(state.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    expect(typeof payload.browser).toBe("string");
    expect(payload.browser).not.toBe(binding);
    expect(JSON.stringify(payload)).not.toContain(binding);
  });

  it("AC-01: refuses to mint a state that no browser is bound to", async () => {
    process.env.AUTH_SECRET = SECRET;
    const fake = new OAuthStateDb();
    await expect(createGoogleDriveOAuthState(fake as unknown as DbClient, { ...CONTEXT, browserBinding: "" }))
      .rejects.toThrow(/browser binding/);
    expect(fake.row).toBeNull();
  });

  it("AC-01: a correctly signed state with no browser claim is never redeemable", async () => {
    process.env.AUTH_SECRET = SECRET;
    const fake = new OAuthStateDb();
    fake.row = { nonce: "unbound-nonce", team_id: CONTEXT.teamId, member_id: CONTEXT.memberId };
    const unbound = await new SignJWT({ ...CONTEXT, nonce: "unbound-nonce" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("600s")
      .sign(new TextEncoder().encode(SECRET));

    await expect(consumeGoogleDriveOAuthState(fake as unknown as DbClient, unbound, "browser-a")).resolves.toBeNull();
    expect(fake.updatePayload).toBeNull();
  });
});
