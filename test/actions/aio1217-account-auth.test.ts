import { SignJWT, decodeJwt, jwtVerify } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

/**
 * AIO-1217 — the ACCOUNT protocol, unit tier (AC-06): the two SELF credential exports and the
 * sign-out own-cookie exception, executed as the actual exported functions.
 *
 * Every assertion is derived from the accepted specification's account source contract, not from
 * the implementation. The real-Postgres half (current-password verification, the only-if-null
 * write, no-active-membership accounts, hash readback) is a separately admitted supplement,
 * `test/datamechanics/server-action-account-protocol.datamechanics.test.ts`; nothing here stands in
 * for it.
 *
 *   X — the fixture's own contract: the identities, inputs and tokens are what the cases call them.
 *   P — `changeMyPassword` and `setInitialPassword`, each: an admitted Alice control, then every
 *       denied identity, the strength refusal, the honored false verdict, the propagated owner
 *       fault and the binding of the credential target to the cookie's signed subject.
 *   O — `signOutAction`: delete only `aios_session`, then redirect to `/login`, in that order, for
 *       a missing, stale or valid cookie; and what sign-out does and does not do to identity.
 *
 * Registry keys certified, as `(repository path, export name)`:
 *   P  app/actions/account.ts changeMyPassword            (protected, SELF)
 *   P  app/auth/welcome/actions.ts setInitialPassword     (protected, SELF)
 *   O  app/actions/account.ts signOutAction               (protocol exception, OUT)
 *
 * What is real: the three exports, `lib/auth/session` `getSessionUser`/`signOut`,
 * `lib/auth/pg-session` `signSession`/`verifySession` (jose HS256 against AUTH_SECRET) and
 * `lib/auth/password` `isPasswordStrongEnough`. `getSessionUser` and `verifySession` are never
 * mocked: an identity is admitted only by a cookie the real verifier accepts.
 *
 * The synthetic seams, all of them:
 *   SEAM cookies     `next/headers` `cookies` — async, resolves a recording store over a per-request
 *                    Map. Reads and outgoing mutations are recorded separately.
 *   SEAM redirect    `next/navigation` `redirect` — records the path, then throws one sentinel.
 *   SEAM credential  `@/lib/auth/pg-login` `changePassword` and `setPasswordIfUnset` only — each
 *                    records its arguments and returns or throws the verdict a case armed. Every
 *                    other pg-login export stays the actual function and is not called.
 * AUTH_SECRET is a synthetic value stubbed for this file and restored afterwards.
 *
 * One ordered ledger, `effects`, takes every outgoing effect — cookie set/delete, redirect and
 * credential-owner call — so "nothing else happened" is an equality on it, not an absence of spies.
 *
 * Each refusal case first runs the admitted control in the same test and then clears every
 * recording, so an earlier admission cannot satisfy a later proof. Denied-identity cases keep the
 * strong input and an admitting writer verdict armed: the cookie is the only thing that changed.
 *
 * Bounds of what is claimed. The credential doubles are wiring and verdict evidence: they prove the
 * action passes the signed subject and honors true/false/throw, and nothing about SQL, hashing or
 * whether a current password is correct. Calling an exported function against a cookie double does
 * not prove Set-Cookie headers, browser dispatch, a redirect status or Next action-wire behavior.
 * No team, member or membership exists anywhere in this fixture, so the admitted controls run with
 * none — the paired no-active-membership proof is the PG supplement's. Sessions are stateless JWTs:
 * sign-out deletes this request's cookie and a retained copy of the token still verifies; the last
 * O case pins that existing behavior and is not a revocation or replay-protection claim, and a
 * password change likewise promises no JWT invalidation.
 */

const FIXTURE = "FIXTURE PREMISE FAILED (setup, not a security observation):";
const CONTROL = "PRECEDING ADMITTED CONTROL FAILED (the refusal below would be vacuous):";

const h = vi.hoisted(() => ({
  /** SEAM cookies: the async `cookies()` of this request. */
  cookies: vi.fn(),
  /** SEAM redirect: records, then throws the sentinel. */
  redirect: vi.fn(),
  /** SEAM credential: the two recording owners. */
  changePassword: vi.fn(),
  setPasswordIfUnset: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("next/navigation", () => ({ redirect: h.redirect }));
vi.mock("@/lib/auth/pg-login", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/pg-login")>()),
  changePassword: h.changePassword,
  setPasswordIfUnset: h.setPasswordIfUnset,
}));

import { changeMyPassword, signOutAction } from "@/app/actions/account";
import { setInitialPassword } from "@/app/auth/welcome/actions";
import { isPasswordStrongEnough } from "@/lib/auth/password";
import { signSession, verifySession, type SessionUser } from "@/lib/auth/pg-session";
import { getSessionUser } from "@/lib/auth/session";

type PasswordAction = (...args: string[]) => Promise<{ ok: boolean; error?: string }>;

const AUTH_SECRET = "aio1217-account-auth-secret-not-for-production";
const FOREIGN_SECRET = "aio1217-account-auth-foreign-secret-not-for-production";

const ALICE: SessionUser = { id: "00000000-0000-4000-8000-00a11ce01217", email: "alice.aio1217@fixture.test" };
const BOB: SessionUser = { id: "00000000-0000-4000-8000-000b0b001217", email: "bob.aio1217@fixture.test" };

const OLD_PASSWORD = "old-password-A-123";
const NEW_PASSWORD = "new-password-A-456";
const WRONG_CURRENT_PASSWORD = "wrong-current-A-789";
const INITIAL_PASSWORD = "initial-password-A-123";
const REPLACEMENT_PASSWORD = "replacement-password-A-456";
/** Nine characters: the strength refusal. A validation case, never a denied-identity proof. */
const TOO_SHORT_NEW_PASSWORD = "short-A-1";

const SESSION_COOKIE = "aios_session";
const OTHER_COOKIE = "fixture_other_cookie";
const OTHER_COOKIE_VALUE = "aio1217-unrelated-cookie-value";

const NOT_SIGNED_IN = { ok: false, error: "not signed in" };
const TOO_SHORT = { ok: false, error: "password must be at least 10 characters" };

const DELETE_SESSION = `cookie.delete:${SESSION_COOKIE}`;
const REDIRECT_LOGIN = "redirect:/login";

/** An explicit past window (2020-01-01T00:00:00Z + 1h): expired with no clock control and no sleep. */
const EXPIRED_ISSUED_AT = 1_577_836_800;
const EXPIRED_AT = EXPIRED_ISSUED_AT + 3_600;

interface PasswordSurface {
  /** The protected-export registry key this group certifies. */
  key: string;
  action: PasswordAction;
  ownerName: "changePassword" | "setPasswordIfUnset";
  /** SEAM credential: the owner this export must call, and the one it must never call. */
  owner: Mock;
  sibling: Mock;
  strongInput: string[];
  weakInput: string[];
  /** A strong input the writer refuses, and the fixed refusal the action owes for that verdict. */
  refusedInput: string[];
  refusal: string;
}

const SURFACES: PasswordSurface[] = [
  {
    key: "app/actions/account.ts changeMyPassword",
    action: changeMyPassword,
    ownerName: "changePassword",
    owner: h.changePassword,
    sibling: h.setPasswordIfUnset,
    strongInput: [OLD_PASSWORD, NEW_PASSWORD],
    weakInput: [OLD_PASSWORD, TOO_SHORT_NEW_PASSWORD],
    refusedInput: [WRONG_CURRENT_PASSWORD, NEW_PASSWORD],
    refusal: "current password is incorrect",
  },
  {
    key: "app/auth/welcome/actions.ts setInitialPassword",
    action: setInitialPassword,
    ownerName: "setPasswordIfUnset",
    owner: h.setPasswordIfUnset,
    sibling: h.changePassword,
    strongInput: [INITIAL_PASSWORD],
    weakInput: [TOO_SHORT_NEW_PASSWORD],
    refusedInput: [REPLACEMENT_PASSWORD],
    refusal: "a password is already set for this account",
  },
];

const DENIED_IDENTITIES = [
  "an absent session cookie",
  "a malformed token",
  "a validly signed but expired token",
  "a token signed with a different secret",
] as const;
type DeniedIdentity = (typeof DENIED_IDENTITIES)[number];

const SIGN_OUT_STATES = [
  "a missing session cookie",
  "a malformed session cookie",
  "an expired session cookie",
  "a valid session cookie",
] as const;
type SignOutState = (typeof SIGN_OUT_STATES)[number];

const MALFORMED_TOKEN = "aio1217.not-a-jwt.fixture";

let tokens: { alice: string; bob: string; expired: string; wrongSignature: string; retargetedAtBob: string };

/** The cookies of the request in flight; null until a case admits one. */
let jar: Map<string, string> | null = null;
/** When set, `cookies()` does not resolve until it does. */
let cookiesGate: Promise<void> | null = null;
let redirectSentinel = new Error("AIO1217 redirect sentinel");
/** Cookie names read through the store. */
const cookieReads: string[] = [];
/** Every outgoing effect, in order: cookie mutations, redirect, credential-owner calls. */
const effects: string[] = [];

const key = (secret: string) => new TextEncoder().encode(secret);

function signedToken(user: SessionUser, secret: string, issuedAt?: number, expiresAt: number | string = "600s") {
  return new SignJWT({ email: user.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key(secret));
}

/** The copied embedded target: `token`'s header and signature around claims that name `user`. */
function retargeted(token: string, user: SessionUser): string {
  const [header, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: user.id, email: user.email })).toString("base64url");
  return [header, forged, signature].join(".");
}

function cookieStoreOver(requestJar: Map<string, string>) {
  return {
    get: (name: string) => {
      cookieReads.push(name);
      const value = requestJar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    has: (name: string) => {
      cookieReads.push(name);
      return requestJar.has(name);
    },
    getAll: () => {
      cookieReads.push("*");
      return [...requestJar].map(([name, value]) => ({ name, value }));
    },
    set: (name: string, value: string) => {
      effects.push(`cookie.set:${name}`);
      requestJar.set(name, value);
    },
    delete: (name: string) => {
      effects.push(`cookie.delete:${name}`);
      requestJar.delete(name);
    },
  };
}

/** A new request: its own store, always carrying the unrelated cookie, with or without a session. */
function beginRequest(sessionCookie: string | null): Map<string, string> {
  const requestJar = new Map([[OTHER_COOKIE, OTHER_COOKIE_VALUE]]);
  if (sessionCookie !== null) requestJar.set(SESSION_COOKIE, sessionCookie);
  jar = requestJar;
  return requestJar;
}

function arm(surface: PasswordSurface, verdict: boolean | Error): void {
  surface.owner.mockImplementation(async () => {
    effects.push(`credential:${surface.ownerName}`);
    if (verdict instanceof Error) throw verdict;
    return verdict;
  });
}

/** Clears every recording; armed verdicts and the request in flight are untouched. */
function resetHistory(): void {
  cookieReads.length = 0;
  effects.length = 0;
  for (const recorder of [h.cookies, h.redirect, h.changePassword, h.setPasswordIfUnset]) recorder.mockClear();
}

/** Signed Alice, strong input, admitting writer: the action must succeed and write for Alice. */
async function admittedAliceControl(surface: PasswordSurface): Promise<void> {
  beginRequest(tokens.alice);
  arm(surface, true);
  await expect(surface.action(...surface.strongInput), CONTROL).resolves.toStrictEqual({ ok: true });
  expect(surface.owner.mock.calls, CONTROL).toEqual([[ALICE.id, ...surface.strongInput]]);
  expect(effects, CONTROL).toEqual([`credential:${surface.ownerName}`]);
}

function deniedSessionCookie(identity: DeniedIdentity): string | null {
  switch (identity) {
    case "an absent session cookie":
      return null;
    case "a malformed token":
      return MALFORMED_TOKEN;
    case "a validly signed but expired token":
      return tokens.expired;
    case "a token signed with a different secret":
      return tokens.wrongSignature;
  }
}

function signOutSessionCookie(state: SignOutState): string | null {
  switch (state) {
    case "a missing session cookie":
      return null;
    case "a malformed session cookie":
      return MALFORMED_TOKEN;
    case "an expired session cookie":
      return tokens.expired;
    case "a valid session cookie":
      return tokens.alice;
  }
}

/** One macrotask turn: every microtask already queued has run. Not a sleep. */
const macrotaskTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeAll(async () => {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  const alice = await signSession(ALICE);
  tokens = {
    alice,
    bob: await signSession(BOB),
    expired: await signedToken(ALICE, AUTH_SECRET, EXPIRED_ISSUED_AT, EXPIRED_AT),
    wrongSignature: await signedToken(ALICE, FOREIGN_SECRET),
    retargetedAtBob: retargeted(alice, BOB),
  };
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  jar = null;
  cookiesGate = null;
  cookieReads.length = 0;
  effects.length = 0;
  redirectSentinel = new Error("AIO1217 redirect sentinel");
  h.cookies.mockReset();
  h.cookies.mockImplementation(async () => {
    // Bound to the request in flight when `cookies()` was called, not when it resolves.
    const requestJar = jar;
    if (!requestJar) throw new Error(`${FIXTURE} cookies() called with no request admitted`);
    if (cookiesGate) await cookiesGate;
    return cookieStoreOver(requestJar);
  });
  h.redirect.mockReset();
  h.redirect.mockImplementation((path: string): never => {
    effects.push(`redirect:${path}`);
    throw redirectSentinel;
  });
  for (const surface of SURFACES) {
    surface.owner.mockReset();
    surface.owner.mockImplementation(async () => {
      effects.push(`credential:${surface.ownerName}`);
      throw new Error(`${FIXTURE} ${surface.ownerName} reached with no armed verdict`);
    });
  }
});

describe("X — fixture contract", () => {
  it("identities, inputs and tokens are what the cases call them", async () => {
    expect(ALICE.id, FIXTURE).not.toBe(BOB.id);
    expect(ALICE.email, FIXTURE).not.toBe(BOB.email);
    for (const strong of [OLD_PASSWORD, NEW_PASSWORD, WRONG_CURRENT_PASSWORD, INITIAL_PASSWORD, REPLACEMENT_PASSWORD]) {
      expect(isPasswordStrongEnough(strong), `${FIXTURE} ${strong} is not a strong input`).toBe(true);
    }
    expect(isPasswordStrongEnough(TOO_SHORT_NEW_PASSWORD), FIXTURE).toBe(false);

    await expect(verifySession(tokens.alice), FIXTURE).resolves.toStrictEqual(ALICE);
    await expect(verifySession(tokens.bob), FIXTURE).resolves.toStrictEqual(BOB);

    // Expired: the right secret and the claims a session needs. Only the clock refuses it.
    const whileLive = await jwtVerify(tokens.expired, key(AUTH_SECRET), {
      algorithms: ["HS256"],
      currentDate: new Date((EXPIRED_ISSUED_AT + 60) * 1000),
    });
    expect(whileLive.payload, FIXTURE).toMatchObject({ sub: ALICE.id, email: ALICE.email, exp: EXPIRED_AT });

    // Wrong signature: unexpired Alice claims that verify under the other secret only.
    const foreign = await jwtVerify(tokens.wrongSignature, key(FOREIGN_SECRET), { algorithms: ["HS256"] });
    expect(foreign.payload, FIXTURE).toMatchObject({ sub: ALICE.id, email: ALICE.email });

    // Re-targeted: Alice's own signature around claims that name Bob.
    expect(decodeJwt(tokens.retargetedAtBob), FIXTURE).toMatchObject({ sub: BOB.id, email: BOB.email });
    expect(tokens.retargetedAtBob.split(".")[2], FIXTURE).toBe(tokens.alice.split(".")[2]);
  });
});

describe.each(SURFACES)("P — $key (SELF credential action)", (surface) => {
  it("admitted control: signed Alice, strong input and an admitting writer succeed with one write for Alice", async () => {
    const requestJar = beginRequest(tokens.alice);
    const arrived = [...requestJar];
    arm(surface, true);

    await expect(surface.action(...surface.strongInput)).resolves.toStrictEqual({ ok: true });

    // The identity came from this request's session cookie; the passwords reached the owner unchanged.
    expect(cookieReads).toContain(SESSION_COOKIE);
    expect(surface.owner.mock.calls).toEqual([[ALICE.id, ...surface.strongInput]]);
    expect(surface.sibling).not.toHaveBeenCalled();
    // No cookie mutation, redirect or second credential call: the session is left as it arrived.
    expect(effects).toEqual([`credential:${surface.ownerName}`]);
    expect([...requestJar]).toEqual(arrived);
  });

  it.each(DENIED_IDENTITIES)("%s is not signed in: no credential call and no cookie mutation", async (identity) => {
    await admittedAliceControl(surface);
    resetHistory();

    const requestJar = beginRequest(deniedSessionCookie(identity));
    const arrived = [...requestJar];
    arm(surface, true);

    await expect(surface.action(...surface.strongInput)).resolves.toStrictEqual(NOT_SIGNED_IN);

    expect(cookieReads).toContain(SESSION_COOKIE);
    expect(surface.owner).not.toHaveBeenCalled();
    expect(surface.sibling).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
    expect([...requestJar]).toEqual(arrived);
  });

  it("a too-short new password from signed Alice is refused before the credential owner", async () => {
    await admittedAliceControl(surface);
    resetHistory();

    beginRequest(tokens.alice);
    arm(surface, true);

    await expect(surface.action(...surface.weakInput)).resolves.toStrictEqual(TOO_SHORT);

    expect(surface.owner).not.toHaveBeenCalled();
    expect(surface.sibling).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });

  it("a refusing writer verdict is honored with its fixed refusal after exactly one call for Alice", async () => {
    await admittedAliceControl(surface);
    resetHistory();

    beginRequest(tokens.alice);
    arm(surface, false);

    await expect(surface.action(...surface.refusedInput)).resolves.toStrictEqual({ ok: false, error: surface.refusal });

    expect(surface.owner.mock.calls).toEqual([[ALICE.id, ...surface.refusedInput]]);
    expect(surface.sibling).not.toHaveBeenCalled();
    expect(effects).toEqual([`credential:${surface.ownerName}`]);
  });

  it("a credential-owner fault rejects with that fault, never a success result", async () => {
    await admittedAliceControl(surface);
    resetHistory();

    beginRequest(tokens.alice);
    const fault = new Error("AIO1217 synthetic credential-owner fault");
    arm(surface, fault);

    await expect(surface.action(...surface.strongInput)).rejects.toBe(fault);

    expect(surface.owner.mock.calls).toEqual([[ALICE.id, ...surface.strongInput]]);
    expect(surface.sibling).not.toHaveBeenCalled();
    expect(effects).toEqual([`credential:${surface.ownerName}`]);
  });

  it("the credential target is the cookie's signed subject: Alice's session writes Alice, Bob's writes Bob", async () => {
    beginRequest(tokens.alice);
    arm(surface, true);
    await expect(surface.action(...surface.strongInput)).resolves.toStrictEqual({ ok: true });
    expect(surface.owner.mock.calls).toEqual([[ALICE.id, ...surface.strongInput]]);
    expect(surface.owner.mock.calls.flat()).not.toContain(BOB.id);

    resetHistory();

    beginRequest(tokens.bob);
    await expect(surface.action(...surface.strongInput)).resolves.toStrictEqual({ ok: true });
    expect(surface.owner.mock.calls).toEqual([[BOB.id, ...surface.strongInput]]);
    expect(surface.owner.mock.calls.flat()).not.toContain(ALICE.id);
  });

  it("a trailing copied Bob target argument from signed Alice still writes Alice only", async () => {
    beginRequest(tokens.alice);
    arm(surface, true);

    await expect(surface.action(...surface.strongInput, BOB.id)).resolves.toStrictEqual({ ok: true });

    expect(surface.owner.mock.calls).toEqual([[ALICE.id, ...surface.strongInput]]);
    expect(surface.sibling).not.toHaveBeenCalled();
    expect(effects).toEqual([`credential:${surface.ownerName}`]);
  });

  it("Alice's token re-targeted at Bob is not signed in and never writes Bob", async () => {
    await admittedAliceControl(surface);
    resetHistory();

    beginRequest(tokens.retargetedAtBob);
    arm(surface, true);

    await expect(surface.action(...surface.strongInput)).resolves.toStrictEqual(NOT_SIGNED_IN);

    expect(surface.owner).not.toHaveBeenCalled();
    expect(surface.sibling).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
  });
});

describe("O — app/actions/account.ts signOutAction (own-cookie protocol exception)", () => {
  it.each(SIGN_OUT_STATES)("%s: deletes only aios_session, then redirects to /login", async (state) => {
    const requestJar = beginRequest(signOutSessionCookie(state));

    await expect(signOutAction()).rejects.toBe(redirectSentinel);

    expect(effects).toEqual([DELETE_SESSION, REDIRECT_LOGIN]);
    expect([...requestJar]).toEqual([[OTHER_COOKIE, OTHER_COOKIE_VALUE]]);
    expect(h.changePassword).not.toHaveBeenCalled();
    expect(h.setPasswordIfUnset).not.toHaveBeenCalled();
  });

  it("awaits the cookie owner before redirecting: nothing is deleted or redirected while cookies() is held", async () => {
    const requestJar = beginRequest(tokens.alice);
    let release: () => void = () => {};
    cookiesGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const settled: unknown[] = [];
    const pending = signOutAction().then(
      () => settled.push("resolved"),
      (error: unknown) => settled.push(error),
    );
    try {
      await macrotaskTurn();
      expect(h.cookies, `${FIXTURE} sign-out never asked for the cookie store`).toHaveBeenCalledTimes(1);
      expect(effects).toEqual([]);
      expect(settled).toEqual([]);
      expect(requestJar.has(SESSION_COOKIE)).toBe(true);
    } finally {
      release();
    }
    await pending;

    expect(settled).toHaveLength(1);
    expect(settled[0]).toBe(redirectSentinel);
    expect(effects).toEqual([DELETE_SESSION, REDIRECT_LOGIN]);
    expect([...requestJar]).toEqual([[OTHER_COOKIE, OTHER_COOKIE_VALUE]]);
  });

  it("removes this request's identity only: a retained copy of the token still verifies (stateless, not revocation)", async () => {
    const copy = tokens.alice;
    const requestJar = beginRequest(copy);
    await expect(getSessionUser(), CONTROL).resolves.toStrictEqual(ALICE);
    resetHistory();

    await expect(signOutAction()).rejects.toBe(redirectSentinel);
    expect(effects).toEqual([DELETE_SESSION, REDIRECT_LOGIN]);

    // The same request store no longer carries an identity.
    await expect(getSessionUser()).resolves.toBeNull();

    // The existing stateless behavior: the token itself is untouched, here and in another request.
    await expect(verifySession(copy)).resolves.toStrictEqual(ALICE);
    const secondJar = beginRequest(copy);
    await expect(getSessionUser()).resolves.toStrictEqual(ALICE);
    expect(requestJar.has(SESSION_COOKIE)).toBe(false);
    expect(secondJar.get(SESSION_COOKIE)).toBe(copy);

    expect(effects).toEqual([DELETE_SESSION, REDIRECT_LOGIN]);
    expect(h.changePassword).not.toHaveBeenCalled();
    expect(h.setPasswordIfUnset).not.toHaveBeenCalled();
  });
});
