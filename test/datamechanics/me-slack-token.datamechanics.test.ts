import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as tokenGET, DELETE as tokenDELETE } from "@/app/api/v1/me/slack-token/route";
import { issueApiKey } from "@/lib/admin/keys";
import { setMemberSecret, getMemberSecret } from "@/lib/member-secrets/manage";
import { db, seedTeam, type Seed } from "./helpers";

// The personal Slack token endpoint is owner-only BY CONSTRUCTION (member id from the API key,
// never a parameter). This pins that property + storage round-trip against real Postgres:
//   - the owner's key returns the owner's token (decrypted), connected:true
//   - a DIFFERENT member's key returns 404 not_connected (can never read someone else's token)
//   - the stored ciphertext is opaque (plaintext absent)
//   - DELETE disconnects
const URL = "http://test/api/v1/me/slack-token";

async function memberWithKey(seed: Seed, opts: { distinct?: boolean } = {}) {
  let memberId = seed.memberId;
  if (opts.distinct) {
    const { data } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `m-${randomUUID().slice(0, 8)}@test.local`,
        display_name: "Other",
        actor_handle: `other-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    memberId = (data as { id: string }).id;
  }
  const { key } = await issueApiKey(db(), seed.teamId, memberId, "key");
  return { key, memberId };
}

function get(route: (r: NextRequest) => Promise<Response>, key: string, teamSlug: string, method = "GET") {
  const req = new Request(URL, {
    method,
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": teamSlug },
  }) as unknown as NextRequest;
  return route(req);
}

describe("GET/DELETE /api/v1/me/slack-token (owner-only, real Postgres)", () => {
  it("owner reads their token; another member cannot", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const other = await memberWithKey(seed, { distinct: true });

    const xoxp = `xoxp-${randomUUID()}`;
    await setMemberSecret(db(), { teamId: seed.teamId, memberId: owner.memberId }, "slack", xoxp, {
      slack_user_id: "U0OWNER",
      workspace: "Acme",
    });

    // ciphertext is opaque (plaintext absent)
    const { data: row } = await db()
      .from("member_secrets")
      .select("secret_ciphertext")
      .eq("member_id", owner.memberId)
      .single();
    expect((row as { secret_ciphertext: string }).secret_ciphertext).not.toContain(xoxp);

    const ok = await get(tokenGET, owner.key, seed.teamSlug);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { connected: boolean; token: string; slack_user_id: string };
    expect(body.connected).toBe(true);
    expect(body.token).toBe(xoxp);
    expect(body.slack_user_id).toBe("U0OWNER");

    const denied = await get(tokenGET, other.key, seed.teamSlug);
    expect(denied.status).toBe(404); // other member has no token → never sees the owner's
  });

  it("DELETE disconnects", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    await setMemberSecret(db(), { teamId: seed.teamId, memberId: owner.memberId }, "slack", `xoxp-${randomUUID()}`, {});

    const del = await get(tokenDELETE, owner.key, seed.teamSlug, "DELETE");
    expect(del.status).toBe(200);
    expect(await getMemberSecret(db(), seed.teamId, owner.memberId, "slack")).toBeNull();
  });
});
