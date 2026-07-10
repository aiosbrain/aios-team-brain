import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { purgeExpiredAuthRows } from "@/lib/auth/cleanup";
import { db, seedTeam } from "./helpers";

// Spec: purgeExpiredAuthRows must delete auth_tokens/oauth_states rows that are done being
// useful — already consumed (used_at set) or expired for 7+ days — and must NOT touch a fresh,
// unused, unexpired row (the "leave a live sign-in link alone" case). Verified to the observable
// outcome: what actually survives in real Postgres after the purge.

function iso(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString();
}

const DAY_MS = 24 * 60 * 60_000;

describe("purgeExpiredAuthRows (real Postgres)", () => {
  it("deletes used and 7+ day expired auth_tokens; leaves a fresh, unused, unexpired token", async () => {
    await seedTeam();

    // Survivor: fresh, unused, still valid (a live magic-link the user hasn't clicked yet).
    await db().from("auth_tokens").insert({
      token_hash: `fresh-${randomUUID()}`,
      email: "fresh@test.local",
      expires_at: iso(15 * 60_000), // 15 min from now
      used_at: null,
    });
    // Purged: consumed, even though not yet expired.
    await db().from("auth_tokens").insert({
      token_hash: `used-${randomUUID()}`,
      email: "used@test.local",
      expires_at: iso(15 * 60_000),
      used_at: new Date().toISOString(),
    });
    // Survivor: expired less than 7 days ago (grace window for ops investigation).
    await db().from("auth_tokens").insert({
      token_hash: `recently-expired-${randomUUID()}`,
      email: "recent@test.local",
      expires_at: iso(-1 * 60_000), // 1 min ago
      used_at: null,
    });
    // Purged: expired well past the 7-day grace window.
    await db().from("auth_tokens").insert({
      token_hash: `stale-${randomUUID()}`,
      email: "stale@test.local",
      expires_at: iso(-8 * DAY_MS),
      used_at: null,
    });

    const result = await purgeExpiredAuthRows();
    expect(result.authTokens).toBe(2);

    const { data: remaining } = await db().from("auth_tokens").select("token_hash");
    const survivorHashes = (remaining ?? []).map((r) => (r as { token_hash: string }).token_hash);
    expect(survivorHashes.some((h) => h.startsWith("fresh-"))).toBe(true);
    expect(survivorHashes.some((h) => h.startsWith("recently-expired-"))).toBe(true);
    expect(survivorHashes.some((h) => h.startsWith("used-"))).toBe(false);
    expect(survivorHashes.some((h) => h.startsWith("stale-"))).toBe(false);
  });

  it("deletes used and 7+ day expired oauth_states; leaves a fresh, unused, unexpired nonce", async () => {
    const seed = await seedTeam();

    await db().from("oauth_states").insert({
      team_id: seed.teamId,
      member_id: seed.memberId,
      provider: "slack",
      expires_at: iso(5 * 60_000),
      used_at: null,
    });
    const { data: used } = await db()
      .from("oauth_states")
      .insert({
        team_id: seed.teamId,
        member_id: seed.memberId,
        provider: "slack",
        expires_at: iso(5 * 60_000),
        used_at: new Date().toISOString(),
      })
      .select("nonce")
      .single();
    const { data: stale } = await db()
      .from("oauth_states")
      .insert({
        team_id: seed.teamId,
        member_id: seed.memberId,
        provider: "slack",
        expires_at: iso(-8 * DAY_MS),
        used_at: null,
      })
      .select("nonce")
      .single();

    const result = await purgeExpiredAuthRows();
    expect(result.oauthStates).toBe(2);

    const { data: remaining } = await db().from("oauth_states").select("nonce, used_at");
    const remainingNonces = new Set((remaining ?? []).map((r) => (r as { nonce: string }).nonce));
    expect(remainingNonces.size).toBe(1); // only the fresh one survives
    expect(remainingNonces.has((used as { nonce: string }).nonce)).toBe(false);
    expect(remainingNonces.has((stale as { nonce: string }).nonce)).toBe(false);
  });
});
