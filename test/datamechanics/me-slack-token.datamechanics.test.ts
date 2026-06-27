import { describe, expect, it, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as tokenGET, POST as tokenPOST, DELETE as tokenDELETE } from "@/app/api/v1/me/slack-token/route";
import { issueApiKey } from "@/lib/admin/keys";
import { setMemberSecret, getMemberSecret } from "@/lib/member-secrets/manage";
import { db, seedTeam, type Seed } from "./helpers";

// The personal Slack token endpoint is owner-only BY CONSTRUCTION (member id from the API key,
// never a parameter). This pins that property + storage round-trip against real Postgres:
//   - the owner's key returns the owner's token (decrypted), connected:true
//   - a DIFFERENT member's key returns 404 not_connected (can never read someone else's token)
//   - the stored ciphertext is opaque (plaintext absent)
//   - POST validates xoxp- prefix + auth.test before storing
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

function req(route: (r: NextRequest) => Promise<Response>, key: string, teamSlug: string, init: RequestInit = {}) {
  const r = new Request(URL, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      "X-AIOS-Team": teamSlug,
      ...(init.headers as Record<string, string> | undefined),
    },
  }) as unknown as NextRequest;
  return route(r);
}

function mockSlackAuthTest(ok: boolean, userId = "U0TEST") {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("slack.com/api/auth.test")) {
      return new Response(
        JSON.stringify(
          ok
            ? { ok: true, user_id: userId, user: "tester", team: "Acme", team_id: "T0TEST" }
            : { ok: false, error: "invalid_auth" }
        ),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response("unexpected fetch in test", { status: 500 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET/POST/DELETE /api/v1/me/slack-token (owner-only, real Postgres)", () => {
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

    const ok = await req(tokenGET, owner.key, seed.teamSlug);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { connected: boolean; token: string; slack_user_id: string };
    expect(body.connected).toBe(true);
    expect(body.token).toBe(xoxp);
    expect(body.slack_user_id).toBe("U0OWNER");

    const denied = await req(tokenGET, other.key, seed.teamSlug);
    expect(denied.status).toBe(404); // other member has no token → never sees the owner's
  });

  it("POST rejects non-xoxp tokens and stores after auth.test", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const badPrefix = await req(tokenPOST, owner.key, seed.teamSlug, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "xoxb-bot-token" }),
    });
    expect(badPrefix.status).toBe(400);

    const fetchSpy = mockSlackAuthTest(false);
    const rejected = await req(tokenPOST, owner.key, seed.teamSlug, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "xoxp-invalid" }),
    });
    expect(rejected.status).toBe(422);
    fetchSpy.mockRestore();

    const xoxp = `xoxp-${randomUUID()}`;
    mockSlackAuthTest(true, "U0POST");
    const ok = await req(tokenPOST, owner.key, seed.teamSlug, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: xoxp }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok: boolean; slack_user_id: string };
    expect(body.ok).toBe(true);
    expect(body.slack_user_id).toBe("U0POST");

    const stored = await getMemberSecret(db(), seed.teamId, owner.memberId, "slack");
    expect(stored?.secret).toBe(xoxp);
    expect(stored?.meta.slack_user_id).toBe("U0POST");
  });

  it("DELETE disconnects", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    await setMemberSecret(db(), { teamId: seed.teamId, memberId: owner.memberId }, "slack", `xoxp-${randomUUID()}`, {});

    const del = await req(tokenDELETE, owner.key, seed.teamSlug, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await getMemberSecret(db(), seed.teamId, owner.memberId, "slack")).toBeNull();
  });
});
