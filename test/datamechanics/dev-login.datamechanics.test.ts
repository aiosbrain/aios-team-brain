import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/auth/dev-login/route";
import { ensureAuthUser } from "@/lib/auth/pg-login";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import { runSql } from "@/lib/db/pg/pool";
import { parseSetCookie } from "../http/dev-login-dev-setup";
import { db, seedTeam, type Seed } from "./helpers";

// Spec (AIO-1210 AC06/AC07), verified to the observable outcome in real Postgres with the REAL
// writers, signer and verifier — nothing here is mocked:
//
//   - a deliberately admitted local login creates or reuses ONE auth identity for the selected email,
//     links only the existing eligible member rows, grants nothing new, and returns a session cookie
//     the real verifier accepts;
//   - every policy refusal leaves auth_users and members exactly as they were.
//
// The tier truncates before each test, so the whole of auth_users/members IS this route's effect
// surface: a full before/after comparison also catches a row written for the wrong email.
// AUTH_SECRET is a fresh synthetic value per test; NODE_ENV and the opt-in are stubbed only around
// the handler call and restored afterwards.

const DISABLED_BODY = "dev-login is disabled";
const DEFAULT_EMAIL = "alex@demo.aios.local";
const LOCAL_HOST = "localhost:3000";
const LOCAL_ORIGIN = `http://${LOCAL_HOST}`;

interface UserRow {
  id: string;
  email: string;
}
interface MemberRow {
  id: string;
  team_id: string;
  email: string;
  auth_user_id: string | null;
  status: string;
  role: string;
  tier: string;
}

async function snapshot(): Promise<{ users: UserRow[]; members: MemberRow[] }> {
  const users = await runSql<UserRow>(`select id::text as id, email::text as email from auth_users order by 2`);
  const members = await runSql<MemberRow>(
    `select id::text as id, team_id::text as team_id, email::text as email, auth_user_id::text as auth_user_id,
            status::text as status, role::text as role, tier::text as tier
       from members order by 3, 1`
  );
  return { users: users.rows, members: members.rows };
}

async function addMember(
  seed: Seed,
  row: { email: string; status: "active" | "invited" | "disabled"; role?: string; tier?: string; authUserId?: string }
): Promise<string> {
  const { data, error } = await db()
    .from("members")
    .insert({
      team_id: seed.teamId,
      email: row.email,
      display_name: "Dev-login fixture",
      actor_handle: `devlogin-${randomUUID().slice(0, 8)}`,
      role: row.role ?? "member",
      tier: row.tier ?? "team",
      status: row.status,
      auth_user_id: row.authUserId ?? null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`member fixture failed: ${error?.message}`);
  return (data as { id: string }).id;
}

const address = (label: string): string => `${label}-${randomUUID().slice(0, 8)}@test.local`;

interface Sent {
  params?: Record<string, string>;
  host?: string;
  headers?: Record<string, string>;
}

function request(sent: Sent = {}): NextRequest {
  const query = new URLSearchParams(sent.params ?? {}).toString();
  const host = sent.host ?? LOCAL_HOST;
  const req = new NextRequest(`${LOCAL_ORIGIN}/auth/dev-login${query ? `?${query}` : ""}`, {
    headers: { host, ...(sent.headers ?? {}) },
  });
  // The handler really sees this Host.
  expect(req.headers.get("host")).toBe(host);
  return req;
}

/**
 * Call the real handler under an explicit runtime mode / opt-in, set only for the call. An omitted
 * `nodeEnv` means `development` here: this wrapper has no unset-NODE_ENV case (the direct-handler
 * tier owns that one). An opt-in requested as `undefined` is a genuinely absent variable, which is
 * asserted before the GET rather than assumed.
 */
async function login(sent: Sent, mode: { nodeEnv?: string; optIn?: string | undefined } = {}): Promise<Response> {
  const optIn = "optIn" in mode ? mode.optIn : "1";
  vi.stubEnv("NODE_ENV", mode.nodeEnv ?? "development");
  vi.stubEnv("AIOS_DEV_LOGIN", optIn);
  if (optIn === undefined) expect("AIOS_DEV_LOGIN" in process.env, "AIOS_DEV_LOGIN must be absent").toBe(false);
  else expect(process.env.AIOS_DEV_LOGIN).toBe(optIn);
  return GET(request(sent));
}

function sessionToken(res: Response): string {
  const cookies = res.headers.getSetCookie().map(parseSetCookie).filter((cookie) => cookie.name === SESSION_COOKIE);
  expect(cookies).toHaveLength(1);
  return cookies[0].value;
}

/** Admitted to the local origin, with a cookie the REAL verifier resolves to a session user. */
async function admitted(res: Response, target = "/t/demo"): Promise<SessionUser> {
  expect(res.status).toBe(307);
  const destination = new URL(String(res.headers.get("location")));
  expect(destination.origin).toBe(LOCAL_ORIGIN);
  expect(destination.pathname + destination.search + destination.hash).toBe(target);
  const user = await verifySession(sessionToken(res));
  expect(user).not.toBeNull();
  return user as SessionUser;
}

async function expectInert(res: Response): Promise<void> {
  expect.soft(res.status).toBe(404);
  expect.soft(await res.text()).toBe(DISABLED_BODY);
  expect.soft(res.headers.get("location")).toBeNull();
  expect.soft(res.headers.getSetCookie()).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv("AUTH_SECRET", randomBytes(32).toString("hex"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /auth/dev-login — admitted auth outcome (real Postgres, AC06)", () => {
  it("deliberate local login signs the selected identity: creates the identity, links the eligible member, mints a verifiable cookie", async () => {
    const seed = await seedTeam();
    const email = address("eligible");
    const memberId = await addMember(seed, { email, status: "active", role: "admin", tier: "team" });
    const before = await snapshot();
    expect(before.users).toEqual([]);

    const user = await admitted(await login({ params: { email } }));

    expect(user.email).toBe(email);
    const after = await snapshot();
    expect(after.users).toEqual([{ id: user.id, email }]);
    // Only the eligible row changed, and only its link: status, role and tier are untouched and no
    // member row was created (the seeded bystander member is still unlinked).
    expect(after.members).toEqual(before.members.map((m) => (m.id === memberId ? { ...m, auth_user_id: user.id } : m)));
  });

  it("the session cookie keeps the existing host-only options and 30-day expiry", async () => {
    const email = address("cookie");
    const res = await login({ params: { email } });
    expect(res.status).toBe(307);

    const cookies = res.headers.getSetCookie().map(parseSetCookie);
    expect(cookies.map((cookie) => cookie.name)).toEqual([SESSION_COOKIE]);
    const [cookie] = cookies;
    expect(cookie.attributes.httponly).toBe(true);
    expect(String(cookie.attributes.samesite).toLowerCase()).toBe("lax");
    expect(cookie.attributes.path).toBe("/");
    expect(cookie.attributes["max-age"]).toBe(String(SESSION_MAX_AGE_S));
    expect("domain" in cookie.attributes).toBe(false);
    expect("secure" in cookie.attributes).toBe(false);

    // The signer's own expiry is unchanged: the session max age after issuance. `iat` and `exp` are
    // two consecutive whole-second clock readings in the signer (jose: setIssuedAt(), then
    // setExpirationTime("<max>s")), so a second boundary between them makes the difference MAX + 1 —
    // never less than MAX, never more than MAX + 1. The cookie's own Max-Age above is exact.
    const claims = JSON.parse(Buffer.from(cookie.value.split(".")[1], "base64url").toString("utf8")) as {
      sub: string;
      email: string;
      iat: number;
      exp: number;
    };
    expect(claims.exp - claims.iat).toBeGreaterThanOrEqual(SESSION_MAX_AGE_S);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(SESSION_MAX_AGE_S + 1);
    expect(claims.email).toBe(email);
    expect(await verifySession(cookie.value)).toEqual({ id: claims.sub, email });

    // A cookie signed under this test's secret is worthless under any other.
    vi.stubEnv("AUTH_SECRET", randomBytes(32).toString("hex"));
    expect(await verifySession(cookie.value)).toBeNull();
  });

  it("an admitted success is explicitly no-store", async () => {
    const res = await login({ params: { email: address("no-store") } });
    expect(res.status).toBe(307);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("an absent email selects the demo default identity", async () => {
    const user = await admitted(await login({}));
    expect(user.email).toBe(DEFAULT_EMAIL);
    expect((await snapshot()).users).toEqual([{ id: user.id, email: DEFAULT_EMAIL }]);
  });

  it("a second login reuses the same identity and leaves the existing link alone", async () => {
    const seed = await seedTeam();
    const email = address("reuse");
    await addMember(seed, { email, status: "active" });

    const first = await admitted(await login({ params: { email } }));
    const afterFirst = await snapshot();
    const second = await admitted(await login({ params: { email } }));

    expect(second).toEqual(first);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("links every eligible row for the email across teams and never activates an invited one", async () => {
    const teamA = await seedTeam();
    const teamB = await seedTeam();
    const email = address("multi");
    const activeId = await addMember(teamA, { email, status: "active" });
    const invitedId = await addMember(teamB, { email, status: "invited", role: "lead", tier: "external" });
    const before = await snapshot();

    const user = await admitted(await login({ params: { email } }));

    // The route supplies no team context to the linker: identity is linked, `invited` stays invited.
    const after = await snapshot();
    expect(after.members).toEqual(
      before.members.map((m) => (m.id === activeId || m.id === invitedId ? { ...m, auth_user_id: user.id } : m))
    );
    expect(after.members.find((m) => m.id === invitedId)?.status).toBe("invited");
  });

  it("a disabled member seeded with a null auth_user_id stays null while the identity still gets a cookie", async () => {
    const seed = await seedTeam();
    const email = address("disabled");
    await addMember(seed, { email, status: "disabled" });
    const before = await snapshot();

    const user = await admitted(await login({ params: { email } }));

    expect(user.email).toBe(email);
    const after = await snapshot();
    expect(after.users).toEqual([{ id: user.id, email }]);
    expect(after.members).toEqual(before.members);
  });

  it("a member already linked to another identity is not re-linked", async () => {
    const seed = await seedTeam();
    const email = address("linked");
    const otherId = await ensureAuthUser(address("other-identity"));
    await addMember(seed, { email, status: "active", authUserId: otherId });
    const before = await snapshot();

    const user = await admitted(await login({ params: { email } }));

    expect(user.id).not.toBe(otherId);
    expect((await snapshot()).members).toEqual(before.members);
  });

  it("an email with no member obtains an auth_users row and a cookie without any membership grant", async () => {
    await seedTeam();
    const email = address("no-member");
    const before = await snapshot();

    const user = await admitted(await login({ params: { email } }));

    const after = await snapshot();
    expect(after.users).toEqual([{ id: user.id, email }]);
    expect(after.members).toEqual(before.members);
    expect(after.members.some((m) => m.email === email)).toBe(false);
  });
});

describe("GET /auth/dev-login — refusals change no auth row (real Postgres, AC07)", () => {
  // Each refused request names an email with an ELIGIBLE unlinked member: a wrongful admission would
  // be visible twice over — a new auth_users row and a newly linked member.
  const REFUSED: { label: string; sent: Sent; mode: { nodeEnv?: string; optIn?: string | undefined } }[] = [
    { label: "opt-in missing", sent: {}, mode: { optIn: undefined } },
    { label: "opt-in 0", sent: {}, mode: { optIn: "0" } },
    { label: "opt-in true", sent: {}, mode: { optIn: "true" } },
    { label: "opt-in missing under NODE_ENV=test", sent: {}, mode: { nodeEnv: "test", optIn: undefined } },
    { label: "a nonlocal Host", sent: { host: "evil.example:3000" }, mode: {} },
    { label: "a lookalike Host", sent: { host: "localhost.evil.example:3000" }, mode: {} },
    { label: "a local Host on another port", sent: { host: "localhost:3001" }, mode: {} },
    { label: "a public x-forwarded-host", sent: { headers: { "x-forwarded-host": "evil.example" } }, mode: {} },
    { label: "an aliased x-forwarded-host", sent: { headers: { "x-forwarded-host": "127.0.0.1:3000" } }, mode: {} },
    { label: "a mismatched x-forwarded-proto", sent: { headers: { "x-forwarded-proto": "https" } }, mode: {} },
    {
      label: "a public Host with local forwarding",
      sent: { host: "evil.example:3000", headers: { "x-forwarded-host": LOCAL_HOST, "x-forwarded-for": "127.0.0.1" } },
      mode: {},
    },
  ];

  it.each(REFUSED)("all policy refusals are inert: $label", async ({ sent, mode }) => {
    const seed = await seedTeam();
    const email = address("refused");
    await addMember(seed, { email, status: "active" });
    const before = await snapshot();

    const res = await login({ ...sent, params: { email } }, mode);

    await expectInert(res);
    expect.soft(res.headers.get("cache-control")).toBe("no-store");
    expect.soft(await snapshot()).toEqual(before);
  });

  it("production denies with both opt-ins and a valid local authority, and writes nothing", async () => {
    const seed = await seedTeam();
    const email = address("production");
    await addMember(seed, { email, status: "active" });
    const before = await snapshot();
    vi.stubEnv("ALLOW_DEV_LOGIN", "1");

    const res = await login({ params: { email } }, { nodeEnv: "production", optIn: "1" });

    await expectInert(res);
    expect(await snapshot()).toEqual(before);
  });
});

describe("GET /auth/dev-login — admitted failure (real Postgres, AC07)", () => {
  it("admitted ensure/link/sign failures never return a successful cookie: the real signer refuses an unusable AUTH_SECRET", async () => {
    const seed = await seedTeam();
    const email = address("sign-failure");
    await addMember(seed, { email, status: "active" });
    vi.stubEnv("AUTH_SECRET", "too-short");

    // The signer's own error propagates: no response, so no cookie and no redirect. An identity write
    // that completed before the failure is not rolled back — no such promise exists, so none is asserted.
    await expect(login({ params: { email } })).rejects.toThrow(/AUTH_SECRET/);
  });
});
