import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";

/**
 * The Google Drive CONNECTION acquisition order (AIO-1167).
 *
 * Spec. Every path that locks a Drive connection takes its locks in one order:
 *
 *   team identity authority → [named integration advisory: OAuth publication only]
 *     → integration + connection-authority rows → member / API-key rows
 *
 *   1. The identity authority is FIRST on every such path — OAuth publication, Admin test/config,
 *      connector provisioning/rotation, and the bound-principal execution paths — including the
 *      ones that change no identity. Each locks a connection and then a member; a roster writer
 *      holds the identity authority before a member row, and a hard deletion's foreign-key actions
 *      then reach the connection. Taken late (or never), the two orders cross.
 *   2. No member or API-key row is locked before the connection rows.
 *   3. OAUTH PUBLICATION is one transaction. An ABSENT connection is reserved first, with no
 *      `created_by` (so the reservation takes no member lock), create-or-read-winner; reusable
 *      config and credential are read from the row AFTER it is locked; a lost Admin authorization
 *      or an incomplete credential rolls back everything, the reservation included; nothing is
 *      retried.
 *
 * The connection below records each statement and answers from a script. The real-Postgres
 * counterpart is `test/datamechanics/gdrive-oauth-lock-order.datamechanics.test.ts`.
 */

type Row = Record<string, unknown>;
type Reply = Row[] | Error | undefined;
type Entry = { sql: string; params: unknown[] };

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();

class ScriptedConnection {
  readonly log: Entry[] = [];
  readonly release = vi.fn();
  private lockTimeout = "0";

  constructor(private readonly respond: (sql: string, params: unknown[], log: Entry[]) => Reply) {}

  async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
    const sql = norm(text);
    this.log.push({ sql, params });
    const command = text.trim().split(/\s+/)[0].toUpperCase();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [], rowCount: null, command };
    if (sql === "show lock_timeout") return { rows: [{ lock_timeout: this.lockTimeout }], rowCount: 1, command };
    if (sql.startsWith("select set_config('lock_timeout'")) {
      this.lockTimeout = String(params[0]);
      return { rows: [], rowCount: 1, command };
    }
    const reply = this.respond(sql, params, this.log);
    if (reply instanceof Error) throw reply;
    return { rows: reply ?? [], rowCount: reply?.length ?? 0, command };
  }

  /** Statements that are not transaction control or `lock_timeout` plumbing. */
  get work(): Entry[] {
    return this.log.filter((entry) =>
      !["begin", "commit", "rollback", "show lock_timeout"].includes(entry.sql) &&
      !entry.sql.startsWith("select set_config('lock_timeout'"));
  }

  count(sql: string): number {
    return this.log.filter((entry) => entry.sql === sql).length;
  }
}

const h = vi.hoisted(() => ({ connection: null as unknown }));

vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    async connect(): Promise<unknown> {
      return h.connection;
    }
    async query(text: string, params?: unknown[]): Promise<unknown> {
      return (h.connection as { query(text: string, params?: unknown[]): Promise<unknown> }).query(text, params);
    }
  },
  types: { setTypeParser(): void {} },
}));

import {
  acquireGdriveAdminTestAuthority,
  acquireGdriveExecution,
  authorizeGdriveAdminTestCall,
  authorizeGdriveProviderCall,
  checkpointGdriveExecution,
  provisionGdriveConnectorPrincipal,
  publishGdriveVerifiedConfig,
  releaseGdriveExecution,
  type GdriveAdminTestAuthority,
} from "@/lib/integrations/gdrive-authority";
import {
  IncompleteGoogleOAuthPairError,
  InvalidGoogleOAuthInitiatorError,
  publishGoogleDriveOAuthCredential,
} from "@/lib/integrations/gdrive-oauth";
import { decryptSecret, encryptSecret } from "@/lib/secrets/crypto";

function use(connection: ScriptedConnection): ScriptedConnection {
  h.connection = connection;
  return connection;
}

const TEAM = "10000000-0000-4000-8000-000000000001";
const INTEGRATION = "20000000-0000-4000-8000-000000000002";
const ADMIN = "30000000-0000-4000-8000-000000000003";
const AUDIENCE = "4a000000-0000-4000-8000-000000000001";
const OWNER = "owner-1";
const NAME = "company-docs";

// ── statement classes ──────────────────────────────────────────────────────────────────────────
const advisoryKey = (e: Entry) => (e.sql.includes("pg_advisory_xact_lock(hashtextextended(") ? String(e.params[0]) : "");
const isIdentityLock = (e: Entry) => advisoryKey(e) === `${TEAM}:identity-authority`;
const isNamedLock = (e: Entry) => advisoryKey(e) === `${TEAM}:gdrive:${NAME}`;
const isConnectionLock = (e: Entry) => e.sql.includes("from integrations i") && e.sql.endsWith("for update of i, a");
const isAdminLock = (e: Entry) => e.sql === "select role,status from members where id=$1 and team_id=$2 for update";
const isPrincipalLock = (e: Entry) => e.sql.includes("from api_keys k") && e.sql.endsWith("for update of k, m");
const isIdRead = (e: Entry) => e.sql === "select id from integrations where team_id=$1 and type='gdrive' and name=$2";
const isReservation = (e: Entry) => e.sql.startsWith("insert into integrations (") && e.sql.includes(" do nothing");
const isWinnerRead = (e: Entry) => e.sql.startsWith("select id from integrations where team_id = $1");
const isPublication = (e: Entry) => e.sql.startsWith("insert into integrations (") && e.sql.includes(" do update set ");
const isSecretWrite = (e: Entry) => e.sql.startsWith("update integrations set secret_ciphertext");
const isIdentityMapRead = (e: Entry) => e.sql.startsWith("select id, email, actor_handle, status from members");
/** Any statement that locks a member or API-key row. */
const isMemberRowLock = (e: Entry) => isAdminLock(e) || isPrincipalLock(e)
  || (/\bfrom members\b/.test(e.sql) && / for (update|share|key share|no key update)\b/.test(e.sql));
const isWrite = (e: Entry) => /^(insert|update|delete) /.test(e.sql);

const indexOf = (entries: Entry[], match: (e: Entry) => boolean) => entries.findIndex(match);
const which = (entries: Entry[], match: (e: Entry) => boolean) => entries.filter(match);

const OAUTH_SECRET = { client_id: "oauth-client", client_secret: "client-secret", refresh_token: "stored-refresh", account_subject: "subject:acct-1" };

/** A scripted database holding (or not holding) one Drive connection. */
function database(opts: {
  /** The id the by-name read returns, per call (last repeats). `null` = absent. */
  named?: (string | null)[];
  /** What the reservation insert returns: its own row, or nothing when a concurrent creator won. */
  reservationWins?: boolean;
  config?: Record<string, unknown>;
  secret?: Record<string, unknown> | null;
  status?: string;
  admin?: Row | null;
  progressRevision?: number;
} = {}) {
  const named = opts.named ?? [INTEGRATION];
  let reads = 0;
  const secret = opts.secret === undefined ? OAUTH_SECRET : opts.secret;
  const ciphertext = secret ? encryptSecret(JSON.stringify(secret)) : null;
  return (sql: string, params: unknown[]): Reply => {
    const e: Entry = { sql, params };
    if (isIdRead(e)) {
      const id = named[Math.min(reads++, named.length - 1)];
      return id ? [{ id }] : [];
    }
    if (isReservation(e)) return opts.reservationWins === false ? [] : [{ id: INTEGRATION }];
    if (isWinnerRead(e)) return [{ id: INTEGRATION }];
    if (isConnectionLock(e)) {
      return [{
        integration_id: INTEGRATION, team_id: TEAM, status: opts.status ?? "enabled",
        config: opts.config ?? { authMode: "oauth", fileIds: ["Kept"], audienceProjectIds: [AUDIENCE] },
        secret_ciphertext: ciphertext,
        generation: 3, scope_hash: "scope", credential_revision: 2,
        connector_member_id: "member", connector_api_key_id: "key",
        lease_owner: OWNER, fence: 5, lease_until: new Date(Date.now() + 60_000).toISOString(),
        progress: {}, progress_revision: opts.progressRevision ?? 1,
      }];
    }
    if (isAdminLock(e)) return opts.admin === null ? [] : [opts.admin ?? { role: "admin", status: "active" }];
    if (isPrincipalLock(e)) return [{ valid: true }];
    if (isPublication(e)) return [{ id: INTEGRATION, status: "enabled" }];
    if (/^select id, slug from projects /.test(sql)) return (params[1] as string[]).map((id) => ({ id, slug: "docs" }));
    if (sql.includes("exists(select 1 from project_groups")) return (params[1] as string[]).map((id) => ({ id, granted: true }));
    if (sql.startsWith("update gdrive_connection_authority")) {
      return [{ lease_until: new Date(Date.now() + 600_000).toISOString(), progress_revision: 2, progress: {} }];
    }
    if (sql.startsWith("update integrations set config=$1::jsonb")) return [{ id: INTEGRATION }];
    return [];
  };
}

const connector = {
  teamId: TEAM, memberId: "member", apiKeyId: "key", memberTier: "team", memberRole: "member",
  actorHandle: "gdrive-sync", displayName: "Google Drive Sync", email: null, isConnector: true,
} as unknown as ApiAuth;
const execution = { integrationId: INTEGRATION, generation: 3, fence: 5, owner: OWNER };
const adminAuthority: GdriveAdminTestAuthority = {
  integrationId: INTEGRATION, teamId: TEAM, memberId: ADMIN, generation: 3, credentialRevision: 2,
  config: { authMode: "oauth", fileIds: ["Kept"], audienceProjectIds: [AUDIENCE] },
  credential: { clientId: "oauth-client", clientSecret: "client-secret", refreshToken: "stored-refresh" },
};

/** identity authority → connection rows → the path's member lock; no member lock any earlier. */
function expectCanonicalOrder(c: ScriptedConnection, memberLock: (e: Entry) => boolean) {
  const work = c.work;
  const identity = indexOf(work, isIdentityLock);
  const connection = indexOf(work, isConnectionLock);
  const member = indexOf(work, memberLock);
  expect([identity, connection, member].every((index) => index >= 0), `missing a level: ${[identity, connection, member]}`).toBe(true);
  expect(identity).toBeLessThan(connection);
  expect(connection).toBeLessThan(member);
  // Nothing is LOCKED before the identity authority, and no member row before the connection.
  expect(which(work.slice(0, identity), (e) => advisoryKey(e) !== "" || / for (update|share)\b/.test(e.sql))).toEqual([]);
  expect(which(work.slice(0, connection), isMemberRowLock)).toEqual([]);
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://unit:unit@127.0.0.1:1/unit");
  vi.stubEnv("SECRETS_KEY", Buffer.alloc(32, 7).toString("base64"));
});

describe("Drive connection paths: identity authority → connection rows → member", () => {
  it("Admin test authority: acquire, per-call authorization and verified-config publication", async () => {
    const acquired = use(new ScriptedConnection(database()));
    await expect(acquireGdriveAdminTestAuthority({ teamId: TEAM, memberId: ADMIN, integrationName: NAME }))
      .resolves.toMatchObject({ integrationId: INTEGRATION, credential: { refreshToken: "stored-refresh" } });
    expectCanonicalOrder(acquired, isAdminLock);
    // The by-name lookup that precedes the boundary is a plain read.
    expect(isIdRead(acquired.work[0])).toBe(true);

    const authorized = use(new ScriptedConnection(database()));
    await authorizeGdriveAdminTestCall(adminAuthority);
    expectCanonicalOrder(authorized, isAdminLock);
    expect(isIdentityLock(authorized.work[0])).toBe(true);

    const published = use(new ScriptedConnection(database()));
    await publishGdriveVerifiedConfig(adminAuthority, { ...adminAuthority.config, fileIds: ["Kept", "Added"] });
    expectCanonicalOrder(published, isAdminLock);
    // The config write comes only after the Admin was validated under all three locks.
    expect(indexOf(published.work, isWrite)).toBeGreaterThan(indexOf(published.work, isAdminLock));
  });

  it("Admin test authority: an Admin who is gone is refused under the same order, with nothing written", async () => {
    const c = use(new ScriptedConnection(database({ admin: null })));
    await expect(publishGdriveVerifiedConfig(adminAuthority, adminAuthority.config))
      .rejects.toMatchObject({ code: "admin_authority_changed" });
    expectCanonicalOrder(c, isAdminLock);
    expect(which(c.work, isWrite)).toEqual([]);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("provisioning/rotation: the acting Admin is locked after the connection, which is after the identity authority", async () => {
    // The scripted database has no built-in groups, so provisioning stops after its lock prefix.
    const c = use(new ScriptedConnection(database()));
    await provisionGdriveConnectorPrincipal({ teamId: TEAM, integrationId: INTEGRATION, actorMemberId: ADMIN })
      .catch(() => undefined);
    expectCanonicalOrder(c, isAdminLock);
    expect(isIdentityLock(c.work[0])).toBe(true);
    // The connector member is created/updated only below all three.
    const memberWrite = indexOf(c.work, (e) => e.sql.startsWith("insert into members"));
    if (memberWrite >= 0) expect(memberWrite).toBeGreaterThan(indexOf(c.work, isAdminLock));
  });

  it.each([
    ["acquire", () => acquireGdriveExecution(connector, INTEGRATION, OWNER)],
    ["authorize provider call", () => authorizeGdriveProviderCall(connector, execution)],
    ["checkpoint", () => checkpointGdriveExecution(connector, execution, { page: "p2" }, 1)],
    ["release", () => releaseGdriveExecution(connector, execution)],
  ] as const)("bound-principal execution path (%s): the connector member is locked after the connection, after the identity authority", async (_name, call) => {
    const c = use(new ScriptedConnection(database()));
    await call();
    expectCanonicalOrder(c, isPrincipalLock);
    expect(isIdentityLock(c.work[0])).toBe(true);
    // The lease/progress write is below the whole prefix.
    expect(indexOf(c.work, isWrite)).toBeGreaterThan(indexOf(c.work, isPrincipalLock));
    expect(c.count("begin")).toBe(1);
  });
});

describe("OAuth publication: one transaction, canonical order", () => {
  const publish = (over: Partial<Parameters<typeof publishGoogleDriveOAuthCredential>[0]> = {}) =>
    publishGoogleDriveOAuthCredential({
      teamId: TEAM, memberId: ADMIN, integrationName: NAME,
      clientId: "oauth-client", clientSecret: "client-secret",
      subject: "acct-1", email: "Shared@Example.com", name: "Shared",
      refreshToken: "fresh-refresh", scopes: ["https://www.googleapis.com/auth/drive.file"],
      ...over,
    });
  /** The JSON-ish parameters of a statement, parsed where they are strings. */
  const jsonParams = (entry: Entry): Record<string, unknown>[] => entry.params.flatMap((param) => {
    if (param && typeof param === "object" && !Array.isArray(param)) return [param as Record<string, unknown>];
    if (typeof param !== "string" || !param.startsWith("{")) return [];
    try { return [JSON.parse(param) as Record<string, unknown>]; } catch { return []; }
  });
  const publishedConfig = (c: ScriptedConnection) =>
    jsonParams(which(c.work, isPublication)[0]).find((value) => value.authMode === "oauth")!;
  const publishedSecret = (c: ScriptedConnection) =>
    JSON.parse(decryptSecret(String(which(c.work, isSecretWrite)[0].params[0]))) as Record<string, unknown>;

  it("EXISTING connection: identity authority → named advisory → connection rows → initiating member → map, publication, credential", async () => {
    const c = use(new ScriptedConnection(database()));
    await publish();
    const work = c.work;
    const order = [
      indexOf(work, isIdentityLock),
      indexOf(work, isNamedLock),
      indexOf(work, isIdRead),
      indexOf(work, isConnectionLock),
      indexOf(work, isAdminLock),
      indexOf(work, isIdentityMapRead),
      indexOf(work, isPublication),
      indexOf(work, isSecretWrite),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBe(0);
    expectCanonicalOrder(c, isAdminLock);
    // An existing connection is never reserved — and so never rewritten merely to reserve it.
    expect(which(work, isReservation)).toEqual([]);
    // Nothing is written before the Admin is validated under every lock.
    expect(indexOf(work, isWrite)).toBeGreaterThan(order[4]);
    // Reusable config comes from the LOCKED row: the prior selection survives, OAuth mode is forced.
    expect(publishedConfig(c)).toMatchObject({
      fileIds: ["Kept"], audienceProjectIds: [AUDIENCE], authMode: "oauth",
      authenticatedAccount: "shared@example.com", authenticatedAccountId: "subject:acct-1",
    });
    expect(publishedSecret(c)).toMatchObject({ refresh_token: "fresh-refresh", account_subject: "subject:acct-1" });
    // One transaction, committed once.
    expect(c.count("begin")).toBe(1);
    expect(c.count("commit")).toBe(1);
    expect(c.log.at(-1)!.sql).toBe("commit");
  });

  it("ABSENT connection: reserved with no created_by BEFORE the member is locked, then locked, validated and published", async () => {
    const c = use(new ScriptedConnection(database({ named: [null], secret: null, config: {} })));
    await publish();
    const work = c.work;
    const order = [
      indexOf(work, isIdentityLock),
      indexOf(work, isNamedLock),
      indexOf(work, isIdRead),
      indexOf(work, isReservation),
      indexOf(work, isConnectionLock),
      indexOf(work, isAdminLock),
      indexOf(work, isPublication),
      indexOf(work, isSecretWrite),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expectCanonicalOrder(c, isAdminLock);

    const reservation = work[order[3]];
    // `created_by` is NULL: the initiating member's id appears nowhere in the reservation.
    const columns = reservation.sql.match(/^insert into integrations \(([^)]*)\)/)![1].split(",").map((column) => column.trim());
    expect(columns).toContain("created_by");
    expect(reservation.params[columns.indexOf("created_by")]).toBeNull();
    expect(reservation.params).not.toContain(ADMIN);
    // CREATE-or-read-winner: it can only insert, never update.
    expect(reservation.sql).toContain("on conflict (team_id, type, name) do nothing");
    expect(which(work, isReservation)).toHaveLength(1);
    // The publication that follows is the ordinary audited one, and it names the Admin.
    expect(work[order[6]].params).toContain(ADMIN);
    expect(publishedConfig(c)).toMatchObject({ authMode: "oauth", selectionState: "absent", fileIds: [] });
    expect(c.count("commit")).toBe(1);
  });

  it("ABSENT connection, concurrent creator won: the winner is READ, locked, and its config reused — not overwritten by the reservation", async () => {
    const c = use(new ScriptedConnection(database({ named: [null], reservationWins: false })));
    await publish({ refreshToken: undefined });
    const work = c.work;
    const order = [indexOf(work, isReservation), indexOf(work, isWinnerRead), indexOf(work, isConnectionLock), indexOf(work, isAdminLock), indexOf(work, isPublication)];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The winner's selection, read under its row lock, is what gets published …
    expect(publishedConfig(c)).toMatchObject({ fileIds: ["Kept"], audienceProjectIds: [AUDIENCE] });
    // … and its credential is reusable: same subject, same client, no new refresh token returned.
    expect(publishedSecret(c)).toMatchObject({ refresh_token: "stored-refresh" });
  });

  it("REUSE and CONVERSION: same subject and client keeps the stored refresh token; a service-account connection becomes OAuth", async () => {
    const reused = use(new ScriptedConnection(database({ config: { authMode: "service_account", fileIds: ["Kept"] } })));
    await publish({ refreshToken: undefined });
    expect(publishedSecret(reused)).toMatchObject({ refresh_token: "stored-refresh", client_id: "oauth-client" });
    expect(publishedConfig(reused)).toMatchObject({ authMode: "oauth", fileIds: ["Kept"] });

    // A different subject, or a different client, may not inherit the stored token.
    for (const over of [{ subject: "someone-else" }, { clientId: "another-client" }]) {
      const c = use(new ScriptedConnection(database()));
      await expect(publish({ refreshToken: undefined, ...over })).rejects.toBeInstanceOf(IncompleteGoogleOAuthPairError);
      expect(which(c.work, isWrite)).toEqual([]);
      expect(c.log.at(-1)!.sql).toBe("rollback");
    }
  });

  it.each([
    ["demoted", { role: "member", status: "active" }],
    ["deactivated", { role: "admin", status: "disabled" }],
    ["deleted", null],
  ] as const)("AUTH LOSS (%s): refused under every lock, nothing published, the reservation rolled back, not retried", async (_name, admin) => {
    for (const named of [[INTEGRATION], [null]]) {
      const c = use(new ScriptedConnection(database({ named, admin, ...(named[0] ? {} : { secret: null }) })));
      await expect(publish()).rejects.toBeInstanceOf(InvalidGoogleOAuthInitiatorError);
      expectCanonicalOrder(c, isAdminLock);
      expect(which(c.work, isPublication)).toEqual([]);
      expect(which(c.work, isSecretWrite)).toEqual([]);
      // The only write a refused publication can have made is its own reservation — and the one
      // transaction it lives in is rolled back.
      expect(which(c.work, isWrite).every(isReservation)).toBe(true);
      expect(which(c.work, isReservation)).toHaveLength(named[0] ? 0 : 1);
      expect(c.count("begin")).toBe(1);
      expect(c.count("commit")).toBe(0);
      expect(c.log.at(-1)!.sql).toBe("rollback");
    }
  });

  it("INCOMPLETE PAIR on an absent connection leaves no reservation and is not retried", async () => {
    const c = use(new ScriptedConnection(database({ named: [null], secret: null })));
    await expect(publish({ refreshToken: undefined })).rejects.toBeInstanceOf(IncompleteGoogleOAuthPairError);
    expect(which(c.work, isReservation)).toHaveLength(1);
    expect(which(c.work, isPublication)).toEqual([]);
    expect(c.count("begin")).toBe(1);
    expect(c.count("commit")).toBe(0);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("the test seam fires with every lock held and nothing published", async () => {
    const c = use(new ScriptedConnection(database()));
    let seen: Entry[] = [];
    await publishGoogleDriveOAuthCredential({
      teamId: TEAM, memberId: ADMIN, integrationName: NAME, clientId: "oauth-client",
      clientSecret: "client-secret", subject: "acct-1", email: "shared@example.com", refreshToken: "fresh-refresh",
    }, { afterLocks: async () => { seen = [...c.work]; } });
    expect(seen.some(isIdentityLock) && seen.some(isNamedLock) && seen.some(isConnectionLock) && seen.some(isAdminLock)).toBe(true);
    expect(which(seen, isWrite)).toEqual([]);
  });
});
