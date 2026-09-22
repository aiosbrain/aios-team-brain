import { afterEach, describe, expect, it } from "vitest";
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

const previousSecret = process.env.AUTH_SECRET;
afterEach(() => { process.env.AUTH_SECRET = previousSecret; });

describe("AIO-1167 Google Drive OAuth state", () => {
  it("AC-01: binds team/admin/name and consumes the nonce exactly once", async () => {
    process.env.AUTH_SECRET = "aio-1167-test-secret-at-least-sixteen";
    const fake = new OAuthStateDb();
    const db = fake as unknown as DbClient;
    const state = await createGoogleDriveOAuthState(db, {
      teamId: "team-a", memberId: "admin-a", integrationName: "docs", teamSlug: "alpha",
    });
    await expect(consumeGoogleDriveOAuthState(db, state)).resolves.toEqual({
      teamId: "team-a", memberId: "admin-a", integrationName: "docs", teamSlug: "alpha",
    });
    await expect(consumeGoogleDriveOAuthState(db, state)).resolves.toBeNull();
  });

  it("AC-01: rejects malformed callback state before trusting any callback association", async () => {
    process.env.AUTH_SECRET = "aio-1167-test-secret-at-least-sixteen";
    await expect(consumeGoogleDriveOAuthState({} as DbClient, "not-a-jwt")).resolves.toBeNull();
  });
});
