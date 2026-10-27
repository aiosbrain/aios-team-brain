import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, type NextResponse } from "next/server";

/**
 * AIO-1167 R43 — the OAuth start/callback boundaries the R43 review reopened.
 *
 * F3 (least privilege for the chosen mode, AC-01). Start requires an explicit mode, requests EXACTLY
 * that mode's scopes (never `include_granted_scopes`), and signs the mode into the one-use state. The
 * callback judges Google's actual grant against the SIGNED mode — a query parameter cannot change it
 * — and refuses a grant that is broader, insufficient or missing before asking Google anything else
 * and before publishing. A stored credential the publisher will not reuse is reported, sanitized.
 *
 * F4 (bounded, actionable provider failures). Each provider leg — token exchange, then userinfo — is
 * bounded INCLUDING its body. Rejected requests, timeouts, bodies that stall after the headers,
 * non-JSON, null/array/malformed objects and non-2xx replies all finish, sanitized and `no-store`,
 * with an instruction to start again; nothing is published, the state stays consumed (a replay is
 * refused with no further provider call), and nothing is retried.
 *
 * The route handlers are real; the state store, the session and the publisher are fakes (the stored
 * outcome is covered in the real-Postgres tier).
 */
const h = vi.hoisted(() => ({
  admin: null as null | { teamId: string; memberId: string },
  db: null as unknown,
  publish: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => h.db }));
vi.mock("@/lib/auth/guard", () => ({ requireTeamAdmin: async () => h.admin }));
vi.mock("@/lib/integrations/gdrive-oauth", () => ({
  IncompleteGoogleOAuthPairError: class extends Error {},
  GoogleIdentityConflictError: class extends Error {},
  InvalidGoogleOAuthInitiatorError: class extends Error {},
  GoogleGrantOutsideModeError: class extends Error {
    constructor(readonly reason: string) { super(reason); }
  },
  IncompatibleStoredGoogleCredentialError: class extends Error {},
  publishGoogleDriveOAuthCredential: h.publish,
}));

const { GET: startGET } = await import("@/app/api/auth/gdrive/start/route");
const { GET: callbackGET } = await import("@/app/api/auth/gdrive/callback/route");
const { GDRIVE_OAUTH_BINDING_COOKIE } = await import("@/lib/auth/gdrive-oauth-state");
const oauth = await import("@/lib/integrations/gdrive-oauth");

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
const G = "https://www.googleapis.com/auth/";
const FILE = `${G}drive.file`;
const READONLY = `${G}drive.readonly`;
/** Values that must never appear in a callback response. */
const PRIVATE = ["one-time-code", "callback-access", "callback-refresh", "PROVIDER-BODY-MARKER", "oauth-secret"];

let db: OAuthStateDb;

beforeEach(() => {
  process.env.AUTH_SECRET = "aio-1167-test-secret-at-least-sixteen";
  process.env.GOOGLE_DRIVE_CLIENT_ID = "oauth-client";
  process.env.GOOGLE_DRIVE_CLIENT_SECRET = "oauth-secret";
  process.env.GOOGLE_DRIVE_OAUTH_REDIRECT = `${ORIGIN}/api/auth/gdrive/callback`;
  db = new OAuthStateDb();
  h.db = db;
  h.admin = ADMIN;
  h.publish.mockReset().mockResolvedValue({ status: "enabled" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const name of ENV) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokens = (scope: string | undefined, extra: Record<string, unknown> = {}) =>
  json({ access_token: "callback-access", refresh_token: "callback-refresh", ...(scope === undefined ? {} : { scope }), ...extra });
const USER = { sub: "google-subject", email: "admin@example.com", email_verified: true };

function startRequest(query: string): Promise<NextResponse> {
  return startGET(new NextRequest(`${ORIGIN}/api/auth/gdrive/start?team=alpha&name=docs${query}`)) as Promise<NextResponse>;
}

async function start(mode: "files" | "folders" = "files"): Promise<{ state: string; binding: string }> {
  const response = await startRequest(`&mode=${mode}`);
  expect(response.status).toBe(307);
  return {
    state: new URL(response.headers.get("location")!).searchParams.get("state")!,
    binding: response.cookies.get(GDRIVE_OAUTH_BINDING_COOKIE)!.value,
  };
}

function callback(state: string, binding: string, extraQuery = "") {
  return callbackGET(new NextRequest(
    `${ORIGIN}/api/auth/gdrive/callback?state=${encodeURIComponent(state)}&code=one-time-code${extraQuery}`,
    { headers: { cookie: `${GDRIVE_OAUTH_BINDING_COOKIE}=${binding}` } },
  ));
}

async function expectSanitizedRefusal(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  for (const value of PRIVATE) expect(body).not.toContain(value);
  return body;
}

describe("R43 F3: start requests exactly the chosen mode's scopes, bound into the state", () => {
  it.each([
    ["files", ["openid", "email", "profile", FILE]],
    ["folders", ["openid", "email", "profile", READONLY]],
  ] as const)("mode=%s requests exactly its scopes and never include_granted_scopes", async (mode, scopes) => {
    const response = await startRequest(`&mode=${mode}`);
    const authorize = new URL(response.headers.get("location")!);
    expect(authorize.searchParams.get("scope")!.split(" ")).toEqual(scopes);
    expect(authorize.searchParams.has("include_granted_scopes")).toBe(false);
    const payload = JSON.parse(Buffer.from(authorize.searchParams.get("state")!.split(".")[1]!, "base64url").toString("utf8"));
    expect(payload.mode).toBe(mode);
  });

  it.each([["missing", ""], ["unknown", "&mode=everything"], ["wrong case", "&mode=FILES"]])(
    "a %s mode is refused before any state is minted", async (_case, query) => {
      const response = await startRequest(query);
      expect(response.status).toBe(400);
      expect(db.row).toBeNull();
      expect(response.cookies.get(GDRIVE_OAUTH_BINDING_COOKIE)).toBeUndefined();
    },
  );
});

describe("R43 F3: the callback judges Google's grant against the SIGNED mode", () => {
  it("a narrow per-file grant (OIDC aliases included) publishes under files mode with the granted scopes", async () => {
    const granted = `openid ${G}userinfo.email ${G}userinfo.profile ${FILE}`;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(granted)).mockResolvedValueOnce(json(USER));
    const { state, binding } = await start("files");

    expect((await callback(state, binding)).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(h.publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      grantMode: "files", scopes: granted.split(" "), refreshToken: "callback-refresh",
    }));
  });

  it("folder discovery publishes under folders mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(`openid email ${READONLY}`)).mockResolvedValueOnce(json(USER));
    const { state, binding } = await start("folders");
    expect((await callback(state, binding)).status).toBe(200);
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ grantMode: "folders" }));
  });

  it.each([
    ["broader (drive.readonly carried over)", `openid email ${FILE} ${READONLY}`, /more access than requested/i],
    ["broader (full drive)", `openid email ${FILE} ${G}drive`, /more access than requested/i],
    ["insufficient (identity only)", "openid email profile", /did not grant the Drive access/i],
    ["missing scope", undefined, /did not grant the Drive access/i],
  ])("files mode with a %s grant is refused before userinfo and before publishing", async (_case, scope, message) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(scope)).mockResolvedValueOnce(json(USER));
    const { state, binding } = await start("files");

    const body = await expectSanitizedRefusal(await callback(state, binding), 422);
    expect(body).toMatch(message);
    expect(body).toContain("No credentials were stored");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(h.publish).not.toHaveBeenCalled();
    expect(db.consumed).toBe(1);
  });

  it("a mode query parameter on the callback cannot widen the signed per-file mode", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(`openid ${READONLY}`)).mockResolvedValueOnce(json(USER));
    const { state, binding } = await start("files");
    await expectSanitizedRefusal(await callback(state, binding, "&mode=folders"), 422);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("folders mode refuses a grant beyond discovery", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(`openid ${READONLY} ${G}gmail.readonly`)).mockResolvedValueOnce(json(USER));
    const { state, binding } = await start("folders");
    await expectSanitizedRefusal(await callback(state, binding), 422);
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("a stored credential the publisher will not reuse is reported as a reconnect, sanitized", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(`openid ${FILE}`, { refresh_token: undefined }))
      .mockResolvedValueOnce(json(USER));
    h.publish.mockRejectedValueOnce(new oauth.IncompatibleStoredGoogleCredentialError("stored_credential_outside_mode"));
    const { state, binding } = await start("files");

    const body = await expectSanitizedRefusal(await callback(state, binding), 422);
    expect(body).toMatch(/was not reused/);
    expect(body).toContain("left unchanged");
    expect(h.publish).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: undefined, grantMode: "files" }));
  });

  it("a reconnect that leaves the connection paused says so", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(tokens(`openid ${FILE}`)).mockResolvedValueOnce(json(USER));
    h.publish.mockResolvedValueOnce({ status: "disabled" });
    const { state, binding } = await start("files");
    const response = await callback(state, binding);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toMatch(/paused: nothing will be read until you Resume/);
  });
});

/** A Response whose body never arrives: headers are sent, then the stream stalls. */
const stalledBody = () => new Response(new ReadableStream({ start() { /* never enqueues or closes */ } }), {
  status: 200, headers: { "content-type": "application/json" },
});

type Leg = "token" | "userinfo";
/** Make `leg` behave as `failure`; the token leg before a userinfo failure succeeds narrowly. */
function google(leg: Leg, failure: () => Promise<Response>) {
  const spy = vi.spyOn(globalThis, "fetch");
  if (leg === "userinfo") spy.mockResolvedValueOnce(tokens(`openid ${FILE}`));
  spy.mockImplementationOnce(failure);
  return spy;
}

describe("R43 F4: each provider leg fails bounded, sanitized and final", () => {
  const LEGS: Leg[] = ["token", "userinfo"];

  const cases: [string, () => Promise<Response>, number][] = [
    ["a rejected request", async () => { throw new TypeError("fetch failed PROVIDER-BODY-MARKER"); }, 503],
    ["a 500", async () => json({ error: "PROVIDER-BODY-MARKER" }, 500), 503],
    ["a 429", async () => json({ error: "PROVIDER-BODY-MARKER" }, 429), 503],
    ["a 400", async () => json({ error: "PROVIDER-BODY-MARKER" }, 400), 422],
    ["a non-JSON 200", async () => new Response("<html>PROVIDER-BODY-MARKER</html>", { status: 200 }), 422],
    ["JSON null", async () => json(null), 422],
    ["a JSON array", async () => json(["PROVIDER-BODY-MARKER"]), 422],
    ["a malformed object", async () => json({ unexpected: "PROVIDER-BODY-MARKER" }), 422],
  ];

  for (const leg of LEGS) {
    it.each(cases)(`${leg}: %s finishes with %s, publishes nothing, and stays consumed`, async (_case, failure, status) => {
      const spy = google(leg, failure);
      const { state, binding } = await start("files");

      const body = await expectSanitizedRefusal(await callback(state, binding), status);
      expect(body).toMatch(/No credentials were stored/);
      expect(body).toMatch(/Start the connection again/);
      expect(h.publish).not.toHaveBeenCalled();
      expect(spy).toHaveBeenCalledTimes(leg === "token" ? 1 : 2);
      expect(db.consumed).toBe(1);

      // Replay: refused at the state, with no further provider call and no automatic retry.
      expect((await callback(state, binding)).status).toBe(400);
      expect(spy).toHaveBeenCalledTimes(leg === "token" ? 1 : 2);
      expect(h.publish).not.toHaveBeenCalled();
    });

    it.each([
      ["a request that never answers", (signal?: AbortSignal | null) => new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      })],
      ["a request that ignores its abort signal", () => new Promise<Response>(() => { /* never settles */ })],
      ["a body that stalls after the headers", async () => stalledBody()],
    ])(`${leg}: %s is cut off at the deadline with a 503`, async (_case, behaviour) => {
      let reached = false;
      const spy = vi.spyOn(globalThis, "fetch");
      if (leg === "userinfo") spy.mockResolvedValueOnce(tokens(`openid ${FILE}`));
      spy.mockImplementationOnce(async (_url, init) => {
        reached = true;
        return behaviour(init?.signal);
      });
      const { state, binding } = await start("files");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const pending = callback(state, binding);
      await vi.waitFor(() => expect(reached).toBe(true));
      await vi.advanceTimersByTimeAsync(15_000);
      const response = await pending;

      await expectSanitizedRefusal(response, 503);
      expect(h.publish).not.toHaveBeenCalled();
      expect(db.consumed).toBe(1);
    });
  }

  it("the deadline is per leg and not earlier than 15 seconds", async () => {
    let reached = false;
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () => {
      reached = true;
      return stalledBody();
    });
    const { state, binding } = await start("files");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const pending = callback(state, binding).then((response) => { settled = true; return response; });
    await vi.waitFor(() => expect(reached).toBe(true));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe(503);
  });
});
