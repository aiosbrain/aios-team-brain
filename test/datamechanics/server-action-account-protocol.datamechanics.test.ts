import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPool } from "@/lib/db/pg/pool";
import { placeMemberByTier } from "./helpers";

/**
 * AIO-1217 — the ACCOUNT protocol against real Postgres (AC-06, the credential half): the two SELF
 * credential exports, executed as the actual exported functions, bind their write to the identity
 * the request's signed session cookie names, and keep working for an account that holds no active
 * tenant membership.
 *
 * Every assertion is derived from the accepted specification's account contract, not from the
 * implementation: welcome uses own identity and the only-if-unset writer; change password uses own
 * identity plus current-password verification; missing identity, an invalid old password and an
 * already-set account refuse with zero credential change; admitted credential controls work; no
 * active tenant membership requirement is added. This is the PG supplement the unit-tier file
 * `test/actions/aio1217-account-auth.test.ts` names; that file's credential doubles prove wiring
 * and verdict handling, and this one proves what they cannot — the stored hash.
 *
 *   X — the fixture's own contract: the accounts, passwords, sessions and snapshot are what the
 *       cases call them.
 *   A — `changeMyPassword`: the admitted change, a wrong current password, another account's
 *       correct password, and a denied identity.
 *   B — `setInitialPassword`: the admitted first set, the already-set refusal, a denied identity.
 *   C — both exports for an account with no member row, and for one linked only to a disabled
 *       membership: set a first password, change it, and the two refusal controls.
 *
 * Registry keys certified, as `(repository path, export name)`:
 *   A, C  app/actions/account.ts changeMyPassword          (protected, SELF)
 *   B, C  app/auth/welcome/actions.ts setInitialPassword   (protected, SELF)
 * `signOutAction` is not exercised here; its evidence is the unit-tier file's.
 *
 * What is real: the two exports, `lib/auth/session` `getSessionUser`, `lib/auth/pg-session`
 * `signSession`/`verifySession` (jose HS256 against AUTH_SECRET), `lib/auth/password`
 * `isPasswordStrongEnough`/`hashPassword`/`verifyPasswordHash` (scrypt), `lib/auth/pg-login`
 * `changePassword`/`setPasswordIfUnset`, the pg pool and the task's data-mechanics Postgres. No
 * credential owner, identity resolver, JWT check, hash or query is stubbed.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies   `next/headers` `cookies` — async, resolves a recording store over the Map of the
 *                  one request in flight. Reads and outgoing mutations are recorded per request.
 *   SEAM redirect  `next/navigation` `redirect` — records the path, then throws one sentinel.
 * AUTH_SECRET is a fresh synthetic value per test, restored afterwards.
 *
 * Every action call is one request: the durable rowsets of auth_users, auth_tokens, members,
 * group_members and audit_log are read whole before and after it (rows, not counts) and compared
 * together with the result and the request's cookie/redirect trace in ONE grouped assertion, so a
 * wrong return value cannot hide a durable write and a right one cannot excuse it. A refusal owes
 * identical rowsets. An admitted write owes rowsets that differ in exactly one value — the signed
 * subject's `password_hash` — which makes Bob's row, Carol's row, every membership row and every
 * token/audit row a bystander by construction. Hash claims are the real `verifyPasswordHash` over
 * the raw stored column. The tier truncates before each test, so these rowsets are the whole effect
 * surface of the snapshot tables.
 *
 * Two bystanders, because the two writers can leak in two directions. Bob holds a password, so a
 * write that reaches a set account shows on him. Carol holds none, exactly like Alice before her
 * first set, so an only-if-unset writer that lost its `id` conjunct — every unset account instead
 * of the signed subject's — shows on her; with Alice the only unset account it would show nowhere.
 * Both hashes are named in every grouped assertion, admitted or refused.
 *
 * Each refusal is paired, in the same test and fixture, with an admitted control that differs only
 * in the refused conjunct, so a reject-everything action cannot pass. Fixture premises fail with
 * the `FIXTURE` prefix below and are never a security observation; a failed control says `CONTROL`.
 *
 * Bounds of what is claimed. These are direct calls of the exported functions against a cookie
 * double: not Set-Cookie headers, not browser dispatch, not Next action-wire behavior. Sessions are
 * stateless JWTs and nothing here claims revocation of a copied token or that a password change
 * invalidates a session. The token/audit invariance on the ADMITTED paths pins that these actions
 * write nothing but the one hash today; it is not a specification that a reviewed audit event could
 * never be added. In C the subject's session is signed directly by the session helper — no login
 * path runs, no membership is created, linked or activated for it, and the only active membership
 * in any fixture is the bystander Bob's; Carol holds no member row in any of them. This file
 * certifies neither the whole of AC-06 nor any other registry row.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "ADMITTED CONTROL FAILED (the paired refusal would be vacuous):";

const h = vi.hoisted(() => ({
  /** SEAM cookies: the async `cookies()` of the request in flight. */
  cookies: vi.fn(),
  /** SEAM redirect: records, then throws the sentinel. */
  redirect: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));

import { changeMyPassword } from "@/app/actions/account";
import { setInitialPassword } from "@/app/auth/welcome/actions";
import { hashPassword, isPasswordStrongEnough, verifyPasswordHash } from "@/lib/auth/password";
import { signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";

type Row = Record<string, unknown>;
type ActionResult = { ok: boolean; error?: string };
type Membership = "active" | "disabled" | "none";

/** Real scrypt runs a dozen times in a case; the default per-test budget is not sized for it. */
const SLOW = 60_000;

const PASSWORDS = {
  old: "old-password-A-123",
  new: "new-password-A-456",
  wrongCurrent: "wrong-current-A-789",
  initial: "initial-password-A-123",
  replacement: "replacement-password-A-456",
  bob: "bob-own-password-B-321",
} as const;
type PasswordName = keyof typeof PASSWORDS;
const PASSWORD_NAMES = Object.keys(PASSWORDS) as PasswordName[];

const SESSION_COOKIE = "aios_session";
const OTHER_COOKIE = "fixture_other_cookie";
const OTHER_COOKIE_VALUE = "aio1217-unrelated-cookie-value";

const NOT_SIGNED_IN = { ok: false, error: "not signed in" };
const INCORRECT_CURRENT = { ok: false, error: "current password is incorrect" };
const ALREADY_SET = { ok: false, error: "a password is already set for this account" };

/** An explicit past window (2020-01-01T00:00:00Z + 1h): expired with no clock control and no sleep. */
const EXPIRED_ISSUED_AT = 1_577_836_800;
const EXPIRED_AT = EXPIRED_ISSUED_AT + 3_600;

const DENIED_IDENTITIES = ["an absent session cookie", "a validly signed but expired session"] as const;
type DeniedIdentity = (typeof DENIED_IDENTITIES)[number];

const NO_ACTIVE_MEMBERSHIP = [
  { shape: "no member row at all", membership: "none" },
  { shape: "only a disabled membership", membership: "disabled" },
] as const;

/** Read whole, in a stable order, before and after every action call. */
const SNAPSHOT_TABLES = ["auth_users", "auth_tokens", "members", "group_members", "audit_log"] as const;
type World = Record<(typeof SNAPSHOT_TABLES)[number], Row[]>;

const HASH_SLOT = "<the signed subject's password_hash>";

interface Account {
  label: string;
  user: SessionUser;
  /** `signSession(user)` under this test's AUTH_SECRET. */
  token: string;
  seededHash: string | null;
}

interface Fixture {
  teamId: string;
  /** The signed self identity of every admitted call. */
  alice: Account;
  /** The bystander: an ordinary account with its own password and an active membership. */
  bob: Account;
  /** The unset bystander: a distinct account with no password, as Alice has before a first set, and no member row. */
  carol: Account;
  /** Alice's claims under the right secret, inside an explicit past window. */
  expiredAlice: string;
  aliceMemberships: Row[];
  /** The snapshot tables as seeded. */
  seeded: World;
}

interface RequestTrace {
  readSession: boolean;
  cookieMutations: string[];
  redirects: string[];
  jar: [string, string][];
}

interface Observed {
  result: ActionResult;
  before: World;
  after: World;
  /** The request's cookies as they arrived. */
  arrived: [string, string][];
  trace: RequestTrace;
}

interface InFlight {
  jar: Map<string, string>;
  reads: string[];
  mutations: string[];
}

let authSecret = "";
/** The one request in flight; null between requests. */
let inFlight: InFlight | null = null;
const redirects: string[] = [];
const redirectSentinel = new Error("AIO1217 redirect sentinel");

function cookieStoreOver(flight: InFlight) {
  return {
    get: (name: string) => {
      flight.reads.push(name);
      const value = flight.jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    has: (name: string) => {
      flight.reads.push(name);
      return flight.jar.has(name);
    },
    getAll: () => {
      flight.reads.push("*");
      return [...flight.jar].map(([name, value]) => ({ name, value }));
    },
    set: (first: string | { name: string; value: string }, value?: string) => {
      const name = typeof first === "string" ? first : first.name;
      flight.mutations.push(`cookie.set:${name}`);
      flight.jar.set(name, typeof first === "string" ? String(value) : first.value);
    },
    delete: (name: string) => {
      flight.mutations.push(`cookie.delete:${name}`);
      flight.jar.delete(name);
    },
  };
}

beforeEach(() => {
  authSecret = randomBytes(32).toString("hex");
  vi.stubEnv("AUTH_SECRET", authSecret);
  inFlight = null;
  redirects.length = 0;
  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called.
    const flight = inFlight;
    if (!flight) throw new Error(`${FIXTURE} cookies() called with no request in flight`);
    return cookieStoreOver(flight);
  });
  h.redirect.mockReset();
  h.redirect.mockImplementation((path: string): never => {
    redirects.push(path);
    throw redirectSentinel;
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ── fixture plumbing ─────────────────────────────────────────────────────────────────────────────

async function fx<T extends Row = Row>(label: string, text: string, params: unknown[] = []): Promise<T[]> {
  try {
    return (await getPool().query(text, params)).rows as T[];
  } catch (error) {
    throw new Error(`${FIXTURE} ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function fxOne<T extends Row = Row>(label: string, text: string, params: unknown[] = []): Promise<T> {
  const rows = await fx<T>(label, text, params);
  if (rows.length !== 1) throw new Error(`${FIXTURE} ${label}: expected exactly one row, got ${rows.length}`);
  return rows[0];
}

function premise(label: string, actual: unknown, expected: unknown): void {
  expect(actual, `${FIXTURE} ${label}`).toEqual(expected);
}

/** Every row of every snapshot table, every column, in an order that depends on content only. */
async function world(): Promise<World> {
  const snapshot = {} as World;
  for (const table of SNAPSHOT_TABLES) {
    const rows = await fx<{ row: Row }>(
      `${table} snapshot`,
      `select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`,
    );
    snapshot[table] = rows.map((entry) => entry.row);
  }
  return snapshot;
}

/** The raw stored `password_hash` of `account` in a snapshot. */
function storedHash(snapshot: World, account: Account): string | null {
  const rows = snapshot.auth_users.filter((row) => row.id === account.user.id);
  if (rows.length !== 1) throw new Error(`${account.label} has ${rows.length} auth_users rows; exactly one was seeded`);
  return rows[0].password_hash as string | null;
}

/** The snapshot with one account's hash factored out: what an admitted write may not have touched. */
function withoutHashOf(snapshot: World, account: Account): World {
  return {
    ...snapshot,
    auth_users: snapshot.auth_users.map((row) =>
      row.id === account.user.id ? { ...row, password_hash: HASH_SLOT } : row,
    ),
  };
}

/** Which of the named fixture passwords the raw stored hash verifies, by the real verifier. */
async function verifiedBy(hash: string | null, names: readonly PasswordName[]): Promise<PasswordName[]> {
  const verified: PasswordName[] = [];
  if (hash === null) return verified;
  for (const name of names) {
    if (await verifyPasswordHash(PASSWORDS[name], hash)) verified.push(name);
  }
  return verified;
}

const membershipsOf = (account: Account) =>
  fx(
    "membership readback",
    `select team_id::text as team_id, status::text as status, auth_user_id::text as auth_user_id
       from members where auth_user_id = $1 or email = $2 order by id`,
    [account.user.id, account.user.email],
  );

/** A distinct auth user with a real `hashPassword` value (or none) and one unused magic-link row. */
async function seedAccount(label: string, password: string | null): Promise<Account> {
  const user = { id: randomUUID(), email: `${label}-${randomUUID().slice(0, 8)}@aio1217.fixture.test` };
  const seededHash = password === null ? null : await hashPassword(password);
  await fxOne("auth user insert", `insert into auth_users(id, email, password_hash) values($1, $2, $3) returning id`, [
    user.id,
    user.email,
    seededHash,
  ]);
  await fxOne(
    "auth token insert",
    `insert into auth_tokens(token_hash, email, next_path, expires_at)
     values($1, $2, '/', now() + interval '1 hour') returning token_hash`,
    [createHash("sha256").update(randomUUID()).digest("hex"), user.email],
  );
  return { label, user, token: await signSession(user), seededHash };
}

/** A member row linked to `account`, with the builtin posture row every real member has. */
async function seedMember(teamId: string, account: Account, status: "active" | "disabled"): Promise<void> {
  const { id } = await fxOne<{ id: string }>(
    "member insert",
    `insert into members(team_id, email, display_name, actor_handle, role, tier, status, auth_user_id)
     values($1, $2, $3, $4, 'member', 'team', $5, $6) returning id`,
    [teamId, account.user.email, `AIO1217 ${account.label}`, `${account.label}-${randomUUID().slice(0, 8)}`, status, account.user.id],
  );
  await placeMemberByTier(teamId, id, "team");
}

function expiredSession(user: SessionUser): Promise<string> {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(EXPIRED_ISSUED_AT)
    .setExpirationTime(EXPIRED_AT)
    .sign(new TextEncoder().encode(authSecret));
}

/**
 * One team, Bob as an active member with his own password, Carol with no password and no member
 * row, and Alice with the password and the membership shape a case asks for. Alice is never given a
 * membership the case did not ask for.
 */
async function seedFixture(opts: { alicePassword: PasswordName | null; aliceMembership: Membership }): Promise<Fixture> {
  const { id: teamId } = await fxOne<{ id: string }>(
    "team insert",
    `insert into teams(slug, name) values($1, 'AIO-1217 account fixture') returning id`,
    [`aio1217-${randomUUID().slice(0, 8)}`],
  );
  const alice = await seedAccount("alice", opts.alicePassword === null ? null : PASSWORDS[opts.alicePassword]);
  const bob = await seedAccount("bob", PASSWORDS.bob);
  const carol = await seedAccount("carol", null);
  await seedMember(teamId, bob, "active");
  if (opts.aliceMembership !== "none") await seedMember(teamId, alice, opts.aliceMembership);
  await fxOne(
    "audit insert",
    `insert into audit_log(team_id, actor_kind, action, target_type, target_id)
     values($1, 'system', 'aio1217.fixture', 'auth_user', $2) returning id::text as id`,
    [teamId, bob.user.id],
  );

  const aliceMemberships = await membershipsOf(alice);
  premise(
    "Alice's memberships",
    aliceMemberships,
    opts.aliceMembership === "none"
      ? []
      : [{ team_id: teamId, status: opts.aliceMembership, auth_user_id: alice.user.id }],
  );
  premise("Bob's memberships", await membershipsOf(bob), [
    { team_id: teamId, status: "active", auth_user_id: bob.user.id },
  ]);
  premise("Carol's memberships", await membershipsOf(carol), []);

  const seeded = await world();
  const accounts = [alice, bob, carol];
  premise(
    "the accounts are distinct",
    {
      ids: new Set(accounts.map((account) => account.user.id)).size,
      emails: new Set(accounts.map((account) => account.user.email)).size,
    },
    { ids: accounts.length, emails: accounts.length },
  );
  premise(
    "stored hashes are the seeded ones, and Carol's is unset",
    [storedHash(seeded, alice), storedHash(seeded, bob), storedHash(seeded, carol), carol.seededHash],
    [alice.seededHash, bob.seededHash, null, null],
  );
  premise(
    "snapshot contents",
    {
      authUsers: seeded.auth_users.map((row) => row.id).sort(),
      authTokenEmails: seeded.auth_tokens.map((row) => row.email).sort(),
      members: seeded.members.length,
      builtinRows: seeded.group_members.length,
      fixtureAuditRows: seeded.audit_log.filter((row) => row.action === "aio1217.fixture").length,
    },
    {
      authUsers: accounts.map((account) => account.user.id).sort(),
      authTokenEmails: accounts.map((account) => account.user.email).sort(),
      members: opts.aliceMembership === "none" ? 1 : 2,
      builtinRows: opts.aliceMembership === "none" ? 1 : 2,
      fixtureAuditRows: 1,
    },
  );

  // Expired means: the right secret and the claims a session needs, inside a window that has closed.
  // What the real verifier does with it is the cases' observation, not a premise.
  const expiredAlice = await expiredSession(alice.user);
  const whileLive = await jwtVerify(expiredAlice, new TextEncoder().encode(authSecret), {
    algorithms: ["HS256"],
    currentDate: new Date((EXPIRED_ISSUED_AT + 60) * 1000),
  });
  expect(whileLive.payload, `${FIXTURE} expired token claims`).toMatchObject({
    sub: alice.user.id,
    email: alice.user.email,
    exp: EXPIRED_AT,
  });
  premise("the expired window has closed", EXPIRED_AT * 1000 < Date.now(), true);

  return { teamId, alice, bob, carol, expiredAlice, aliceMemberships, seeded };
}

function deniedSessionCookie(identity: DeniedIdentity, fixture: Fixture): string | null {
  switch (identity) {
    case "an absent session cookie":
      return null;
    case "a validly signed but expired session":
      return fixture.expiredAlice;
  }
}

// ── one request, and what it owes ────────────────────────────────────────────────────────────────

/** A new request with its own cookie store: snapshot, run the actual export, snapshot again. */
async function request(sessionCookie: string | null, action: () => Promise<ActionResult>): Promise<Observed> {
  const jar = new Map([[OTHER_COOKIE, OTHER_COOKIE_VALUE]]);
  if (sessionCookie !== null) jar.set(SESSION_COOKIE, sessionCookie);
  const flight: InFlight = { jar, reads: [], mutations: [] };
  const arrived = [...jar];
  redirects.length = 0;

  const before = await world();
  inFlight = flight;
  let result: ActionResult;
  try {
    result = await action();
  } finally {
    inFlight = null;
  }
  const after = await world();

  return {
    result,
    before,
    after,
    arrived,
    trace: {
      readSession: flight.reads.includes(SESSION_COOKIE),
      cookieMutations: [...flight.mutations],
      redirects: [...redirects],
      jar: [...jar],
    },
  };
}

/** The identity was read from the session cookie, and the request left exactly as it arrived. */
const leftAsArrived = (seen: Observed): RequestTrace => ({
  readSession: true,
  cookieMutations: [],
  redirects: [],
  jar: seen.arrived,
});

/** A refusal: the fixed result, every snapshot row identical, Bob's hash the seeded one, Carol's still unset. */
function expectRefused(seen: Observed, fixture: Fixture, refusal: ActionResult): void {
  expect({
    result: seen.result,
    rows: seen.after,
    bobHash: storedHash(seen.after, fixture.bob),
    carolHash: storedHash(seen.after, fixture.carol),
    request: seen.trace,
  }).toStrictEqual({
    result: refusal,
    rows: seen.before,
    bobHash: fixture.bob.seededHash,
    carolHash: null,
    request: leftAsArrived(seen),
  });
}

/**
 * An admitted write: exact success, and the rowsets differ in exactly one value — Alice's
 * `password_hash` — which the real verifier accepts for `verifies` and for nothing else in `of`.
 * Only Alice's hash is factored out of `everythingElse`, so Carol's unset row is compared whole.
 */
async function expectOnlyAliceHashWritten(
  seen: Observed,
  fixture: Fixture,
  hash: { of: readonly PasswordName[]; verifies: readonly PasswordName[] },
  label = "",
): Promise<void> {
  const before = storedHash(seen.before, fixture.alice);
  const after = storedHash(seen.after, fixture.alice);
  expect(
    {
      result: seen.result,
      hashReplaced: after !== null && after !== before,
      verifies: await verifiedBy(after, hash.of),
      everythingElse: withoutHashOf(seen.after, fixture.alice),
      bobHash: storedHash(seen.after, fixture.bob),
      carolHash: storedHash(seen.after, fixture.carol),
      request: seen.trace,
    },
    label,
  ).toStrictEqual({
    result: { ok: true },
    hashReplaced: true,
    verifies: [...hash.verifies],
    everythingElse: withoutHashOf(seen.before, fixture.alice),
    bobHash: fixture.bob.seededHash,
    carolHash: null,
    request: leftAsArrived(seen),
  });
}

/** From seed to now: the member and builtin-group rowsets are the seeded ones, and so is Alice's shape. */
async function expectMembershipUntouched(fixture: Fixture): Promise<void> {
  const now = await world();
  expect({
    members: now.members,
    groupMembers: now.group_members,
    aliceMemberships: await membershipsOf(fixture.alice),
  }).toStrictEqual({
    members: fixture.seeded.members,
    groupMembers: fixture.seeded.group_members,
    aliceMemberships: fixture.aliceMemberships,
  });
}

describe("X — fixture contract", () => {
  it(
    "the accounts, passwords, sessions and snapshot are what the cases call them",
    async () => {
      for (const name of PASSWORD_NAMES) {
        expect(isPasswordStrongEnough(PASSWORDS[name]), `${FIXTURE} ${name} is not a strong input`).toBe(true);
      }
      premise("passwords are pairwise distinct", new Set(Object.values(PASSWORDS)).size, PASSWORD_NAMES.length);

      const fixture = await seedFixture({ alicePassword: "old", aliceMembership: "active" });

      // The sessions the cases sign resolve, through the real verifier, to exactly their account.
      await expect(verifySession(fixture.alice.token), FIXTURE).resolves.toStrictEqual(fixture.alice.user);
      await expect(verifySession(fixture.bob.token), FIXTURE).resolves.toStrictEqual(fixture.bob.user);
      await expect(verifySession(fixture.carol.token), FIXTURE).resolves.toStrictEqual(fixture.carol.user);

      // Each seeded hash is a real scrypt hash of its own password and of no other fixture password.
      premise("Alice's seeded hash", await verifiedBy(fixture.alice.seededHash, PASSWORD_NAMES), ["old"]);
      premise("Bob's seeded hash", await verifiedBy(fixture.bob.seededHash, PASSWORD_NAMES), ["bob"]);
      premise("the seeded hashes differ", fixture.alice.seededHash !== fixture.bob.seededHash, true);

      // Carol is the unset bystander: her own auth_users row, a NULL stored hash, no membership.
      premise(
        "Carol is a distinct unset account",
        {
          rows: fixture.seeded.auth_users.filter((row) => row.id === fixture.carol.user.id).length,
          storedHash: storedHash(fixture.seeded, fixture.carol),
          memberships: await membershipsOf(fixture.carol),
        },
        { rows: 1, storedHash: null, memberships: [] },
      );

      // The snapshot is stable: nothing writes these tables between two reads with no action.
      premise("snapshot is repeatable", await world(), fixture.seeded);
    },
    SLOW,
  );
});

describe("A — app/actions/account.ts changeMyPassword (SELF, real Postgres)", () => {
  it(
    "signed Alice, her correct current password and a strong new one: exact success, only Alice's hash changes and it verifies the new password only",
    async () => {
      const fixture = await seedFixture({ alicePassword: "old", aliceMembership: "active" });

      const seen = await request(fixture.alice.token, () => changeMyPassword(PASSWORDS.old, PASSWORDS.new));

      await expectOnlyAliceHashWritten(seen, fixture, { of: ["old", "new", "bob"], verifies: ["new"] });
      // Bob's stored hash is the same bytes and still his own credential.
      expect(storedHash(seen.after, fixture.bob)).toBe(fixture.bob.seededHash);
      expect(await verifiedBy(storedHash(seen.after, fixture.bob), ["bob", "old", "new"])).toEqual(["bob"]);
    },
    SLOW,
  );

  it(
    "a wrong current password is refused with the fixed refusal and Alice's hash is exactly unchanged",
    async () => {
      const fixture = await seedFixture({ alicePassword: "old", aliceMembership: "active" });

      const refused = await request(fixture.alice.token, () =>
        changeMyPassword(PASSWORDS.wrongCurrent, PASSWORDS.new),
      );

      expectRefused(refused, fixture, INCORRECT_CURRENT);
      expect(storedHash(refused.after, fixture.alice)).toBe(fixture.alice.seededHash);
      expect(await verifiedBy(storedHash(refused.after, fixture.alice), ["old", "new", "wrongCurrent"])).toEqual(["old"]);

      // Only the current password differed: the same session and new password are admitted.
      const admitted = await request(fixture.alice.token, () => changeMyPassword(PASSWORDS.old, PASSWORDS.new));
      await expectOnlyAliceHashWritten(admitted, fixture, { of: ["old", "new"], verifies: ["new"] }, CONTROL);
    },
    SLOW,
  );

  it(
    "Bob's correct password presented as the current one under Alice's session is refused: it is verified against the signed subject only",
    async () => {
      const fixture = await seedFixture({ alicePassword: "old", aliceMembership: "active" });
      premise("the presented password is Bob's real one", await verifiedBy(fixture.bob.seededHash, ["bob"]), ["bob"]);

      const refused = await request(fixture.alice.token, () => changeMyPassword(PASSWORDS.bob, PASSWORDS.new));

      expectRefused(refused, fixture, INCORRECT_CURRENT);
      expect({
        alice: storedHash(refused.after, fixture.alice),
        bob: storedHash(refused.after, fixture.bob),
      }).toStrictEqual({ alice: fixture.alice.seededHash, bob: fixture.bob.seededHash });

      const admitted = await request(fixture.alice.token, () => changeMyPassword(PASSWORDS.old, PASSWORDS.new));
      await expectOnlyAliceHashWritten(admitted, fixture, { of: ["old", "new", "bob"], verifies: ["new"] }, CONTROL);
    },
    SLOW,
  );

  it.each(DENIED_IDENTITIES)(
    "%s with Alice's correct current password and a strong new one is not signed in: both hashes exactly unchanged",
    async (identity) => {
      const fixture = await seedFixture({ alicePassword: "old", aliceMembership: "active" });

      const refused = await request(deniedSessionCookie(identity, fixture), () =>
        changeMyPassword(PASSWORDS.old, PASSWORDS.new),
      );

      expectRefused(refused, fixture, NOT_SIGNED_IN);
      expect({
        alice: storedHash(refused.after, fixture.alice),
        bob: storedHash(refused.after, fixture.bob),
      }).toStrictEqual({ alice: fixture.alice.seededHash, bob: fixture.bob.seededHash });

      // Only the cookie differed: the same passwords under signed Alice are admitted.
      const admitted = await request(fixture.alice.token, () => changeMyPassword(PASSWORDS.old, PASSWORDS.new));
      await expectOnlyAliceHashWritten(admitted, fixture, { of: ["old", "new"], verifies: ["new"] }, CONTROL);
    },
    SLOW,
  );
});

describe("B — app/auth/welcome/actions.ts setInitialPassword (SELF, real Postgres)", () => {
  it(
    "signed Alice with no password yet: exact success, her hash verifies the initial password, Bob is unchanged and unset Carol stays unset",
    async () => {
      const fixture = await seedFixture({ alicePassword: null, aliceMembership: "active" });

      const seen = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.initial));
      // Two accounts were unset when the request arrived, so "only if unset" alone does not pick Alice.
      premise(
        "Alice and Carol both arrive unset",
        { alice: storedHash(seen.before, fixture.alice), carol: storedHash(seen.before, fixture.carol) },
        { alice: null, carol: null },
      );

      await expectOnlyAliceHashWritten(seen, fixture, {
        of: ["initial", "replacement", "bob"],
        verifies: ["initial"],
      });
      expect(storedHash(seen.after, fixture.bob)).toBe(fixture.bob.seededHash);
      expect(await verifiedBy(storedHash(seen.after, fixture.bob), ["bob", "initial"])).toEqual(["bob"]);
      // The first set is bound to the signed subject's id: the other unset account has no hash still.
      expect(storedHash(seen.after, fixture.carol)).toBeNull();
    },
    SLOW,
  );

  it(
    "a second strong replacement is refused as already set: Alice's hash is byte-for-byte unchanged, only the initial password verifies and unset Carol stays unset",
    async () => {
      const fixture = await seedFixture({ alicePassword: null, aliceMembership: "active" });

      const first = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.initial));
      await expectOnlyAliceHashWritten(first, fixture, { of: ["initial", "replacement"], verifies: ["initial"] }, CONTROL);
      const initialHash = storedHash(first.after, fixture.alice);

      const second = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.replacement));
      // Carol is now the only unset account: the one row an unscoped only-if-unset write would reach.
      premise(
        "Alice arrives set and Carol unset",
        { alice: storedHash(second.before, fixture.alice), carol: storedHash(second.before, fixture.carol) },
        { alice: initialHash, carol: null },
      );

      expectRefused(second, fixture, ALREADY_SET);
      expect(storedHash(second.after, fixture.alice)).toBe(initialHash);
      expect(await verifiedBy(storedHash(second.after, fixture.alice), ["initial", "replacement"])).toEqual(["initial"]);
      // Alice's refused replacement did not land on the remaining unset account either.
      expect(storedHash(second.after, fixture.carol)).toBeNull();
    },
    SLOW,
  );

  it.each(DENIED_IDENTITIES)(
    "%s with a strong initial password is not signed in: Alice's and Carol's hashes stay unset and Bob's is unchanged",
    async (identity) => {
      const fixture = await seedFixture({ alicePassword: null, aliceMembership: "active" });

      const refused = await request(deniedSessionCookie(identity, fixture), () =>
        setInitialPassword(PASSWORDS.initial),
      );

      expectRefused(refused, fixture, NOT_SIGNED_IN);
      expect({
        alice: storedHash(refused.after, fixture.alice),
        bob: storedHash(refused.after, fixture.bob),
        carol: storedHash(refused.after, fixture.carol),
      }).toStrictEqual({ alice: null, bob: fixture.bob.seededHash, carol: null });

      // Only the cookie differed: the same password under signed Alice is admitted.
      const admitted = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.initial));
      await expectOnlyAliceHashWritten(admitted, fixture, { of: ["initial"], verifies: ["initial"] }, CONTROL);
    },
    SLOW,
  );
});

describe.each(NO_ACTIVE_MEMBERSHIP)(
  "C — self-account with $shape (no active tenant membership, real Postgres)",
  ({ membership }) => {
    it(
      "sets a first password, then changes it, through the actual exports: each transition is proven on the stored hash",
      async () => {
        const fixture = await seedFixture({ alicePassword: null, aliceMembership: membership });

        const set = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.initial));
        await expectOnlyAliceHashWritten(set, fixture, { of: ["initial", "new", "bob"], verifies: ["initial"] });

        const changed = await request(fixture.alice.token, () =>
          changeMyPassword(PASSWORDS.initial, PASSWORDS.new),
        );
        await expectOnlyAliceHashWritten(changed, fixture, { of: ["initial", "new", "bob"], verifies: ["new"] });

        // Neither write created, linked or activated a membership, and Bob's credential is intact.
        await expectMembershipUntouched(fixture);
        expect(await verifiedBy(storedHash(changed.after, fixture.bob), ["bob", "initial", "new"])).toEqual(["bob"]);
        // Neither write reached the other unset account: not the first set, not the change after it.
        expect({
          afterSet: storedHash(set.after, fixture.carol),
          afterChange: storedHash(changed.after, fixture.carol),
        }).toStrictEqual({ afterSet: null, afterChange: null });
      },
      SLOW,
    );

    it(
      "the already-set and wrong-current controls still refuse and leave the stored hash exactly unchanged",
      async () => {
        const fixture = await seedFixture({ alicePassword: null, aliceMembership: membership });

        const set = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.initial));
        await expectOnlyAliceHashWritten(set, fixture, { of: ["initial"], verifies: ["initial"] }, CONTROL);
        const initialHash = storedHash(set.after, fixture.alice);

        const again = await request(fixture.alice.token, () => setInitialPassword(PASSWORDS.replacement));
        expectRefused(again, fixture, ALREADY_SET);

        const wrong = await request(fixture.alice.token, () =>
          changeMyPassword(PASSWORDS.wrongCurrent, PASSWORDS.new),
        );
        expectRefused(wrong, fixture, INCORRECT_CURRENT);

        expect(storedHash(wrong.after, fixture.alice)).toBe(initialHash);
        expect(
          await verifiedBy(storedHash(wrong.after, fixture.alice), ["initial", "replacement", "wrongCurrent", "new"]),
        ).toEqual(["initial"]);
        // The already-set refusal and the wrong-current refusal both left the other unset account unset.
        expect({
          afterAlreadySet: storedHash(again.after, fixture.carol),
          afterWrongCurrent: storedHash(wrong.after, fixture.carol),
        }).toStrictEqual({ afterAlreadySet: null, afterWrongCurrent: null });
        await expectMembershipUntouched(fixture);

        // Only the current password differed: this membership-less account's own change is admitted.
        const admitted = await request(fixture.alice.token, () =>
          changeMyPassword(PASSWORDS.initial, PASSWORDS.new),
        );
        await expectOnlyAliceHashWritten(admitted, fixture, { of: ["initial", "new"], verifies: ["new"] }, CONTROL);
      },
      SLOW,
    );
  },
);
