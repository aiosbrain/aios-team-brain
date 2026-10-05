import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiAuth } from "@/lib/api/auth";
import type { ItemPayload } from "@/lib/api/schemas";
import type { DbClient, TransactionSession } from "@/lib/db/types";

/**
 * The SHARED INGEST LOCK ORDER (AIO-1167, blocker 4; PR 743 owns the migration, PR 714 is frozen).
 *
 * Spec. Every ingest is PROJECT-BEFORE-ITEM. In full, and only the levels a writer needs:
 *
 *   identity authority/revision → connection authority → the COMPLETE project set, sorted
 *     → provider identity (and its mapping row) → path identities by project id, sorted
 *     → item-attribution advisories, sorted → item rows, sorted → dependent rows
 *
 *   1. The public wrapper takes NO lock of its own. Its Drive-ownership read is unlocked and can
 *      only refuse; nothing path-, attribution- or item-shaped is held before the project row.
 *      (The confirmed HIGH: public ingest held the item, then waited for the project, while a
 *      Drive commit held the project and waited for that item.)
 *   2. A Drive ingest PLANS — unlocked reads of the provider mapping and of every item it can adopt
 *      or collide with — and takes the whole project set in one ascending pass, each row once, in
 *      its final mode: written `no key update`, audience `share`, referenced `key share`. No
 *      project row is acquired or strengthened after the provider lock.
 *   3. One Drive path identity has ONE key — the key the ingest session's `lockIngestIdentity` takes.
 *   4. Reconciliation takes every provider identity, their mapping rows, every item-attribution
 *      advisory (sorted) and then the complete sorted set of item rows before its first write.
 *   5. Every one of these outer waits runs under the 10-second `lock_timeout`, restored afterwards.
 *      A timeout (55P03) is not retried.
 *   6. A plan that no longer describes the database under its locks — mapping changed, candidate
 *      removed, moved or appeared, planned project gone — abandons the WHOLE attempt (rollback,
 *      every lock released), which is planned again once and then fails by name.
 *   7. An ORDINARY ingest's project work is inside its publishing transaction and its context
 *      session: the source project is planned by an unlocked read, created there when absent (a
 *      do-nothing insert — a concurrent slug winner is read, never conflict-updated), and locked
 *      with the system destinations in the same single ascending pass, before its path identity.
 *      A failed ingest rolls the project, its timestamp and its graph pointer back.
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
    /** A statement outside any transaction (the public wrapper's unlocked read). */
    async query(text: string, params?: unknown[]): Promise<unknown> {
      return (h.connection as { query(text: string, params?: unknown[]): Promise<unknown> }).query(text, params);
    }
  },
  types: { setTypeParser(): void {} },
}));

import { runSql, withTransaction } from "@/lib/db/pg/pool";
import { PgClient } from "@/lib/db/pg/client";
import { LOCK_ACQUISITION_TIMEOUT } from "@/lib/db/pg/bounded-lock";
import { projectGroupId } from "@/lib/graph/group";
import { ingestApiItem, ingestItem } from "@/lib/ingest";
import {
  driveCollisionSafePath,
  drivePathIdentityKey,
  driveRequestPathIdentities,
  GDRIVE_INGEST_ATTEMPTS,
  GdriveIngestStateChangedError,
  lockGdriveIngestIdentities,
  orderDrivePathIdentities,
  planGdriveIngest,
  runGdriveIngestAttempts,
  type GdriveIngestLockHooks,
  type GdriveIngestPlan,
} from "@/lib/ingest/gdrive-commit-locks";
import { stageGdriveReconciliation } from "@/lib/ingest/source-reconcile";
import { withGdriveExecutionCommit, type GdriveCommitProjectPlan } from "@/lib/integrations/gdrive-authority";
import { ITEM_INGEST_LOCK_NS, lockIngestIdentity } from "@/lib/projects/context/transaction";
import {
  lockProjectRows,
  ProjectPlanChangedError,
  resolveSourceProject,
  type ProjectSqlExecutor,
} from "@/lib/projects/project-row-locks";

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
const isProjectLock = (e: Entry) => /^select id, slug from projects where team_id = \$1 and id = any\(\$2::uuid\[\]\) order by id for (key share|share|no key update)$/.test(e.sql);
const SOURCE_PROJECT_READ = "select id from projects where team_id = $1 and slug = $2";
const isSourceProjectRead = (e: Entry) => e.sql === SOURCE_PROJECT_READ;
const isProjectCreate = (e: Entry) => e.sql.startsWith("insert into projects (team_id, slug, last_synced_at)") && e.sql.includes("on conflict (team_id, slug) do nothing returning id");
const isSystemDestinationRead = (e: Entry) => e.sql === "select id from projects where team_id = $1 and kind = 'system'";
const isSessionPathLock = (e: Entry) => e.sql === "select pg_advisory_xact_lock($1::int, hashtext($2::text))";
const isSessionItemLock = (e: Entry) => e.sql.includes("member_id_locked") && e.sql.includes(" from items where team_id = $1 and id = $2") && e.sql.endsWith("for update");
const isProviderLock = (e: Entry) => e.sql.includes("pg_advisory_xact_lock(hashtextextended(") && String(e.params[0]).startsWith(`${TEAM}:gdrive:`);
const isMappingRead = (e: Entry) => e.sql === "select item_id, project_id, canonical_path from source_item_mappings where team_id=$1 and source='gdrive' and provider_id=$2";
const isMappingLock = (e: Entry) => e.sql.includes("from source_item_mappings") && e.sql.endsWith("for update");
const isPathLock = (e: Entry) => e.sql === "select pg_advisory_xact_lock($1::int, hashtext($2::text))";
const isOccupantRead = (e: Entry) => e.sql.includes("jsonb_to_recordset");
const isProvenanceRead = (e: Entry) => e.sql.includes("frontmatter->>'source_id'=$2");
const isAttributionLock = (e: Entry) => e.sql.includes("pg_advisory_xact_lock(hashtextextended(") && /:item:[0-9a-f-]{36}$/.test(String(e.params[0]));
const isItemRowLock = (e: Entry) => e.sql.startsWith("select id, project_id, path from items where team_id=$1 and id=any($2::uuid[])") && e.sql.endsWith("for update");
const isMappedItemRead = (e: Entry) => e.sql === "select id, project_id, path from items where team_id=$1 and id=$2";
const isMappingWrite = (e: Entry) => /^(insert into|update|delete from) source_item_mappings\b/.test(e.sql);
const isReconcileItemRead = (e: Entry) => e.sql.startsWith("select c.item_id from gdrive_item_claims c") && e.sql.includes("union select m.item_id from source_item_mappings m");
const isReconcileItemLock = (e: Entry) => e.sql === "select id from items where team_id=$1 and id=any($2::uuid[]) order by id for update";
const isSlugPathLock = (e: Entry) => String(e.params[0]).startsWith(`${TEAM}:item:docs:`);
/** Anything that takes a lock: an advisory lock or a locking read. */
const isLocking = (e: Entry) => e.sql.includes("pg_advisory_xact_lock") || / for (update|share|key share|no key update)( of [a-z, ]+)?$/.test(e.sql);
/** Anything that writes a row. */
const isWrite = (e: Entry) => /^(update|delete|insert) /.test(e.sql);

const indexOf = (entries: Entry[], match: (e: Entry) => boolean) => entries.findIndex(match);
const lastIndexOf = (entries: Entry[], match: (e: Entry) => boolean) =>
  entries.length - 1 - [...entries].reverse().findIndex(match);
const which = (entries: Entry[], match: (e: Entry) => boolean) => entries.filter(match);
const mode = (entry: Entry) => entry.sql.match(/for (key share|share|no key update)$/)![1];

/** What a project row lock returns: the id, and the slug read under the lock (`docs` is the payload's). */
const lockedProjectRow = (id: string): Row => ({ id, slug: id === STORAGE ? "docs" : `project-${id.slice(-1)}` });

/** A candidate: an item id (in the storage project), `[id, projectId]` or `[id, projectId, path]`. */
type Candidate = string | [string, string] | [string, string, string];
const candidateRow = (candidate: Candidate, pathFor: (id: string) => string): Row =>
  typeof candidate === "string"
    ? { id: candidate, project_id: STORAGE, path: pathFor(candidate) }
    : { id: candidate[0], project_id: candidate[1], path: candidate[2] ?? pathFor(candidate[0]) };

/** A scripted database holding one Drive connection and whatever items a test places in it. */
function driveDatabase(opts: {
  audience?: string[];
  /** The provider mapping, per read (plan, then locked; last entry repeats). */
  mappings?: (Row | null)[];
  /** Rows the path-occupant lookup returns, per call (last entry repeats). */
  discoveries?: Candidate[][];
  /** Rows the mapped-item lookup returns. */
  mappedItem?: Candidate[];
  /** Rows the item `for update` returns, per call. Defaults to exactly what was asked for. */
  rowLocks?: Candidate[][];
  fail?: (sql: string, params: unknown[]) => Error | null;
} = {}) {
  let occupantReads = 0;
  let mappingReads = 0;
  let rowLocks = 0;
  const discoveries = opts.discoveries ?? [[]];
  const mappings = opts.mappings ?? [null];
  // Where an item lives unless a test says otherwise: the mapped item at its mapping's canonical
  // path (so its location adds no path identity of its own), anything else at a path of its own.
  const planned = mappings.find((mapping) => mapping !== null) ?? null;
  const pathFor = (id: string) =>
    planned?.item_id === id && typeof planned.canonical_path === "string" ? planned.canonical_path : `occupied/${id}.md`;
  const row = (candidate: Candidate) => candidateRow(candidate, pathFor);
  const rowOf = new Map<string, Row>();
  const remember = (rows: Row[]) => {
    for (const found of rows) rowOf.set(found.id as string, found);
    return rows;
  };
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
    if (isSourceProjectRead(e)) return [{ id: STORAGE }];
    if (isProjectLock(e)) return (params[1] as string[]).map(lockedProjectRow);
    if (sql.includes("exists(select 1 from project_groups")) {
      return (params[1] as string[]).map((id) => ({ id, granted: true }));
    }
    if (isMappingRead(e) || (isMappingLock(e) && sql.startsWith("select item_id, project_id, canonical_path"))) {
      const mapping = mappings[Math.min(mappingReads++, mappings.length - 1)];
      return mapping ? [mapping] : [];
    }
    if (isOccupantRead(e)) return remember(discoveries[Math.min(occupantReads++, discoveries.length - 1)].map(row));
    if (isMappedItemRead(e)) return remember((opts.mappedItem ?? []).map(row));
    if (isItemRowLock(e)) {
      const scriptedLock = opts.rowLocks?.[Math.min(rowLocks++, (opts.rowLocks?.length ?? 1) - 1)];
      if (scriptedLock) return scriptedLock.map(row);
      return (params[1] as string[]).map((id) => rowOf.get(id) ?? row(id));
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

/** No transaction capability: an ordinary `ingestItem` stops before it takes anything, by name. */
const NOT_A_DATABASE = {} as DbClient;
const STOPS_AFTER_LOCKS = "transaction-capability-required";
/**
 * A Drive commit validates payload and capability BEFORE it can create its storage project, so it
 * needs a real client to get as far as its locks. The scripted database knows no project row to
 * point, so `ingestItem` then stops — inside the commit, after every outer lock — at the source
 * project's graph pointer.
 */
const STOPS_INSIDE_THE_COMMIT = /graph pointer: project .* unreadable/;

const planTheDocument = () =>
  planGdriveIngest({ teamId: TEAM, storageProjectId: STORAGE, requestedPath: PATH, providerId: PROVIDER });
const everyPlannedProject = (plan: GdriveIngestPlan) => new Set([plan.storageProjectId, ...plan.referenceProjectIds]);

/** Plan, then lock, holding exactly the projects the plan named (as the commit would). */
function planAndLock(hooks: GdriveIngestLockHooks = {}) {
  return withTransaction(async () => {
    const plan = await planTheDocument();
    const locks = await lockGdriveIngestIdentities({ plan, lockedProjectIds: everyPlannedProject(plan), hooks });
    return { plan, locks };
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
    await planAndLock();
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

describe("the plan: every project, path and item, read without a lock", () => {
  it("takes no lock, and names the projects a mapping and its candidates live in", async () => {
    const elsewhere = project(9);
    const c = use(new ScriptedConnection(driveDatabase({
      mappings: [{ item_id: item(7), project_id: elsewhere, canonical_path: "gdrive/kept.md" }],
      mappedItem: [[item(7), elsewhere]],
      discoveries: [[item(1), [item(7), elsewhere]]],
    })));
    const plan = await withTransaction(planTheDocument);
    expect(which(c.work, isLocking)).toEqual([]);
    expect(plan.candidates).toEqual([
      { id: item(1), projectId: STORAGE, path: `occupied/${item(1)}.md` },
      { id: item(7), projectId: elsewhere, path: "gdrive/kept.md" },
    ]);
    // The storage project is written, not merely referenced; it is not listed twice.
    expect(plan.referenceProjectIds).toEqual([elsewhere]);
    expect(plan.paths).toHaveLength(3);
    expect(plan.paths.map((identity) => drivePathIdentityKey(TEAM, identity)))
      .toContain(drivePathIdentityKey(TEAM, { projectId: elsewhere, path: "gdrive/kept.md" }));
  });

  it("recovers an unmapped document by provenance; a mapped one by its mapping, never by a scan", async () => {
    const unmapped = use(new ScriptedConnection(driveDatabase()));
    await withTransaction(planTheDocument);
    expect(which(unmapped.work, isProvenanceRead).length).toBeGreaterThan(0);

    const mapped = use(new ScriptedConnection(driveDatabase({
      mappings: [{ item_id: item(1), project_id: STORAGE, canonical_path: PATH }],
    })));
    const plan = await withTransaction(planTheDocument);
    expect(which(mapped.work, isProvenanceRead)).toEqual([]);
    expect(plan.referenceProjectIds).toEqual([]);
  });
});

describe("the plan: where the document already IS joins the path set", () => {
  const elsewhere = project(9);
  const legacy = { id: item(7), project_id: elsewhere, path: "gdrive/legacy.md" };
  /** An item ingested before mappings existed: found by provenance, in another project. */
  const withLegacyItem = (atRowLock: Row = legacy) => {
    const base = driveDatabase();
    return (sql: string, params: unknown[]): Reply => {
      const e: Entry = { sql, params, lockTimeout: "" };
      if (isProvenanceRead(e)) return [legacy];
      if (isItemRowLock(e)) return [atRowLock];
      return base(sql, params);
    };
  };

  it("a historical item's own location is planned, its project referenced, and both are held and revalidated", async () => {
    const c = use(new ScriptedConnection(withLegacyItem()));
    const { plan, locks } = await planAndLock();
    const legacyKey = drivePathIdentityKey(TEAM, { projectId: elsewhere, path: "gdrive/legacy.md" });
    expect(plan.candidates).toEqual([{ id: item(7), projectId: elsewhere, path: "gdrive/legacy.md" }]);
    // The request's two paths, plus the canonical location the existing row supplies.
    expect(plan.paths).toHaveLength(3);
    expect(plan.referenceProjectIds).toEqual([elsewhere]);
    expect(locks.pathKeys.has(legacyKey)).toBe(true);
    expect(which(c.work, isPathLock).map((entry) => entry.params[1])).toContain(legacyKey);
    expect([...locks.itemIds]).toEqual([item(7)]);
    // Still provider → mapping → paths → advisory → row, with the extra path in the one sorted pass.
    const work = c.work;
    const order = [indexOf(work, isProviderLock), indexOf(work, isMappingLock), indexOf(work, isPathLock), lastIndexOf(work, isPathLock), indexOf(work, isAttributionLock), indexOf(work, isItemRowLock)];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const keys = which(work, isPathLock).map((entry) => entry.params[1] as string);
    expect(keys).toEqual([...keys].sort());
  });

  it("a historical item that MOVED before its row lock abandons the attempt", async () => {
    use(new ScriptedConnection(withLegacyItem({ ...legacy, path: "gdrive/renamed.md" })));
    await expect(planAndLock()).rejects.toBeInstanceOf(GdriveIngestStateChangedError);
  });
});

describe("ingest: provider → mapping → paths → attribution advisories → item rows", () => {
  it("takes every level in order, sorted within a level, each wait under the 10s bound", async () => {
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(2), item(1)]] })));
    const before: string[] = [];
    const { locks } = await planAndLock({ beforeAttributionLock: async (id: string) => { before.push(id); } });

    const work = c.work;
    const provider = indexOf(work, isProviderLock);
    const mapping = indexOf(work, isMappingLock);
    const firstPath = indexOf(work, isPathLock);
    const lastPath = lastIndexOf(work, isPathLock);
    const firstAdvisory = indexOf(work, isAttributionLock);
    const lastAdvisory = lastIndexOf(work, isAttributionLock);
    const rows = indexOf(work, isItemRowLock);
    const revalidation = lastIndexOf(work, isOccupantRead);
    const order = [provider, mapping, firstPath, lastPath, firstAdvisory, lastAdvisory, rows, revalidation];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Everything before the provider lock is the plan: reads only.
    expect(which(work.slice(0, provider), isLocking)).toEqual([]);
    expect(which(work.slice(0, provider), isOccupantRead)).toHaveLength(1);

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
    expect(work[rows].sql).toContain("order by id for update");

    for (const entry of work.filter((e) => isProviderLock(e) || isMappingLock(e) || isPathLock(e) || isAttributionLock(e) || isItemRowLock(e))) {
      expect(entry.lockTimeout, `unbounded wait: ${entry.sql}`).toBe(LOCK_ACQUISITION_TIMEOUT);
    }
    expect(LOCK_ACQUISITION_TIMEOUT).toBe("10s");
    // Restored for the dependent writes that follow.
    expect(c.log.filter((entry) => entry.sql.startsWith("select set_config")).at(-1)!.params).toEqual(["0"]);

    expect([...locks.itemIds].sort()).toEqual([item(1), item(2)]);
    expect(locks.pathKeys).toEqual(new Set(pathKeys));
    expect(locks.providerId).toBe(PROVIDER);
    expect(locks.projectIds).toEqual(new Set([STORAGE]));
  });

  it("a tombstoned mapping: its restore path is held and its item id is advisory-locked with no row to lock", async () => {
    const elsewhere = project(9);
    const c = use(new ScriptedConnection(driveDatabase({
      mappings: [{ item_id: item(7), project_id: elsewhere, canonical_path: "gdrive/kept--drive-0123456789.md" }],
    })));
    const { plan, locks } = await planAndLock();
    expect(plan.referenceProjectIds).toEqual([elsewhere]);
    expect(locks.pathKeys.has(drivePathIdentityKey(TEAM, { projectId: elsewhere, path: "gdrive/kept--drive-0123456789.md" }))).toBe(true);
    expect(locks.pathKeys.size).toBe(3);
    expect(which(c.work, isAttributionLock).map((entry) => entry.params[0])).toEqual([`${TEAM}:item:${item(7)}`]);
    expect(which(c.work, isItemRowLock)).toEqual([]);
    expect([...locks.itemIds]).toEqual([item(7)]);
    expect(locks.projectIds.has(elsewhere)).toBe(true);
  });
});

describe("a plan that does not survive its locks abandons the attempt", () => {
  const abandoned = async (database: ReturnType<typeof driveDatabase>) => {
    const c = use(new ScriptedConnection(database));
    const error = await planAndLock().catch((caught) => caught);
    expect(error).toBeInstanceOf(GdriveIngestStateChangedError);
    expect(error).toMatchObject({ code: "gdrive-ingest-state-changed" });
    expect(c.log.at(-1)!.sql).toBe("rollback");
    return c;
  };

  it("MAPPING CHANGED after it was planned — before any path, attribution or item lock is taken", async () => {
    const planned = { item_id: item(1), project_id: STORAGE, canonical_path: PATH };
    for (const locked of [null, { ...planned, canonical_path: "gdrive/moved.md" }, { ...planned, project_id: project(9) }, { ...planned, item_id: item(2) }]) {
      const c = await abandoned(driveDatabase({ mappings: [planned, locked], mappedItem: [item(1)] }));
      expect(which(c.work, isPathLock)).toEqual([]);
      expect(which(c.work, isAttributionLock)).toEqual([]);
      expect(which(c.work, isItemRowLock)).toEqual([]);
    }
    // …and a mapping that APPEARED where none was planned.
    await abandoned(driveDatabase({ mappings: [null, planned] }));
  });

  it("a candidate REMOVED before its row lock is not reused", async () => {
    await abandoned(driveDatabase({ discoveries: [[item(1), item(2)]], rowLocks: [[item(2)]] }));
  });

  it("a candidate that MOVED to another project is a stale project plan", async () => {
    await abandoned(driveDatabase({ discoveries: [[item(1)]], rowLocks: [[[item(1), project(9)]]] }));
  });

  it("a candidate that APPEARS under the locks is refused the same way", async () => {
    await abandoned(driveDatabase({ discoveries: [[item(1)], [item(1), item(2)]] }));
  });

  it("a planned project that is not held is never replaced by a late lock", async () => {
    const c = use(new ScriptedConnection(driveDatabase({
      mappings: [{ item_id: item(7), project_id: project(9), canonical_path: PATH }],
    })));
    const error = await withTransaction(async () => {
      const plan = await planTheDocument();
      // The commit holds the storage project but the referenced one was gone when it was locked.
      return lockGdriveIngestIdentities({ plan, lockedProjectIds: new Set([STORAGE]) });
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(GdriveIngestStateChangedError);
    expect(which(c.work, isLocking)).toEqual([]);
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
    ["an unknown commit outcome", Object.assign(new Error("COMMIT was not confirmed"), { unknownCommit: true })],
    ["an ordinary failure", new Error("boom")],
  ])("does not retry %s", async (_name, failure) => {
    let calls = 0;
    await expect(runGdriveIngestAttempts(async () => { calls++; throw failure; })).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
});

describe("the whole Drive ingest: identity → connection → the complete project set, then the document", () => {
  it("plans after the connection authority, takes every project before the provider, and none after", async () => {
    const elsewhere = project(9);
    const c = use(new ScriptedConnection(driveDatabase({
      audience: [project(5), project(1)],
      mappings: [{ item_id: item(7), project_id: elsewhere, canonical_path: "gdrive/kept.md" }],
      mappedItem: [[item(7), elsewhere]],
      discoveries: [[item(1), [item(7), elsewhere]]],
    })));
    await expect(ingestApiItem(
      new PgClient(), auth, drivePayload(), "team", { authorMemberId: null, mappingRevision: 7 }, "team", execution,
    )).rejects.toThrow(STOPS_INSIDE_THE_COMMIT);

    const work = c.work;
    const order = [
      indexOf(work, isIdentityLock),
      indexOf(work, isAuthorityLock),
      indexOf(work, isPrincipalLock),
      indexOf(work, isMappingRead),
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

    // The plan — between the principal lock and the first project lock — takes no lock.
    expect(which(work.slice(order[2] + 1, order[4]), isLocking)).toEqual([]);
    // COMPLETE and in final mode: audience shared, storage written, the canonical project by key.
    expect(which(work, isProjectLock).map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[project(1)], "share"],
      [[STORAGE], "no key update"],
      [[project(5)], "share"],
      [[elsewhere], "key share"],
    ]);
    // NO LATE PROJECT: nothing touches a project row once the provider identity is held.
    expect(which(work.slice(order[6]), isProjectLock)).toEqual([]);
    expect(which(work.slice(order[6]), (e) => /\bfrom projects\b|\binto projects\b/.test(e.sql) && isLocking(e))).toEqual([]);

    // One key per path identity: no slug-keyed advisory anywhere.
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

  it("a stale execution is refused at the connection authority, before planning or any project, provider or item lock", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    await expect(ingestApiItem(NOT_A_DATABASE, auth, drivePayload(), "team", undefined, "team", { ...execution, fence: 4 }))
      .rejects.toMatchObject({ code: "stale_execution", status: 409 });
    expect(which(c.work, isMappingRead)).toEqual([]);
    expect(which(c.work, isProjectLock)).toEqual([]);
    expect(which(c.work, isProviderLock)).toEqual([]);
    expect(which(c.work, isItemRowLock)).toEqual([]);
  });

  it("RETRYABLE: the first attempt rolls back whole and the second plans again from the connection authority", async () => {
    // Attempt 1 plans item 1, which is gone by the row lock. Attempt 2 plans an empty path.
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(1)], [], []], rowLocks: [[]] })));
    const attempts: number[] = [];
    await expect(ingestApiItem(new PgClient(), auth, drivePayload(), "team", undefined, "team", execution, {
      beforeDriveAttempt: async (attempt) => { attempts.push(attempt); },
    })).rejects.toThrow(STOPS_INSIDE_THE_COMMIT);

    expect(attempts).toEqual([1, 2]);
    expect(c.count("begin")).toBe(2);
    expect(c.count("rollback")).toBe(2);
    const firstRollback = c.log.findIndex((entry) => entry.sql === "rollback");
    const work = new Set(c.work);
    const second = c.log.slice(firstRollback + 1).filter((entry) => work.has(entry));
    // Nothing is reused: the second attempt re-takes the identity authority and then the connection
    // authority, plans again, and re-takes every lock below it.
    expect(indexOf(second, isIdentityLock)).toBe(0);
    expect(indexOf(second, isAuthorityLock)).toBe(1);
    expect(indexOf(second, isMappingRead)).toBeGreaterThan(0);
    expect(indexOf(second, isProjectLock)).toBeGreaterThan(indexOf(second, isMappingRead));
    expect(indexOf(second, isProviderLock)).toBeGreaterThan(indexOf(second, isProjectLock));
    expect(which(second, isAttributionLock)).toEqual([]);
    expect(which(c.log.slice(0, firstRollback), isAttributionLock)).toHaveLength(1);
  });

  it("a plan that fails on BOTH attempts aborts by name after exactly two", async () => {
    const c = use(new ScriptedConnection(driveDatabase({ discoveries: [[item(1)]], rowLocks: [[]] })));
    await expect(ingestApiItem(new PgClient(), auth, drivePayload(), "team", undefined, "team", execution))
      .rejects.toBeInstanceOf(GdriveIngestStateChangedError);
    expect(c.count("begin")).toBe(2);
    expect(c.count("rollback")).toBe(2);
  });

  it.each([
    ["a project row", (sql: string) => / for (key share|share|no key update)$/.test(sql) && sql.includes("from projects")],
    ["the provider identity", (_sql: string, params: unknown[]) => String(params[0]).startsWith(`${TEAM}:gdrive:`)],
  ])("BOUNDED TIMEOUT: %s that times out fails the ingest once, with no retry and nothing below it taken", async (_name, blocked) => {
    const c = use(new ScriptedConnection(driveDatabase({
      fail: (sql, params) => (blocked(sql, params) ? sqlError("canceling statement due to lock timeout", "55P03") : null),
    })));
    await expect(ingestApiItem(new PgClient(), auth, drivePayload(), "team", undefined, "team", execution))
      .rejects.toMatchObject({ code: "55P03" });
    expect(c.count("begin")).toBe(1);
    expect(c.log.at(-1)!.sql).toBe("rollback");
    expect(c.log.at(-2)!.lockTimeout).toBe("10s");
    expect(which(c.work, isPathLock)).toEqual([]);
    expect(which(c.work, isAttributionLock)).toEqual([]);
  });

  it.each([
    ["a payload that fails validation", () => new PgClient(), { ...drivePayload(), content_sha256: "not-a-hash" } as ItemPayload, /invalid item payload/],
    ["a client that cannot run the publishing transaction", () => NOT_A_DATABASE, drivePayload(), STOPS_AFTER_LOCKS],
  ] as const)("VALIDATE BEFORE MUTATION: %s is refused after the connection authority and before any project is created or locked", async (_name, client, payload, refusal) => {
    // The storage project does not exist: a commit that got that far would create it.
    const c = use(new ScriptedConnection((sql, params) => {
      if (isSourceProjectRead({ sql, params, lockTimeout: "" })) return [];
      if (isProjectCreate({ sql, params, lockTimeout: "" })) return [{ id: STORAGE }];
      return driveDatabase()(sql, params);
    }));
    await expect(ingestApiItem(client(), auth, payload, "team", undefined, "team", execution)).rejects.toThrow(refusal);
    // The authority refusals keep their precedence: the connection was locked and checked first.
    expect(which(c.work, isAuthorityLock)).toHaveLength(1);
    expect(which(c.work, isSourceProjectRead)).toEqual([]);
    expect(which(c.work, isProjectCreate)).toEqual([]);
    expect(which(c.work, isWrite)).toEqual([]);
    expect(which(c.work, isProjectLock)).toEqual([]);
    expect(which(c.work, isProviderLock)).toEqual([]);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("an ABSENT storage project is created inside the commit, before the project pass, and locked for write with the rest", async () => {
    const c = use(new ScriptedConnection((sql, params) => {
      if (isSourceProjectRead({ sql, params, lockTimeout: "" })) return [];
      if (isProjectCreate({ sql, params, lockTimeout: "" })) return [{ id: STORAGE }];
      return driveDatabase()(sql, params);
    }));
    await expect(ingestApiItem(new PgClient(), auth, drivePayload(), "team", undefined, "team", execution))
      .rejects.toThrow(STOPS_INSIDE_THE_COMMIT);
    const work = c.work;
    const order = [
      indexOf(work, isAuthorityLock),
      indexOf(work, isSourceProjectRead),
      indexOf(work, isProjectCreate),
      indexOf(work, isMappingRead),
      indexOf(work, isProjectLock),
      indexOf(work, isProviderLock),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(work[order[2]].lockTimeout, "the create can wait on a concurrent creator").toBe("10s");
    expect(which(work, isProjectLock).map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[project(1)], "share"],
      [[STORAGE], "no key update"],
    ]);
    // Created in the commit's one transaction, which then failed: it is rolled back with it.
    expect(c.count("begin")).toBe(1);
    expect(c.count("commit")).toBe(0);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });
});

describe("the public wrapper: project-before-item, so it holds nothing of its own", () => {
  it("a payload that is not Drive-sourced takes NO lock before ingestItem — only an unlocked read", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    const payload = { ...drivePayload(), frontmatter: { source: "notion" } } as ItemPayload;
    await expect(ingestApiItem(NOT_A_DATABASE, auth, payload, "team", undefined, "team")).rejects.toThrow(STOPS_AFTER_LOCKS);
    // `ingestItem` stopped before its project acquisition, so this is everything the wrapper did —
    // and it ran outside any transaction.
    expect(c.count("begin")).toBe(0);
    expect(c.work).toHaveLength(1);
    expect(c.work[0].sql).toContain("i.frontmatter->>'source' as item_source");
    expect(which(c.work, isLocking)).toEqual([]);
    // No path key, no attribution advisory, no item row lock, and no Drive lock of any kind.
    expect(which(c.work, isSlugPathLock)).toEqual([]);
    expect(which(c.work, isAttributionLock)).toEqual([]);
    expect(which(c.work, isAuthorityLock)).toEqual([]);
    expect(which(c.work, isProviderLock)).toEqual([]);
    expect(which(c.work, isMappingLock)).toEqual([]);
  });

  it.each([
    [undefined, "connector_principal_required"],
    [execution, "wrong_connection"],
  ] as const)("the unlocked read may REFUSE a Drive-owned target (execution %o → %s)", async (ref, code) => {
    // Either signal refuses: stored provenance, or a provider mapping for the row — which carries
    // no connection id for any claimed document, and survives provenance that was stripped or altered.
    for (const stored of [
      { item_source: "gdrive", drive_mapped: false },
      { item_source: "notion", drive_mapped: true },
      { item_source: null, drive_mapped: true },
    ]) {
      const c = use(new ScriptedConnection((sql) => (sql.includes("as item_source") ? [stored] : [])));
      const payload = { ...drivePayload(), frontmatter: {} } as ItemPayload;
      await expect(ingestApiItem(NOT_A_DATABASE, auth, payload, "team", undefined, "team", ref))
        .rejects.toMatchObject({ code, status: 403 });
      expect(which(c.work, isLocking)).toEqual([]);
    }
  });
});

describe("project rows: one ascending pass, each row once in its final mode, no upgrade", () => {
  async function commit(audience: string[], plan?: GdriveCommitProjectPlan) {
    const c = use(new ScriptedConnection(driveDatabase({ audience })));
    let seen: unknown;
    await withGdriveExecutionCommit(auth, execution, async (approved) => {
      seen = approved;
    }, plan ? { projects: async () => plan } : {});
    return {
      c,
      seen: seen as { projectIds: string[]; lockedProjects: ReadonlyMap<string, string> },
      locks: which(c.work, isProjectLock).map((entry) => [entry.params[1], mode(entry)]),
    };
  }
  const held = (seen: { lockedProjects: ReadonlyMap<string, string> }) => new Set(seen.lockedProjects.keys());
  const writes = (...ids: string[]): GdriveCommitProjectPlan => ({ writeProjectIds: ids, referenceProjectIds: [] });

  it("locks the audience below the storage project, the storage project for write, then the audience above", async () => {
    const { c, seen, locks } = await commit([project(5), project(1), project(3)], writes(project(4)));
    expect(locks).toEqual([
      [[project(1), project(3)], "share"],
      [[project(4)], "no key update"],
      [[project(5)], "share"],
    ]);
    for (const entry of which(c.work, isProjectLock)) expect(entry.lockTimeout).toBe("10s");
    expect(indexOf(c.work, isAuthorityLock)).toBeLessThan(indexOf(c.work, isProjectLock));
    expect(seen.projectIds).toEqual([project(5), project(1), project(3)]);
    expect(held(seen)).toEqual(new Set([project(1), project(3), project(4), project(5)]));
    // The slug each row had under its lock is what a caller verifies its plan against.
    expect(seen.lockedProjects.get(project(4))).toBe("docs");
  });

  it("NO UPGRADE: a storage project that is also an audience project is write-locked once and never share-locked", async () => {
    const { locks } = await commit([project(5), project(1), project(3)], writes(project(3)));
    expect(locks).toEqual([
      [[project(1)], "share"],
      [[project(3)], "no key update"],
      [[project(5)], "share"],
    ]);
    const weaker = locks.filter(([, held]) => held !== "no key update").flatMap(([ids]) => ids as string[]);
    expect(weaker).not.toContain(project(3));
  });

  it("COMPLETE: a referenced project is taken by key in the same pass; the strongest need wins", async () => {
    const { seen, locks } = await commit([project(5), project(2)], {
      writeProjectIds: [project(4)],
      // 1 and 3 are only referenced; 2 is also audience (share wins); 4 is also written (write wins).
      referenceProjectIds: [project(3), project(1), project(2), project(4)],
    });
    expect(locks).toEqual([
      [[project(1)], "key share"],
      [[project(2)], "share"],
      [[project(3)], "key share"],
      [[project(4)], "no key update"],
      [[project(5)], "share"],
    ]);
    // Each row exactly once.
    const all = locks.flatMap(([ids]) => ids as string[]);
    expect(new Set(all).size).toBe(all.length);
    expect(seen.lockedProjects.size).toBe(5);
  });

  it("is the same order whichever way the audience is configured, and case-insensitive", async () => {
    const forward = (await commit([project(1), project(3), project(5)], writes(project(4)))).locks;
    const shuffled = (await commit([project(5).toUpperCase(), project(3), project(1)], writes(project(4).toUpperCase()))).locks;
    expect(shuffled).toEqual(forward);
  });

  it("reconciliation plans no project: one ascending share pass over its audience", async () => {
    const { seen, locks } = await commit([project(5), project(1)]);
    expect(locks).toEqual([[[project(1), project(5)], "share"]]);
    expect(held(seen)).toEqual(new Set([project(1), project(5)]));
  });

  it("a planned project that is gone under its lock is reported as not held, not assumed", async () => {
    const c = use(new ScriptedConnection((sql, params) => {
      const reply = driveDatabase({ audience: [project(1)] })(sql, params);
      // The storage row lock finds nothing.
      return /for no key update$/.test(sql) ? [] : reply;
    }));
    let seen = new Set<string>() as ReadonlySet<string>;
    await withGdriveExecutionCommit(auth, execution, async (approved) => { seen = new Set(approved.lockedProjects.keys()); }, { projects: async () => writes(project(4)) });
    expect(seen).toEqual(new Set([project(1)]));
    expect(which(c.work, isProjectLock)).toHaveLength(2);
  });

  it("IDENTITY FIRST: a commit that validates no identity revision still takes the team identity authority before its connection rows, bounded", async () => {
    // A commit locks its connection and then its bound connector MEMBER. A roster writer holds the
    // identity authority before a member row, and a hard deletion's foreign-key actions then reach
    // the connection — so the authority is the head of this order whether or not a revision is checked.
    const c = use(new ScriptedConnection(driveDatabase()));
    await withGdriveExecutionCommit(auth, execution, async () => undefined);
    const work = c.work;
    expect(isIdentityLock(work[0])).toBe(true);
    expect(indexOf(work, isAuthorityLock)).toBe(1);
    expect(indexOf(work, isPrincipalLock)).toBeGreaterThan(1);
    expect(work[0].lockTimeout).toBe("10s");
    expect(which(work, isIdentityLock)).toHaveLength(1);
  });

  it("the lock_timeout is back to the caller's value for the commit body", async () => {
    const c = use(new ScriptedConnection(driveDatabase()));
    await withGdriveExecutionCommit(auth, execution, async () => {
      await runSql("DEPENDENT WRITE");
    });
    expect(c.work.find((entry) => entry.sql === "dependent write")!.lockTimeout).toBe("0");
  });
});

describe("reconciliation: connection → every provider → attribution advisories → the complete item set, then the first write", () => {
  it("takes all provider locks (sorted), their mapping rows, every attribution advisory, then every item row in id order — bounded — before writing", async () => {
    const c = use(new ScriptedConnection((sql) => {
      if (sql.startsWith("select provider_id from gdrive_item_claims")) {
        return [{ provider_id: "b" }, { provider_id: "c" }, { provider_id: "a" }];
      }
      // Claims and mappings name three items, unsorted and with a repeat.
      if (isReconcileItemRead({ sql, params: [], lockTimeout: "" })) {
        return [{ item_id: item(3) }, { item_id: item(1) }, { item_id: item(2) }, { item_id: item(1) }];
      }
      return [];
    }));
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
    // … then their mapping rows, and — under those — the items the pass can touch …
    expect(isMappingLock(work[4])).toBe(true);
    expect(work[4].params[1]).toEqual(["a", "b", "c"]);
    expect(isReconcileItemRead(work[5])).toBe(true);
    expect(isLocking(work[5])).toBe(false);
    expect(work[5].params).toEqual([TEAM, INTEGRATION, ["a", "b", "c"]]);
    // … then EVERY item-attribution advisory, sorted and once each, before ANY item row …
    expect(work.slice(6, 9).every(isAttributionLock)).toBe(true);
    expect(work.slice(6, 9).map((entry) => entry.params[0]))
      .toEqual([`${TEAM}:item:${item(1)}`, `${TEAM}:item:${item(2)}`, `${TEAM}:item:${item(3)}`]);
    // … then the complete item-row set, in id order …
    expect(isReconcileItemLock(work[9])).toBe(true);
    expect(work[9].params).toEqual([TEAM, [item(1), item(2), item(3)]]);
    expect(indexOf(work, (e) => e.sql.includes(" from items") && isLocking(e))).toBe(9);
    for (const entry of work.slice(1, 10)) expect(entry.lockTimeout, entry.sql).toBe("10s");
    for (const entry of which(work, isProviderLock)) expect(entry.lockTimeout).toBe("10s");
    // … and nothing is written before the last of them.
    expect(work.findIndex(isWrite)).toBeGreaterThan(9);
    expect(which(work, isReconcileItemLock)).toHaveLength(1);
    expect(which(work, isAttributionLock)).toHaveLength(3);
  });

  it("providers that name no item take no advisory and no item row", async () => {
    const c = use(new ScriptedConnection((sql) =>
      (sql.startsWith("select provider_id from gdrive_item_claims") ? [{ provider_id: "a" }] : [])));
    await stageGdriveReconciliation(NOT_A_DATABASE, TEAM, {
      connectionId: INTEGRATION, removedProviderIds: ["a"], reason: "removed upstream",
    });
    expect(which(c.work, isProviderLock).length).toBeGreaterThan(0);
    expect(which(c.work, isReconcileItemRead)).toHaveLength(1);
    expect(which(c.work, isAttributionLock)).toEqual([]);
    expect(which(c.work, isReconcileItemLock)).toEqual([]);
  });

  it("takes no provider or item lock when nothing is retired", async () => {
    const c = use(new ScriptedConnection());
    await stageGdriveReconciliation(NOT_A_DATABASE, TEAM, {
      connectionId: INTEGRATION, removedProviderIds: ["a"], reason: "noop",
    });
    expect(which(c.work, isProviderLock)).toEqual([]);
    expect(which(c.work, isAttributionLock)).toEqual([]);
    expect(which(c.work, isReconcileItemLock)).toEqual([]);
  });
});

describe("project rows for every ingest: planned by unlocked reads, created or abandoned, locked once", () => {
  const exec = (respond: (sql: string, params: unknown[], log: Entry[]) => Reply) => {
    const c = use(new ScriptedConnection(respond));
    const run: ProjectSqlExecutor = async <T,>(text: string, params: unknown[] = []) =>
      (await c.query(text, params)) as unknown as { rows: T[] };
    return { c, run };
  };
  const NOW = "2026-01-02T03:04:05.000Z";

  it("an existing source project is read without a lock and nothing is written", async () => {
    const { c, run } = exec((sql) => (sql === SOURCE_PROJECT_READ ? [{ id: STORAGE }] : []));
    await expect(resolveSourceProject(run, TEAM, "docs", NOW)).resolves.toEqual({ id: STORAGE, created: false });
    expect(c.work).toHaveLength(1);
    expect(which(c.work, isLocking)).toEqual([]);
    expect(which(c.work, isWrite)).toEqual([]);
  });

  it("an absent source project is created by a do-nothing insert — never a conflict-update", async () => {
    const { c, run } = exec((sql) => (sql.startsWith("insert into projects") ? [{ id: STORAGE }] : []));
    await expect(resolveSourceProject(run, TEAM, "docs", NOW)).resolves.toEqual({ id: STORAGE, created: true });
    expect(c.work.map((entry) => entry.sql)).toEqual([SOURCE_PROJECT_READ, c.work[1].sql]);
    expect(isProjectCreate(c.work[1])).toBe(true);
    expect(c.work[1].params).toEqual([TEAM, "docs", NOW]);
    expect(c.work[1].sql).not.toContain("do update");
  });

  it("CREATE RACE: a concurrent slug winner is resolved by reading it, before any downstream lock", async () => {
    // Read: absent. Insert: the winner committed first, so nothing is returned. Read again: the winner.
    const { c, run } = exec((sql, _params, log) =>
      (sql === SOURCE_PROJECT_READ && log.filter((entry) => entry.sql === SOURCE_PROJECT_READ).length === 2
        ? [{ id: STORAGE }] : []));
    await expect(resolveSourceProject(run, TEAM, "docs", NOW)).resolves.toEqual({ id: STORAGE, created: false });
    expect(c.work.map((entry) => (isProjectCreate(entry) ? "create" : entry.sql)))
      .toEqual([SOURCE_PROJECT_READ, "create", SOURCE_PROJECT_READ]);
    expect(which(c.work, isLocking)).toEqual([]);
  });

  it("a winner that is gone again abandons the plan by name", async () => {
    const { run } = exec(() => []);
    const error = await resolveSourceProject(run, TEAM, "docs", NOW).catch((caught) => caught);
    expect(error).toBeInstanceOf(ProjectPlanChangedError);
    expect(error).toMatchObject({ code: "ingest-project-plan-changed" });
  });

  it("locks each row once, ascending, in the strongest mode any of its roles needs", async () => {
    const { c, run } = exec((sql, params) =>
      (isProjectLock({ sql, params, lockTimeout: "" }) ? (params[1] as string[]).map(lockedProjectRow) : []));
    const locked = await lockProjectRows(run, TEAM, {
      write: [project(4).toUpperCase()],
      share: [project(5), project(2), project(4)],
      reference: [project(3), project(1), project(2), project(4), project(6), project(7)],
    });
    expect(which(c.work, isProjectLock).map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[project(1)], "key share"],
      [[project(2)], "share"],
      [[project(3)], "key share"],
      [[project(4)], "no key update"],
      [[project(5)], "share"],
      // Neighbours that want the same mode share one statement; the pass stays ascending.
      [[project(6), project(7)], "key share"],
    ]);
    expect(c.work.every(isProjectLock)).toBe(true);
    expect([...locked.keys()]).toEqual([1, 2, 3, 4, 5, 6, 7].map(project));
    expect(locked.get(project(4))).toBe("docs");
  });
});

describe("an ordinary ingest: project acquisition is inside the publishing transaction and before every item lock", () => {
  const ordinaryAuth = { teamId: TEAM, memberId: "member", apiKeyId: "key" };
  const ordinaryPayload = () => ({ ...drivePayload(), frontmatter: { source: "notion" } }) as ItemPayload;
  const SYSTEM = [project(9), project(1)];

  /** A database with no source project yet, two system destinations, and a readable graph pointer. */
  function ordinaryDatabase(opts: {
    lockedRows?: (ids: string[]) => Row[];
    pointerReadable?: boolean;
  } = {}) {
    return (sql: string, params: unknown[]): Reply => {
      const e: Entry = { sql, params, lockTimeout: "" };
      if (isProjectCreate(e)) return [{ id: STORAGE }];
      if (isSystemDestinationRead(e)) return SYSTEM.map((id) => ({ id }));
      if (isProjectLock(e)) return (opts.lockedRows ?? ((ids) => ids.map(lockedProjectRow)))(params[1] as string[]);
      if (sql.startsWith("select slug, kind, graph_group_id from projects") && opts.pointerReadable !== false) {
        return [{ slug: "docs", kind: "source", graph_group_id: projectGroupId(TEAM, STORAGE) }];
      }
      return [];
    };
  }
  const run = (c: ScriptedConnection) =>
    ingestItem(new PgClient(), ordinaryAuth, ordinaryPayload(), "team").then(
      () => null,
      (error: unknown) => error as Error,
    ).finally(() => expect(c.release).toHaveBeenCalled());

  it("plans by unlocked reads, creates the absent project in the transaction, and takes the whole set once", async () => {
    const c = use(new ScriptedConnection(ordinaryDatabase()));
    await run(c);

    const begin = c.log.findIndex((entry) => entry.sql === "begin");
    const savepoint = c.log.findIndex((entry) => entry.sql.startsWith("savepoint "));
    const create = c.log.findIndex(isProjectCreate);
    // Created inside the one transaction, and inside the context session's savepoint.
    expect(begin).toBe(0);
    expect(savepoint).toBeGreaterThan(begin);
    expect(create).toBeGreaterThan(savepoint);
    expect(c.count("begin")).toBe(1);

    const work = c.work;
    const order = [
      indexOf(work, isSourceProjectRead),
      indexOf(work, isProjectCreate),
      indexOf(work, isSystemDestinationRead),
      indexOf(work, isProjectLock),
      lastIndexOf(work, isProjectLock),
      indexOf(work, (e) => e.sql.startsWith("update projects set last_synced_at")),
      indexOf(work, isSessionPathLock),
      indexOf(work, isAttributionLock),
      indexOf(work, isSessionItemLock),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The plan takes no lock, and it is the first thing the ingest does.
    expect(order[0]).toBe(0);
    expect(which(work.slice(0, order[3]), isLocking)).toEqual([]);
    // COMPLETE, ascending, final mode: the source for write, each system destination by key.
    expect(which(work, isProjectLock).map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[project(1)], "key share"],
      [[STORAGE], "no key update"],
      [[project(9)], "key share"],
    ]);
    for (const entry of which(work, isProjectLock)) expect(entry.lockTimeout).toBe("10s");
    expect(work[order[1]].lockTimeout, "the create can wait on a concurrent creator").toBe("10s");
    // NO LATE PROJECT: once a path identity is held, no project row is locked again.
    expect(which(work.slice(order[6]), isProjectLock)).toEqual([]);
    // The timestamp is written only under the row lock.
    expect(order[5]).toBeGreaterThan(order[4]);

    // BOUNDED ATTRIBUTION ADVISORY: the one wait between the path identity and the item row runs
    // under the same 10s bound, exactly once, and the caller's value is restored by the very next
    // statement — before the item row is asked for.
    const attribution = which(work, isAttributionLock);
    expect(attribution).toHaveLength(1);
    expect(attribution[0].lockTimeout).toBe(LOCK_ACQUISITION_TIMEOUT);
    const restore = c.log[c.log.indexOf(attribution[0]) + 1];
    expect(restore.sql.startsWith("select set_config('lock_timeout'")).toBe(true);
    expect(restore.params).toEqual(["0"]);
    expect(c.log.indexOf(restore)).toBeLessThan(c.log.indexOf(work[order[8]]));
  });

  it("BOUNDED TIMEOUT: a held item-attribution advisory fails the ingest once (55P03) — after project and path, before the item row, with no retry", async () => {
    const c = use(new ScriptedConnection((sql, params) =>
      (isAttributionLock({ sql, params, lockTimeout: "" })
        ? sqlError("canceling statement due to lock timeout", "55P03")
        : ordinaryDatabase()(sql, params))));
    const error = await run(c);
    expect(error).toMatchObject({ code: "55P03" });

    const work = c.work;
    const timedOut = which(work, isAttributionLock);
    // ONE attempt: the wait is not repeated, and no second context session is opened for it.
    expect(timedOut).toHaveLength(1);
    expect(c.log.filter((entry) => entry.sql.startsWith("savepoint "))).toHaveLength(1);
    expect(c.count("begin")).toBe(1);
    expect(timedOut[0].lockTimeout).toBe(LOCK_ACQUISITION_TIMEOUT);
    // The order is unchanged: project rows, then the path identity, then this advisory …
    const order = [lastIndexOf(work, isProjectLock), indexOf(work, isSessionPathLock), indexOf(work, isAttributionLock)];
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // … and nothing below it: no item row, and the whole publication rolled back with the project.
    expect(which(work, isSessionItemLock)).toEqual([]);
    expect(which(work.slice(order[2] + 1), isWrite)).toEqual([]);
    expect(c.count("commit")).toBe(0);
    expect(c.log.at(-1)!.sql).toBe("rollback");
    expect(c.log.some((entry) => entry.sql.startsWith("rollback to savepoint"))).toBe(true);
  });

  it("ROLLBACK: a failure after the project setup takes the created project with it", async () => {
    const c = use(new ScriptedConnection(ordinaryDatabase({ pointerReadable: false })));
    const error = await run(c);
    expect(error?.message).toMatch(/graph pointer/);
    expect(which(c.work, isProjectCreate)).toHaveLength(1);
    expect(c.count("commit")).toBe(0);
    expect(c.log.at(-1)!.sql).toBe("rollback");
    expect(c.log.findIndex(isProjectCreate)).toBeLessThan(c.log.findIndex((entry) => entry.sql.startsWith("rollback to savepoint")));
    // It never got as far as a path, attribution or item lock.
    expect(which(c.work, isSessionPathLock)).toEqual([]);
    expect(which(c.work, isAttributionLock)).toEqual([]);
  });

  it.each([
    ["the source project was renamed before its row lock", (ids: string[]) => ids.map((id) => ({ id, slug: "renamed" }))],
    ["the source project is gone under its row lock", (ids: string[]) => ids.filter((id) => id !== STORAGE).map(lockedProjectRow)],
    ["a planned system destination is gone under its row lock", (ids: string[]) => ids.filter((id) => id !== project(9)).map(lockedProjectRow)],
  ])("PLAN CHANGED: %s — abandoned by name, not retried, nothing below it taken", async (_name, lockedRows) => {
    const c = use(new ScriptedConnection(ordinaryDatabase({ lockedRows })));
    const error = await run(c);
    expect(error).toBeInstanceOf(ProjectPlanChangedError);
    // One attempt: an invalid plan is not one of the context engine's retryable causes.
    expect(c.log.filter((entry) => entry.sql.startsWith("savepoint "))).toHaveLength(1);
    expect(c.log.at(-1)!.sql).toBe("rollback");
    expect(which(c.work, (e) => e.sql.startsWith("update projects set"))).toEqual([]);
    expect(which(c.work, isSessionPathLock)).toEqual([]);
    expect(which(c.work, isAttributionLock)).toEqual([]);
    expect(which(c.work, isSessionItemLock)).toEqual([]);
  });

  it("BOUNDED TIMEOUT: a held project row fails the ingest once (55P03), with no retry", async () => {
    const c = use(new ScriptedConnection((sql, params) =>
      (/ for no key update$/.test(sql)
        ? sqlError("canceling statement due to lock timeout", "55P03")
        : ordinaryDatabase()(sql, params))));
    const error = await run(c);
    expect(error).toMatchObject({ code: "55P03" });
    expect(c.log.filter((entry) => entry.sql.startsWith("savepoint "))).toHaveLength(1);
    expect(c.log.at(-1)!.sql).toBe("rollback");
    expect(which(c.work, isSessionPathLock)).toEqual([]);
  });
});

describe("a DIRECT Drive ingest takes the fenced order: provider → mapping → the whole path set → advisories → rows", () => {
  /**
   * Spec. `ingestItem` given a Drive-sourced payload directly (no execution commit) used to take
   * its path identity and only then read and write the provider mapping, while a fenced commit
   * takes provider → mapping → paths. Requested from different projects their project locks are
   * compatible, so each could hold what the other needed next. Every runtime Drive writer now runs
   * `lockGdriveIngestIdentities` from the plan its projects were taken for, before its first path.
   * The identity locks are not a commit: no connection authority, no claim.
   */
  type Scripted = NonNullable<Parameters<typeof driveDatabase>[0]>;
  const mappingColumns = (entry: Entry) =>
    entry.sql.match(/^insert into source_item_mappings \(([^)]*)\)/)![1].split(",").map((column) => column.trim());

  /** The scripted Drive world, plus what the ingest session itself reads once its locks are held. */
  function directDatabase(opts: Scripted = {}) {
    const base = driveDatabase(opts);
    let mapping = (opts.mappings ?? [null]).find((row) => row !== null) ?? null;
    return (sql: string, params: unknown[]): Reply => {
      if (sql.startsWith("select slug, kind, graph_group_id from projects")) {
        return [{ slug: "docs", kind: "source", graph_group_id: projectGroupId(TEAM, STORAGE) }];
      }
      // The session's own (builder) mapping reads see the planned row, or the one it just inserted.
      if (sql.startsWith("select item_id, project_id, canonical_path from source_item_mappings where team_id = $1")) {
        return mapping ? [mapping] : [];
      }
      if (sql.startsWith("insert into source_item_mappings (") && !mapping) {
        const columns = sql.match(/^insert into source_item_mappings \(([^)]*)\)/)![1].split(",").map((column) => column.trim());
        mapping = Object.fromEntries(["item_id", "project_id", "canonical_path"].map((column) => [column, params[columns.indexOf(column)]]));
        return [];
      }
      return base(sql, params);
    };
  }
  const direct = (hooks?: { beforeAttributionLock?: (id: string) => Promise<void>; afterAttributionLock?: (id: string) => Promise<void> }) =>
    ingestItem(
      new PgClient(), { teamId: TEAM, memberId: "member", apiKeyId: "key" }, drivePayload(), "external",
      { authorMemberId: null }, "team", undefined, hooks ? { concurrencyHooks: hooks } : {},
    ).then(() => null, (error: unknown) => error as Error);
  const noCommitAuthority = (work: Entry[]) => {
    expect(which(work, isAuthorityLock)).toEqual([]);
    expect(which(work, isPrincipalLock)).toEqual([]);
    expect(which(work, isIdentityLock)).toEqual([]);
    expect(which(work, (e) => /gdrive_item_claims|gdrive_item_claim_projects|gdrive_connection_authority/.test(e.sql))).toEqual([]);
  };

  it("ABSENT MAPPING: provider advisory, then the (absent) mapping row, then both paths — and only then is the mapping created, with no connection id", async () => {
    const c = use(new ScriptedConnection(directDatabase()));
    await direct();

    const work = c.work;
    const order = [
      indexOf(work, isSourceProjectRead),
      indexOf(work, isMappingRead),
      indexOf(work, isProjectLock),
      lastIndexOf(work, isProjectLock),
      indexOf(work, isProviderLock),
      indexOf(work, isMappingLock),
      indexOf(work, isPathLock),
      lastIndexOf(work, isPathLock),
      indexOf(work, (e) => e.sql.startsWith("update projects set last_synced_at")),
      indexOf(work, isMappingWrite),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The plan is made ONCE, before the project pass, and reused: it is never planned again.
    expect(which(work, isMappingRead)).toHaveLength(1);
    // The whole path set is taken once, in order, AFTER the mapping row — and never again by the
    // session: there is no second, path-first acquisition.
    const keys = which(work, isPathLock).map((entry) => entry.params[1] as string);
    expect(keys).toEqual([
      drivePathIdentityKey(TEAM, { projectId: STORAGE, path: PATH }),
      drivePathIdentityKey(TEAM, { projectId: STORAGE, path: driveCollisionSafePath(PATH, PROVIDER) }),
    ].sort());
    for (const entry of work.filter((e) => isProviderLock(e) || isMappingLock(e) || isPathLock(e))) {
      expect(entry.lockTimeout, `unbounded wait: ${entry.sql}`).toBe(LOCK_ACQUISITION_TIMEOUT);
    }
    // No placeholder: absence was re-read under the provider advisory, and the row is created only
    // after every acquisition — insert-if-absent, with a NULL connection id.
    const created = work[order[9]];
    expect(created.sql).toContain("on conflict (team_id, source, provider_id) do nothing");
    expect(created.params[mappingColumns(created).indexOf("connection_id")]).toBeNull();
    expect(created.params[mappingColumns(created).indexOf("project_id")]).toBe(STORAGE);
    // FRESH UUID: the minted item's advisory is the one identity taken after the mapping exists.
    const minted = String(created.params[mappingColumns(created).indexOf("item_id")]);
    const mintedLock = indexOf(work, (e) => isAttributionLock(e) && e.params[0] === `${TEAM}:item:${minted}`);
    expect(mintedLock).toBeGreaterThan(order[9]);
    noCommitAuthority(work);
    expect(c.count("begin")).toBe(1);
  });

  it("CANONICAL ELSEWHERE: requested from one project, living in another — the canonical project by key, its path in the set, the item held before the session reads", async () => {
    const elsewhere = project(9);
    const c = use(new ScriptedConnection(directDatabase({
      mappings: [{ item_id: item(7), project_id: elsewhere, canonical_path: "gdrive/kept.md" }],
      mappedItem: [[item(7), elsewhere]],
      discoveries: [[[item(7), elsewhere]]],
    })));
    const fired: string[] = [];
    await direct({
      beforeAttributionLock: async (id) => { fired.push(`before:${id}`); },
      afterAttributionLock: async (id) => { fired.push(`after:${id}`); },
    });

    const work = c.work;
    // COMPLETE project set, final modes: the requested project written, the canonical one by key.
    expect(which(work, isProjectLock).map((entry) => [entry.params[1], mode(entry)])).toEqual([
      [[STORAGE], "no key update"],
      [[elsewhere], "key share"],
    ]);
    const order = [
      lastIndexOf(work, isProjectLock),
      indexOf(work, isProviderLock),
      indexOf(work, isMappingLock),
      indexOf(work, isPathLock),
      lastIndexOf(work, isPathLock),
      indexOf(work, isAttributionLock),
      indexOf(work, isItemRowLock),
      indexOf(work, isMappingWrite),
    ];
    expect(order.every((index) => index >= 0), `missing a level: ${order}`).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The retained canonical location is one of the THREE paths, taken in the one sorted pass.
    const keys = which(work, isPathLock).map((entry) => entry.params[1] as string);
    expect(keys).toHaveLength(3);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain(drivePathIdentityKey(TEAM, { projectId: elsewhere, path: "gdrive/kept.md" }));
    // The seams fire once, where the advisory is really taken — not again where it is re-entered.
    expect(fired).toEqual([`before:${item(7)}`, `after:${item(7)}`]);
    // The mapping keeps its identity: nothing rewrites which item or provider it names.
    for (const write of which(work, isMappingWrite)) {
      if (write.sql.startsWith("update ")) expect(write.sql).not.toMatch(/\b(item_id|provider_id|source|team_id) = \$\d+,|set (item_id|provider_id|source|team_id) =/);
    }
    noCommitAuthority(work);
  });

  it("CHANGED PLAN: a mapping that differs under the provider advisory abandons the ingest — once, with nothing owned below it and nothing written", async () => {
    const c = use(new ScriptedConnection(directDatabase({
      mappings: [null, { item_id: item(7), project_id: STORAGE, canonical_path: PATH }],
    })));
    // `directDatabase` answers the session's own reads from the first non-null mapping; this
    // attempt never gets that far.
    const error = await direct();
    expect(error).toBeInstanceOf(GdriveIngestStateChangedError);
    const work = c.work;
    expect(which(work, isPathLock)).toEqual([]);
    expect(which(work, isAttributionLock)).toEqual([]);
    expect(which(work, isItemRowLock)).toEqual([]);
    expect(which(work, isWrite)).toEqual([]);
    // Not the fenced owner's two attempts, and not a replan: one transaction, one session, one plan.
    expect(c.count("begin")).toBe(1);
    expect(c.log.filter((entry) => entry.sql.startsWith("savepoint "))).toHaveLength(1);
    expect(which(work, isMappingRead)).toHaveLength(1);
    expect(c.count("commit")).toBe(0);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });

  it("BOUNDED: a held provider identity times the direct ingest out once (55P03), before the mapping row or any path", async () => {
    const c = use(new ScriptedConnection(directDatabase({
      fail: (_sql, params) => (String(params[0]).startsWith(`${TEAM}:gdrive:`)
        ? sqlError("canceling statement due to lock timeout", "55P03") : null),
    })));
    const error = await direct();
    expect(error).toMatchObject({ code: "55P03" });
    const work = c.work;
    expect(which(work, isProviderLock)).toHaveLength(1);
    expect(work.find(isProviderLock)!.lockTimeout).toBe(LOCK_ACQUISITION_TIMEOUT);
    expect(which(work, isMappingLock)).toEqual([]);
    expect(which(work, isPathLock)).toEqual([]);
    expect(c.count("begin")).toBe(1);
    expect(c.log.filter((entry) => entry.sql.startsWith("savepoint "))).toHaveLength(1);
    expect(c.log.at(-1)!.sql).toBe("rollback");
  });
});
