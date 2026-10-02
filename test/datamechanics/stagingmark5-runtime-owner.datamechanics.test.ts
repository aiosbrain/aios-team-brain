import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { db, transactionSessionDecoratedDb } from "./helpers";
import { getPool } from "@/lib/db/pg/pool";
import { PgClient } from "@/lib/db/pg/client";
import { runPgClientTransaction, type PgTransactionFactory } from "@/lib/db/pg/tx";
import type { SqlExecutor, TransactionCapableDbClient, TransactionSession } from "@/lib/db/types";
import { materializeBuiltinMembershipOnce, type MaterializeOnceResult } from "@/lib/access/groups";
import { makeMaterializeDeps, runMaterializeCommand, type MaterializeResult } from "@/lib/access/materialize-command";

/**
 * STAGINGMARK-5 / AIO-1132 — one bounded runtime owner for builtin materialization.
 * Spec: docs/design/stagingmark5-runtime-owner.md (v2.2). Covers AC-01, AC-02 (stale state, blocked
 * cascade barrier, repeatable-read connection-default variant) and Stage 1 slices of AC-07/AC-11.
 * Later criteria (AC-03..AC-12 remainder) land in later stages.
 *
 * These are written from the spec, not from the implementation. Against the pre-conversion
 * TypeScript materializer (lib/access/groups.ts), which reads the marker but never the substrate,
 * every refusal case below is expected RED: it stamps the marker over content with zero context
 * memberships. That is the gap, not a test fault.
 *
 * Expected refusal is the FROZEN PRET-6 text raised by `materialize_builtin_membership_once()`
 * (postgres/schema.sql), surfaced through the transaction engine's `transaction SQL failed: `
 * prefix (lib/db/pg/tx.ts executionError) with SQLSTATE P0001 (plpgsql RAISE EXCEPTION default).
 */

const root = join(import.meta.dirname, "../..");
const query = (sql: string, values: unknown[] = []) => getPool().query(sql, values);

const SUBSTRATE_MESSAGE =
  "PRET-6 refused: this fleet has content but no context substrate — upgrade through the prior release so the corpus is partitioned before enforcement (see docs/RELEASE-NOTES-pret6.md)";
const SERVICE_ERROR = `transaction SQL failed: ${SUBSTRATE_MESSAGE}`;
const MARKER = "pret4_builtin_materialize";
const CASE_TIMEOUT_MS = 30_000;
const CANONICAL_SQL = join(root, "postgres/schema.sql");
/**
 * Mutation harness ONLY (see the STAGINGMARK-5 core-stage2 handoff): a disposable COPY of the
 * schema file whose materializer has exactly the post-lock substrate check removed. Unset in every
 * ordinary run, so the canonical file is installed and every assertion below stays normative.
 */
const MUTANT_SQL = process.env.STAGINGMARK5_MUTANT_SQL;

/** Install the materializer from `path`, first proving where its substrate checks sit. */
async function installMaterializer(path: string, postLockCopies: 0 | 1): Promise<void> {
  const source = readFileSync(path, "utf8");
  const block = source.match(/create\s+or\s+replace\s+function\s+materialize_builtin_membership_once\s*\(\s*\)[\s\S]*?\bas\s+(\$\w*\$)[\s\S]*?\1\s*;/i);
  if (!block) throw new Error(`materializer definition missing in ${path}`);
  // The function text itself must carry the message these tests expect: once before the locks and
  // (canonical) once after the last lock. A mutant may drop ONLY the post-lock copy.
  const lockEnd = block[0].indexOf("lock table migration_markers");
  expect(lockEnd).toBeGreaterThan(0);
  expect(block[0].slice(0, lockEnd).split(SUBSTRATE_MESSAGE)).toHaveLength(2);
  expect(block[0].slice(lockEnd).split(SUBSTRATE_MESSAGE)).toHaveLength(postLockCopies + 1);
  await query("drop function if exists materialize_builtin_membership_once()");
  await query(block[0]);
}

beforeAll(async () => {
  // Install the schema FILE's definition even on a reused dm container: the runtime owner must
  // execute the frozen SQL as it is in this tree, not whatever an earlier run left installed.
  await installMaterializer(MUTANT_SQL ?? CANONICAL_SQL, MUTANT_SQL ? 0 : 1);
});

afterAll(async () => {
  // The dm container is shared by every file in this worktree: never leave a mutant installed.
  if (MUTANT_SQL) await installMaterializer(CANONICAL_SQL, 1);
});

beforeEach(async () => {
  // migration_markers is not in the harness truncation list; the marker persists across files.
  await query("delete from migration_markers where name = $1", [MARKER]);
});

/** A team with one member per tier and NO builtin groups (never seedTeam: it creates builtins). */
async function team(): Promise<{ id: string; members: { id: string; tier: "team" | "external" }[] }> {
  const id = (await query("insert into teams (slug, name) values ($1, 'stagingmark5') returning id", [`sm5-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  const members: { id: string; tier: "team" | "external" }[] = [];
  for (const tier of ["team", "external"] as const) {
    const member = randomUUID();
    await query(
      `insert into members (id, team_id, email, display_name, actor_handle, kind, status, tier)
       values ($1, $2, $3, 'fixture', $4, 'human', 'active', $5)`,
      [member, id, `${member}@test.local`, `h-${member.slice(0, 8)}`, tier]
    );
    members.push({ id: member, tier });
  }
  return { id, members };
}

/** One content item in `teamId`; partitioned => it also gets a context unit + membership. */
async function corpus(teamId: string, opts: { partitioned: boolean }): Promise<void> {
  const project = (await query("insert into projects (team_id, slug) values ($1, $2) returning id", [teamId, `p-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  const item = (await query(
    `insert into items (team_id, project_id, path, kind, access, content_sha256)
     values ($1, $2, $3, 'deliverable', 'team', 'sha') returning id`,
    [teamId, project, `docs/${randomUUID().slice(0, 8)}.md`]
  )).rows[0].id as string;
  if (!opts.partitioned) return;
  const unit = (await query(
    `insert into project_context_units (team_id, unit_key, audience, content_sha256, source_item_id)
     values ($1, $2, 'team', 'sha', $3) returning id`,
    [teamId, `u-${randomUUID().slice(0, 8)}`, item]
  )).rows[0].id as string;
  await query("insert into project_context_memberships (team_id, project_id, context_unit_id) values ($1, $2, $3)", [teamId, project, unit]);
}

/**
 * The spec's cascade fixture: A = unpartitioned content in a team that SURVIVES; B = the sole
 * partitioned item, in a DISTINCT team that the cascade deletes.
 */
async function cascadeFleet() {
  const a = await team();
  const b = await team();
  await corpus(a.id, { partitioned: false });
  await corpus(b.id, { partitioned: true });
  return { a, b };
}

async function deleteTeamCommitted(teamId: string): Promise<void> {
  await query("delete from teams where id = $1", [teamId]);
  // Precondition, so a refusal is not vacuous: the cascade really left content with zero
  // partition rows — the exact predicate the frozen SQL gate evaluates.
  const { rows } = await query(
    "select (select count(*)::int from items) as items, (select count(*)::int from project_context_memberships) as memberships"
  );
  expect(rows[0]).toEqual({ items: 1, memberships: 0 });
}

/** Every effect a refusal must not have: groups, edges, marker, materialization audit. */
async function effects() {
  return {
    groups: (await query("select * from groups order by id")).rows,
    edges: (await query("select * from group_members order by group_id, member_id")).rows,
    marker: (await query("select name from migration_markers where name = $1", [MARKER])).rows,
    audits: (await query("select * from audit_log where action = 'access.builtin_materialized' order by id")).rows,
  };
}

/**
 * The real transaction-capable adapter, with the session executor wrapped to RECORD (never alter)
 * a thrown SQL failure, so the underlying SQLSTATE is observable even though the service returns
 * only `{ok:false,error}`. A pre-conversion materializer opens no transaction, records nothing.
 */
function recordingDb(): { client: TransactionCapableDbClient; failures: { code?: string; message: string }[] } {
  const failures: { code?: string; message: string }[] = [];
  const client = transactionSessionDecoratedDb(db(), (session) => ({
    ...session,
    executeSql: async <T>(text: string, params: unknown[] = []) => {
      try {
        return await session.executeSql<T>(text, params);
      } catch (error) {
        const e = error as { code?: unknown; message?: unknown };
        failures.push({ code: typeof e.code === "string" ? e.code : undefined, message: String(e.message ?? error) });
        throw error;
      }
    },
  }));
  return { client, failures };
}

async function expectBuiltinsFor(teams: { id: string; members: { id: string; tier: "team" | "external" }[] }[]) {
  const actual = (await query(`select gm.team_id, gm.member_id, g.slug from group_members gm
    join groups g on g.id = gm.group_id and g.team_id = gm.team_id where g.is_builtin`)).rows
    .map((r) => `${r.team_id}/${r.member_id}/${r.slug}`).sort();
  const expected = teams.flatMap((t) => t.members.map((m) => `${t.id}/${m.id}/${m.tier === "team" ? "everyone" : "external"}`)).sort();
  expect(actual).toEqual(expected);
}

describe("STAGINGMARK-5 AC-01 — runtime service refuses a markerless fleet with content and zero context memberships", () => {
  it("static zero-substrate fleet: exact P0001 substrate refusal, no group/edge/marker/audit effect", async () => {
    const a = await team();
    await corpus(a.id, { partitioned: false });
    const before = await effects();
    expect(before.marker).toEqual([]);
    const { client, failures } = recordingDb();

    const result = await materializeBuiltinMembershipOnce(client);

    expect(result).toEqual({ ok: false, error: SERVICE_ERROR });
    expect(failures.some((f) => f.code === "P0001" && f.message === SUBSTRATE_MESSAGE)).toBe(true);
    expect(await effects()).toEqual(before);
  }, CASE_TIMEOUT_MS);

  it("cascade-shaped fleet: B's team deleted (committed) before the call leaves surviving A unpartitioned — refused atomically", async () => {
    const { b } = await cascadeFleet();
    await deleteTeamCommitted(b.id);
    const before = await effects();
    const { client, failures } = recordingDb();

    const result = await materializeBuiltinMembershipOnce(client);

    expect(result).toEqual({ ok: false, error: SERVICE_ERROR });
    expect(failures.some((f) => f.code === "P0001" && f.message === SUBSTRATE_MESSAGE)).toBe(true);
    expect(await effects()).toEqual(before);
  }, CASE_TIMEOUT_MS);

  it("inverse: the same two-team fleet with B's partition intact materializes and stamps", async () => {
    const { a, b } = await cascadeFleet();
    const result = await materializeBuiltinMembershipOnce(db());
    expect(result).toEqual({ ok: true, ran: true });
    expect((await effects()).marker).toHaveLength(1);
    await expectBuiltinsFor([a, b]);
  }, CASE_TIMEOUT_MS);

  it("inverse: a fleet with no content at all materializes and stamps — there is no corpus to darken", async () => {
    const a = await team();
    const result = await materializeBuiltinMembershipOnce(db());
    expect(result).toEqual({ ok: true, ran: true });
    expect((await effects()).marker).toHaveLength(1);
    await expectBuiltinsFor([a]);
  }, CASE_TIMEOUT_MS);
});

describe("STAGINGMARK-5 AC-02 (stale state) — confirmed CLI acting on a state read made stale by a committed team cascade", () => {
  it("refuses with the frozen substrate error instead of stamping over the now-unpartitioned fleet", async () => {
    const { b } = await cascadeFleet();
    const { client, failures } = recordingDb();
    const real = makeMaterializeDeps(client);

    // The REAL read-only state read, while B's partition still exists: the CLI's own pre-check passes.
    const state = await real.readState();
    expect(state).toMatchObject({ marker: false, teams: 2, contentWithoutSubstrate: false });

    // Then the cascade commits between the CLI's check and its write.
    await deleteTeamCommitted(b.id);
    const before = await effects();

    const results: MaterializeResult[] = [];
    const outcome = await runMaterializeCommand(
      {
        readState: async () => state, // the captured (now stale) state, exactly as the handler saw it
        materialize: async () => {
          const r = await real.materialize();
          results.push(r);
          return r;
        },
      },
      // Both flags: the local test DB may or may not carry `staging_marker`; the production
      // discriminator itself is not under test and is not altered.
      { confirm: true, confirmProduction: true }
    );

    expect(results).toEqual([{ ok: false, error: SERVICE_ERROR }]);
    expect(failures.some((f) => f.code === "P0001" && f.message === SUBSTRATE_MESSAGE)).toBe(true);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.lines.some((l) => l.includes(SERVICE_ERROR))).toBe(true);
    expect(await effects()).toEqual(before);
  }, CASE_TIMEOUT_MS);
});

const FUNCTION_SQL = "SELECT materialize_builtin_membership_once() AS result";

/**
 * Test-owned pinned transaction fixture (Stage 1 slice of AC-07): the REAL engine over a REAL pool
 * checkout, with a query facade that records each statement and the backend PID that ran it, and —
 * right after the function SELECT returns, on the same connection, before the engine's COMMIT —
 * reads the effective isolation and local caps. No production hook; release is delegated as-is.
 */
function pinnedDb() {
  const log: { pid: number; sql: string; params: unknown[] }[] = [];
  const effective: Record<string, string> = {};
  const releases: (Error | undefined)[] = [];
  const factory: PgTransactionFactory = {
    connect: async () => {
      const real = await getPool().connect();
      const pid = (real as unknown as { processID: number }).processID;
      return {
        query: async (text: string, params: unknown[] = []) => {
          log.push({ pid, sql: text, params });
          const result = await real.query(text, params);
          if (text === FUNCTION_SQL) {
            for (const name of ["transaction_isolation", "statement_timeout", "lock_timeout"]) {
              effective[name] = (await real.query(`show ${name}`)).rows[0][name];
            }
            effective.backend = String((await real.query("select pg_backend_pid() as pid")).rows[0].pid);
          }
          return result;
        },
        release: (err?: Error) => {
          releases.push(err);
          real.release(err);
        },
      } as unknown as PoolClient;
    },
    makeBoundClient: (executor, reportFailure) => new PgClient({ executor, reportFailure, bound: true }),
  };
  const outer = db() as TransactionCapableDbClient;
  const client: TransactionCapableDbClient = {
    from: outer.from.bind(outer),
    rpc: outer.rpc.bind(outer),
    transaction: <T>(fn: (session: TransactionSession) => Promise<T>) => runPgClientTransaction(factory, fn),
  };
  return { client, log, effective, releases };
}

describe("STAGINGMARK-5 AC-07 (order slice) — one owned transaction on one real backend, required order", () => {
  it("BEGIN → READ COMMITTED → local 120000ms/2000ms → one function SELECT → COMMIT on one PID; effective settings observed", async () => {
    const a = await team();
    const { client, log, effective, releases } = pinnedDb();

    expect(await materializeBuiltinMembershipOnce(client)).toEqual({ ok: true, ran: true });

    expect(log.map(({ sql, params }) => ({ sql, params }))).toEqual([
      { sql: "BEGIN", params: [] },
      { sql: "SET TRANSACTION ISOLATION LEVEL READ COMMITTED", params: [] },
      { sql: "SELECT set_config('statement_timeout', $1, true)", params: ["120000ms"] },
      { sql: "SELECT set_config('lock_timeout', $1, true)", params: ["2000ms"] },
      { sql: FUNCTION_SQL, params: [] },
      { sql: "COMMIT", params: [] },
    ]);
    const pids = new Set(log.map((e) => e.pid));
    expect(pids.size).toBe(1);
    expect(String([...pids][0])).toBe(effective.backend);
    expect(effective).toMatchObject({ transaction_isolation: "read committed", statement_timeout: "2min", lock_timeout: "2s" });
    expect(releases).toEqual([undefined]);
    expect((await effects()).marker).toHaveLength(1);
    await expectBuiltinsFor([a]);

    // Marked: the same owner commits a no-op and reports ran:false.
    const second = pinnedDb();
    expect(await materializeBuiltinMembershipOnce(second.client)).toEqual({ ok: true, ran: false });
    expect(second.log.filter((e) => e.sql === FUNCTION_SQL)).toHaveLength(1);
  }, CASE_TIMEOUT_MS);
});

describe("STAGINGMARK-5 AC-11 (real PG) — nested and malformed results fail closed", () => {
  it("a real transaction-bound PgClient is refused by the existing guard: no function call, no effects", async () => {
    await team();
    const before = await effects();
    const executed: string[] = [];
    const outer = new PgClient({
      decorateSessionExecutor: (executor: SqlExecutor): SqlExecutor => async <T>(text: string, params: unknown[] = []) => {
        executed.push(text);
        return executor<T>(text, params);
      },
    });
    const nested = await outer.transaction(async (session) => materializeBuiltinMembershipOnce(session.db));
    expect(nested.ok).toBe(false);
    expect(nested.error).toMatch(/transaction-session-already-bound/);
    expect(executed.some((sql) => /materialize_builtin_membership_once/.test(sql))).toBe(false);
    expect(await effects()).toEqual(before);
  }, CASE_TIMEOUT_MS);

  // Each variant really runs the frozen function (effects happen inside the transaction) and then
  // shapes its output wrongly; the owner must abort BEFORE COMMIT so the effects roll back.
  const variants: [string, string][] = [
    ["zero rows", "select v as result from r where not v"],
    ["two rows", "select v as result from r cross join generate_series(1, 2)"],
    ["null result", "select null::boolean as result from r"],
    ["string result", "select v::text as result from r"],
    ["missing result column", "select v as other from r"],
  ];
  for (const [label, shape] of variants) {
    it(`${label}: named failure after real in-transaction effects, all rolled back`, async () => {
      await team();
      const before = await effects();
      const inside: number[] = [];
      const client = new PgClient({
        decorateSessionExecutor: (executor: SqlExecutor): SqlExecutor => async <T>(text: string, params: unknown[] = []) => {
          if (text !== FUNCTION_SQL) return executor<T>(text, params);
          const out = await executor<T>(`with r as materialized (select materialize_builtin_membership_once() as v) ${shape}`, params);
          const seen = await executor<{ n: number }>("select count(*)::int as n from migration_markers where name = $1", [MARKER]);
          inside.push(seen.rows[0].n);
          return out;
        },
      });
      const result = await materializeBuiltinMembershipOnce(client);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/malformed result/);
      expect(inside, "non-vacuity: the function stamped inside the transaction").toEqual([1]);
      expect(await effects()).toEqual(before);
    }, CASE_TIMEOUT_MS);
  }
});

const LOCK_TIMEOUT_SQL = "SELECT set_config('lock_timeout', $1, true)";
const PRODUCTION_LOCK_TIMEOUT = "2000ms";
const RACE_LOCK_TIMEOUT = "10000ms";
type SqlFailure = { code?: string; message: string };

/**
 * Test-owned session executor for the AC-02 blocked-race cases ONLY. It records the lock cap the
 * service REQUESTED and, only when that is exactly the production 2000ms, sends 10000ms instead so
 * the barrier has deterministic commit slack — a timeout must never stand in for the gate. Every
 * thrown SQL failure is recorded, never altered. Production 2s cancellation is AC-08's, not here.
 */
function raceExecutor(requested: unknown[][], failures: SqlFailure[]) {
  return (executor: SqlExecutor): SqlExecutor => async <T>(text: string, params: unknown[] = []) => {
    let sent = params;
    if (text === LOCK_TIMEOUT_SQL) {
      requested.push(params);
      if (params.length === 1 && params[0] === PRODUCTION_LOCK_TIMEOUT) sent = [RACE_LOCK_TIMEOUT];
    }
    try {
      return await executor<T>(text, sent);
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      failures.push({ code: typeof e.code === "string" ? e.code : undefined, message: String(e.message ?? error) });
      throw error;
    }
  };
}

/** A dedicated connection holding B's team deletion (and its cascade) UNCOMMITTED. */
async function holdTeamDeletion(teamId: string) {
  const holder = await getPool().connect();
  let open = false;
  const dispose = async () => {
    try {
      if (open) await holder.query("ROLLBACK");
      open = false;
      holder.release();
    } catch (error) {
      holder.release(error instanceof Error ? error : new Error(String(error)));
    }
  };
  try {
    const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    await holder.query("BEGIN");
    open = true;
    expect((await holder.query("delete from teams where id = $1", [teamId])).rowCount).toBe(1);
    return {
      pid,
      commit: async () => {
        await holder.query("COMMIT");
        open = false;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * Poll (bounded, well inside the 10s race cap) until the ONE backend running the service's function
 * SELECT reports `holderPid` among its pg_blocking_pids. `premature` means the service settled
 * first — the barrier was never observed, so the case must fail rather than pass on an outcome alone.
 */
async function awaitServiceBlockedBehind(holderPid: number, settled: () => boolean) {
  const deadline = Date.now() + 5_000;
  let last = { count: 0, pid: null as number | null, blockers: [] as number[], waiting: null as string | null };
  while (Date.now() < deadline) {
    if (settled()) return { ...last, premature: true };
    const { rows } = await query(
      `select pid, pg_blocking_pids(pid) as blockers, wait_event_type as waiting
         from pg_stat_activity
        where datname = current_database() and state = 'active' and query = $1`,
      [FUNCTION_SQL]
    );
    last = { count: rows.length, pid: rows[0]?.pid ?? null, blockers: rows[0]?.blockers ?? [], waiting: rows[0]?.waiting ?? null };
    if (rows.length === 1 && last.blockers.includes(holderPid)) return { ...last, premature: false };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ...last, premature: settled() };
}

async function substrate() {
  return (await query(
    "select (select count(*)::int from items) as items, (select count(*)::int from project_context_memberships) as memberships"
  )).rows[0];
}

/**
 * Repeatable-read connection-default variant: the existing `runPgClientTransaction` factory seam with
 * a REAL pool checkout. connect() sets the pinned client's session default to repeatable read BEFORE
 * the engine's BEGIN; the engine's (synchronous) healthy release restores and SHOWs the original
 * default on that same client, then releases it for real — `released` lets the test await that.
 * The bound client, reportFailure and engine are the real ones; no pool or production option is touched.
 */
function repeatableReadDefaultDb(decorateExecutor: (executor: SqlExecutor) => SqlExecutor) {
  const setup: { pid: number; original: string; pinned: string }[] = [];
  const statements: { pid: number; sql: string }[] = [];
  const restorations: { pid: number; restored?: string; destroyed?: string }[] = [];
  let markReleased!: () => void;
  const released = new Promise<void>((resolve) => {
    markReleased = resolve;
  });
  const show = async (real: PoolClient) =>
    (await real.query("show default_transaction_isolation")).rows[0].default_transaction_isolation as string;
  const factory: PgTransactionFactory = {
    connect: async () => {
      const real = await getPool().connect();
      const pid = (real as unknown as { processID: number }).processID;
      const original = await (async () => {
        try {
          const value = await show(real);
          await real.query("SET default_transaction_isolation = 'repeatable read'");
          setup.push({ pid, original: value, pinned: await show(real) });
          return value;
        } catch (error) {
          real.release(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      })();
      return {
        query: (text: string, params: unknown[] = []) => {
          statements.push({ pid, sql: text });
          return real.query(text, params);
        },
        release: (err?: Error) => {
          void (async () => {
            if (err) {
              restorations.push({ pid, destroyed: err.message });
              real.release(err);
              return;
            }
            try {
              await real.query("select set_config('default_transaction_isolation', $1, false)", [original]);
              const restored = await show(real);
              restorations.push({ pid, restored });
              real.release(restored === original ? undefined : new Error(`default not restored: ${restored}`));
            } catch (error) {
              restorations.push({ pid, destroyed: String(error) });
              real.release(error instanceof Error ? error : new Error(String(error)));
            }
          })().finally(markReleased);
        },
      } as unknown as PoolClient;
    },
    decorateExecutor,
    makeBoundClient: (executor, reportFailure) => new PgClient({ executor, reportFailure, bound: true }),
  };
  const outer = db() as TransactionCapableDbClient;
  const client: TransactionCapableDbClient = {
    from: outer.from.bind(outer),
    rpc: outer.rpc.bind(outer),
    transaction: <T>(fn: (session: TransactionSession) => Promise<T>) => runPgClientTransaction(factory, fn),
  };
  return { client, setup, statements, restorations, released };
}

describe("STAGINGMARK-5 AC-02 (blocked cascade) — the authoritative post-lock gate refuses a cascade that commits while the owner waits", () => {
  it("base: owner blocks behind B's uncommitted team deletion (pg_blocking_pids), then refuses with exact P0001 once it commits", async () => {
    const { b } = await cascadeFleet();
    const before = await effects();
    const requested: unknown[][] = [];
    const failures: SqlFailure[] = [];
    const client = new PgClient({ decorateSessionExecutor: raceExecutor(requested, failures) });
    const holder = await holdTeamDeletion(b.id);
    let settled = false;
    let service: Promise<MaterializeOnceResult> | undefined;
    try {
      service = materializeBuiltinMembershipOnce(client).finally(() => {
        settled = true;
      });
      const observed = await awaitServiceBlockedBehind(holder.pid, () => settled);
      expect(observed).toMatchObject({ premature: false, count: 1, waiting: "Lock" });
      expect(observed.blockers).toContain(holder.pid);

      await holder.commit();
      const result = await service;

      expect(requested).toEqual([[PRODUCTION_LOCK_TIMEOUT]]);
      expect(result).toEqual({ ok: false, error: SERVICE_ERROR });
      expect(failures).toEqual([{ code: "P0001", message: SUBSTRATE_MESSAGE }]);
      // Non-vacuity: the cascade really committed, leaving surviving A's content with zero partition rows.
      expect(await substrate()).toEqual({ items: 1, memberships: 0 });
      expect(await effects()).toEqual(before);
    } finally {
      await holder.dispose();
      await service;
    }
  }, CASE_TIMEOUT_MS);

  it("repeatable-read connection default set before BEGIN: the service's READ COMMITTED pin still yields the exact P0001 refusal", async () => {
    const { b } = await cascadeFleet();
    const before = await effects();
    const requested: unknown[][] = [];
    const failures: SqlFailure[] = [];
    const rr = repeatableReadDefaultDb(raceExecutor(requested, failures));
    const holder = await holdTeamDeletion(b.id);
    let settled = false;
    let service: Promise<MaterializeOnceResult> | undefined;
    try {
      service = materializeBuiltinMembershipOnce(rr.client).finally(() => {
        settled = true;
      });
      const observed = await awaitServiceBlockedBehind(holder.pid, () => settled);
      expect(observed).toMatchObject({ premature: false, count: 1, waiting: "Lock" });
      expect(observed.blockers).toContain(holder.pid);

      await holder.commit();
      const result = await service;
      await rr.released;

      expect(rr.setup).toHaveLength(1);
      const [{ pid, original }] = rr.setup;
      expect(rr.setup).toEqual([{ pid, original, pinned: "repeatable read" }]);
      expect(original).not.toBe("repeatable read");
      expect(observed.pid).toBe(pid);
      expect(rr.statements).toEqual(
        ["BEGIN", "SET TRANSACTION ISOLATION LEVEL READ COMMITTED", "SELECT set_config('statement_timeout', $1, true)", LOCK_TIMEOUT_SQL, FUNCTION_SQL, "ROLLBACK"]
          .map((sql) => ({ pid, sql }))
      );
      expect(rr.restorations).toEqual([{ pid, restored: original }]);

      expect(requested).toEqual([[PRODUCTION_LOCK_TIMEOUT]]);
      expect(result).toEqual({ ok: false, error: SERVICE_ERROR });
      expect(failures).toEqual([{ code: "P0001", message: SUBSTRATE_MESSAGE }]);
      expect(await substrate()).toEqual({ items: 1, memberships: 0 });
      expect(await effects()).toEqual(before);
    } finally {
      await holder.dispose();
      await service;
      if (rr.setup.length) await rr.released;
    }
  }, CASE_TIMEOUT_MS);
});
