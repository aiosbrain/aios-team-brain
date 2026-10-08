import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

/**
 * AIO-1167 — the Google Drive OAuth callback is bound to the browser and the session that started
 * the grant, BEFORE Google's code is exchanged and before anything is published.
 *
 * Spec. A `state` is a bearer value that travels through Google and back; it can leak (a copied
 * authorize URL, a referrer, a log line). Whoever holds one must not be able to finish the
 * connection — with a Google account of their own — unless they are also:
 *   · the BROWSER that started it (the HttpOnly binding cookie `start` set), and
 *   · the SESSION that started it (the same Admin, still an Admin of that team, signed in here).
 * A refused attempt exchanges nothing and stores nothing, and an attempt from the wrong browser does
 * not even use the state up: its rightful owner can still complete.
 *
 * The two route handlers are real; the database, the session resolver and the publisher are fakes,
 * so this pins the ORDER of the checks. The stored outcome is `gdrive-authority.datamechanics`.
 */
const h = vi.hoisted(() => ({
  admin: null as null | { teamId: string; memberId: string },
  adminSlugs: [] as string[],
  db: null as unknown,
  publish: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => h.db }));
vi.mock("@/lib/auth/guard", () => ({
  requireTeamAdmin: async (teamSlug: string) => {
    h.adminSlugs.push(teamSlug);
    return h.admin;
  },
}));
vi.mock("@/lib/integrations/gdrive-oauth", () => ({
  IncompleteGoogleOAuthPairError: class extends Error {},
  GoogleIdentityConflictError: class extends Error {},
  InvalidGoogleOAuthInitiatorError: class extends Error {},
  publishGoogleDriveOAuthCredential: h.publish,
}));

const { GET: startGET } = await import("@/app/api/auth/gdrive/start/route");
const { GET: callbackGET } = await import("@/app/api/auth/gdrive/callback/route");
const { GDRIVE_OAUTH_BINDING_COOKIE } = await import("@/lib/auth/gdrive-oauth-state");

/** `oauth_states`, in memory: one nonce row, consumed at most once. */
class OAuthStateDb {
  row: Record<string, unknown> | null = null;
  consumed = 0;
  private update_: Record<string, unknown> | null = null;

  from() { return this; }
  delete() { return this; }
  async lt() { return { error: null }; }
  async insert(row: Record<string, unknown>) { this.row = row; return { error: null }; }
  update(row: Record<string, unknown>) { this.update_ = row; return this; }
  eq() { return this; }
  is() { return this; }
  gt() { return this; }
  select() { return this; }
  async maybeSingle() {
    if (!this.row || this.row.used_at || !this.update_) return { data: null, error: null };
    this.row.used_at = this.update_.used_at;
    this.consumed += 1;
    return { data: { team_id: this.row.team_id, member_id: this.row.member_id }, error: null };
  }
}

const ADMIN = { teamId: "team-a", memberId: "admin-a" };
const ORIGIN = "https://brain.example.com";
const ENV = ["AUTH_SECRET", "GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_OAUTH_REDIRECT"] as const;
const previous = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));

let db: OAuthStateDb;

beforeEach(() => {
  process.env.AUTH_SECRET = "aio-1167-test-secret-at-least-sixteen";
  process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
  process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = `${ORIGIN}/api/auth/gdrive/callback`;
  db = new OAuthStateDb();
  h.db = db;
  h.admin = ADMIN;
  h.adminSlugs = [];
  h.publish.mockReset().mockResolvedValue(undefined);
  // Google: the token exchange, then the account lookup. Nothing else may be fetched.
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(JSON.stringify({
      access_token: "callback-access", refresh_token: "callback-refresh",
      scope: "https://www.googleapis.com/auth/drive.file",
    }), { status: 200, headers: { "content-type": "application/json" } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ sub: "google-subject", email: "admin@example.com" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of ENV) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

function startRequest(): Promise<NextResponse> {
  return startGET(
    new NextRequest(`${ORIGIN}/api/auth/gdrive/start?team=alpha&name=docs&mode=files`),
  ) as Promise<NextResponse>;
}

/** Begin a grant as the signed-in Admin; what Google is sent, and what stays in the browser. */
async function start(): Promise<{ state: string; binding: string }> {
  const response = await startRequest();
  expect(response.status).toBe(307);
  const state = new URL(response.headers.get("location")!).searchParams.get("state")!;
  const cookie = response.cookies.get(GDRIVE_OAUTH_BINDING_COOKIE)!;
  expect(state).toBeTruthy();
  expect(cookie.value).toBeTruthy();
  return { state, binding: cookie.value };
}

function callback(state: string, binding?: string) {
  return callbackGET(new NextRequest(
    `${ORIGIN}/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code`,
    binding === undefined ? undefined : { headers: { cookie: `${GDRIVE_OAUTH_BINDING_COOKIE}=${binding}` } },
  ));
}

describe("AIO-1167 Google Drive OAuth: start binds the browser", () => {
  it("sets an HttpOnly, callback-scoped, short-lived binding cookie and never puts it in the URL", async () => {
    const response = await startRequest();
    const cookie = response.cookies.get(GDRIVE_OAUTH_BINDING_COOKIE)!;
    expect(cookie).toMatchObject({
      httpOnly: true, sameSite: "lax", path: "/api/auth/gdrive/callback", maxAge: 600,
    });
    expect(cookie.value.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
    expect(response.headers.get("location")).not.toContain(cookie.value);
  });

  it("gives every grant its own binding", async () => {
    const first = await start();
    const second = await start();
    expect(second.binding).not.toBe(first.binding);
  });
});

describe("AIO-1167 Google Drive OAuth: callback is bound to the initiating browser and session", () => {
  it("completes for the browser and Admin session that started the grant", async () => {
    const { state, binding } = await start();

    const response = await callback(state, binding);

    expect(response.status).toBe(200);
    expect(db.consumed).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      teamId: ADMIN.teamId, memberId: ADMIN.memberId, integrationName: "docs",
      subject: "google-subject", refreshToken: "callback-refresh",
    }));
    // The session was resolved for the team the STATE names, not for anything the request supplied.
    expect(h.adminSlugs).toEqual(["alpha", "alpha"]);
  });

  it.each([
    ["without the binding cookie", false],
    ["with another grant's binding", true],
  ])("a leaked state presented %s exchanges nothing, stores nothing, and is not used up", async (_case, otherBrowser) => {
    const { state, binding } = await start();
    // Another browser began its own grant: its cookie is valid, but for a different state.
    const presented = otherBrowser ? (await start()).binding : undefined;
    const sessionsResolved = h.adminSlugs.length;

    const refused = await callback(state, presented);

    expect(refused.status).toBe(400);
    expect(db.consumed).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    // The browser check comes first: no session was even consulted.
    expect(h.adminSlugs).toHaveLength(sessionsResolved);

    // The rightful browser still completes with the very same state.
    expect((await callback(state, binding)).status).toBe(200);
    expect(db.consumed).toBe(1);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["signed out", null],
    ["a different Admin of the same team", { teamId: ADMIN.teamId, memberId: "admin-b" }],
    ["the same member id under another team", { teamId: "team-b", memberId: ADMIN.memberId }],
  ])("the right browser with the wrong session (%s) exchanges nothing and stores nothing", async (_case, session) => {
    const { state, binding } = await start();
    h.admin = session;

    const response = await callback(state, binding);

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.publish).not.toHaveBeenCalled();
    await expect(response.text()).resolves.toContain("No credentials were stored");
  });

  it("a redeemed state cannot be replayed, even by the same browser and session", async () => {
    const { state, binding } = await start();
    expect((await callback(state, binding)).status).toBe(200);

    const replay = await callback(state, binding);

    expect(replay.status).toBe(400);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledTimes(1);
  });
});
