import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { GET as startGET } from "@/app/api/auth/slack/start/route";
import { GET as callbackGET } from "@/app/api/auth/slack/callback/route";
import { GET as statusGET } from "@/app/api/auth/slack/status/route";
import { issueApiKey } from "@/lib/admin/keys";
import { getMemberSecret } from "@/lib/member-secrets/manage";
import { createSlackOAuthState, consumeSlackOAuthState } from "@/lib/auth/slack-oauth-state";
import { db, seedTeam, type Seed } from "./helpers";

// One-click Slack OAuth (start → callback → status), real handlers + real Postgres. Pins the
// contract spec-first (not characterization):
//   - start: member-authed; authorize_url carries the exact user scopes + a state that binds the key's member/team
//   - callback: browser (no key); recovers member ONLY from the signed single-use state, re-validates via auth.test,
//     stores the xoxp token encrypted (member_secrets, acquired_via:"oauth"); HTML never contains the token
//   - single-use nonce: a consumed/expired/bad state stores nothing (replay + code-mixing guard)
//   - status: reports connection WITHOUT the token; config errors fail cleanly

// The data-mechanics config sets DB/SECRETS_KEY but NOT these — helpers/routes read them lazily.
beforeAll(() => {
  process.env.AUTH_SECRET = "test-auth-secret-which-is-long-enough";
  process.env.SLACK_CLIENT_ID = "test-client-id";
  process.env.SLACK_CLIENT_SECRET = "test-client-secret";
  process.env.SLACK_OAUTH_REDIRECT = "http://test/api/auth/slack/callback";
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const START_URL = "http://test/api/auth/slack/start";
const STATUS_URL = "http://test/api/auth/slack/status";
const CALLBACK_URL = "http://test/api/auth/slack/callback";

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

// Authed wrapper for start/status (Bearer key + team header).
function authedReq(route: (r: NextRequest) => Promise<Response>, url: string, key: string, teamSlug: string) {
  const r = new Request(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}`, "X-AIOS-Team": teamSlug },
  }) as unknown as NextRequest;
  return route(r);
}

// Dedicated callback wrapper: browser request, NO auth headers; member comes from `state` alone.
function callbackReq(query: Record<string, string | undefined>) {
  const u = new URL(CALLBACK_URL);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, v);
  const r = new Request(u.toString(), { method: "GET" }) as unknown as NextRequest;
  return callbackGET(r);
}

function jsonResponse(obj: unknown) {
  return new Response(JSON.stringify(obj), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Mock both Slack endpoints the callback hits. `token` is echoed by oauth.v2.access and accepted by auth.test.
function mockSlack(opts: { token?: string; exchangeOk?: boolean; authTestOk?: boolean; userId?: string } = {}) {
  const token = opts.token ?? `xoxp-${randomUUID()}`;
  const userId = opts.userId ?? "U0OAUTH";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("oauth.v2.access")) {
      return jsonResponse(
        opts.exchangeOk === false
          ? { ok: false, error: "invalid_code" }
          : { ok: true, authed_user: { id: userId, access_token: token }, team: { id: "T0TEST", name: "Acme" } }
      );
    }
    if (url.includes("auth.test")) {
      return jsonResponse(
        opts.authTestOk === false
          ? { ok: false, error: "invalid_auth" }
          : { ok: true, user_id: userId, user: "tester", team: "Acme", team_id: "T0TEST" }
      );
    }
    return new Response("unexpected fetch in test", { status: 500 });
  });
  return token;
}

describe("one-click Slack OAuth (start/callback/status, real Postgres)", () => {
  it("start returns an authorize_url with the user scopes + a state bound to the member/team", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);

    const res = await authedReq(startGET, START_URL, owner.key, seed.teamSlug);
    expect(res.status).toBe(200);
    const { authorize_url } = (await res.json()) as { authorize_url: string };
    const u = new URL(authorize_url);
    expect(u.origin + u.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(u.searchParams.get("user_scope")).toBe(
      "chat:write,im:write,users:read,users:read.email,reactions:write,channels:read"
    );
    expect(u.searchParams.get("redirect_uri")).toBe("http://test/api/auth/slack/callback");
    const state = u.searchParams.get("state");
    expect(state).toBeTruthy();

    // The state binds exactly this key's member + team (consuming it here proves the binding).
    const bound = await consumeSlackOAuthState(db(), state!);
    expect(bound).toEqual({ teamId: seed.teamId, memberId: owner.memberId });
  });

  it("start returns 500 config_error when SLACK_CLIENT_ID is unset", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const saved = process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_ID;
    try {
      const res = await authedReq(startGET, START_URL, owner.key, seed.teamSlug);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("config_error");
    } finally {
      process.env.SLACK_CLIENT_ID = saved;
    }
  });

  it("callback stores the token (encrypted, acquired_via:oauth) and never echoes it in HTML", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const state = await createSlackOAuthState(db(), seed.teamId, owner.memberId);
    const token = mockSlack({ token: `xoxp-${randomUUID()}`, userId: "U0OAUTH" });

    const res = await callbackReq({ code: "good-code", state });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).not.toContain(token);
    expect(html).not.toContain("xoxp-");

    const stored = await getMemberSecret(db(), seed.teamId, owner.memberId, "slack");
    expect(stored?.secret).toBe(token);
    expect(stored?.meta.acquired_via).toBe("oauth");
    expect(stored?.meta.slack_user_id).toBe("U0OAUTH");
    expect(stored?.meta.workspace).toBe("Acme");

    // ciphertext at rest is opaque
    const { data: row } = await db()
      .from("member_secrets")
      .select("secret_ciphertext")
      .eq("member_id", owner.memberId)
      .single();
    expect((row as { secret_ciphertext: string }).secret_ciphertext).not.toContain(token);
  });

  it("callback rejects a tampered/garbage state and stores nothing", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    mockSlack();

    const res = await callbackReq({ code: "good-code", state: "not-a-real-jwt" });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("xoxp-");
    expect(await getMemberSecret(db(), seed.teamId, owner.memberId, "slack")).toBeNull();
  });

  it("callback rejects a consumed state on replay (single-use nonce / code-mixing guard)", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const state = await createSlackOAuthState(db(), seed.teamId, owner.memberId);

    const tokenA = mockSlack({ token: `xoxp-${randomUUID()}` });
    const first = await callbackReq({ code: "code-A", state });
    expect(first.status).toBe(200);
    expect((await getMemberSecret(db(), seed.teamId, owner.memberId, "slack"))?.secret).toBe(tokenA);

    // Replay the SAME state with a different code → nonce already used → rejected, nothing re-stored.
    vi.restoreAllMocks();
    const tokenB = mockSlack({ token: `xoxp-${randomUUID()}` });
    const second = await callbackReq({ code: "code-B", state });
    expect(second.status).toBe(400);
    const after = await getMemberSecret(db(), seed.teamId, owner.memberId, "slack");
    expect(after?.secret).toBe(tokenA); // unchanged — token B never bound
    expect(after?.secret).not.toBe(tokenB);
  });

  it("callback rejects an expired state (DB-side TTL) and stores nothing", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const state = await createSlackOAuthState(db(), seed.teamId, owner.memberId);
    // Force the persisted nonce past its TTL (avoids fake timers, which can hang the real pg driver).
    // This pins the DB-side `expires_at` guard in consumeSlackOAuthState; JWT exp is covered in the unit test.
    await db()
      .from("oauth_states")
      .update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("member_id", owner.memberId);
    mockSlack();

    const res = await callbackReq({ code: "good-code", state });
    expect(res.status).toBe(400);
    expect(await getMemberSecret(db(), seed.teamId, owner.memberId, "slack")).toBeNull();
  });

  it("callback on user denial (?error) renders an error page and stores nothing", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);
    const state = await createSlackOAuthState(db(), seed.teamId, owner.memberId);
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const res = await callbackReq({ state, error: "access_denied" });
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled(); // no token exchange attempted
    expect(await getMemberSecret(db(), seed.teamId, owner.memberId, "slack")).toBeNull();
  });

  it("status reports connection without ever returning the token", async () => {
    const seed = await seedTeam();
    const owner = await memberWithKey(seed);

    const before = await authedReq(statusGET, STATUS_URL, owner.key, seed.teamSlug);
    expect(((await before.json()) as { connected: boolean }).connected).toBe(false);

    const state = await createSlackOAuthState(db(), seed.teamId, owner.memberId);
    mockSlack({ token: `xoxp-${randomUUID()}` });
    await callbackReq({ code: "good-code", state });

    const res = await authedReq(statusGET, STATUS_URL, owner.key, seed.teamSlug);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.connected).toBe(true);
    expect(body.slack_user_id).toBe("U0OAUTH");
    expect(body.workspace).toBe("Acme");
    expect("token" in body).toBe(false); // never leaks the token
  });
});
