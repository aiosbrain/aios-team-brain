import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import type { DbClient, TransactionSession } from "@/lib/db/types";

/**
 * The Google Drive commit LOCK ORDER (AIO-1167, blocker 4).
 *
 * Spec. Every Drive writer acquires, in this order and only the levels it needs:
 *
 *   identity authority/revision → connection authority → project rows
 *     → provider identity (and its mapping row) → path identities, sorted
 *     → item-attribution advisories, sorted → item rows → dependent rows
 *
 *   1. Ingest takes the connection authority BEFORE any provider, path or item lock — the order
 *      source reconciliation has always used — so the two cannot each hold the other's next lock.
 *   2. Project rows are locked once, in ascending id order, each in the strongest mode the commit
 *      needs. A storage project that is also an audience project is write-locked and never
 *      share-locked: there is no SHARE→write upgrade for two commits to deadlock on.
 *   3. One Drive path identity has ONE key — the key the ingest session's `lockIngestIdentity` takes.
 *   4. Reconciliation takes every provider identity it will touch before its first item row.
 *   5. Every one of these outer waits runs under the 10-second `lock_timeout`, restored afterwards.
 *      A timeout (55P03) is not retried.
 *   6. What was discovered before the item locks must be what exists under them. A candidate that
 *      vanished or appeared abandons the WHOLE attempt — rollback, every lock released — which is
 *      retried from the top once, and then fails by name.
 *
 * The connection below models only what these rules turn on: it records each statement with the
 * `lock_timeout` in force when it ran, and answers from a script. The real-Postgres counterpart is
 * `test/datamechanics/gdrive-lock-order.datamechanics.test.ts`.
 */

type Row = Record<string, unknown>;
type Reply = Row[] | Error | undefined;
type Entry = { sql: string; params: unknown[]; lockTimeout: string };

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim().toLowerCase();
const sqlError = (message: string, code: string) => Object.assign(new Error(message), { code });

class ScriptedConnection {
  readonly log: Entry[] = [];
  readonly release = vi.fn();
  private lockTimeout = "0";

  constructor(private readonly respond: (sql: string, params: unknown[], log: Entry[]) => Reply = () => undefined) {}

  async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
    const sql = norm(text);
    this.log.push({ sql, params, lockTimeout: this.lockTimeout });
    const command = text.trim().split(/\s+/)[0].toUpperCase();
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
      this.lockTimeout = "0"; // transaction-local settings end with the transaction
      return { rows: [], rowCount: null, command };
    }
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
      !entry.sql.startsWith("select set_config('lock_timeout'") &&
      !/^(savepoint|release savepoint|rollback to savepoint)/.test(entry.sql));
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
  },
  types: { setTypeParser(): void {} },
}));

import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { LOCK_ACQUISITION_TIMEOUT } from "@/lib/db/pg/bounded-lock";
import { ingestApiItem } from "@/lib/ingest";
import {
  driveCollisionSafePath,
  drivePathIdentityKey,
  driveRequestPathIdentities,
  GDRIVE_INGEST_ATTEMPTS,
  GdriveIngestStateChangedError,
  lockGdriveIngestIdentities,
  orderDrivePathIdentities,
  runGdriveIngestAttempts,
} from "@/lib/ingest/gdrive-commit-locks";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { withGdriveExecutionCommit } from "@/lib/integrations/gdrive-authority";
import { ITEM_INGEST_LOCK_NS, lockIngestIdentity } from "@/lib/projects/context/transaction";

function use(connection: ScriptedConnection): ScriptedConnection {
  h.connection = connection;
  return connection;
}

const TEAM = "10000000-0000-4000-8000-000000000001";
const INTEGRATION = "20000000-0000-4000-8000-000000000002";
const OWNER = "30000000-0000-4000-8000-000000000003";
const project = (n: number) => `4a000000-0000-4000-8000-00000000000${n}`;
const item = (n: number) => `50000000-0000-4000-8000-00000000000${n}`;
const STORAGE = project(4);
const PROVIDER = "DocA";
const PATH = "gdrive/doc.md";

// ── statement classes ──────────────────────────────────────────────────────────────────────────
const isIdentityLock = (e: Entry) => e.params[0] === `${TEAM}:identity-authority`;
const isAuthorityLock = (e: Entry) => e.sql.includes("from integrations i") && e.sql.includes("for update of i, a");
const isPrincipalLock = (e: Entry) => e.sql.includes("from api_keys k") && e.sql.includes("for update of k, m");
const isProjectLock = (e: Entry) => /from projects where team_id=\$1 and id=any\(\$2::uuid\[\]\) order by id for (share|no key update)$/.test(e.sql);
const isProviderLock = (e: Entry) => e.sql.includes("pg_advisory_xact_lock(hashtextextended(") && String(e.params[0]).startsWith(`${TEAM}:gdrive:`);
const isMappingLock = (e: Entry) => e.sql.includes("from source_item_mappings") && e.sql.endsWith("for update");
const isPathLock = (e: Entry) => e.sql === "select pg_advisory_xact_lock($1::int, hashtext($2::text))";
const isOccupantRead = (e: Entry) => e.sql.includes("jsonb_to_recordset");
const isProvenanceRead = (e: Entry) => e.sql.includes("frontmatter->>'source_id'=$2");
const isAttributionLock = (e: Entry) => e.sql.includes("pg_advisory_xact_lock(hashtextextended(") && /:item:[0-9a-f-]{36}$/.test(String(e.params[0]));
const isItemRowLock = (e: Entry) => e.sql.startsWith("select id from items where team_id=$1 and id=any($2::uuid[])") && e.sql.endsWith("for update");
const isSlugPathLock = (e: Entry) => String(e.params[0]).startsWith(`${TEAM}:item:docs:`);

const indexOf = (entries: Entry[], match: (e: Entry) => boolean) => entries.findIndex(match);
const lastIndexOf = (entries: Entry[], match: (e: Entry) => boolean) =>
  entries.length - 1 - [...entries].reverse().findIndex(match);
const which = (entries: Entry[], match: (e: Entry) => boolean) => entries.filter(match);

/** A scripted database holding one Drive connection and whatever items a test places in it. */
function driveDatabase(opts: {
  audience?: string[];
  mapping?: Row | null;
  /** Rows the occupant/provenance/mapped-item lookups return, per call (last entry repeats). */
  discoveries?: string[][];
  /** Rows the item `for update` returns, per call. Defaults to exactly what was asked for. */
  rowLocks?: (string[] | Error)[];
  fail?: (sql: string, params: unknown[]) => Error | null;
} = {}) {
  let occupantReads = 0;
  let rowLocks = 0;
  const discoveries = opts.discoveries ?? [[]];
  return (sql: string, params: unknown[]): Reply => {
    const scripted = opts.fail?.(sql, params);
    if (scripted) return scripted;
    const e: Entry = { sql, params, lockTimeout: "" };
    if (sql.includes("from team_identity_authority")) return [{ revision: 7, repair_revision: 7 }];
    if (isAuthorityLock(e)) {
      return [{
        integration_id: INTEGRATION, team_id: TEAM, status: "enabled",
        config: { audienceProjectIds: opts.audience ?? [project(1)] }, secret_ciphertext: null,
        generation: 3, scope_hash: "scope", credential_revision: 1,
        connector_member_id: "member", connector_api_key_id: "key",
        lease_owner: OWNER, fence: 5, lease_until: new Date(Date.now() + 60_000).toISOString(),
        progress: {}, progress_revision: 1,
      }];
    }
    if (isPrincipalLock(e)) return [{ valid: true }];
    if (sql === "select id from projects where team_id=$1 and slug=$2") return [{ id: STORAGE }];
    if (isProjectLock(e)) return (params[1] as string[]).map((id) => ({ id }));
    if (sql.includes("exists(select 1 from project_groups")) {
      return (params[1] as string[]).map((id) => ({ id, granted: true }));
    }
    if (isMappingLock(e)) return opts.mapping ? [opts.mapping] : [];
    if (isOccupantRead(e)) {
      const ids = discoveries[Math.min(occupantReads++, discoveries.length - 1)];
      return ids.map((id) => ({ id }));
    }
    if (isItemRowLock(e)) {
      const scriptedLock = opts.rowLocks?.[Math.min(rowLocks++, (opts.rowLocks?.length ?? 1) - 1)];
      if (scriptedLock instanceof Error) return scriptedLock;
      return (scriptedLock ?? (params[1] as string[])).map((id) => ({ id }));
    }
    return [];
  };
}

const auth = {
  teamId: TEAM, memberId: "member", apiKeyId: "key", memberTier: "team", memberRole: "member",
  actorHandle: "gdrive-sync", displayName: "Google Drive Sync", email: null, isConnector: true,
} as unknown as ApiAuth;
const execution = { integrationId: INTEGRATION, generation: 3, fence: 5, owner: OWNER };

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
function drivePayload(): ItemPayload {
  const body = "drive body";
  return {
    project: "docs", path: PATH, kind: "deliverable", access: "team", actor: "gdrive-sync",
    body, content_sha256: sha(body),
    frontmatter: { source: "gdrive", source_id: PROVIDER, connection_id: INTEGRATION },
  } as ItemPayload;
}

/** No transaction capability: `ingestItem` stops right after the outer lock phase, by name. */
const NOT_A_DATABASE = {} as DbClient;
const STOPS_AFTER_LOCKS = "transaction-capability-required";

function lockTheDocument(hooks = {}) {
  return lockGdriveIngestIdentities({
    teamId: TEAM, storageProjectId: STORAGE, requestedPath: PATH, providerId: PROVIDER, hooks,
  });
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://unit:unit@127.0.0.1:1/unit");
});

describe("one key per Drive path identity", () => {
  it("is exactly the key and statement the ingest session's lockIngestIdentity takes", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const session = {
      executeSql: async (sql: string, params: unknown[] = []) => {
        seen.push({ sql: norm(sql), params });
        return { rows: [], rowCount: 0 };
      },
    } as unknown as TransactionSession;
    await lockIngestIdentity(session, TEAM, STORAGE, PATH);
    const sessionLock = seen.find((entry) => entry.sql.includes("pg_advisory_xact_lock"))!;

    const c = use(new ScriptedConnection(driveDatabase()));
    await withTransaction(() => lockTheDocument());
    const ambientLock = which(c.log, isPathLock).find((entry) =>
      entry.params[1] === drivePathIdentityKey(TEAM, { projectId: STORAGE, path: PATH }))!;

    expect(ambientLock.sql).toBe(sessionLock.sql);
    expect(ambientLock.params).toEqual(sessionLock.params);
    expect(ambientLock.params[0]).toBe(ITEM_INGEST_LOCK_NS);
  });

  it("orders identities deterministically and derives the collision-safe path from the request alone", () => {
    const safe = driveCollisionSafePath(PATH, PROVIDER);
    expect(safe).toMatch(/^gdrive\/doc--drive-[0-9a-f]{10}\.md$/);
    expect(driveCollisionSafePath(PATH, PROVIDER)).toBe(safe);
    expect(driveCollisionSafePath(PATH, "other")).not.toBe(safe);
    expect(driveCollisionSafePath("gdrive/no-extension", PROVIDER)).toMatch(/^gdrive\/no-extension--drive-[0-9a-f]{10}$/);

    const request = driveRequestPathIdentities(TEAM, STORAGE, PATH, PROVIDER);
    expect(request.map((identity) => identity.path).sort()).toEqual([PATH, safe].sort());
    const forward = orderDrivePathIdentities(TEAM, [...request, { projectId: project(9), path: "z.md" }]);
    const reversed = orderDrivePathIdentities(TEAM, [{ projectId: project(9), path: "z.md" }, ...[...request].reverse(), request[0]]);
    expect(reversed).toEqual(forward);
    expect(forward).toHaveLength(3);
  });
});

describe("ingest: provider → mapping → paths → attribution advisories → item rows", () => {
  it("takes every level in order, sorted within a level, each wait under the 10s bound", async () => {
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(2), item(1)]] })));
    const before: string[] = [];
    const locks = await withTransaction(() => lockTheDocument({
      beforeAttributionLock: async (id: string) => { before.push(id); },
    }));

    const work = c.work;
    const provider = indexOf(work, isProviderLock);
    const mapping = indexOf(work, isMappingLock);
    const firstPath = indexOf(work, isPathLock);
    const lastPath = lastIndexOf(work, isPathLock);
    const firstRead = indexOf(work, isOccupantRead);
    const firstAdvisory = indexOf(work, isAttributionLock);
    const lastAdvisory = lastIndexOf(work, isAttributionLock);
    const rows = indexOf(work, isItemRowLock);
    const revalidation = lastIndexOf(work, isOccupantRead);
    expect([provider, mapping, firstPath, lastPath, firstRead, firstAdvisory, lastAdvisory, rows, revalidation])
      .toEqual([...[provider, mapping, firstPath, lastPath, firstRead, firstAdvisory, lastAdvisory, rows, revalidation]].sort((a, b) => a - b));
    expect(provider).toBe(0);
    expect(revalidation).toBeGreaterThan(rows);

    const pathKeys = which(work, isPathLock).map((entry) => entry.params[1] as string);
    expect(pathKeys).toEqual([...pathKeys].sort());
    expect(new Set(pathKeys)).toEqual(new Set([
      drivePathIdentityKey(TEAM, { projectId: STORAGE, path: PATH }),
      drivePathIdentityKey(TEAM, { projectId: STORAGE, path: driveCollisionSafePath(PATH, PROVIDER) }),
    ]));
    expect(which(work, isAttributionLock).map((entry) => entry.params[0]))
      .toEqual([`${TEAM}:item:${item(1)}`, `${TEAM}:item:${item(2)}`]);
    expect(before).toEqual([item(1), item(2)]);
    expect(work[rows].params[1]).toEqual([item(1), item(2)]);

    for (const entry of work.filter((e) => isProviderLock(e) || isMappingLock(e) || isPathLock(e) || isAttributionLock(e) || isItemRowLock(e))) {
      expect(entry.lockTimeout, `unbounded wait: ${entry.sql}`).toBe(LOCK_ACQUISITION_TIMEOUT);
    }
    expect(LOCK_ACQUISITION_TIMEOUT).toBe("10s");
    // Restored for the dependent writes that follow.
    expect(c.log.filter((entry) => entry.sql.startsWith("select set_config")).at(-1)!.params).toEqual(["0"]);

    expect([...locks.itemIds].sort()).toEqual([item(1), item(2)]);
    expect(locks.pathKeys).toEqual(new Set(pathKeys));
    expect(locks.providerId).toBe(PROVIDER);
  });

  it("recovers an unmapped document by provenance; a mapped one by its mapping, never by a scan", async () => {
    const unmapped = use(new ScriptedConnection(driveDatabase()));
    await withTransaction(() => lockTheDocument());
    expect(which(unmapped.work, isProvenanceRead).length).toBeGreaterThan(0);

    const mapped = use(new ScriptedConnection(driveDatabase({
      mapping: { item_id: item(1), project_id: STORAGE, canonical_path: PATH },
    })));
    await withTransaction(() => lockTheDocument());
    expect(which(mapped.work, isProvenanceRead)).toEqual([]);
  });

  it("a tombstoned mapping: its restore path is held and its item id is advisory-locked with no row to lock", async () => {
    const elsewhere = project(9);
    const c = use(new ScriptedConnection(driveDatabase({
      mapping: { item_id: item(7), project_id: elsewhere, canonical_path: "gdrive/kept--drive-0123456789.md" },
    })));
    const locks = await withTransaction(() => lockTheDocument());
    expect(locks.pathKeys.has(drivePathIdentityKey(TEAM, { projectId: elsewhere, path: "gdrive/kept--drive-0123456789.md" }))).toBe(true);
    expect(locks.pathKeys.size).toBe(3);
    expect(which(c.work, isAttributionLock).map((entry) => entry.params[0])).toEqual([`${TEAM}:item:${item(7)}`]);
    expect(which(c.work, isItemRowLock)).toEqual([]);
    expect([...locks.itemIds]).toEqual([item(7)]);
  });
});

describe("a discovery that does not survive its locks abandons the attempt", () => {
  it("a candidate removed before its row lock is a GdriveIngestStateChangedError, not a stale reuse", async () => {
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(1), item(2)]], rowLocks: [[item(2)]] })));
    const error = await withTransaction(() => lockTheDocument()).catch((caught) => caught);
    expect(error).toBeInstanceOf(GdriveIngestStateChangedError);
    expect(error).toMatchObject({ code: "gdrive-ingest-state-changed" });
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("a candidate that appears under the locks is refused the same way", async () => {
    use(new ScriptedConnection(driveDatabase({ discoveries: [[item(1)], [item(1), item(2)]] })));
    await expect(withTransaction(() => lockTheDocument())).rejects.toBeInstanceOf(GdriveIngestStateChangedError);
  });

  it("is retried as a whole attempt, once, and then fails by name", async () => {
    let calls = 0;
    await expect(runGdriveIngestAttempts(async (number) => {
      calls++;
      if (number === 1) throw new GdriveIngestStateChangedError("first");
      return "second attempt";
    })).resolves.toBe("second attempt");
    expect(calls).toBe(2);

    calls = 0;
    const last = new GdriveIngestStateChangedError("again");
    await expect(runGdriveIngestAttempts(async () => { calls++; throw last; })).rejects.toBe(last);
    expect(calls).toBe(GDRIVE_INGEST_ATTEMPTS);
    expect(GDRIVE_INGEST_ATTEMPTS).toBe(2);
  });

  it.each([
    ["a lock timeout", sqlError("canceling statement due to lock timeout", "55P03")],
    ["a deadlock", sqlError("deadlock detected", "40P01")],
    ["an ordinary failure", new Error("boom")],
  ])("does not retry %s", async (_name, failure) => {
    let calls = 0;
    await expect(runGdriveIngestAttempts(async () => { calls++; throw failure; })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

describe("the whole Drive ingest: identity → connection → projects, then the document", () => {
  it("validates the identity revision, then the connection authority, then project rows, before any provider, path or item lock", async () => {
    const c = use(new ScriptedConnection(driveDatabase({ audience: [project(5), project(1)], discoveries: [[item(1)]] })));
    await expect(ingestApiItem(
      NOT_A_DATABASE, auth, drivePayload(), "team", { authorMemberId: null, mappingRevision: 7 }, "team", execution,
    )).rejects.toThrow(STOPS_AFTER_LOCKS);

    const work = c.work;
    const order = [
      indexOf(work, isIdentityLock),
      indexOf(work, isAuthorityLock),
      indexOf(work, isPrincipalLock),
      indexOf(work, isProjectLock),
      lastIndexOf(work, isProjectLock),
      indexOf(work, isProviderLock),
      indexOf(work, isMappingLock),
      indexOf(work, isPathLock),
      indexOf(work, isAttributionLock),
      indexOf(work, isItemRowLock),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBe(0);

    // One key per path identity: the slug-keyed advisory is not taken on the Drive path at all.
    expect(which(work, isSlugPathLock)).toEqual([]);
    // The first acquisition at each level is the one that can wait (later ones are re-entrant).
    for (const level of [isIdentityLock, isAuthorityLock, isProjectLock, isProviderLock]) {
      const entry = work[indexOf(work, level)];
      expect(entry.lockTimeout, `unbounded wait: ${entry.sql}`).toBe("10s");
    }
    for (const entry of which(work, isProjectLock)) expect(entry.lockTimeout).toBe("10s");
    expect(c.count("begin")).toBe(1);
  });

  it("refuses a Drive payload without its connection before taking any lock", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team"))
      .rejects.toMatchObject({ code: "connector_principal_required", status: 403 });
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team", { ...execution, integrationId: OWNER }))
      .rejects.toMatchObject({ code: "wrong_connection", status: 403 });
    expect(c.log).toEqual([]);
  });

  it("a stale execution is refused at the connection authority, before project, provider or item locks", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team", { ...execution, fence: 4 }))
      .rejects.toMatchObject({ code: "stale_execution" });
    expect(which(c.work, isProjectLock)).toEqual([]);
    expect(which(c.work, isProviderLock)).toEqual([]);
    expect(which(c.work, isItemRowLock)).toEqual([]);
  });

  it("RETRYABLE VANISHED CANDIDATE: the first attempt rolls back whole and the second starts from the connection authority", async () => {
    // Attempt 1 discovers item 1, which is gone by the row lock. Attempt 2 sees an empty path.
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(1)], [], []], rowLocks: [[]] })));
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team", execution))
      .rejects.toThrow(STOPS_AFTER_LOCKS);

    expect(c.count("begin")).toBe(2);
    expect(c.count("rollback")).toBe(2);
    const firstRollback = c.log.findIndex((entry) => entry.sql === "rollback");
    const second = c.log.slice(firstRollback + 1).filter((entry) => c.work.includes(entry));
    // Nothing is reused: the second attempt re-takes the connection authority and every lock below it.
    expect(indexOf(second, isAuthorityLock)).toBe(0);
    expect(indexOf(second, isProviderLock)).toBeGreaterThan(indexOf(second, isProjectLock));
    expect(which(second, isAttributionLock)).toEqual([]);
    expect(which(c.log.slice(0, firstRollback), isAttributionLock)).toHaveLength(1);
  });

  it("a candidate that vanishes on BOTH attempts aborts by name after exactly two", async () => {
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(1)]], rowLocks: [[]] })));
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team", execution))
      .rejects.toBeInstanceOf(GdriveIngestStateChangedError);
    expect(c.count("begin")).toBe(2);
    expect(c.count("rollback")).toBe(2);
  });

  it("BOUNDED TIMEOUT: a provider lock that times out fails the ingest once, with no retry", async () => {
    const c = use(new ScriptedConnection(driveDatabase({
      fail: (sql, params) => (String(params[0]).startsWith(`${TEAM}:gdrive:`)
        ? sqlError("canceling statement due to lock timeout", "55P03") : null),
    })));
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team", execution))
      .rejects.toMatchObject({ code: "55P03" });
    expect(c.count("begin")).toBe(1);
    expect(which(c.work, isProviderLock)).toHaveLength(1);
    expect(which(c.work, isProviderLock)[0].lockTimeout).toBe("10s");
    expect(which(c.work, isPathLock)).toEqual([]);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("a payload that is not Drive-sourced takes no Drive lock and keeps its own path key", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    const payload = { ...drivePayload(), frontmatter: { source: "notion" } } as ItemPayload;
    await expect(ingestApiItem(NOT_A_DATABASE, auth, payload, "team", undefined, "team")).rejects.toThrow(STOPS_AFTER_LOCKS);
    expect(which(c.work, isAuthorityLock)).toEqual([]);
    expect(which(c.work, isProviderLock)).toEqual([]);
    expect(which(c.work, isSlugPathLock).length).toBeGreaterThan(0);
    // The Drive mapping row is read here, never locked after the item row.
    expect(which(c.work, isMappingLock)).toEqual([]);
  });

  it("refuses a non-Drive payload whose stored target is Drive-owned", async () => {
    use(new ScriptedConnection((sql) =>
      (sql.startsWith("with target as") ? [{ item_id: item(1), item_source: "gdrive", mapping_connection: null }] : [])));
    const payload = { ...drivePayload(), frontmatter: {} } as ItemPayload;
    await expect(ingestApiItem(NOT_A_DATABASE, auth, payload, "team", undefined, "team"))
      .rejects.toMatchObject({ code: "connector_principal_required" });
  });
});

describe("project rows: one ascending pass, strongest mode, no SHARE→write upgrade", () => {
  async function commit(audience: string[], storage?: string) {
    const c = use(new ScriptedConnection(driveDatabase({ audience })));
    let seen: unknown;
    await withGdriveExecutionCommit(auth, execution, async (approved) => {
      seen = approved;
    }, storage ? { storageProject: async () => storage } : {});
    return { c, seen: seen as { projectIds: string[]; storageProjectId?: string }, locks: which(c.work, isProjectLock) };
  }
  const mode = (entry: Entry) => entry.sql.match(/for (share|no key update)$/)![1];

  it("locks the audience below the storage project, the storage project for write, then the audience above", async () => {
    const { c, seen, locks } = await commit([project(5), project(1), project(3)], project(4));
    expect(locks.map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[project(1), project(3)], "share"],
      [[project(4)], "no key update"],
      [[project(5)], "share"],
    ]);
    for (const entry of locks) expect(entry.lockTimeout).toBe("10s");
    expect(indexOf(c.work, isAuthorityLock)).toBeLessThan(indexOf(c.work, isProjectLock));
    expect(seen).toEqual({ projectIds: [project(5), project(1), project(3)], storageProjectId: project(4) });
  });

  it("NO UPGRADE: a storage project that is also an audience project is write-locked once and never share-locked", async () => {
    const { locks } = await commit([project(5), project(1), project(3)], project(3));
    expect(locks.map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[project(1)], "share"],
      [[project(3)], "no key update"],
      [[project(5)], "share"],
    ]);
    const shared = locks.filter((entry) => mode(entry) === "share").flatMap((entry) => entry.params[1] as string[]);
    expect(shared).not.toContain(project(3));
  });

  it("is the same order whichever way the audience is configured, and case-insensitive", async () => {
    const forward = (await commit([project(1), project(3), project(5)], project(4))).locks.map((entry) => entry.params[1]);
    const shuffled = (await commit([project(5).toUpperCase(), project(3), project(1)], project(4))).locks.map((entry) => entry.params[1]);
    expect(shuffled).toEqual(forward);
  });

  it("reconciliation writes no project: one ascending share pass", async () => {
    const { seen, locks } = await commit([project(5), project(1)]);
    expect(locks.map((entry) => [entry.params[1], mode(entry)])).toEqual([[[project(1), project(5)], "share"]]);
    expect(seen.storageProjectId).toBeUndefined();
  });

  it("a storage project that is gone under its lock is reported as absent, not assumed", async () => {
    const c = use(new ScriptedConnection((sql, params) => {
      const reply = driveDatabase({ audience: [project(1)] })(sql, params);
      // The storage row lock finds nothing.
      return /for no key update$/.test(sql) ? [] : reply;
    }));
    let seen: { storageProjectId?: string } = {};
    await withGdriveExecutionCommit(auth, execution, async (approved) => { seen = approved; }, { storageProject: async () => project(4) });
    expect(seen.storageProjectId).toBeUndefined();
    expect(which(c.work, isProjectLock)).toHaveLength(2);
  });

  it("the lock_timeout is back to the caller's value for the commit body", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    await withGdriveExecutionCommit(auth, execution, async () => {
      await runSql("DEPENDENT WRITE");
    });
    expect(c.work.find((entry) => entry.sql === "dependent write")!.lockTimeout).toBe("0");
  });
});

describe("reconciliation: connection → every provider identity → item rows", () => {
  it("takes all of its provider locks, sorted and bounded, before the first mapping or claim row", async () => {
    const c = use(new ScriptedConnection((sql) =>
      (sql.startsWith("select provider_id from gdrive_item_claims")
        ? [{ provider_id: "b" }, { provider_id: "c" }, { provider_id: "a" }] : [])));
    const staged = await stageGdriveReconciliation(NOT_A_DATABASE, TEAM, {
      connectionId: INTEGRATION, removedProviderIds: ["a", "b", "c"], reason: "removed upstream",
    }, { memberId: "member", apiKeyId: "key" });
    expect(staged).toMatchObject({ candidates: 3 });

    const work = c.work;
    // The candidate read, then all three provider identities in sorted order (the read returned
    // them unsorted) …
    expect(work[0].sql).toMatch(/^select provider_id from gdrive_item_claims/);
    expect(work.slice(1, 4).every(isProviderLock)).toBe(true);
    expect(work.slice(1, 4).map((entry) => entry.params[0]))
      .toEqual([`${TEAM}:gdrive:a`, `${TEAM}:gdrive:b`, `${TEAM}:gdrive:c`]);
    for (const entry of which(work, isProviderLock)) expect(entry.lockTimeout).toBe("10s");
    // … and nothing that locks or writes a row runs before the last of them.
    const firstRowStatement = work.findIndex((entry) => /for update$|^update |^delete |^insert /.test(entry.sql));
    expect(firstRowStatement).toBeGreaterThan(3);
  });

  it("takes no provider lock when nothing is retired", async () => {
    const c = use(new ScriptedConnection());
    await stageGdriveReconciliation(NOT_A_DATABASE, TEAM, {
      connectionId: INTEGRATION, removedProviderIds: ["a"], reason: "noop",
    });
    expect(which(c.work, isProviderLock)).toEqual([]);
  });
});
