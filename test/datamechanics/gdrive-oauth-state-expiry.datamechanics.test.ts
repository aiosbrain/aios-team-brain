import { describe, expect, it } from "vitest";

import { consumeGoogleDriveOAuthState, createGoogleDriveOAuthState } from "@/lib/auth/gdrive-oauth-state";
import { getPool } from "@/lib/db/pg/pool";
import { db, seedTeam } from "./helpers";

/**
 * AIO-1167 — the bound OAuth state EXPIRES in the store too (AC-01: expiring, single-use, browser-bound).
 *
 * Spec. A state is redeemable once, from its initiating browser, before it expires. The signed token
 * carries an expiry, and the stored nonce carries its own: a token still within its signature lifetime
 * whose stored nonce has expired is refused, and the refusal consumes nothing. Positive control: the
 * same, unexpired, is redeemed once.
 */
process.env.AUTH_SECRET ??= "aio-1167-dm-test-secret-at-least-sixteen";

async function mint(teamId: string, memberId: string, teamSlug: string) {
  return createGoogleDriveOAuthState(db(), {
    teamId, memberId, integrationName: "docs", teamSlug, mode: "files", browserBinding: "browser-a",
  });
}

async function storedRows(memberId: string) {
  return (await getPool().query<{ used_at: string | null }>(
    "select used_at from oauth_states where member_id=$1 and provider='gdrive'", [memberId])).rows;
}

describe("Drive OAuth state expiry in the store (real Postgres)", () => {
  it("a token whose stored nonce has expired is refused and consumes nothing; an unexpired one redeems once", async () => {
    const seed = await seedTeam();
    const state = await mint(seed.teamId, seed.memberId, seed.teamSlug);
    await getPool().query(
      "update oauth_states set expires_at = now() - interval '1 minute' where member_id=$1 and provider='gdrive'",
      [seed.memberId]);

    await expect(consumeGoogleDriveOAuthState(db(), state, "browser-a")).resolves.toBeNull();
    expect(await storedRows(seed.memberId)).toEqual([{ used_at: null }]);

    // Positive control: a fresh state for the same Admin redeems exactly once.
    const fresh = await mint(seed.teamId, seed.memberId, seed.teamSlug);
    await expect(consumeGoogleDriveOAuthState(db(), fresh, "browser-a")).resolves.toMatchObject({
      teamId: seed.teamId, memberId: seed.memberId, mode: "files",
    });
    await expect(consumeGoogleDriveOAuthState(db(), fresh, "browser-a")).resolves.toBeNull();
  });
});
