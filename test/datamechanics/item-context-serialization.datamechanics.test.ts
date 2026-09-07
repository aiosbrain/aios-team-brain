import { randomUUID } from "node:crypto";
import { Client, type PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ensureAccessBootstrap } from "@/lib/access/bootstrap";
import { canSeeItem } from "@/lib/access/enforce";
import { ingestItem } from "@/lib/ingest";
import { PgClient } from "@/lib/db/pg/client";
import { getPool } from "@/lib/db/pg/pool";
import type {
  DbClient,
  SqlExecutor,
  TransactionCapableDbClient,
} from "@/lib/db/types";
import {
  reconcileItemContext,
  systemProjectIds,
} from "@/lib/projects/context/reconcile-item";
import { backfillTeamContext } from "@/lib/projects/context/backfill";
import { reconcileItemUnit } from "@/lib/projects/context/units";
import {
  closeMembershipInto,
  ensureIncludeMembership,
} from "@/lib/projects/context/memberships";
import { addVariant, createOpportunity, createPlan } from "@/lib/social/store";
import {
  db,
  externalMember,
  placeMemberByTier,
  seedTeam,
  sha,
  transactionDecoratedDb,
  type Seed,
} from "./helpers";

/**
 * AUDITFIX-13 red-phase black-box coverage.
 *
 * These tests intentionally use only the shipped ingest/reconcile entry points for the operation
 * under test. The trigger below is real PostgreSQL failure injection: it rejects the target
 * membership INSERT after the narrowing path has already closed the old membership on the current
 * baseline. A non-transactional FakeSupabase cannot reproduce that stored half-move.
 */

type IngestAuth = Parameters<typeof ingestItem>[1];
type IngestPayload = Parameters<typeof ingestItem>[2];

interface ExistingItemFixture {
  seed: Seed;
  auth: IngestAuth;
  itemId: string;
  original: IngestPayload;
  system: { general: string; externalShared: string };
  externalViewerId: string;
}

interface Attempt<T> {
  result: T | null;
  error: string | null;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function within<T>(promise: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sessionClient(
  decorate: (executor: SqlExecutor) => SqlExecutor
): DbClient {
  return new PgClient({ decorateSessionExecutor: decorate });
}

function isItemAuthorityRead(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  return /^select /i.test(normalized) &&
    normalized.includes("member_id_locked") &&
    / from items where team_id = \$1 and (?:id = \$2|project_id = \$2 and path = \$3)/i.test(normalized);
}

async function observeAuthorityBlock(
  observer: Client,
  holderPid: number,
  waiterPid: number,
  authorityReadCompleted: () => boolean
): Promise<{ blockers: number[]; query: string | null; premature: boolean }> {
  const deadline = Date.now() + 4_000;
  let last = { blockers: [] as number[], query: null as string | null, premature: false };
  while (Date.now() < deadline) {
    if (authorityReadCompleted()) return { ...last, premature: true };
    const read = await observer.query<{ blockers: number[]; query: string | null }>(
      `select pg_blocking_pids($1::int) as blockers, query
         from pg_stat_activity
        where pid = $1`,
      [waiterPid]
    );
    last = read.rows[0] ?? last;
    if (last.blockers.includes(holderPid)) return { ...last, premature: false };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ...last, premature: authorityReadCompleted() };
}

interface RuntimeSqlTrace {
  readonly bound: { sql: string; params: unknown[]; rowCount: number | null }[];
  readonly poolCalls: {
    kind: "pool.query" | "pool.connect";
    phase: "outside-bound-phase" | "after-BEGIN-before-end";
    sql: string;
  }[];
  readonly forbidden: {
    kind: "pool.query" | "pool.connect";
    phase: "after-BEGIN-before-end";
    sql: string;
  }[];
  readonly checkouts: number;
  readonly transactions: number;
  restore(): void;
}

function installRuntimeSqlTrace(): RuntimeSqlTrace {
  type QueryResultShape = { rows: unknown[]; rowCount: number | null };
  type Callable = (...args: unknown[]) => unknown;
  type QuerySurface = { query: Callable };
  type PoolSurface = QuerySurface & { connect: Callable };

  const pool = getPool();
  const surface = pool as unknown as PoolSurface;
  const poolOwnedQuery = Object.prototype.hasOwnProperty.call(surface, "query");
  const poolOwnedConnect = Object.prototype.hasOwnProperty.call(surface, "connect");
  const originalPoolQuery = surface.query;
  const originalConnect = surface.connect;
  const originalClientQueries = new Map<
    PoolClient,
    { query: QuerySurface["query"]; owned: boolean }
  >();
  const nestedCheckouts = new WeakSet<PoolClient>();
  const bound: { sql: string; params: unknown[]; rowCount: number | null }[] = [];
  const poolCalls: RuntimeSqlTrace["poolCalls"] extends readonly (infer Entry)[]
    ? Entry[]
    : never = [];
  const forbidden: RuntimeSqlTrace["forbidden"] extends readonly (infer Entry)[]
    ? Entry[]
    : never = [];
  let activeClient: PoolClient | null = null;
  let checkouts = 0;
  let transactions = 0;

  const wrapClient = (client: PoolClient, nested = false): PoolClient => {
    if (nested) nestedCheckouts.add(client);
    if (originalClientQueries.has(client)) return client;
    const clientSurface = client as unknown as QuerySurface;
    const original = clientSurface.query;
    originalClientQueries.set(client, {
      query: original,
      owned: Object.prototype.hasOwnProperty.call(clientSurface, "query"),
    });
    clientSurface.query = (...args: unknown[]) => {
      const text = typeof args[0] === "string" ? args[0] : "<query-config>";
      const params = Array.isArray(args[1]) ? args[1] : [];
      const sql = text.replace(/\s+/g, " ").trim();
      const beginning = /^BEGIN$/i.test(sql);
      const wasActive = activeClient === client;
      if (activeClient && !wasActive && nestedCheckouts.has(client)) {
        forbidden.push({
          kind: "pool.connect",
          phase: "after-BEGIN-before-end",
          sql,
        });
      }
      const pending = original.apply(client, args);
      // Bound application/control calls use pg's Promise form. Callback-form queries are pool
      // internals outside this session and must retain their exact calling convention.
      if (!beginning && !wasActive) return pending;
      return Promise.resolve(pending).then((unknownResult) => {
        const result = unknownResult as QueryResultShape;
        if (beginning) {
          if (activeClient) {
            forbidden.push({
              kind: "pool.connect",
              phase: "after-BEGIN-before-end",
              sql: "nested BEGIN on a second session",
            });
          }
          activeClient = client;
          transactions++;
          bound.push({ sql, params, rowCount: result.rowCount });
        } else {
          bound.push({ sql, params, rowCount: result.rowCount });
          if (/^(?:COMMIT|ROLLBACK)$/i.test(sql)) activeClient = null;
        }
        return unknownResult;
      });
    };
    return client;
  };

  surface.query = (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : "<query-config>";
    const sql = text.replace(/\s+/g, " ").trim();
    poolCalls.push({
      kind: "pool.query",
      phase: activeClient ? "after-BEGIN-before-end" : "outside-bound-phase",
      sql,
    });
    if (activeClient) forbidden.push({ kind: "pool.query", phase: "after-BEGIN-before-end", sql });
    return originalPoolQuery.apply(pool, args);
  };
  surface.connect = (...args: unknown[]) => {
    const nested = activeClient !== null;
    poolCalls.push({
      kind: "pool.connect",
      phase: nested ? "after-BEGIN-before-end" : "outside-bound-phase",
      sql: "pool.connect()",
    });
    if (nested) {
      forbidden.push({
        kind: "pool.connect",
        phase: "after-BEGIN-before-end",
        sql: "nested pool checkout",
      });
    }
    checkouts++;
    if (typeof args[0] === "function") {
      const callback = args[0] as (
        error: unknown,
        client?: PoolClient,
        done?: (releaseError?: Error | boolean) => void
      ) => void;
      return originalConnect.call(
        pool,
        (error: unknown, client?: PoolClient, done?: (releaseError?: Error | boolean) => void) =>
          callback(error, client ? wrapClient(client, nested) : client, done)
      );
    }
    return Promise.resolve(originalConnect.call(pool)).then((client) =>
      wrapClient(client as PoolClient, nested)
    );
  };

  return {
    bound,
    poolCalls,
    forbidden,
    get checkouts() {
      return checkouts;
    },
    get transactions() {
      return transactions;
    },
    restore() {
      if (poolOwnedQuery) surface.query = originalPoolQuery;
      else delete (surface as Partial<PoolSurface>).query;
      if (poolOwnedConnect) surface.connect = originalConnect;
      else delete (surface as Partial<PoolSurface>).connect;
      for (const [client, original] of originalClientQueries) {
        const clientSurface = client as unknown as QuerySurface;
        if (original.owned) clientSurface.query = original.query;
        else delete (clientSurface as Partial<QuerySurface>).query;
      }
    },
  };
}

function actualSqlFaultDb(pattern: RegExp): { db: DbClient; fired: () => number } {
  let hits = 0;
  return {
    db: sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (hits === 0 && pattern.test(normalized)) {
        hits++;
        // This is a real PostgreSQL transaction-aborting error, not a fabricated envelope.
        await execute("select 1 / 0 as auditfix13_injected_failure");
      }
      return execute<T>(text, params);
    }),
    fired: () => hits,
  };
}

async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { result: await fn(), error: null };
  } catch (error) {
    return {
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function seedConvergedExternalItem(path: string): Promise<ExistingItemFixture> {
  const seed = await seedTeam();
  const bootstrap = await ensureAccessBootstrap(db(), seed.teamId);
  if (!bootstrap.ok) throw new Error(`fixture bootstrap failed: ${bootstrap.error}`);

  const auth: IngestAuth = {
    teamId: seed.teamId,
    memberId: seed.memberId,
    apiKeyId: randomUUID(),
  };
  const body = `original external body for ${path}`;
  const original: IngestPayload = {
    project: "auditfix13-source",
    kind: "deliverable",
    actor: "auditfix13-test",
    frontmatter: { source: "local" },
    path,
    body,
    content_sha256: sha(body),
  };

  const created = await ingestItem(db(), auth, original, "external", undefined, "team");
  expect(created.status, "fixture creates through the public ingest owner").toBe("created");

  const reconciled = await reconcileItemContext(db(), seed.teamId, created.id);
  expect(reconciled.ok, "fixture converges through the public reconcile owner").toBe(true);

  const system = await systemProjectIds(db(), seed.teamId);
  if (!system) throw new Error("fixture system projects missing");

  const externalViewerId = await externalMember(seed);
  expect(
    await canSeeItem(
      db(),
      { teamId: seed.teamId, memberId: externalViewerId },
      created.id
    ),
    "positive control: the external viewer can read the converged external item"
  ).toBe(true);

  return { seed, auth, itemId: created.id, original, system, externalViewerId };
}

async function storedState(seed: Seed, itemId: string) {
  const itemRead = await db()
    .from("items")
    .select("access, body, content_sha256, frontmatter, synced_at, updated_at")
    .eq("team_id", seed.teamId)
    .eq("id", itemId)
    .single();
  if (itemRead.error || !itemRead.data) {
    throw new Error(`item snapshot failed: ${itemRead.error?.message ?? "missing item"}`);
  }

  const unitRead = await db()
    .from("project_context_units")
    .select("id, audience, content_sha256, occurred_at, updated_at")
    .eq("team_id", seed.teamId)
    .eq("source_item_id", itemId)
    .eq("unit_kind", "item")
    .single();
  if (unitRead.error || !unitRead.data) {
    throw new Error(`unit snapshot failed: ${unitRead.error?.message ?? "missing unit"}`);
  }

  const membershipsRead = await db()
    .from("project_context_memberships")
    .select("id, project_id, decision, mode, method, valid_from, valid_to")
    .eq("team_id", seed.teamId)
    .eq("context_unit_id", unitRead.data.id)
    .order("valid_from", { ascending: true })
    .order("id", { ascending: true });
  if (membershipsRead.error) {
    throw new Error(`membership snapshot failed: ${membershipsRead.error.message}`);
  }

  const versionsRead = await db()
    .from("item_versions")
    .select("id, content_sha256, frontmatter, body, member_id, created_at")
    .eq("item_id", itemId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (versionsRead.error) {
    throw new Error(`version snapshot failed: ${versionsRead.error.message}`);
  }

  const auditsRead = await db()
    .from("audit_log")
    .select("id, action, target_type, target_id, meta, created_at")
    .eq("team_id", seed.teamId)
    .eq("target_id", itemId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });
  if (auditsRead.error) {
    throw new Error(`audit snapshot failed: ${auditsRead.error.message}`);
  }

  return {
    item: itemRead.data,
    unit: unitRead.data,
    memberships: membershipsRead.data ?? [],
    versions: versionsRead.data ?? [],
    audits: auditsRead.data ?? [],
  };
}

function assertUuid(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error(`unsafe UUID fixture value: ${value}`);
  return value;
}

/**
 * Install a test-scoped trigger from a dedicated real connection. The sequence is deliberate:
 * PostgreSQL sequence increments are not rolled back, so `fired` proves that the injected failing
 * statement was actually reached even after the production transaction becomes atomic.
 */
async function withFailingMembershipInsert<T>(
  scope: { teamId: string; projectId: string; unitId: string },
  fn: (marker: string) => Promise<T>
): Promise<{ value: T; fired: boolean }> {
  const suffix = randomUUID().replaceAll("-", "");
  // Keep identifiers below PostgreSQL's 63-byte limit so the regclass lookup is exact.
  const triggerName = `a13_fail_trg_${suffix}`;
  const functionName = `a13_fail_fn_${suffix}`;
  const sequenceName = `a13_fail_seq_${suffix}`;
  const marker = `AUDITFIX13_MEMBERSHIP_INSERT_${suffix}`;
  const teamId = assertUuid(scope.teamId);
  const projectId = assertUuid(scope.projectId);
  const unitId = assertUuid(scope.unitId);
  const control = new Client({ connectionString: process.env.DATABASE_URL });

  await control.connect();
  try {
    await control.query("set statement_timeout = '5s'");
    await control.query("set lock_timeout = '5s'");
    await control.query(`create sequence ${sequenceName}`);
    await control.query(`
      create function ${functionName}() returns trigger language plpgsql as $body$
      begin
        if new.team_id = '${teamId}'::uuid
           and new.project_id = '${projectId}'::uuid
           and new.context_unit_id = '${unitId}'::uuid then
          perform nextval('${sequenceName}'::regclass);
          raise exception '${marker}' using errcode = 'P0001';
        end if;
        return new;
      end
      $body$
    `);
    await control.query(`
      create trigger ${triggerName}
      before insert on project_context_memberships
      for each row execute function ${functionName}()
    `);

    const value = await fn(marker);
    const firedRead = await control.query<{ is_called: boolean }>(
      `select is_called from ${sequenceName}`
    );
    return { value, fired: firedRead.rows[0]?.is_called === true };
  } finally {
    // A failed assertion must not poison the shared data-mechanics database for later files.
    let cleanupError: unknown;
    try {
      for (const sql of [
        `drop trigger if exists ${triggerName} on project_context_memberships`,
        `drop function if exists ${functionName}()`,
        `drop sequence if exists ${sequenceName}`,
      ]) {
        try {
          await control.query(sql);
        } catch (error) {
          cleanupError ??= error;
        }
      }
    } finally {
      // Connection cleanup is unconditional even when one DROP fails; leaking this control client
      // can hold locks and poison later concurrency cases.
      await control.end();
    }
    if (cleanupError) throw cleanupError;
  }
}

async function unitIdFor(seed: Seed, itemId: string): Promise<string> {
  const { data, error } = await db()
    .from("project_context_units")
    .select("id")
    .eq("team_id", seed.teamId)
    .eq("source_item_id", itemId)
    .eq("unit_kind", "item")
    .single();
  if (error || !data) throw new Error(`fixture unit read failed: ${error?.message}`);
  return data.id as string;
}

async function plantSystemExclusion(
  fixture: ExistingItemFixture,
  projectId: string,
  mode: "auto" | "force_exclude"
): Promise<void> {
  const unitId = await unitIdFor(fixture.seed, fixture.itemId);
  const { error: closeError } = await db()
    .from("project_context_memberships")
    .update({ valid_to: new Date().toISOString() })
    .eq("team_id", fixture.seed.teamId)
    .eq("project_id", projectId)
    .eq("context_unit_id", unitId)
    .is("valid_to", null);
  if (closeError) throw new Error(`fixture current-row close failed: ${closeError.message}`);
  const { error } = await db().from("project_context_memberships").insert({
    team_id: fixture.seed.teamId,
    project_id: projectId,
    context_unit_id: unitId,
    decision: "exclude",
    mode,
    method: "manual",
  });
  if (error) throw new Error(`fixture exclusion insert failed: ${error.message}`);
}

function currentMembershipState(state: Awaited<ReturnType<typeof storedState>>) {
  return (state.memberships as {
    project_id: string;
    decision: string;
    mode: string;
    valid_to: string | null;
  }[])
    .filter((row) => row.valid_to === null)
    .map(({ project_id, decision, mode }) => ({ project_id, decision, mode }))
    .sort((left, right) => left.project_id.localeCompare(right.project_id));
}

async function grantGeneralToExternal(fixture: ExistingItemFixture): Promise<void> {
  const { data: externalGroup, error: groupError } = await db()
    .from("groups")
    .select("id")
    .eq("team_id", fixture.seed.teamId)
    .eq("slug", "external")
    .eq("is_builtin", true)
    .single();
  if (groupError || !externalGroup) {
    throw new Error(`external group fixture read failed: ${groupError?.message}`);
  }

  // Deliberately plant the settled Lane-C-invalid topology with raw fixture DML. Production group
  // writers correctly refuse this unsanctioned system edge; AUDITFIX-13 must remain safe if it exists.
  const { error } = await db().from("project_groups").insert({
    team_id: fixture.seed.teamId,
    project_id: fixture.system.general,
    group_id: externalGroup.id,
  });
  if (error) throw new Error(`unsanctioned General grant fixture failed: ${error.message}`);
}

describe("AUDITFIX-13 Phase A: item/context changes are one atomic operation", () => {
  it.each([
    { pathKind: "unchanged-body", changed: false, holder: "reconcile" as const },
    { pathKind: "unchanged-body", changed: false, holder: "ingest" as const },
    { pathKind: "changed-body", changed: true, holder: "reconcile" as const },
    { pathKind: "changed-body", changed: true, holder: "ingest" as const },
  ])(
    "A13-01: $holder-first row locking serializes the $pathKind narrowing and context move",
    async ({ pathKind, changed, holder }) => {
      const fixture = await seedConvergedExternalItem(`auditfix13/serial-${pathKind}.md`);
      const held = deferred();
      const release = deferred();
      const body = changed ? `${fixture.original.body}\nserialized edit` : fixture.original.body;
      const payload = { ...fixture.original, body, content_sha256: sha(body) };
      const waiterStarted = deferred();
      let holderPid: number | null = null;
      let waiterPid: number | null = null;
      let holderAuthorityReadCompleted = false;
      let waiterAuthorityReadCompleted = false;
      let paused = false;
      let attempted = false;
      const holdingDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
        if (holderPid === null) {
          const pid = await execute<{ pid: number }>("select pg_backend_pid() as pid");
          holderPid = pid.rows[0]?.pid ?? null;
        }
        const result = await execute<T>(text, params);
        if (!paused && isItemAuthorityRead(text)) {
          paused = true;
          holderAuthorityReadCompleted = true;
          held.resolve();
          await release.promise;
        }
        return result;
      });
      const waitingDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
        if (waiterPid === null) {
          const pid = await execute<{ pid: number }>("select pg_backend_pid() as pid");
          waiterPid = pid.rows[0]?.pid ?? null;
        }
        if (!attempted && isItemAuthorityRead(text)) {
          attempted = true;
          waiterStarted.resolve();
          const result = await execute<T>(text, params);
          waiterAuthorityReadCompleted = true;
          return result;
        }
        return execute<T>(text, params);
      });
      const observer = new Client({ connectionString: process.env.DATABASE_URL });
      let first: Promise<unknown> | undefined;
      let waiter: Promise<unknown> | undefined;

      await observer.connect();
      try {
        first = holder === "reconcile"
          ? reconcileItemContext(holdingDb, fixture.seed.teamId, fixture.itemId)
          : ingestItem(holdingDb, fixture.auth, payload, "team", undefined, "team");
        await within(held.promise, "holder to complete the locked authority read");
        expect(holderAuthorityReadCompleted).toBe(true);
        expect(holderPid, "holder backend PID was captured from its dedicated session").not.toBeNull();

        waiter = holder === "reconcile"
          ? ingestItem(waitingDb, fixture.auth, payload, "team", undefined, "team")
          : reconcileItemContext(waitingDb, fixture.seed.teamId, fixture.itemId);
        await within(waiterStarted.promise, "waiter to issue its authority read");
        expect(waiterPid, "waiter backend PID was captured from its dedicated session").not.toBeNull();

        const observation = await observeAuthorityBlock(
          observer,
          holderPid!,
          waiterPid!,
          () => waiterAuthorityReadCompleted
        );
        expect(
          observation.premature,
          "waiter authority read completed while the holder still owned the item lock"
        ).toBe(false);
        expect(
          observation.blockers,
          `waiter ${waiterPid} blockers while its authority SELECT was incomplete; active query: ${observation.query}`
        ).toContain(holderPid);
        expect(observation.query, "the blocked statement is the authority SELECT, not later DML").toMatch(
          /from items/i
        );

        release.resolve();
        const settled = await Promise.allSettled([first, waiter]);
        expect(settled.every((entry) => entry.status === "fulfilled")).toBe(true);
      } finally {
        release.resolve();
        await Promise.allSettled(
          [first, waiter].filter((actor): actor is Promise<unknown> => Boolean(actor))
        );
        await observer.end();
      }

      const after = await storedState(fixture.seed, fixture.itemId);
      expect(after.item.access).toBe("team");
      expect(after.unit.audience).toBe("team");
      const current = (after.memberships as { project_id: string; valid_to: string | null }[])
        .filter((row) => row.valid_to === null)
        .map((row) => row.project_id);
      expect(current).toEqual([fixture.system.general]);
      expect(
        await canSeeItem(
          db(),
          { teamId: fixture.seed.teamId, memberId: fixture.externalViewerId },
          fixture.itemId
        )
      ).toBe(false);
    }
  );

  it("A13-02: opposite exact-hash pushes and a reconcile finish on the last serialized authority", async () => {
    const seed = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const body = "stable body and timestamp";
    const payload: IngestPayload = {
      project: "auditfix13-opposite",
      kind: "deliverable",
      actor: "auditfix13-test",
      frontmatter: { source: "local", source_modified_at: "2026-01-02T03:04:05.000Z" },
      path: "opposite.md",
      body,
      content_sha256: sha(body),
    };
    const created = await ingestItem(db(), auth, payload, "team");
    const { data: missingUnit } = await db()
      .from("project_context_units")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("source_item_id", created.id)
      .maybeSingle();
    expect(missingUnit, "first-create placement remains hook/backfill-owned").toBeNull();

    const widened = await ingestItem(db(), auth, payload, "external");
    expect(widened.status).toBe("unchanged");
    const held = deferred();
    const release = deferred();
    let paused = false;
    const reconcileDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      const result = await execute<T>(text, params);
      if (!paused && /from items[\s\S]*for update/i.test(text)) {
        paused = true;
        held.resolve();
        await release.promise;
      }
      return result;
    });
    const reconcile = reconcileItemContext(reconcileDb, seed.teamId, created.id);
    await within(held.promise, "reconcile to acquire item lock");
    const narrowing = ingestItem(db(), auth, payload, "team");
    release.resolve();
    await Promise.all([reconcile, narrowing]);

    const after = await storedState(seed, created.id);
    expect(after.item.access).toBe("team");
    expect(after.unit.audience).toBe("team");
    expect(after.unit.content_sha256).toBe(sha(body));
    const current = (after.memberships as { project_id: string; valid_to: string | null }[])
      .filter((row) => row.valid_to === null)
      .map((row) => row.project_id);
    const system = await systemProjectIds(db(), seed.teamId);
    if (!system) throw new Error("system topology missing");
    expect(current).toEqual([system.general]);
  });

  it.each([
    { variant: "different", different: true },
    { variant: "identical", different: false },
  ])(
    "A13-03: an external pusher paused before locking reauthorizes after trusted narrowing ($variant body)",
    async ({ different }) => {
      const fixture = await seedConvergedExternalItem(
        `auditfix13/fresh-authorization-${different ? "different" : "identical"}.md`
      );
      const started = deferred();
      const allowLock = deferred();
      let held = false;
      const staleStarter = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
        if (!held && /pg_advisory_xact_lock/i.test(text)) {
          held = true;
          started.resolve();
          await allowLock.promise;
        }
        return execute<T>(text, params);
      });
      const body = different ? `${fixture.original.body}\nuntrusted edit` : fixture.original.body;
      const untrusted = attempt(() =>
        ingestItem(
          staleStarter,
          fixture.auth,
          { ...fixture.original, body, content_sha256: sha(body) },
          "external",
          undefined,
          "external"
        )
      );
      await within(started.promise, "untrusted ingest to reach identity lock");
      await ingestItem(db(), fixture.auth, fixture.original, "team", undefined, "team");
      allowLock.resolve();
      const outcome = await untrusted;
      const after = await storedState(fixture.seed, fixture.itemId);
      expect(after.item.access).toBe("team");
      expect(after.item.body).toBe(fixture.original.body);
      if (different) {
        expect(outcome.result).toBeNull();
        expect(outcome.error).toMatch(/external-tier key may not modify/);
      } else {
        expect(outcome.result?.status).toBe("unchanged");
      }
    }
  );

  it("A13-04: the identity lock makes concurrent first ingests observe one winner while another path progresses", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const body = "one first-ingest body";
    const payload: IngestPayload = {
      project: "auditfix13-first",
      kind: "deliverable",
      actor: "auditfix13-test",
      frontmatter: { source: "local" },
      path: "same.md",
      body,
      content_sha256: sha(body),
    };
    const held = deferred();
    const release = deferred();
    let paused = false;
    const firstDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      const result = await execute<T>(text, params);
      if (!paused && /pg_advisory_xact_lock/i.test(text)) {
        paused = true;
        held.resolve();
        await release.promise;
      }
      return result;
    });
    const first = ingestItem(firstDb, auth, payload, "team");
    await within(held.promise, "first ingest to acquire identity lock");
    const loserStarted = deferred();
    let loserAttempted = false;
    const loserDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      if (!loserAttempted && /pg_advisory_xact_lock/i.test(text)) {
        loserAttempted = true;
        loserStarted.resolve();
      }
      return execute<T>(text, params);
    });
    const loser = ingestItem(loserDb, auth, payload, "team");
    await within(loserStarted.promise, "competing ingest to issue identity lock");
    const other = await ingestItem(
      db(),
      auth,
      { ...payload, path: "different.md", body: "different", content_sha256: sha("different") },
      "team"
    );
    expect(other.status).toBe("created");
    release.resolve();
    const results = await Promise.all([first, loser]);
    expect(results.map((result) => result.status).sort()).toEqual(["created", "unchanged"]);
    const { data: items } = await db()
      .from("items")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("path", "same.md");
    expect(items ?? []).toHaveLength(1);
    const { data: versions } = await db()
      .from("item_versions")
      .select("id")
      .eq("item_id", (items as { id: string }[])[0].id);
    expect(versions ?? []).toHaveLength(1);
  });

  it("A13-04: opposite task-row order exercises a real deadlock and at most one whole retry", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const firstRows = [
      { row_key: "A13-A", title: "A", status: "in_progress" },
      { row_key: "A13-B", title: "B", status: "in_progress" },
    ];
    const secondRows = [...firstRows].reverse();
    const bothArrived = deferred();
    let arrivals = 0;
    let synchronize = true;
    const attempts = [0, 0];
    const makeClient = (index: 0 | 1) =>
      new PgClient({
        decorateSessionExecutor: (execute) => {
          attempts[index]++;
          let taskWrites = 0;
          return async <T>(text: string, params: unknown[] = []) => {
            const result = await execute<T>(text, params);
            if (synchronize && /^insert into tasks/i.test(text.trim()) && ++taskWrites === 1) {
              arrivals++;
              if (arrivals === 2) {
                synchronize = false;
                bothArrived.resolve();
              }
              await within(bothArrived.promise, "both task transactions to hold their first row");
            }
            return result;
          };
        },
      });
    const payload = (path: string, rows: typeof firstRows): IngestPayload => {
      const body = `${path}\n${rows.map((row) => row.row_key).join("\n")}`;
      return {
        project: "auditfix13-deadlock",
        kind: "task",
        actor: "auditfix13-test",
        frontmatter: {},
        path,
        body,
        content_sha256: sha(body),
        rows,
      } as IngestPayload;
    };

    const outcomes = await within(
      Promise.all([
        ingestItem(makeClient(0), auth, payload("deadlock-a.md", firstRows), "team"),
        ingestItem(makeClient(1), auth, payload("deadlock-b.md", secondRows), "team"),
      ]),
      "deadlock retry completion",
      25_000
    );
    expect(outcomes.every((outcome) => outcome.status === "created")).toBe(true);
    expect(Math.max(...attempts), "one deadlock victim retried the whole operation").toBe(2);
    expect(Math.min(...attempts)).toBe(1);
    expect(Math.max(...attempts), "retry budget is at most two total attempts").toBeLessThanOrEqual(2);

    const { data: items } = await db()
      .from("items")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("project_id", outcomes[0].projectId);
    expect(items ?? []).toHaveLength(2);
    for (const item of (items ?? []) as { id: string }[]) {
      const { data: versions } = await db()
        .from("item_versions")
        .select("id")
        .eq("item_id", item.id);
      expect(versions ?? []).toHaveLength(1);
    }
  });

  it("A13-07: a third reader sees only the old placement until close/open commit together", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/atomic-visibility.md");
    const closedInside = deferred();
    const release = deferred();
    let paused = false;
    const movingDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      const result = await execute<T>(text, params);
      if (!paused && /^update project_context_memberships/i.test(text.trim())) {
        paused = true;
        closedInside.resolve();
        await release.promise;
      }
      return result;
    });
    const narrowing = ingestItem(
      movingDb,
      fixture.auth,
      fixture.original,
      "team",
      undefined,
      "team"
    );
    await within(closedInside.promise, "transactional close before open");

    const during = await storedState(fixture.seed, fixture.itemId);
    const duringCurrent = (during.memberships as { project_id: string; valid_to: string | null }[])
      .filter((row) => row.valid_to === null)
      .map((row) => row.project_id);
    expect(during.item.access).toBe("external");
    expect(duringCurrent).toEqual([fixture.system.externalShared]);

    release.resolve();
    await narrowing;
    const after = await storedState(fixture.seed, fixture.itemId);
    const afterCurrent = (after.memberships as { project_id: string; valid_to: string | null }[])
      .filter((row) => row.valid_to === null)
      .map((row) => row.project_id);
    expect(after.item.access).toBe("team");
    expect(afterCurrent).toEqual([fixture.system.general]);
  });

  it("A13-06/10: returned failure rolls back bound builder and raw-executor sentinels", async () => {
    const seed = await seedTeam();
    const capable = db() as TransactionCapableDbClient;
    const builderSlug = `a13-builder-rollback-${randomUUID().slice(0, 8)}`;
    const rawSlug = `a13-raw-rollback-${randomUUID().slice(0, 8)}`;
    const slugs = [builderSlug, rawSlug];
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    try {
      const result = await capable.transaction(async (session) => {
        const builderWrite = await session.db
          .from("projects")
          .insert({ team_id: seed.teamId, slug: builderSlug })
          .select("id")
          .single();
        expect(builderWrite.error).toBeNull();
        expect(builderWrite.data?.id, "the builder sentinel INSERT returned its durable-row id").toBeTruthy();

        const rawWrite = await session.executeSql<{ id: string }>(
          "insert into projects (team_id, slug) values ($1, $2) returning id",
          [seed.teamId, rawSlug]
        );
        expect(rawWrite.rowCount, "the raw sentinel INSERT executed on the bound connection").toBe(1);
        expect(rawWrite.rows[0]?.id).toBeTruthy();

        const beforeCompletion = await observer.query<{ slug: string }>(
          "select slug from projects where team_id = $1 and slug = any($2::text[])",
          [seed.teamId, slugs]
        );
        expect(
          beforeCompletion.rows,
          "a separate connection cannot observe either uncommitted sentinel"
        ).toEqual([]);
        return { ok: false, error: "forced callback refusal" };
      });
      expect(result.ok).toBe(false);

      const afterRollback = await observer.query<{ slug: string }>(
        "select slug from projects where team_id = $1 and slug = any($2::text[])",
        [seed.teamId, slugs]
      );
      expect(afterRollback.rows, "both successful INSERTs are absent after ok:false rollback").toEqual([]);
    } finally {
      await observer.end();
    }
  });

  it("A13-06: ignored returned envelope failure rejects callback success and rolls back real SQL", async () => {
    const seed = await seedTeam();
    const slug = `a13-envelope-swallowed-${randomUUID().slice(0, 8)}`;
    let injectionFired = 0;
    let callbackReturnedSuccess = false;
    let attempts = 0;
    const faulted = new PgClient({
      decorateSessionExecutor: (execute) => {
        attempts++;
        return execute;
      },
      envelopeInterceptor(context, result) {
        if (
          injectionFired === 0 &&
          context.table === "projects" &&
          context.operation === "insert" &&
          result.error === null
        ) {
          injectionFired++;
          return { ...result, data: null, error: { message: "swallowed successful INSERT envelope" } };
        }
        return result;
      },
    });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    try {
      const outcome = await attempt(() =>
        faulted.transaction(async (session) => {
          // Deliberately ignore the returned error. The transaction tracker, not this callback,
          // must prevent a healthy PostgreSQL session from committing the successful INSERT.
          await session.db.from("projects").insert({ team_id: seed.teamId, slug }).select("id").single();
          callbackReturnedSuccess = true;
          return { ok: true };
        })
      );

      expect(injectionFired, "the envelope was replaced only after a successful real INSERT").toBe(1);
      expect(callbackReturnedSuccess, "the callback reached and returned its manufactured success").toBe(true);
      expect(attempts, "this nonretryable returned failure runs one whole attempt").toBe(1);
      expect(outcome.result, "the ignored returned error cannot manufacture transaction success").toBeNull();
      expect(outcome.error).toContain("swallowed successful INSERT envelope");
      const persisted = await observer.query(
        "select id from projects where team_id = $1 and slug = $2",
        [seed.teamId, slug]
      );
      expect(persisted.rows, "the successful SQL is rolled back despite callback ok:true").toEqual([]);
    } finally {
      await observer.end();
    }
  });

  it("A13-06: swallowed real SQL error rejects callback success and rolls back its sentinel", async () => {
    const seed = await seedTeam();
    const slug = `a13-raw-swallowed-${randomUUID().slice(0, 8)}`;
    let sqlFailureCaught = 0;
    let callbackReturnedSuccess = false;
    let attempts = 0;
    const faulted = new PgClient({
      decorateSessionExecutor: (execute) => {
        attempts++;
        return execute;
      },
    });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    try {
      const outcome = await attempt(() =>
        faulted.transaction(async (session) => {
          const inserted = await session.db
            .from("projects")
            .insert({ team_id: seed.teamId, slug })
            .select("id")
            .single();
          if (inserted.error || !inserted.data) throw new Error("raw swallowed-error fixture insert failed");
          try {
            await session.executeSql("select 1 / 0 as auditfix13_swallowed_real_failure");
          } catch {
            sqlFailureCaught++;
          }
          callbackReturnedSuccess = true;
          return { ok: true };
        })
      );

      expect(sqlFailureCaught, "PostgreSQL executed and rejected SELECT 1/0").toBe(1);
      expect(callbackReturnedSuccess, "the callback deliberately returned ok:true after catching SQL").toBe(true);
      expect(attempts, "the 22012 failure is not replayed").toBe(1);
      expect(outcome.result, "an aborted PostgreSQL COMMIT must not masquerade as app success").toBeNull();
      expect(outcome.error).toMatch(/division by zero|auditfix13_swallowed_real_failure/i);
      const persisted = await observer.query(
        "select id from projects where team_id = $1 and slug = $2",
        [seed.teamId, slug]
      );
      expect(persisted.rows).toEqual([]);
    } finally {
      await observer.end();
    }
  });

  it("A13-10: runtime trace keeps the invoked ingest/reconcile SQL closure on dedicated sessions", async () => {
    const seed = await seedTeam();
    const bootstrap = await ensureAccessBootstrap(db(), seed.teamId);
    if (!bootstrap.ok) throw new Error(`runtime trace bootstrap failed: ${bootstrap.error}`);
    const suffix = randomUUID().slice(0, 8);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const taskBody = "external task trace body";
    const taskPayload: IngestPayload = {
      project: `a13-trace-task-${suffix}`,
      kind: "task",
      actor: "auditfix13-test",
      frontmatter: { source: "local" },
      path: "tasks.md",
      body: taskBody,
      content_sha256: sha(taskBody),
      rows: [{ row_key: "A13-TRACE", title: "Trace task", status: "in_progress" }],
    };
    const task = await ingestItem(db(), auth, taskPayload, "external");
    expect(task.status).toBe("created");
    const context = await reconcileItemContext(db(), seed.teamId, task.id);
    expect(context.ok).toBe(true);

    const rowPayloads: IngestPayload[] = [
      {
        project: `a13-trace-decision-${suffix}`,
        kind: "decision",
        actor: "auditfix13-test",
        frontmatter: { source: "local" },
        path: "decisions.md",
        body: "decision trace v1",
        content_sha256: sha("decision trace v1"),
        rows: [{ row_key: "A13-D", title: "Trace decision", audience: "team" }],
      },
      {
        project: `a13-trace-fact-${suffix}`,
        kind: "fact",
        actor: "auditfix13-test",
        frontmatter: { source: "local" },
        path: "facts.md",
        body: "fact trace v1",
        content_sha256: sha("fact trace v1"),
        rows: [{
          row_key: "A13-F",
          title: "Trace fact",
          fact_type: "fact",
          source_path: "facts.md",
          source_quote: "trace fact quote",
        }],
      },
      {
        project: `a13-trace-stakeholder-${suffix}`,
        kind: "stakeholder_mention",
        actor: "auditfix13-test",
        frontmatter: { source: "local" },
        path: "stakeholders.md",
        body: "stakeholder trace v1",
        content_sha256: sha("stakeholder trace v1"),
        rows: [{
          row_key: "A13-S",
          name: "Trace Stakeholder",
          source_path: "stakeholders.md",
          source_quote: "trace stakeholder quote",
        }],
      },
      {
        project: `a13-trace-slack-${suffix}`,
        kind: "deliverable",
        actor: "auditfix13-test",
        frontmatter: { source: "slack" },
        path: "thread.md",
        body: "slack trace v1",
        content_sha256: sha("slack trace v1"),
      },
    ];
    for (const payload of rowPayloads) {
      const created = await ingestItem(db(), auth, payload, "team");
      expect(created.status).toBe("created");
    }

    const { data: taskProject, error: taskProjectError } = await db()
      .from("items")
      .select("project_id")
      .eq("team_id", seed.teamId)
      .eq("id", task.id)
      .single();
    if (taskProjectError || !taskProject) throw new Error("trace task project fixture missing");
    const fixtureRows = [
      {
        table: "extracted_facts",
        row: {
          team_id: seed.teamId,
          project_id: taskProject.project_id,
          source_item_id: task.id,
          row_key: "A13-INHERITED-FACT",
          title: "Inherited fact",
          fact_type: "fact",
          source_path: "tasks.md",
          source_quote: "inherited trace fact",
          audience: "external",
        },
      },
      {
        table: "stakeholder_mentions",
        row: {
          team_id: seed.teamId,
          project_id: taskProject.project_id,
          source_item_id: task.id,
          row_key: "A13-INHERITED-STAKEHOLDER",
          name: "Inherited Stakeholder",
          source_path: "tasks.md",
          source_quote: "inherited trace stakeholder",
          audience: "external",
        },
      },
    ];
    for (const fixtureRow of fixtureRows) {
      const { error } = await db().from(fixtureRow.table).insert(fixtureRow.row);
      if (error) throw new Error(`trace inherited ${fixtureRow.table} seed failed: ${error.message}`);
    }

    const opportunity = await createOpportunity(db(), seed.teamId, {
      access: "external",
      sourceType: "item",
      title: "Runtime transaction trace",
      summary: "seeded closure trace",
      evidence: [{ itemId: task.id, path: "tasks.md" }],
      dedupKey: `a13-runtime-${suffix}`,
    });
    const plan = await createPlan(db(), seed.teamId, opportunity.id, { objective: "trace" });
    const variant = await addVariant(db(), seed.teamId, plan.id, {
      platform: "x",
      format: "text",
      body: "runtime trace variant",
    });
    const leafInsert = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db().from(table).insert(row).select("id").single();
      if (error || !data) throw new Error(`trace ${table} seed failed: ${error?.message}`);
      return data.id as string;
    };
    await leafInsert("content_approvals", {
      team_id: seed.teamId,
      variant_id: variant.id,
      access: "external",
      status: "pending",
    });
    await leafInsert("media_assets", {
      team_id: seed.teamId,
      variant_id: variant.id,
      access: "external",
      provider: "test",
      model: "trace",
      data_base64: "eA==",
    });
    const publicationId = await leafInsert("social_publications", {
      team_id: seed.teamId,
      variant_id: variant.id,
      access: "external",
    });
    await leafInsert("publication_analytics", {
      team_id: seed.teamId,
      publication_id: publicationId,
      access: "external",
    });

    const { data: successor, error: successorError } = await db()
      .from("members")
      .insert({
        team_id: seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Runtime Trace Successor",
        actor_handle: `trace-${suffix}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    if (successorError || !successor) throw new Error("trace successor seed failed");
    await placeMemberByTier(seed.teamId, successor.id as string, "team");

    const taskUnitId = await unitIdFor(seed, task.id);
    const { error: driftError } = await db()
      .from("project_context_units")
      .update({ audience: "team" })
      .eq("team_id", seed.teamId)
      .eq("id", taskUnitId);
    if (driftError) throw new Error(`trace mirror drift seed failed: ${driftError.message}`);

    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await observer.connect();
    const trace = installRuntimeSqlTrace();
    try {
      const repaired = await reconcileItemContext(db(), seed.teamId, task.id);
      expect(repaired.ok, "real exported reconcile repairs the seeded raw mirror drift").toBe(true);

      const narrowedTaskBody = `${taskBody}\ntrace materialization update`;
      const narrowed = await ingestItem(
        db(),
        auth,
        {
          ...taskPayload,
          body: narrowedTaskBody,
          content_sha256: sha(narrowedTaskBody),
          rows: [{ row_key: "A13-TRACE", title: "Trace task updated", status: "completed" }],
        },
        "team",
        { authorMemberId: successor.id as string },
        "team"
      );
      expect(narrowed).toMatchObject({ status: "updated", accessChanged: true });

      for (const payload of rowPayloads) {
        const body = `${payload.body}\ntrace update`;
        const updated = await ingestItem(
          db(),
          auth,
          { ...payload, body, content_sha256: sha(body) },
          "team"
        );
        expect(updated.status).toBe("updated");
      }

      const sawWrite = (pattern: RegExp) =>
        trace.bound.some((entry) => pattern.test(entry.sql) && (entry.rowCount ?? 0) > 0);
      const requiredWrites: [string, RegExp][] = [
        ["raw unit mirror", /^update project_context_units u /i],
        ["task materialization", /^INSERT INTO tasks /i],
        ["decision materialization", /^INSERT INTO decisions /i],
        ["fact materialization", /^INSERT INTO extracted_facts /i],
        ["stakeholder materialization", /^INSERT INTO stakeholder_mentions /i],
        ["superseded Slack body forgetting", /^UPDATE item_versions SET /i],
        ["inherited task cascade", /^UPDATE tasks SET /i],
        ["inherited fact cascade", /^UPDATE extracted_facts SET /i],
        ["inherited stakeholder cascade", /^UPDATE stakeholder_mentions SET /i],
        ["social opportunity narrowing", /^UPDATE social_opportunities SET /i],
        ["social plan narrowing", /^UPDATE content_plans SET /i],
        ["social variant narrowing", /^UPDATE content_variants SET /i],
        ["approval narrowing", /^UPDATE content_approvals SET /i],
        ["media narrowing", /^UPDATE media_assets SET /i],
        ["publication narrowing", /^UPDATE social_publications SET /i],
        ["analytics narrowing", /^UPDATE publication_analytics SET /i],
        ["context membership close", /^UPDATE project_context_memberships SET /i],
        ["context membership open", /^INSERT INTO project_context_memberships /i],
        ["audit persistence", /^INSERT INTO audit_log /i],
      ];
      for (const [label, pattern] of requiredWrites) {
        expect(sawWrite(pattern), `${label} executed successful DML on a bound session`).toBe(true);
      }
      expect(
        trace.bound.some(
          (entry) => /^INSERT INTO audit_log /i.test(entry.sql) && entry.params.includes("item.reassigned")
        ),
        "the reassignment-log writer ran inside the owning ingest session"
      ).toBe(true);
      expect(trace.transactions, "the trace observed successful BEGIN boundaries").toBeGreaterThanOrEqual(6);
      expect(trace.checkouts, "each exported operation used an initial dedicated checkout").toBeGreaterThanOrEqual(6);
      expect(
        trace.poolCalls.some(
          (call) => call.kind === "pool.connect" && call.phase === "outside-bound-phase"
        ),
        "the pass-through trace observed permitted initial checkouts"
      ).toBe(true);
      expect(
        trace.poolCalls.some(
          (call) => call.kind === "pool.query" && call.phase === "outside-bound-phase"
        ),
        "the trace stayed installed across permitted pre-BEGIN/post-COMMIT pool work"
      ).toBe(true);
      expect(
        trace.forbidden,
        `pool execution escaped a bound phase: ${JSON.stringify(trace.forbidden)}`
      ).toEqual([]);

      for (const table of [
        "social_opportunities",
        "content_plans",
        "content_variants",
        "content_approvals",
        "media_assets",
        "social_publications",
        "publication_analytics",
      ]) {
        const visible = await observer.query<{ access: string }>(
          `select access from ${table} where team_id = $1`,
          [seed.teamId]
        );
        expect(visible.rows, `${table} had a seeded row for the traced narrowing`).not.toHaveLength(0);
        expect(visible.rows.every((row) => row.access === "team")).toBe(true);
      }
    } finally {
      trace.restore();
      await observer.end();
    }
  });

  it("A13-06: a held item lock hits the scoped 10s acquisition timeout and a later call reuses healthy capacity", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/lock-timeout.md");
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    let elapsedMs = 0;
    try {
      await holder.query("begin");
      await holder.query(
        "select id from items where team_id = $1 and id = $2 for update",
        [fixture.seed.teamId, fixture.itemId]
      );
      const started = Date.now();
      const blocked = await within(
        reconcileItemContext(db(), fixture.seed.teamId, fixture.itemId),
        "the explicit item-lock timeout",
        16_000
      );
      elapsedMs = Date.now() - started;
      expect(blocked.ok).toBe(false);
      expect(blocked.error).toMatch(/context lock-timeout|lock timeout/i);
      expect(elapsedMs, "the 10s lock timeout must not be replaced by an eager failure").toBeGreaterThanOrEqual(9_000);
      expect(elapsedMs, "the lock acquisition remains bounded").toBeLessThan(16_000);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }

    const retry = await reconcileItemContext(db(), fixture.seed.teamId, fixture.itemId);
    expect(retry.ok, `healthy retry after ${elapsedMs}ms must acquire pool/row capacity`).toBe(true);
  }, 30_000);

  it("A13-06: identity/item acquisition restores the caller's prior lock_timeout before ordinary DML", async () => {
    const seed = await seedTeam();
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const configured: unknown[] = [];
    let seededPrior = false;
    let beforeItemDml: string | null = null;
    const instrumented = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (!seededPrior && /^SHOW lock_timeout$/i.test(normalized)) {
        seededPrior = true;
        await execute("select set_config('lock_timeout', '3s', true)");
      }
      if (/^SELECT set_config\('lock_timeout'/i.test(normalized)) configured.push(params[0]);
      if (beforeItemDml === null && /^INSERT INTO items /i.test(normalized)) {
        const current = await execute<{ lock_timeout: string }>("show lock_timeout");
        beforeItemDml = current.rows[0]?.lock_timeout ?? null;
      }
      return execute<T>(text, params);
    });
    const body = "lock timeout restoration";
    const result = await ingestItem(
      instrumented,
      auth,
      {
        project: "auditfix13-lock-setting",
        kind: "deliverable",
        actor: "auditfix13-test",
        frontmatter: {},
        path: "restore.md",
        body,
        content_sha256: sha(body),
      },
      "team"
    );

    expect(result.status).toBe("created");
    expect(configured).toEqual(["10s", "3s", "10s", "3s"]);
    expect(beforeItemDml).toBe("3s");
  });

  it("A13-06/11: unsupported clients fail closed and stale cross-team system hints cannot place", async () => {
    const seed = await seedTeam();
    const plain = {
      from: db().from.bind(db()),
      rpc: db().rpc.bind(db()),
    } as DbClient;
    const body = "unsupported";
    await expect(
      ingestItem(
        plain,
        { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
        {
          project: "a13-unsupported",
          kind: "deliverable",
          actor: "test",
          frontmatter: {},
          path: "unsupported.md",
          body,
          content_sha256: sha(body),
        },
        "team"
      )
    ).rejects.toThrow("transaction-capability-required");

    const other = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    await ensureAccessBootstrap(db(), other.teamId);
    const item = await ingestItem(
      db(),
      { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() },
      {
        project: "a13-hints",
        kind: "deliverable",
        actor: "test",
        frontmatter: {},
        path: "hints.md",
        body: "hints",
        content_sha256: sha("hints"),
      },
      "team"
    );
    const wrong = await systemProjectIds(db(), other.teamId);
    if (!wrong) throw new Error("other team topology missing");
    const reconciled = await reconcileItemContext(db(), seed.teamId, item.id, wrong);
    expect(reconciled.ok).toBe(false);
    expect(reconciled.error).toMatch(/system project read failed/);

    const right = await systemProjectIds(db(), seed.teamId);
    if (!right || !item.projectId) throw new Error("primary team topology/source project missing");
    const wrongKind = await reconcileItemContext(db(), seed.teamId, item.id, {
      general: item.projectId,
      externalShared: right.externalShared,
    });
    expect(wrongKind.ok).toBe(false);
    expect(wrongKind.error).toMatch(/system project read failed/);
    const wrongSlug = await reconcileItemContext(db(), seed.teamId, item.id, {
      general: right.externalShared,
      externalShared: right.general,
    });
    expect(wrongSlug.ok).toBe(false);
    expect(wrongSlug.error).toMatch(/system project read failed/);
  });

  it("A13-11: standalone unit/membership entry points share one item lock without recursive checkout", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/standalone-entrypoints.md");
    const unitId = await unitIdFor(fixture.seed, fixture.itemId);
    const unit = await within(
      reconcileItemUnit(db(), fixture.seed.teamId, fixture.itemId),
      "standalone unit reconcile"
    );
    expect(unit.ok).toBe(true);
    const include = await within(
      ensureIncludeMembership(db(), fixture.seed.teamId, {
        projectId: fixture.system.externalShared,
        contextUnitId: unitId,
      }),
      "standalone membership ensure"
    );
    expect(include.ok).toBe(true);
    const close = await within(
      closeMembershipInto(db(), fixture.seed.teamId, unitId, randomUUID()),
      "standalone membership close"
    );
    expect(close.ok).toBe(true);
    if (close.ok) expect(close.closed).toBe(0);
  });

  it("A13-11: delete cascade winning while reconcile waits returns an established missing-item skip", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/delete-while-waiting.md");
    const control = new Client({ connectionString: process.env.DATABASE_URL });
    await control.connect();
    const lockIssued = deferred();
    let observed = false;
    const waitingDb = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      if (!observed && /from items[\s\S]*for update/i.test(text)) {
        observed = true;
        lockIssued.resolve();
      }
      return execute<T>(text, params);
    });
    let result: Awaited<ReturnType<typeof reconcileItemContext>>;
    try {
      await control.query("begin");
      await control.query("delete from items where team_id = $1 and id = $2", [
        fixture.seed.teamId,
        fixture.itemId,
      ]);
      const reconcile = reconcileItemContext(waitingDb, fixture.seed.teamId, fixture.itemId);
      await within(lockIssued.promise, "reconcile to issue the item row lock");
      await control.query("commit");
      result = await within(reconcile, "reconcile after delete cascade");
    } finally {
      await control.query("rollback").catch(() => undefined);
      await control.end();
    }

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    const { data: unit } = await db()
      .from("project_context_units")
      .select("id")
      .eq("team_id", fixture.seed.teamId)
      .eq("source_item_id", fixture.itemId)
      .maybeSingle();
    expect(unit).toBeNull();
  });

  it("A13-12: real backfill retries the persistent failing item without skipping its successor", async () => {
    const seed = await seedTeam();
    const bootstrap = await ensureAccessBootstrap(db(), seed.teamId);
    expect(bootstrap.ok).toBe(true);
    const externalViewerId = await externalMember(seed);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const accessById = new Map<string, "team" | "external">();
    for (const [index, access] of (["team", "external", "team"] as const).entries()) {
      const body = `backfill cursor item ${index}`;
      const created = await ingestItem(
        db(),
        auth,
        {
          project: "auditfix13-backfill",
          kind: "deliverable",
          actor: "auditfix13-test",
          frontmatter: { source: "local" },
          path: `cursor-${index}.md`,
          body,
          content_sha256: sha(body),
        },
        access
      );
      expect(created.status).toBe("created");
      accessById.set(created.id, access);
    }
    const [a, b, c] = [...accessById.keys()].sort();
    expect([a, b, c]).toHaveLength(3);

    let faultEnabled = true;
    let faultHits = 0;
    const faulted = new PgClient({
      decorateSessionExecutor: (execute) => async <T>(text: string, params: unknown[] = []) => {
        if (
          faultEnabled &&
          /^INSERT INTO project_context_units /i.test(text.replace(/\s+/g, " ").trim()) &&
          params.includes(b)
        ) {
          faultHits++;
          // Persistent, targeted and transaction-aborting: unlike the one-shot helper, both failed
          // passes execute a real 22012 on b's bound connection.
          await execute("select 1 / 0 as auditfix13_persistent_backfill_failure");
        }
        return execute<T>(text, params);
      },
    });
    const placement = async (itemId: string) => {
      const { data: unit, error } = await db()
        .from("project_context_units")
        .select("id, audience")
        .eq("team_id", seed.teamId)
        .eq("source_item_id", itemId)
        .eq("unit_kind", "item")
        .maybeSingle();
      if (error) throw new Error(`backfill placement read failed: ${error.message}`);
      if (!unit) return null;
      const { data: memberships, error: membershipError } = await db()
        .from("project_context_memberships")
        .select("project_id, decision, valid_to")
        .eq("team_id", seed.teamId)
        .eq("context_unit_id", unit.id)
        .is("valid_to", null);
      if (membershipError) throw new Error(`backfill membership read failed: ${membershipError.message}`);
      return { unit, memberships: memberships ?? [] };
    };

    const first = await backfillTeamContext(faulted, seed.teamId, { batchSize: 10 });
    expect(first).toMatchObject({ ok: false, scanned: 1, cursor: a });
    expect(first.error).toContain(b);
    expect(faultHits, "the first pass executed the targeted real SQL fault on b").toBe(1);
    const firstPlacement = await placement(a);
    expect(firstPlacement, "a commits before b fails").not.toBeNull();
    expect(firstPlacement?.memberships, "a's unit and target membership commit together").toHaveLength(1);
    expect(await placement(b), "b's unit and membership transaction rolls back completely").toBeNull();
    expect(await placement(c), "c is not visited after b fails").toBeNull();

    const second = await backfillTeamContext(faulted, seed.teamId, {
      batchSize: 10,
      afterId: a,
    });
    expect(second).toMatchObject({ ok: false, scanned: 0, cursor: a });
    expect(second.error).toContain(b);
    expect(faultHits, "the persistent fault fired again instead of accidentally healing").toBe(2);
    expect(await placement(b)).toBeNull();
    expect(await placement(c)).toBeNull();

    faultEnabled = false;
    const healed = await backfillTeamContext(faulted, seed.teamId, {
      batchSize: 10,
      afterId: a,
    });
    expect(healed).toMatchObject({ ok: true, scanned: 2, cursor: null });
    expect(faultHits).toBe(2);
    const system = await systemProjectIds(db(), seed.teamId);
    if (!system) throw new Error("backfill system projects missing");
    for (const itemId of [a, b, c]) {
      const state = await placement(itemId);
      const expectedAccess = accessById.get(itemId)!;
      expect(state?.unit.audience, `${itemId} unit mirrors item authority`).toBe(expectedAccess);
      expect(state?.memberships).toEqual([
        {
          project_id: expectedAccess === "external" ? system.externalShared : system.general,
          decision: "include",
          valid_to: null,
        },
      ]);
      expect(
        await canSeeItem(db(), { teamId: seed.teamId, memberId: externalViewerId }, itemId),
        `${itemId} external visibility follows its healed audience`
      ).toBe(expectedAccess === "external");
    }
  });

  it.each([
    { pathKind: "unchanged-body", changed: false, faultMode: "returned" as const },
    { pathKind: "unchanged-body", changed: false, faultMode: "thrown" as const },
    { pathKind: "changed-body", changed: true, faultMode: "returned" as const },
    { pathKind: "changed-body", changed: true, faultMode: "thrown" as const },
  ])(
    "A13-13: confirmed commit survives a $faultMode post-commit teamSlug failure ($pathKind)",
    async ({ pathKind, changed, faultMode }) => {
      const fixture = await seedConvergedExternalItem(
        `auditfix13/postcommit-${pathKind}.md`
      );
      let fired = false;
      const faulted = transactionDecoratedDb(db(), (base) => ({
        from(table: string) {
          const builder = base.from(table);
          if (table !== "teams") return builder;
          return new Proxy(builder, {
            get(target, prop, receiver) {
              const value = Reflect.get(target, prop, receiver);
              if (prop !== "then") {
                return typeof value === "function"
                  ? (...args: unknown[]) => {
                      const result = (value as (...inner: unknown[]) => unknown).apply(target, args);
                      return result === target ? receiver : result;
                    }
                  : value;
              }
              fired = true;
              return (resolve: (value: unknown) => unknown) => {
                if (faultMode === "thrown") throw new Error("postcommit slug fault");
                return resolve({ data: null, error: { message: "postcommit slug fault" }, count: null });
              };
            },
          });
        },
        rpc: base.rpc.bind(base),
      } as DbClient));
      const body = changed ? `${fixture.original.body}\npostcommit edit` : fixture.original.body;
      const result = await ingestItem(
        faulted,
        fixture.auth,
        { ...fixture.original, body, content_sha256: sha(body) },
        "team",
        undefined,
        "team"
      );
      expect(result.accessChanged).toBe(true);
      expect(fired, "the post-commit returned-error injection fired").toBe(true);
      const after = await storedState(fixture.seed, fixture.itemId);
      expect(after.item.access).toBe("team");
      expect(after.unit.audience).toBe("team");
    }
  );

  it("A13-13: repeated audit-local 40P01/40001 failures recover without retrying the durable ingest", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/audit-savepoints.md");
    const { data: successor, error: successorError } = await db()
      .from("members")
      .insert({
        team_id: fixture.seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Successor",
        actor_handle: `successor-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    if (successorError || !successor) throw new Error(`successor fixture failed: ${successorError?.message}`);
    await placeMemberByTier(fixture.seed.teamId, successor.id as string, "team");

    let attempts = 0;
    let auditFailures = 0;
    const faulted = new PgClient({
      decorateSessionExecutor: (execute) => {
        attempts++;
        return async <T>(text: string, params: unknown[] = []) => {
          if (/^INSERT INTO audit_log /i.test(text.replace(/\s+/g, " ").trim())) {
            const state = auditFailures++ === 0 ? "40P01" : "40001";
            await execute(
              `do $a13$ begin raise exception 'audit-local ${state}' using errcode = '${state}'; end $a13$`
            );
          }
          return execute<T>(text, params);
        };
      },
    });
    const body = `${fixture.original.body}\nowner reassigned`;
    const result = await ingestItem(
      faulted,
      fixture.auth,
      { ...fixture.original, body, content_sha256: sha(body) },
      "external",
      { authorMemberId: successor.id as string },
      "team"
    );

    expect(result.status).toBe("updated");
    expect(attempts, "optional audit SQLSTATEs do not consume the whole-operation retry").toBe(1);
    expect(auditFailures, "item.updated and item.reassigned audit INSERTs both faulted").toBe(2);
    const { data: stored } = await db()
      .from("items")
      .select("body, member_id")
      .eq("team_id", fixture.seed.teamId)
      .eq("id", fixture.itemId)
      .single();
    expect(stored).toMatchObject({ body, member_id: successor.id });
  });

  it("A13-13: an actual ownerWindowStart SELECT failure is savepoint-local and reassignment commits", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/owner-window-savepoint.md");
    const { data: successor, error: successorError } = await db()
      .from("members")
      .insert({
        team_id: fixture.seed.teamId,
        email: `${randomUUID()}@test.local`,
        display_name: "Owner Window Successor",
        actor_handle: `window-${randomUUID().slice(0, 8)}`,
        role: "member",
        tier: "team",
        status: "active",
      })
      .select("id")
      .single();
    if (successorError || !successor) throw new Error(`successor fixture failed: ${successorError?.message}`);
    await placeMemberByTier(fixture.seed.teamId, successor.id as string, "team");
    const fault = actualSqlFaultDb(/^SELECT created_at FROM audit_log /i);
    const body = `${fixture.original.body}\nowner window fault`;
    const result = await ingestItem(
      fault.db,
      fixture.auth,
      { ...fixture.original, body, content_sha256: sha(body) },
      "external",
      { authorMemberId: successor.id as string },
      "team"
    );

    expect(fault.fired(), "the actual owner-window SELECT failure fired").toBe(1);
    expect(result.status).toBe("updated");
    const { data: stored } = await db()
      .from("items")
      .select("member_id")
      .eq("team_id", fixture.seed.teamId)
      .eq("id", fixture.itemId)
      .single();
    expect((stored as { member_id: string }).member_id).toBe(successor.id);
  });

  it("A13-05: an actual membership INSERT failure rolls back a trusted changed-body narrowing", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/sql-failure.md");
    const before = await storedState(fixture.seed, fixture.itemId);
    const unitId = await unitIdFor(fixture.seed, fixture.itemId);
    const changedBody = `${fixture.original.body}\nchanged in the rejected push`;
    const changedPayload: IngestPayload = {
      ...fixture.original,
      body: changedBody,
      content_sha256: sha(changedBody),
    };

    const injected = await withFailingMembershipInsert(
      {
        teamId: fixture.seed.teamId,
        projectId: fixture.system.general,
        unitId,
      },
      (marker) =>
        attempt(() =>
          ingestItem(db(), fixture.auth, changedPayload, "team", undefined, "team")
        ).then((outcome) => ({ outcome, marker }))
    );
    const after = await storedState(fixture.seed, fixture.itemId);

    expect(injected.fired, "the real failing membership statement must be reached").toBe(true);
    expect(
      after,
      "a failed context move preserves the pre-attempt item, version, audit, mirror, and membership rows"
    ).toEqual(before);
    expect(injected.value.outcome.result, "failed narrowing is never reported as ingest success").toBeNull();
    expect(injected.value.outcome.error, "the SQL failure remains diagnosable").toContain(
      injected.value.marker
    );
    expect(
      await canSeeItem(
        db(),
        { teamId: fixture.seed.teamId, memberId: fixture.externalViewerId },
        fixture.itemId
      ),
      "rollback retains the previously committed external visibility"
    ).toBe(true);
  });

  it.each([
    { phase: "system target lookup", pattern: /^SELECT .* FROM projects .*kind =/i },
    { phase: "desired-audience gate read", pattern: /^SELECT .* FROM project_groups /i },
    { phase: "item write", pattern: /^UPDATE items SET /i },
    { phase: "unit read", pattern: /^SELECT .* FROM project_context_units /i },
    { phase: "raw unit mirror", pattern: /^update project_context_units u /i },
    { phase: "opposite-membership read", pattern: /^SELECT .* FROM project_context_memberships /i },
    { phase: "opposite-membership close", pattern: /^UPDATE project_context_memberships SET /i },
  ])(
    "A13-05: actual SQL failure at $phase restores the complete pre-attempt state",
    async ({ phase, pattern }) => {
      const fixture = await seedConvergedExternalItem(
        `auditfix13/failure-matrix-${phase.replaceAll(/[^a-z]+/gi, "-").toLowerCase()}.md`
      );
      const before = await storedState(fixture.seed, fixture.itemId);
      const body = `${fixture.original.body}\nfailure matrix edit`;
      const fault = actualSqlFaultDb(pattern);
      const outcome = await attempt(() =>
        ingestItem(
          fault.db,
          fixture.auth,
          { ...fixture.original, body, content_sha256: sha(body) },
          "team",
          undefined,
          "team"
        )
      );

      expect(fault.fired(), `${phase} injection must reach a real SQL statement`).toBe(1);
      expect(outcome.result).toBeNull();
      expect(outcome.error).toMatch(/division by zero|auditfix13_injected_failure/i);
      expect(await storedState(fixture.seed, fixture.itemId)).toEqual(before);
    }
  );

  it("A13-05/07: a close-reread SQL failure rolls back the already-executed close", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/close-reread-failure.md");
    const before = await storedState(fixture.seed, fixture.itemId);
    let hidCloseResult = false;
    let rereadFailed = 0;
    const faulted = sessionClient((execute) => async <T>(text: string, params: unknown[] = []) => {
      const normalized = text.replace(/\s+/g, " ").trim();
      if (hidCloseResult && /^SELECT .* FROM project_context_memberships /i.test(normalized)) {
        rereadFailed++;
        await execute("select 1 / 0 as auditfix13_close_reread_failure");
      }
      const result = await execute<T>(text, params);
      if (!hidCloseResult && /^UPDATE project_context_memberships SET /i.test(normalized)) {
        hidCloseResult = true;
        // The close did run. Suppressing only RETURNING forces the authoritative reread branch.
        return { rows: [] as T[], rowCount: 0 };
      }
      return result;
    });
    const body = `${fixture.original.body}\nclose reread edit`;
    const outcome = await attempt(() =>
      ingestItem(
        faulted,
        fixture.auth,
        { ...fixture.original, body, content_sha256: sha(body) },
        "team",
        undefined,
        "team"
      )
    );

    expect(hidCloseResult, "the real close statement executed before RETURNING was suppressed").toBe(true);
    expect(rereadFailed, "the close reread injection fired").toBe(1);
    expect(outcome.result).toBeNull();
    expect(await storedState(fixture.seed, fixture.itemId)).toEqual(before);
  });

  it("A13-05/11: actual unit INSERT failure is explicit and leaves a first-created item unplaced", async () => {
    const seed = await seedTeam();
    await ensureAccessBootstrap(db(), seed.teamId);
    const auth = { teamId: seed.teamId, memberId: seed.memberId, apiKeyId: randomUUID() };
    const body = "first-created item awaiting its existing context hook";
    const created = await ingestItem(
      db(),
      auth,
      {
        project: "auditfix13-unit-insert",
        kind: "deliverable",
        actor: "auditfix13-test",
        frontmatter: {},
        path: "unit-insert.md",
        body,
        content_sha256: sha(body),
      },
      "team"
    );
    const fault = actualSqlFaultDb(/^INSERT INTO project_context_units /i);
    const reconciled = await reconcileItemContext(fault.db, seed.teamId, created.id);

    expect(fault.fired(), "the real unit INSERT failure injection fired").toBe(1);
    expect(reconciled.ok).toBe(false);
    expect(reconciled.error).toMatch(/division by zero|auditfix13_injected_failure/i);
    const { data: units } = await db()
      .from("project_context_units")
      .select("id")
      .eq("team_id", seed.teamId)
      .eq("source_item_id", created.id);
    expect(units ?? []).toHaveLength(0);
  });

  it("A13-05/06: a returned builder error after real item DML cannot manufacture commit", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/returned-error.md");
    const before = await storedState(fixture.seed, fixture.itemId);
    let fired = 0;
    const faulted = new PgClient({
      envelopeInterceptor(context, result) {
        if (fired === 0 && context.table === "items" && context.operation === "update") {
          fired++;
          return { ...result, data: null, error: { message: "returned item update failure" } };
        }
        return result;
      },
    });
    const body = `${fixture.original.body}\nreturned error edit`;
    const outcome = await attempt(() =>
      ingestItem(
        faulted,
        fixture.auth,
        { ...fixture.original, body, content_sha256: sha(body) },
        "team",
        undefined,
        "team"
      )
    );

    expect(fired, "returned-error injection fired after the real UPDATE").toBe(1);
    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain("returned item update failure");
    expect(await storedState(fixture.seed, fixture.itemId)).toEqual(before);
  });

  it.each([
    { direction: "external-to-team", target: "general" as const, to: "team" as const },
    {
      direction: "team-to-external",
      target: "externalShared" as const,
      to: "external" as const,
    },
  ])(
    "A13-08: a non-auto target exclusion preserves the exact $direction standing state",
    async ({ target, to }) => {
      const fixture = await seedConvergedExternalItem(
        `auditfix13/protected-target-${to}.md`
      );
      if (to === "external") {
        const narrowed = await ingestItem(
          db(),
          fixture.auth,
          fixture.original,
          "team",
          undefined,
          "team"
        );
        expect(narrowed.accessChanged).toBe(true);
      }
      await plantSystemExclusion(fixture, fixture.system[target], "force_exclude");
      let loggedRefusal = false;
      const warn = vi.spyOn(console, "warn").mockImplementation((message) => {
        if (String(message).includes("standing context refusal")) loggedRefusal = true;
      });
      let result!: Awaited<ReturnType<typeof ingestItem>>;
      try {
        result = await ingestItem(
          db(),
          fixture.auth,
          fixture.original,
          to,
          undefined,
          "team"
        );
      } finally {
        warn.mockRestore();
      }

      expect(result.accessChanged).toBe(true);
      expect(result).not.toHaveProperty("refused");
      expect(result).not.toHaveProperty("spared");
      expect(
        loggedRefusal,
        "ingest logs the internal refusal without widening its result/wire contract"
      ).toBe(true);
      const after = await storedState(fixture.seed, fixture.itemId);
      expect(after.item.access).toBe(to);
      expect(after.unit.audience).toBe(to);
      const expected =
        to === "team"
          ? [
              {
                project_id: fixture.system.general,
                decision: "exclude",
                mode: "force_exclude",
              },
            ]
          : [
              {
                project_id: fixture.system.general,
                decision: "include",
                mode: "auto",
              },
              {
                project_id: fixture.system.externalShared,
                decision: "exclude",
                mode: "force_exclude",
              },
            ].sort((left, right) => left.project_id.localeCompare(right.project_id));
      expect(currentMembershipState(after)).toEqual(expected);
      expect(
        await canSeeItem(
          db(),
          { teamId: fixture.seed.teamId, memberId: fixture.externalViewerId },
          fixture.itemId
        )
      ).toBe(false);

      const publicResult = await reconcileItemContext(
        db(),
        fixture.seed.teamId,
        fixture.itemId
      );
      expect(publicResult).toMatchObject({
        ok: false,
        refused: true,
        refusalReason: "protected-target-exclusion",
      });
      expect(currentMembershipState(await storedState(fixture.seed, fixture.itemId))).toEqual(
        expected
      );
    }
  );

  it("A13-08: a target auto-exclude repairs atomically and an opposite human exclusion is spared", async () => {
    const targetRepair = await seedConvergedExternalItem("auditfix13/target-auto-repair.md");
    await ingestItem(
      db(),
      targetRepair.auth,
      targetRepair.original,
      "team",
      undefined,
      "team"
    );
    await plantSystemExclusion(
      targetRepair,
      targetRepair.system.externalShared,
      "auto"
    );
    const repaired = await ingestItem(
      db(),
      targetRepair.auth,
      targetRepair.original,
      "external",
      undefined,
      "team"
    );
    expect(repaired.accessChanged).toBe(true);
    expect(currentMembershipState(await storedState(targetRepair.seed, targetRepair.itemId))).toEqual([
      {
        project_id: targetRepair.system.externalShared,
        decision: "include",
        mode: "auto",
      },
    ]);

    const sparedFixture = await seedConvergedExternalItem("auditfix13/opposite-human-spared.md");
    await plantSystemExclusion(
      sparedFixture,
      sparedFixture.system.externalShared,
      "force_exclude"
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const narrowed = await ingestItem(
        db(),
        sparedFixture.auth,
        sparedFixture.original,
        "team",
        undefined,
        "team"
      );
      expect(narrowed.accessChanged).toBe(true);
      expect(
        info.mock.calls.some((call) => String(call[0]).includes("standing exclusion(s) spared"))
      ).toBe(true);
    } finally {
      info.mockRestore();
    }
    expect(currentMembershipState(await storedState(sparedFixture.seed, sparedFixture.itemId))).toEqual(
      [
        {
          project_id: sparedFixture.system.general,
          decision: "include",
          mode: "auto",
        },
        {
          project_id: sparedFixture.system.externalShared,
          decision: "exclude",
          mode: "force_exclude",
        },
      ].sort((left, right) => left.project_id.localeCompare(right.project_id))
    );
  });

  it.each([
    { direction: "external-to-team", to: "team" as const, target: "general" as const },
    {
      direction: "team-to-external",
      to: "external" as const,
      target: "externalShared" as const,
    },
  ])(
    "A13-09: a direct human override before the conditional auto repair wins in one $direction attempt",
    async ({ to, target }) => {
      const fixture = await seedConvergedExternalItem(
        `auditfix13/override-before-repair-${to}.md`
      );
      if (to === "external") {
        await ingestItem(db(), fixture.auth, fixture.original, "team", undefined, "team");
      }
      await plantSystemExclusion(fixture, fixture.system[target], "auto");
      const updateReached = deferred<string>();
      const overrideDone = deferred();
      let attempts = 0;
      let intercepted = false;
      const instrumented = new PgClient({
        decorateSessionExecutor: (execute) => {
          attempts++;
          return async <T>(text: string, params: unknown[] = []) => {
            const normalized = text.replace(/\s+/g, " ").trim();
            if (
              !intercepted &&
              /^UPDATE project_context_memberships SET /i.test(normalized) &&
              params.includes("exclude") &&
              params.includes("auto")
            ) {
              intercepted = true;
              updateReached.resolve(String(params[2]));
              await within(overrideDone.promise, "direct human override");
            }
            return execute<T>(text, params);
          };
        },
      });
      const move = ingestItem(
        instrumented,
        fixture.auth,
        fixture.original,
        to,
        undefined,
        "team"
      );
      const membershipId = await within(updateReached.promise, "conditional repair UPDATE");
      let overrideFailure: string | null = null;
      try {
        const { error: overrideError } = await db()
          .from("project_context_memberships")
          .update({ mode: "force_exclude" })
          .eq("team_id", fixture.seed.teamId)
          .eq("id", membershipId)
          .eq("decision", "exclude")
          .eq("mode", "auto")
          .is("valid_to", null);
        if (overrideError) overrideFailure = overrideError.message;
      } finally {
        overrideDone.resolve();
      }
      const result = await within(move, "move after protected-row reread");
      if (overrideFailure) throw new Error(`human override fixture failed: ${overrideFailure}`);

      expect(result.accessChanged).toBe(true);
      expect(attempts, "the protected reread is terminal, not a retry cause").toBe(1);
      const state = await storedState(fixture.seed, fixture.itemId);
      expect(state.item.access).toBe(to);
      expect(state.unit.audience).toBe(to);
      expect(currentMembershipState(state)).toEqual(
        (to === "team"
          ? [
              {
                project_id: fixture.system.general,
                decision: "exclude",
                mode: "force_exclude",
              },
            ]
          : [
              {
                project_id: fixture.system.general,
                decision: "include",
                mode: "auto",
              },
              {
                project_id: fixture.system.externalShared,
                decision: "exclude",
                mode: "force_exclude",
              },
            ]
        ).sort((left, right) => left.project_id.localeCompare(right.project_id))
      );
    }
  );

  it("A13-09: repeated unexplained auto-repair state consumes exactly two whole attempts and leaves no partial writes", async () => {
    const fixture = await seedConvergedExternalItem("auditfix13/repeated-membership-state.md");
    await plantSystemExclusion(fixture, fixture.system.general, "auto");
    const before = await storedState(fixture.seed, fixture.itemId);
    let attempts = 0;
    let suppressed = 0;
    const conflict = new PgClient({
      decorateSessionExecutor: (execute) => {
        attempts++;
        return async <T>(text: string, params: unknown[] = []) => {
          const normalized = text.replace(/\s+/g, " ").trim();
          if (
            /^UPDATE project_context_memberships SET /i.test(normalized) &&
            params.includes("exclude") &&
            params.includes("auto")
          ) {
            suppressed++;
            // Simulate the measured zero-row predicate conflict; the authoritative reread still
            // runs against real PostgreSQL and observes the unexplained current auto row.
            return { rows: [] as T[], rowCount: 0 };
          }
          return execute<T>(text, params);
        };
      },
    });
    const outcome = await attempt(() =>
      ingestItem(
        conflict,
        fixture.auth,
        fixture.original,
        "team",
        undefined,
        "team"
      )
    );

    expect(outcome.result).toBeNull();
    expect(outcome.error).toContain("membership-state-changed");
    expect(attempts).toBe(2);
    expect(suppressed).toBe(2);
    expect(await storedState(fixture.seed, fixture.itemId)).toEqual(before);
  });

  it.each([
    { pathKind: "unchanged-body", changed: false },
    { pathKind: "changed-body", changed: true },
  ])(
    "A13-08: settled no-widening refusal rolls back the $pathKind trusted narrowing",
    async ({ pathKind, changed }) => {
      const fixture = await seedConvergedExternalItem(
        `auditfix13/no-widening-${pathKind}.md`
      );
      await grantGeneralToExternal(fixture);
      const before = await storedState(fixture.seed, fixture.itemId);
      const body = changed
        ? `${fixture.original.body}\nchanged in the gate-refused push`
        : fixture.original.body;
      const payload: IngestPayload = {
        ...fixture.original,
        body,
        content_sha256: sha(body),
      };

      const outcome = await attempt(() =>
        ingestItem(db(), fixture.auth, payload, "team", undefined, "team")
      );
      const after = await storedState(fixture.seed, fixture.itemId);

      expect(
        after,
        "a settled policy refusal preserves the complete pre-attempt item/context state"
      ).toEqual(before);
      expect(outcome.result, "the ingest must not claim a refused narrowing succeeded").toBeNull();
      expect(outcome.error, "the refusal is named and distinguishable from a read outage").toMatch(
        /(?:context|no-widening).*(?:gate|refus)|(?:gate|refus).*no-widening/i
      );
      expect(
        await canSeeItem(
          db(),
          { teamId: fixture.seed.teamId, memberId: fixture.externalViewerId },
          fixture.itemId
        ),
        "the rejected push leaves the last committed external item visible"
      ).toBe(true);
    }
  );
});
