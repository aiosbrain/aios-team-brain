import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

/**
 * AIO-1208 — denial evidence for the registered authentication owners
 * (docs/design/aio1208-route-auth-inventory.md, "Registered authority evidence table").
 *
 * The route-auth inventory proves a handler CALLS a registered owner. It cannot prove the owner
 * refuses. Each block below therefore executes the ACTUAL owner — never a mocked verdict of the
 * owner itself — at its normal dependency seam: the request cookie store, the data client, and the
 * lower-layer credential verifier. The data client is an in-memory table set that really applies
 * the owner's `.eq(...)` filters, so "member of another team only" is refused by the owner's own
 * predicate, not by a canned answer. Real-Postgres behaviour of the lower layers stays in the
 * data-mechanics tier; this file is the owner-composition proof.
 */

type Row = Record<string, unknown>;
type Envelope = { data: unknown; error: { message: string } | null };
interface Chain extends PromiseLike<Envelope> {
  select(spec?: string): Chain;
  update(values: unknown): Chain;
  eq(column: string, value: unknown): Chain;
  maybeSingle(): Promise<Envelope>;
}

const h = vi.hoisted(() => ({
  cookie: null as string | null,
  tables: {} as Record<string, Record<string, unknown>[]>,
  failing: new Set<string>(),
  writes: [] as string[],
  audit: vi.fn(),
  verifyAgentToken: vi.fn(),
  markAgentTokenUsed: vi.fn(),
  verifyGatewayCredential: vi.fn(),
  actualVerifyGatewayCredential: null as null | ((authorization: string | null) => Promise<unknown>),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
  actualWithTransaction: null as null | ((fn: never) => Promise<unknown>),
  actualGetPool: null as null | (() => unknown),
}));

/** PostgREST-shaped reads over `h.tables`, honouring every `.eq` the owner applies. */
const db = {
  from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let write = false;
    const failure = (): Envelope | null =>
      h.failing.has(table) ? { data: null, error: { message: `${table} unavailable` } } : null;
    const matches = (): Row[] =>
      (h.tables[table] ?? []).filter((candidate) => filters.every(([column, value]) => candidate[column] === value));
    const chain: Chain = {
      select: () => chain,
      update: () => {
        write = true;
        h.writes.push(table);
        return chain;
      },
      eq: (column, value) => {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => {
        const failed = failure();
        if (failed) return failed;
        const found = matches();
        return found.length > 1
          ? { data: null, error: { message: "multiple rows" } }
          : { data: found[0] ?? null, error: null };
      },
      then: (onfulfilled, onrejected) =>
        Promise.resolve<Envelope>(failure() ?? { data: write ? null : matches(), error: null }).then(
          onfulfilled,
          onrejected,
        ),
    };
    return chain;
  },
};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (h.cookie !== null && name === "aios_session" ? { name, value: h.cookie } : undefined),
  }),
}));
vi.mock("@/lib/db/server", () => ({ serverClient: async () => db }));
vi.mock("@/lib/db/admin", () => ({ adminClient: () => db }));
vi.mock("@/lib/api/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/access/agent-tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/access/agent-tokens")>()),
  verifyAgentToken: h.verifyAgentToken,
  markAgentTokenUsed: h.markAgentTokenUsed,
}));
// The two entries to Postgres under the real gateway verifier: its lookup opens `withTransaction`,
// which checks a client out of `getPool()`. Both stay the ACTUAL functions behind a counting
// pass-through (restored before every test), so a test can arm them to throw and assert zero calls
// without depending on whether a database happens to be configured.
vi.mock("@/lib/db/pg/pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg/pool")>();
  h.actualGetPool = actual.getPool;
  return { ...actual, getPool: () => h.getPool() };
});
vi.mock("@/lib/db/pg/tx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/pg/tx")>();
  h.actualWithTransaction = actual.withTransaction;
  return { ...actual, withTransaction: (fn: never) => h.withTransaction(fn) };
});
vi.mock("@/lib/gateway/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gateway/persistence")>();
  h.actualVerifyGatewayCredential = actual.authenticateGatewayServiceCredential;
  return {
    ...actual,
    authenticateGatewayServiceCredential: (authorization: string | null) => h.verifyGatewayCredential(authorization),
  };
});

const { authenticateApiKey, authenticateAgentToken } = await import("@/lib/api/auth");
const { getSessionUser } = await import("@/lib/auth/session");
const { signSession } = await import("@/lib/auth/pg-session");
const { currentMember } = await import("@/lib/auth/guard");
const { resolveChatOwner } = await import("@/lib/chat/session");
const { authenticateGatewayRequest } = await import("@/lib/gateway/http");
const { GatewayAuthenticationError } = await import("@/lib/gateway/persistence");
const { GATEWAY_CONTRACT_VERSION } = await import("@/lib/api/version");

const AUTH_SECRET = "auth-wrapper-evidence-secret-not-for-production";
const TEAM = { id: "team-a", slug: "acme" };
const OTHER_TEAM = { id: "team-b", slug: "other" };
const USER = { id: "user-1", email: "alex@example.test" };
const MEMBER_ID = "member-a1";
const EVERYONE = { slug: "everyone", is_builtin: true };

const member = (over: Row = {}): Row => ({
  id: MEMBER_ID,
  team_id: TEAM.id,
  auth_user_id: USER.id,
  status: "active",
  role: "admin",
  ...over,
});
const everyoneRow = (teamId = TEAM.id, memberId = MEMBER_ID): Row => ({
  team_id: teamId,
  member_id: memberId,
  group_id: `everyone-${teamId}`,
  groups: EVERYONE,
});

const auditReasons = () =>
  h.audit.mock.calls.map(([, entry]) => (entry as { meta?: { reason?: string } }).meta?.reason);

async function signedWith(secret: string, claims: Record<string, unknown>, subject: string | null, expiry = "600s") {
  const jwt = new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(expiry);
  if (subject !== null) jwt.setSubject(subject);
  return jwt.sign(new TextEncoder().encode(secret));
}

beforeAll(() => {
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
});
afterAll(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  h.cookie = await signSession(USER);
  h.tables = {
    teams: [TEAM, OTHER_TEAM],
    members: [member()],
    group_members: [everyoneRow()],
  };
  h.failing.clear();
  h.writes = [];
  h.audit.mockReset().mockResolvedValue(undefined);
  h.verifyAgentToken.mockReset();
  h.markAgentTokenUsed.mockReset().mockResolvedValue(undefined);
  h.verifyGatewayCredential
    .mockReset()
    .mockImplementation((authorization: string | null) => h.actualVerifyGatewayCredential!(authorization));
  h.withTransaction.mockReset().mockImplementation((fn: never) => h.actualWithTransaction!(fn));
  h.getPool.mockReset().mockImplementation(() => h.actualGetPool!());
});

describe("getSessionUser — actual cookie wrapper over real session verification", () => {
  it("returns null with no session cookie", async () => {
    h.cookie = null;
    await expect(getSessionUser()).resolves.toBeNull();
  });

  it("returns null for a garbage, tampered, foreign-signed or expired cookie", async () => {
    const valid = await signSession(USER);
    const candidates = {
      garbage: "not-a-jwt",
      tampered: valid.slice(0, -3) + (valid.endsWith("a") ? "bbb" : "aaa"),
      "foreign-signed": await signedWith("a-completely-different-signing-secret", { email: USER.email }, USER.id),
      expired: await signedWith(AUTH_SECRET, { email: USER.email }, USER.id, "-1s"),
      "missing subject": await signedWith(AUTH_SECRET, { email: USER.email }, null),
      "missing email": await signedWith(AUTH_SECRET, {}, USER.id),
    };
    for (const [name, cookie] of Object.entries(candidates)) {
      h.cookie = cookie;
      await expect(getSessionUser(), name).resolves.toBeNull();
    }
  });

  it("fails closed when the signing secret is unavailable", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    try {
      await expect(getSessionUser()).resolves.toBeNull();
    } finally {
      vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
    }
  });

  it("admits a valid synthetic session as identity only — membership is not this wrapper's claim", async () => {
    h.tables.members = [];
    await expect(getSessionUser()).resolves.toEqual(USER);
  });
});

describe("currentMember — actual helper at the session and server-data seams", () => {
  it("returns null without a session", async () => {
    h.cookie = null;
    await expect(currentMember(TEAM.id)).resolves.toBeNull();
  });

  it("returns null for an absent, disabled or merely invited membership", async () => {
    h.tables.members = [];
    await expect(currentMember(TEAM.id)).resolves.toBeNull();
    for (const status of ["disabled", "invited"]) {
      h.tables.members = [member({ status })];
      await expect(currentMember(TEAM.id), status).resolves.toBeNull();
    }
  });

  it("returns null when the user's only membership is in another team", async () => {
    h.tables.members = [member({ id: "member-b1", team_id: OTHER_TEAM.id })];
    h.tables.group_members = [everyoneRow(OTHER_TEAM.id, "member-b1")];
    await expect(currentMember(TEAM.id)).resolves.toBeNull();
  });

  it("returns null for another user's active membership in the same team", async () => {
    h.tables.members = [member({ auth_user_id: "user-2" })];
    await expect(currentMember(TEAM.id)).resolves.toBeNull();
  });

  it("admits the same-team active member with membership-derived posture", async () => {
    await expect(currentMember(TEAM.id)).resolves.toEqual({
      id: MEMBER_ID,
      role: "admin",
      tier: "team",
      userId: USER.id,
    });
  });

  it("derives posture from THIS team's Everyone row only", async () => {
    h.tables.group_members = [everyoneRow(OTHER_TEAM.id, MEMBER_ID), { ...everyoneRow(), groups: { slug: "everyone", is_builtin: false } }];
    await expect(currentMember(TEAM.id)).resolves.toMatchObject({ id: MEMBER_ID, tier: "external" });
  });

  it("propagates a posture read failure instead of defaulting", async () => {
    h.failing.add("group_members");
    await expect(currentMember(TEAM.id)).rejects.toThrow(/posture read failed/);
  });
});

describe("resolveChatOwner — actual helper at the session and server-data seams", () => {
  it("returns null without a session", async () => {
    h.cookie = null;
    await expect(resolveChatOwner(TEAM.slug)).resolves.toBeNull();
  });

  it("returns null for an unknown team", async () => {
    await expect(resolveChatOwner("no-such-team")).resolves.toBeNull();
  });

  it("returns null for a disabled or invited membership", async () => {
    for (const status of ["disabled", "invited"]) {
      h.tables.members = [member({ status })];
      await expect(resolveChatOwner(TEAM.slug), status).resolves.toBeNull();
    }
  });

  it("returns null when the user is an active member of a different team only", async () => {
    h.tables.members = [member({ id: "member-b1", team_id: OTHER_TEAM.id })];
    await expect(resolveChatOwner(TEAM.slug)).resolves.toBeNull();
    // Control: the same row does own conversations in ITS team.
    await expect(resolveChatOwner(OTHER_TEAM.slug)).resolves.toEqual({ teamId: OTHER_TEAM.id, memberId: "member-b1" });
  });

  it("admits the active same-team member as the owner pair", async () => {
    await expect(resolveChatOwner(TEAM.slug)).resolves.toEqual({ teamId: TEAM.id, memberId: MEMBER_ID });
  });
});

describe("authenticateApiKey — actual owner", () => {
  const SECRET = "secret_value";
  const keyRow = (over: Row = {}): Row => ({
    key_id: "key1",
    id: "api-key-row-1",
    team_id: TEAM.id,
    member_id: MEMBER_ID,
    key_hash: createHash("sha256").update(SECRET).digest("hex"),
    revoked_at: null,
    members: { actor_handle: "alex", status: "active", role: "lead", display_name: "Alex", email: USER.email },
    teams: { slug: TEAM.slug },
    ...over,
  });
  const request = (authorization?: string, team?: string) => {
    const headers = new Headers();
    if (authorization !== undefined) headers.set("Authorization", authorization);
    if (team !== undefined) headers.set("X-AIOS-Team", team);
    return new Request("https://brain.example.test/api/v1/me", { headers });
  };
  const VALID = `Bearer aios_key1_${SECRET}`;

  beforeEach(() => {
    h.tables.api_keys = [keyRow()];
  });

  it.each([
    ["a missing Authorization header", () => request(), "malformed_bearer"],
    ["a non-key bearer", () => request("Bearer something-else"), "malformed_bearer"],
    ["a delegated agent token on a member-key route", () => request("Bearer aiosd_tok1_secret"), "malformed_bearer"],
    ["an unknown key id", () => request(`Bearer aios_nokey_${SECRET}`), "unknown_or_revoked_key"],
    ["a wrong secret", () => request("Bearer aios_key1_wrong_secret"), "bad_secret"],
    ["a mismatching team header", () => request(VALID, OTHER_TEAM.slug), "team_mismatch"],
  ])("refuses %s", async (_name, build, reason) => {
    await expect(authenticateApiKey(build())).resolves.toBeNull();
    expect(auditReasons()).toEqual([reason]);
    expect(h.writes).toEqual([]);
  });

  it("refuses a revoked key", async () => {
    h.tables.api_keys = [keyRow({ revoked_at: "2026-01-01T00:00:00.000Z" })];
    await expect(authenticateApiKey(request(VALID))).resolves.toBeNull();
    expect(auditReasons()).toEqual(["unknown_or_revoked_key"]);
    expect(h.writes).toEqual([]);
  });

  it.each(["disabled", "invited"])("refuses a key whose owner is %s", async (status) => {
    h.tables.api_keys = [keyRow({ members: { actor_handle: "alex", status, role: "lead", display_name: null, email: null } })];
    await expect(authenticateApiKey(request(VALID))).resolves.toBeNull();
    expect(auditReasons()).toEqual(["member_not_active"]);
    expect(h.writes).toEqual([]);
  });

  it("refuses when posture cannot be resolved — never a default tier", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.failing.add("group_members");
    try {
      await expect(authenticateApiKey(request(VALID))).resolves.toBeNull();
      expect(auditReasons()).toEqual(["posture_unresolvable"]);
    } finally {
      logged.mockRestore();
    }
  });

  it("admits a valid key with membership-derived posture", async () => {
    await expect(authenticateApiKey(request(VALID, TEAM.slug))).resolves.toEqual({
      teamId: TEAM.id,
      memberId: MEMBER_ID,
      memberTier: "team",
      memberRole: "lead",
      apiKeyId: "api-key-row-1",
      actorHandle: "alex",
      displayName: "Alex",
      email: USER.email,
      // An ordinary member key is never a connector principal (AIO-1167): the fixture's member row
      // carries no `is_connector`, and the owner reports that as an explicit `false`.
      isConnector: false,
    });
    expect(h.audit).not.toHaveBeenCalled();

    h.tables.group_members = [];
    await expect(authenticateApiKey(request(VALID))).resolves.toMatchObject({ memberTier: "external" });
  });

  it("reports connector identity from the key owner's member row alone, and only for a literal true", async () => {
    const owner = (is_connector: unknown): Row =>
      keyRow({ members: { actor_handle: "gdrive-sync", status: "active", role: "member", display_name: null, email: null, is_connector } });

    h.tables.api_keys = [owner(true)];
    await expect(authenticateApiKey(request(VALID))).resolves.toMatchObject({ isConnector: true, actorHandle: "gdrive-sync" });

    // The reserved handle, a truthy non-boolean, or a missing flag do not make a connector.
    for (const flag of [false, null, undefined, "true", 1]) {
      h.tables.api_keys = [owner(flag)];
      await expect(authenticateApiKey(request(VALID)), String(flag)).resolves.toMatchObject({
        isConnector: false,
        actorHandle: "gdrive-sync",
      });
    }
    expect(h.audit).not.toHaveBeenCalled();
  });
});

describe("authenticateAgentToken — actual owner over the token verifier seam", () => {
  const principal = {
    tokenRowId: "token-row-1",
    teamId: TEAM.id,
    memberId: MEMBER_ID,
    onBehalfOf: null,
    projectScope: ["alpha"],
    effectiveTier: "external" as const,
  };
  const request = (team?: string) => {
    const headers = new Headers({ Authorization: "Bearer aiosd_tok1_secretvalue" });
    if (team !== undefined) headers.set("X-AIOS-Team", team);
    return new Request("https://brain.example.test/api/v1/items", { headers });
  };

  it("refuses when token verification fails — no principal, no use recorded", async () => {
    h.verifyAgentToken.mockResolvedValue(null);
    await expect(authenticateAgentToken(request(TEAM.slug))).resolves.toBeNull();
    expect(h.verifyAgentToken).toHaveBeenCalledExactlyOnceWith(db, "aiosd_tok1_secretvalue");
    expect(auditReasons()).toEqual(["invalid_agent_token"]);
    expect(h.markAgentTokenUsed).not.toHaveBeenCalled();
  });

  it.each([OTHER_TEAM.id, OTHER_TEAM.slug, "no-such-team"])(
    "refuses a verified token presented for another team (%s) before returning its principal",
    async (team) => {
      h.verifyAgentToken.mockResolvedValue(principal);
      await expect(authenticateAgentToken(request(team))).resolves.toBeNull();
      expect(auditReasons()).toEqual(["team_mismatch"]);
      expect(h.markAgentTokenUsed).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, TEAM.id, TEAM.slug])("admits a verified token for its own team (header %s)", async (team) => {
    h.verifyAgentToken.mockResolvedValue(principal);
    await expect(authenticateAgentToken(request(team))).resolves.toEqual({
      kind: "agent",
      teamId: TEAM.id,
      memberId: MEMBER_ID,
      onBehalfOf: null,
      projectScope: ["alpha"],
      memberTier: "external",
      agentTokenId: "token-row-1",
    });
    expect(h.markAgentTokenUsed).toHaveBeenCalledExactlyOnceWith(db, "token-row-1");
    expect(auditReasons()).toEqual([undefined]); // the access.token_used audit, not a failure
  });
});

describe("authenticateGatewayRequest — actual wrapper over the service credential verifier seam", () => {
  const VERSIONS = {
    "x-aios-executor-version": "1.5.33",
    "x-aios-companion-version": "0.1.0",
    "x-aios-contract-version": GATEWAY_CONTRACT_VERSION,
  };
  const service = () => ({
    id: "service-1",
    teamId: TEAM.id,
    environment: "test",
    credentialId: "credential-1",
    credentialVersion: 1,
    credentialRowId: "credential-row-1",
    secretBytes: Buffer.alloc(32, 7),
  });
  const request = (headers: Record<string, string>) =>
    new Request("https://brain.example.test/api/internal/executor-gateway/v1/resolve-lease", { method: "POST", headers });
  const errorCode = async (response: unknown) => {
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("cache-control")).toBe("no-store");
    return ((await (response as Response).json()) as { error: { code: string } }).error.code;
  };

  // Synthetic, canonically encoded credential parts (16 and 32 bytes) — registered nowhere.
  const CREDENTIAL_ID = Buffer.alloc(16, 1).toString("base64url");
  const SECRET = Buffer.alloc(32, 2).toString("base64url");
  const bearer = (credentialId: string, secret: string) => `Bearer aios_gw_${credentialId}_${secret}`;
  const prohibit = (entry: typeof h.getPool, name: string) =>
    entry.mockImplementation(() => {
      throw new Error(`lookup prohibited: ${name} was reached`);
    });

  it("refuses a missing or malformed credential through the REAL verifier, before any lookup", async () => {
    // A lookup attempt would throw here and surface as the fixed 500, never as this 401.
    prohibit(h.withTransaction, "withTransaction");
    prohibit(h.getPool, "getPool");
    const refused = {
      "no authorization header": VERSIONS,
      "not a gateway bearer": { ...VERSIONS, authorization: "Bearer deliberately-invalid" },
      // Right length and alphabet, but the last character carries bits no 16/32-byte value encodes.
      "non-canonical credential id": { ...VERSIONS, authorization: bearer(`${CREDENTIAL_ID.slice(0, -1)}R`, SECRET) },
      "non-canonical secret": { ...VERSIONS, authorization: bearer(CREDENTIAL_ID, `${SECRET.slice(0, -1)}J`) },
    };
    for (const [name, headers] of Object.entries(refused)) {
      const result = await authenticateGatewayRequest(request(headers));
      expect(h.withTransaction, name).toHaveBeenCalledTimes(0);
      expect(h.getPool, name).toHaveBeenCalledTimes(0);
      expect((result as Response).status, name).toBe(401);
      await expect(errorCode(result), name).resolves.toBe("gateway_unauthorized");
    }
    expect(h.verifyGatewayCredential).toHaveBeenCalledTimes(4);
  });

  it("seam control: a well-formed credential takes the same REAL verifier into withTransaction and on to getPool", async () => {
    // Only the pool entry is armed: the actual withTransaction runs and must be what reaches it.
    // Without this, the zero-call assertions above could be watching functions the verifier never uses.
    prohibit(h.getPool, "getPool");
    const result = await authenticateGatewayRequest(
      request({ ...VERSIONS, authorization: bearer(CREDENTIAL_ID, SECRET) }),
    );
    expect(h.withTransaction).toHaveBeenCalledTimes(1);
    expect(h.getPool).toHaveBeenCalledTimes(1);
    expect((result as Response).status).toBe(500);
    await expect(errorCode(result)).resolves.toBe("gateway_internal");
  });

  it("refuses when the credential verifier rejects, returning no service principal", async () => {
    h.verifyGatewayCredential.mockRejectedValueOnce(new GatewayAuthenticationError());
    const result = await authenticateGatewayRequest(request({ ...VERSIONS, authorization: "Bearer presented" }));
    expect((result as Response).status).toBe(401);
    await expect(errorCode(result)).resolves.toBe("gateway_unauthorized");
    expect(h.verifyGatewayCredential).toHaveBeenCalledExactlyOnceWith("Bearer presented");
  });

  it("answers a verifier fault with the fixed 500, never an admission", async () => {
    h.verifyGatewayCredential.mockRejectedValueOnce(new Error("connection reset"));
    const result = await authenticateGatewayRequest(request({ ...VERSIONS, authorization: "Bearer presented" }));
    expect((result as Response).status).toBe(500);
    const body = await (result as Response).text();
    expect(JSON.parse(body).error.code).toBe("gateway_internal");
    expect(body).not.toContain("connection reset");
  });

  it.each(Object.keys(VERSIONS))("refuses a valid credential whose %s is wrong, and wipes its secret", async (header) => {
    const admitted = service();
    h.verifyGatewayCredential.mockResolvedValueOnce(admitted);
    const result = await authenticateGatewayRequest(
      request({ ...VERSIONS, authorization: "Bearer presented", [header]: "0.0.0-mismatch" }),
    );
    expect((result as Response).status).toBe(409);
    await expect(errorCode(result)).resolves.toBe("gateway_version_mismatch");
    expect(admitted.secretBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("admits a verified, correctly versioned service as its principal", async () => {
    const admitted = service();
    h.verifyGatewayCredential.mockResolvedValueOnce(admitted);
    const result = await authenticateGatewayRequest(request({ ...VERSIONS, authorization: "Bearer presented" }));
    expect(result).toBe(admitted);
    expect(admitted.secretBytes.every((byte) => byte === 7)).toBe(true);
  });
});
