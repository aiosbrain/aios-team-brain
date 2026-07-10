import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueApiKey, revokeOwnApiKey } from "@/lib/admin/keys";
import { db, seedTeam } from "./helpers";

// Spec: self-serve key management closes the invite/key gap by letting a member issue their
// own key instead of an admin generating a secret and relaying it out-of-band. The security
// invariant is revokeOwnApiKey — a member must NEVER be able to revoke a teammate's key, even
// by guessing/enumerating another key's row id. Verified on real Postgres.

describe("revokeOwnApiKey (real Postgres)", () => {
  it("revokes a key the member actually owns", async () => {
    const seed = await seedTeam();
    const { keyId: apiKeyRowId } = await issueOwnRow(seed.teamId, seed.memberId);

    const { revoked } = await revokeOwnApiKey(db(), seed.teamId, seed.memberId, apiKeyRowId);
    expect(revoked).toBe(true);

    const { data: row } = await db().from("api_keys").select("revoked_at").eq("id", apiKeyRowId).single();
    expect((row as { revoked_at: string | null }).revoked_at).not.toBeNull();
  });

  it("refuses to revoke a teammate's key — the core trust boundary", async () => {
    const seed = await seedTeam();
    // A second member on the SAME team, with their own key.
    const { data: other } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Other",
        actor_handle: `actor-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    const otherMemberId = (other as { id: string }).id;
    const { keyId: otherKeyRowId } = await issueOwnRow(seed.teamId, otherMemberId);

    // seed.memberId (NOT the owner) tries to revoke it.
    const { revoked } = await revokeOwnApiKey(db(), seed.teamId, seed.memberId, otherKeyRowId);
    expect(revoked).toBe(false);

    const { data: row } = await db().from("api_keys").select("revoked_at").eq("id", otherKeyRowId).single();
    expect((row as { revoked_at: string | null }).revoked_at).toBeNull(); // untouched
  });

  it("refuses a key id from a different team entirely", async () => {
    const seedA = await seedTeam();
    const seedB = await seedTeam();
    const { keyId: keyInTeamA } = await issueOwnRow(seedA.teamId, seedA.memberId);

    // A member of team B tries to revoke a key that belongs to team A.
    const { revoked } = await revokeOwnApiKey(db(), seedB.teamId, seedB.memberId, keyInTeamA);
    expect(revoked).toBe(false);
  });

  it("no-ops (does not throw) on a nonexistent key id", async () => {
    const seed = await seedTeam();
    await expect(
      revokeOwnApiKey(db(), seed.teamId, seed.memberId, randomUUID())
    ).resolves.toEqual({ revoked: false });
  });

  it("no-ops on an already-revoked key it owns — does not re-revoke or duplicate the audit entry", async () => {
    const seed = await seedTeam();
    const { keyId: apiKeyRowId } = await issueOwnRow(seed.teamId, seed.memberId);
    const first = await revokeOwnApiKey(db(), seed.teamId, seed.memberId, apiKeyRowId);
    expect(first).toEqual({ revoked: true });

    const second = await revokeOwnApiKey(db(), seed.teamId, seed.memberId, apiKeyRowId);
    expect(second).toEqual({ revoked: false }); // already revoked — not re-revoked

    const { data: entries } = await db()
      .from("audit_log")
      .select("id")
      .eq("target_id", apiKeyRowId)
      .eq("action", "api_key.revoked");
    expect(entries).toHaveLength(1); // exactly one revoke event, not two
  });
});

/** Issue a key for a member and resolve the api_keys row id (not the key_id column). */
async function issueOwnRow(teamId: string, memberId: string): Promise<{ keyId: string }> {
  await issueApiKey(db(), teamId, memberId, "test key");
  const { data } = await db()
    .from("api_keys")
    .select("id")
    .eq("team_id", teamId)
    .eq("member_id", memberId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  return { keyId: (data as { id: string }).id };
}
