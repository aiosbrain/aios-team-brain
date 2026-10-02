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
 * cascade barrier, repeatable-read connection-default variant), AC-04 (posture matrix), AC-05
 * (racing owners), AC-06 (atomic failures, best-effort audit) and Stage 1 slices of AC-07/AC-11.
 * Later criteria (AC-03, AC-07..AC-12 remainder) land in later stages.
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
 * Mutation harness ONLY (see the STAGINGMARK-5 core-stage2/stage3 handoffs): a disposable COPY of
 * the schema file whose materializer has exactly ONE post-lock check removed — the substrate check
 * (`STAGINGMARK5_MUTANT_KIND` unset or `substrate`) or the marker recheck (`marker`). Both unset in
 * every ordinary run, so the canonical file is installed and every assertion below stays normative.
 */
const MUTANT_SQL = process.env.STAGINGMARK5_MUTANT_SQL;
const MUTANT_KIND = process.env.STAGINGMARK5_MUTANT_KIND;
const MARKER_CHECK = /select\s+1\s+from\s+migration_markers\s+where\s+name\s*=\s*'pret4_builtin_materialize'/gi;
type PostLockChecks = { substrate: 0 | 1; marker: 0 | 1 };
const CANONICAL_CHECKS: PostLockChecks = { substrate: 1, marker: 1 };

function mutantChecks(): PostLockChecks {
  if (!MUTANT_SQL) {
    if (MUTANT_KIND) throw new Error("STAGINGMARK5_MUTANT_KIND requires STAGINGMARK5_MUTANT_SQL");
    return CANONICAL_CHECKS;
  }
  if (MUTANT_KIND === undefined || MUTANT_KIND === "substrate") return { substrate: 0, marker: 1 };
  if (MUTANT_KIND === "marker") return { substrate: 1, marker: 0 };
  throw new Error(`unknown STAGINGMARK5_MUTANT_KIND: ${MUTANT_KIND}`);
}

/** Install the materializer from `path`, first proving where its substrate and marker checks sit. */
async function installMaterializer(path: string, postLock: PostLockChecks): Promise<void> {
  const source = readFileSync(path, "utf8");
  const block = source.match(/create\s+or\s+replace\s+function\s+materialize_builtin_membership_once\s*\(\s*\)[\s\S]*?\bas\s+(\$\w*\$)[\s\S]*?\1\s*;/i);
  if (!block) throw new Error(`materializer definition missing in ${path}`);
  // The function text itself must carry the checks these tests expect: each once before the locks
  // and (canonical) once after the last lock. A mutant may drop ONLY the named post-lock copy.
  const lockEnd = block[0].indexOf("lock table migration_markers");
  expect(lockEnd).toBeGreaterThan(0);
  const [preLock, postLockText] = [block[0].slice(0, lockEnd), block[0].slice(lockEnd)];
  expect(preLock.split(SUBSTRATE_MESSAGE)).toHaveLength(2);
  expect(postLockText.split(SUBSTRATE_MESSAGE)).toHaveLength(postLock.substrate + 1);
  expect(preLock.match(MARKER_CHECK) ?? []).toHaveLength(1);
  expect(postLockText.match(MARKER_CHECK) ?? []).toHaveLength(postLock.marker);
  await query("drop function if exists materialize_builtin_membership_once()");
  await query(block[0]);
}

/** Test-owned fault triggers (AC-06). Dropped before and after the file, and in each case's finally. */
async function dropTestFaults(): Promise<void> {
  await query("drop trigger if exists stagingmark5_late_fault on migration_markers");
  await query("drop function if exists stagingmark5_late_fault()");
  await query("drop trigger if exists stagingmark5_audit_fault on audit_log");
  await query("drop function if exists stagingmark5_audit_fault()");
}

beforeAll(async () => {
  // Install the schema FILE's definition even on a reused dm container: the runtime owner must
  // execute the frozen SQL as it is in this tree, not whatever an earlier run left installed.
  await installMaterializer(MUTANT_SQL ?? CANONICAL_SQL, mutantChecks());
  await dropTestFaults();
});

afterAll(async () => {
  // The dm container is shared by every file in this worktree: never leave a mutant or fault installed.
  await dropTestFaults();
  if (MUTANT_SQL) await installMaterializer(CANONICAL_SQL, CANONICAL_CHECKS);
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

      // Substantive DB outcome FIRST, so a pin-deletion mutant is witnessed by its actual result
      // (not merely by the missing SET TRANSACTION in the command order below).
      expect(result).toEqual({ ok: false, error: SERVICE_ERROR });
      expect(failures).toEqual([{ code: "P0001", message: SUBSTRATE_MESSAGE }]);
      expect(await substrate()).toEqual({ items: 1, memberships: 0 });
      expect(await effects()).toEqual(before);
      expect(requested).toEqual([[PRODUCTION_LOCK_TIMEOUT]]);

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
    } finally {
      await holder.dispose();
      await service;
      if (rr.setup.length) await rr.released;
    }
  }, CASE_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Stage 3 — AC-04 posture matrix, AC-05 racing owners, AC-06 atomic failures.
// ---------------------------------------------------------------------------------------------

type Tier = "team" | "external";
type Slug = "everyone" | "external";
type FleetTeam = { id: string; members: { id: string; tier: Tier }[] };
// lib/db/pg/pool.ts keeps timestamptz (OID 1184) as the raw wire string; rows carry it unparsed.
type GroupRow = { id: string; team_id: string; slug: string; name: string; is_builtin: boolean; person_member_id: string | null; created_at: string; updated_at: string };
type EdgeRow = { team_id: string; group_id: string; member_id: string; added_by: string | null; created_at: string };
type AuditRow = {
  team_id: string; actor_kind: string; member_id: string | null; api_key_id: string | null;
  target_type: string; target_id: string; meta: Record<string, unknown>; created_at: string;
};
type State = {
  groups: GroupRow[]; edges: EdgeRow[]; audits: AuditRow[]; marker: { name: string; at: string }[];
  members: Record<string, unknown>[]; grants: Record<string, unknown>[];
};
type ExpectedAudit = { group: string; slug: Slug; added: string[]; removed: string[] };

/** The frozen posture policy as the SPEC states it: tier alone decides, for every kind/status/connector. */
const slugFor = (tier: Tier): Slug => (tier === "team" ? "everyone" : "external");
const BUILTIN_NAMES: Record<Slug, string> = { everyone: "Everyone", external: "External" };
const OLD = {
  group: new Date("2001-02-03T04:05:06Z"),
  everyone: new Date("2001-01-01T00:00:00Z"),
  external: new Date("2002-02-02T00:00:00Z"),
  custom: new Date("2000-06-07T08:09:10Z"),
  marker: new Date("2003-03-03T03:03:03Z"),
};
const SQUATTER_MESSAGE = "PRET-4 refused: a non-builtin group holds a reserved slug";
const LOCK_TIMEOUT_MESSAGE = "canceling statement due to lock timeout";

/** One team holding every kind × connector × status × tier combination (36), no builtins. */
async function postureTeam(): Promise<FleetTeam> {
  const id = (await query("insert into teams (slug, name) values ($1, 'stagingmark5 posture') returning id", [`sm5p-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  const members: FleetTeam["members"] = [];
  for (const kind of ["human", "agent", "offroster"]) {
    for (const connector of [false, true]) {
      for (const status of ["invited", "active", "disabled"]) {
        for (const tier of ["team", "external"] as const) {
          const member = randomUUID();
          await query(
            `insert into members (id, team_id, email, display_name, actor_handle, kind, is_connector, status, tier)
             values ($1, $2, $3, 'fixture', $4, $5, $6, $7, $8)`,
            [member, id, `${member}@test.local`, `h-${member.slice(0, 8)}`, kind, connector, status, tier]
          );
          members.push({ id: member, tier });
        }
      }
    }
  }
  expect(members).toHaveLength(36);
  return { id, members };
}

async function group(teamId: string, slug: string, opts: { builtin?: boolean; person?: string } = {}): Promise<string> {
  return (await query(
    `insert into groups (team_id, slug, name, is_builtin, person_member_id, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $6) returning id`,
    [teamId, slug, opts.builtin ? BUILTIN_NAMES[slug as Slug] : `custom ${slug}`, opts.builtin ?? false, opts.person ?? null, OLD.group]
  )).rows[0].id as string;
}

async function edge(teamId: string, groupId: string, memberId: string, createdAt: Date, addedBy: string | null = null): Promise<void> {
  await query(
    "insert into group_members (team_id, group_id, member_id, added_by, created_at) values ($1, $2, $3, $4, $5)",
    [teamId, groupId, memberId, addedBy, createdAt]
  );
}

/**
 * The AC-04 fleet. Expected sets are derived from the fixture INPUTS (each member's tier and the
 * edges seeded here), never from the function under test:
 *  - `missing`: all 36 combinations, no builtin groups at all (both must be created);
 *  - `mixed`: all 36 combinations, builtins present with old timestamps, one correct edge per
 *    builtin (kept byte-for-byte), one refuted edge per builtin (removed), the rest absent (added),
 *    plus a custom and a singleton group with memberships and a project grant (untouched);
 *  - `settled`: builtins already exact (no change, no audit);
 *  - `empty`: no members (builtins created, nothing to audit).
 * `partitioned` adds a partitioned item in `settled` and an unpartitioned one in `missing`: the
 * frozen gate is deliberately fleet-global, so one partition row admits the fleet.
 */
async function postureFleet(content: "none" | "partitioned") {
  const missing = await postureTeam();
  const mixed = await postureTeam();
  const settled = await team();
  const empty = (await query("insert into teams (slug, name) values ($1, 'stagingmark5 empty') returning id", [`sm5e-${randomUUID().slice(0, 8)}`])).rows[0].id as string;

  const ofTier = (t: FleetTeam, tier: Tier) => t.members.filter((m) => m.tier === tier).map((m) => m.id);
  const [correctEveryone, wrongInExternal] = ofTier(mixed, "team");
  const [correctExternal, wrongInEveryone] = ofTier(mixed, "external");
  const mixedGroups = { everyone: await group(mixed.id, "everyone", { builtin: true }), external: await group(mixed.id, "external", { builtin: true }) };
  await edge(mixed.id, mixedGroups.everyone, correctEveryone, OLD.everyone, wrongInExternal);
  await edge(mixed.id, mixedGroups.external, correctExternal, OLD.external);
  await edge(mixed.id, mixedGroups.external, wrongInExternal, OLD.group);
  await edge(mixed.id, mixedGroups.everyone, wrongInEveryone, OLD.group);
  const custom = await group(mixed.id, `custom-${randomUUID().slice(0, 8)}`);
  const singleton = await group(mixed.id, `person-${randomUUID().slice(0, 8)}`, { person: correctEveryone });
  await edge(mixed.id, custom, wrongInExternal, OLD.custom, correctEveryone);
  await edge(mixed.id, custom, wrongInEveryone, OLD.custom);
  await edge(mixed.id, singleton, correctEveryone, OLD.custom);
  const project = (await query("insert into projects (team_id, slug) values ($1, $2) returning id", [mixed.id, `p-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  await query("insert into project_groups (team_id, project_id, group_id, created_at) values ($1, $2, $3, $4)", [mixed.id, project, custom, OLD.custom]);

  const [settledTeam, settledExternal] = settled.members;
  expect([settledTeam.tier, settledExternal.tier]).toEqual(["team", "external"]);
  await edge(settled.id, await group(settled.id, "everyone", { builtin: true }), settledTeam.id, OLD.everyone);
  await edge(settled.id, await group(settled.id, "external", { builtin: true }), settledExternal.id, OLD.external);

  if (content === "partitioned") {
    await corpus(settled.id, { partitioned: true });
    await corpus(missing.id, { partitioned: false });
  }

  const audit = (t: FleetTeam, slug: Slug, kept: string[], removed: string[]): ExpectedAudit => ({
    group: `${t.id}/${slug}`,
    slug,
    added: t.members.filter((m) => slugFor(m.tier) === slug && !kept.includes(m.id)).map((m) => m.id).sort(),
    removed: [...removed].sort(),
  });
  return {
    teamIds: [missing.id, mixed.id, settled.id, empty],
    expectedEdges: [missing, mixed, settled].flatMap((t) => t.members.map((m) => `${t.id}/${m.id}/${slugFor(m.tier)}`)).sort(),
    expectedAudits: [
      audit(missing, "everyone", [], []),
      audit(missing, "external", [], []),
      audit(mixed, "everyone", [correctEveryone], [wrongInEveryone]),
      audit(mixed, "external", [correctExternal], [wrongInExternal]),
    ].sort((x, y) => x.group.localeCompare(y.group)),
    /** Builtins the run must CREATE (all others pre-exist and must be byte-preserved). */
    created: [missing.id, empty].flatMap((team_id) => (["everyone", "external"] as const).map((slug) => `${team_id}/${slug}`)).sort(),
    /** Refuted builtin edges, as `group_id/member_id`. */
    removed: [`${mixedGroups.everyone}/${wrongInEveryone}`, `${mixedGroups.external}/${wrongInExternal}`],
    /** Witnesses of intentional disagreement for the marked case. */
    disagreement: { missingTeam: missing.id, wrongEdge: { group_id: mixedGroups.external, member_id: wrongInExternal } },
  };
}
type PostureFleet = Awaited<ReturnType<typeof postureFleet>>;

async function postureState(): Promise<State> {
  return {
    groups: (await query("select * from groups order by id")).rows,
    edges: (await query("select * from group_members order by group_id, member_id")).rows,
    audits: (await query("select * from audit_log where action = 'access.builtin_materialized' order by id")).rows,
    marker: (await query("select * from migration_markers where name = $1", [MARKER])).rows,
    members: (await query("select * from members order by id")).rows,
    grants: (await query("select * from project_groups order by project_id, group_id")).rows,
  };
}

/**
 * Raw timestamptz wire string → epoch ms, for clock-RANGE checks only (equality stays on the raw
 * string, keeping microseconds). Truncating the fraction to ms is a floor, so ordering is preserved.
 */
function epochMs(raw: string): number {
  expect(typeof raw, `raw timestamptz string: ${String(raw)}`).toBe("string");
  const iso = raw.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1").replace(/([+-]\d{2})$/, "$1:00");
  const ms = Date.parse(iso);
  expect(Number.isFinite(ms), `parseable timestamptz: ${raw}`).toBe(true);
  return ms;
}

async function dbNow(): Promise<number> {
  return epochMs((await query("select clock_timestamp() as now")).rows[0].now as string);
}

const builtinsById = (state: State) => new Map(state.groups.filter((g) => g.is_builtin).map((g) => [g.id, g]));

function builtinEdges(state: State): string[] {
  const builtin = builtinsById(state);
  return state.edges.filter((e) => builtin.has(e.group_id)).map((e) => `${e.team_id}/${e.member_id}/${builtin.get(e.group_id)!.slug}`).sort();
}

/** Materialization audits keyed by `team/slug` of the audited builtin; UUID sets compared unordered. */
function normalizedAudits(state: State) {
  const builtin = builtinsById(state);
  return state.audits
    .map((a) => {
      const g = builtin.get(a.target_id);
      return {
        group: g ? `${g.team_id}/${g.slug}` : `unknown:${a.target_id}`,
        team_id: a.team_id,
        actor_kind: a.actor_kind,
        member_id: a.member_id,
        api_key_id: a.api_key_id,
        target_type: a.target_type,
        metaKeys: Object.keys(a.meta).sort(),
        slug: a.meta.slug,
        added: [...(a.meta.added as string[])].sort(),
        removed: [...(a.meta.removed as string[])].sort(),
        created_at: a.created_at,
      };
    })
    .sort((x, y) => x.group.localeCompare(y.group));
}

/**
 * Exact post-state of one successful run that started after `from` and finished before `to`: every
 * write it made carries the one transaction's now() (the marker's `at`), every pre-existing row it
 * should keep is byte-identical, refuted rows are gone, and audits name exactly the changed builtins.
 */
function expectExactMaterialization(fx: PostureFleet, before: State, after: State, window: { from: number; to: number }) {
  expect(after.marker).toHaveLength(1);
  const stamp = after.marker[0].at;
  expect(epochMs(stamp)).toBeGreaterThanOrEqual(window.from);
  expect(epochMs(stamp)).toBeLessThanOrEqual(window.to);

  expect(builtinEdges(after)).toEqual(fx.expectedEdges);

  const beforeGroups = new Set(before.groups.map((g) => g.id));
  expect(after.groups.filter((g) => beforeGroups.has(g.id))).toEqual(before.groups);
  const createdGroups = after.groups.filter((g) => !beforeGroups.has(g.id));
  expect(createdGroups.map((g) => `${g.team_id}/${g.slug}`).sort()).toEqual(fx.created);
  for (const g of createdGroups) {
    expect(g).toMatchObject({ is_builtin: true, name: BUILTIN_NAMES[g.slug as Slug], person_member_id: null });
    expect([g.created_at, g.updated_at]).toEqual([stamp, stamp]);
  }

  const key = (e: { group_id: string; member_id: string }) => `${e.group_id}/${e.member_id}`;
  const beforeEdges = new Set(before.edges.map(key));
  const removed = new Set(fx.removed);
  expect(fx.removed.every((k) => beforeEdges.has(k))).toBe(true);
  expect(after.edges.filter((e) => beforeEdges.has(key(e)))).toEqual(before.edges.filter((e) => !removed.has(key(e))));
  const added = after.edges.filter((e) => !beforeEdges.has(key(e)));
  expect(added.length).toBeGreaterThan(0);
  expect(added.every((e) => e.added_by === null && e.created_at === stamp)).toBe(true);

  expect(normalizedAudits(after)).toEqual(
    fx.expectedAudits.map((a) => ({
      group: a.group,
      team_id: a.group.split("/")[0],
      actor_kind: "system",
      member_id: null,
      api_key_id: null,
      target_type: "access",
      metaKeys: ["added", "removed", "slug"],
      slug: a.slug,
      added: a.added,
      removed: a.removed,
      created_at: stamp,
    }))
  );
  expect(after.members).toEqual(before.members);
  expect(after.grants).toEqual(before.grants);
}

describe("STAGINGMARK-5 AC-04 — the frozen posture matrix is exact through the runtime owner", () => {
  for (const content of ["none", "partitioned"] as const) {
    it(`all 36 kind×connector×status×tier combinations (content: ${content}): missing builtins created, refuted edges removed, correct/custom/singleton rows and timestamps preserved, exactly the changed groups audited`, async () => {
      const fx = await postureFleet(content);
      const before = await postureState();
      expect(before.audits).toEqual([]);
      expect(before.marker).toEqual([]);

      const from = await dbNow();
      const result = await materializeBuiltinMembershipOnce(db());
      const to = await dbNow();

      expect(result).toEqual({ ok: true, ran: true });
      const after = await postureState();
      expectExactMaterialization(fx, before, after, { from, to });

      // Marked: the same owner is an immediate no-op that changes nothing at all.
      expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: false });
      expect(await postureState()).toEqual(after);
    }, CASE_TIMEOUT_MS);
  }

  it("marked fleet: intentional disagreement is byte-preserved, ran:false, no audit", async () => {
    const fx = await postureFleet("partitioned");
    await query("insert into migration_markers (name, at) values ($1, $2)", [MARKER, OLD.marker]);
    const before = await postureState();
    // Non-vacuity: this state really disagrees with the posture predicate.
    expect(before.groups.some((g) => g.team_id === fx.disagreement.missingTeam)).toBe(false);
    expect(before.edges.some((e) => e.group_id === fx.disagreement.wrongEdge.group_id && e.member_id === fx.disagreement.wrongEdge.member_id)).toBe(true);
    expect(builtinEdges(before)).not.toEqual(fx.expectedEdges);

    expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: false });
    expect(await postureState()).toEqual(before);
    expect(before.marker.map((m) => m.name)).toEqual([MARKER]);
    expect(epochMs(before.marker[0].at)).toBe(OLD.marker.getTime());
    expect(before.audits).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it("zero-team, no-content fleet: stamps once with no groups/edges/audits, then ran:false with the marker untouched", async () => {
    expect((await query("select count(*)::int as n from teams")).rows[0].n).toBe(0);
    expect(await substrate()).toEqual({ items: 0, memberships: 0 });
    const from = await dbNow();
    expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: true });
    const to = await dbNow();
    const after = await postureState();
    expect([after.groups, after.edges, after.audits]).toEqual([[], [], []]);
    expect(after.marker).toHaveLength(1);
    expect(epochMs(after.marker[0].at)).toBeGreaterThanOrEqual(from);
    expect(epochMs(after.marker[0].at)).toBeLessThanOrEqual(to);

    expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: false });
    expect(await postureState()).toEqual(after);
  }, CASE_TIMEOUT_MS);
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: not settled within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Test-owned pinned transaction fixture for AC-05/06: the REAL engine over a REAL pool checkout.
 * Its query facade records statements, collects server NOTICEs from that one connection, and —
 * only when the ENGINE sends `COMMIT` (control path, after the function's real effects) — runs the
 * optional `beforeCommit` on the same connection before forwarding COMMIT. Release is delegated.
 */
function controlledDb(opts: { beforeCommit?: (real: PoolClient) => Promise<void> } = {}) {
  const statements: string[] = [];
  const notices: string[] = [];
  const releases: (Error | undefined)[] = [];
  let pid: number | undefined;
  const factory: PgTransactionFactory = {
    connect: async () => {
      const real = await getPool().connect();
      pid = (real as unknown as { processID: number }).processID;
      const onNotice = (notice: { message?: string }) => notices.push(String(notice.message));
      real.on("notice", onNotice);
      return {
        query: async (text: string, params: unknown[] = []) => {
          statements.push(text);
          if (text === "COMMIT" && opts.beforeCommit) await opts.beforeCommit(real);
          return real.query(text, params);
        },
        release: (err?: Error) => {
          releases.push(err);
          real.off("notice", onNotice);
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
  return { client, statements, notices, releases, pid: () => pid };
}

/**
 * A winner held AFTER the function's real in-transaction effects and BEFORE the engine's COMMIT.
 * `atCommit` resolves with what the winner itself sees inside its open transaction; `release()`
 * lets COMMIT proceed. The hold is bounded so a failed case can never wedge the run.
 */
function heldWinner() {
  const atCommit = deferred<{ marker: number; builtinEdges: number; heldAt: number }>();
  const gate = deferred();
  const winner = controlledDb({
    beforeCommit: async (real) => {
      const { rows } = await real.query(
        `select (select count(*)::int from migration_markers where name = $1) as marker,
                (select count(*)::int from group_members gm join groups g on g.id = gm.group_id where g.is_builtin) as "builtinEdges"`,
        [MARKER]
      );
      atCommit.resolve({ marker: rows[0].marker, builtinEdges: rows[0].builtinEdges, heldAt: Date.now() });
      await within(gate.promise, 20_000, "held winner");
    },
  });
  return { ...winner, atCommit: atCommit.promise, release: () => gate.resolve() };
}

/** Records the requested lock cap and every thrown SQL failure; alters nothing (production 2s cap). */
function observingExecutor(requested: unknown[][], failures: SqlFailure[]) {
  return (executor: SqlExecutor): SqlExecutor => async <T>(text: string, params: unknown[] = []) => {
    if (text === LOCK_TIMEOUT_SQL) requested.push(params);
    try {
      return await executor<T>(text, params);
    } catch (error) {
      const e = error as { code?: unknown; message?: unknown };
      failures.push({ code: typeof e.code === "string" ? e.code : undefined, message: String(e.message ?? error) });
      throw error;
    }
  };
}

async function ungrantedLocks(pid: number | null) {
  return (await query("select relation::regclass::text as relation, mode from pg_locks where pid = $1 and not granted", [pid])).rows;
}

describe("STAGINGMARK-5 AC-05 — racing owners: at most one invocation reconciles and stamps", () => {
  it("fast contender: loser observed blocked on teams behind the held winner inside the production 2s cap, then ran:false; one completion, one audit set", async () => {
    const fx = await postureFleet("none");
    const before = await postureState();
    const winner = heldWinner();
    const requested: unknown[][] = [];
    const failures: SqlFailure[] = [];
    const loserClient = new PgClient({ decorateSessionExecutor: observingExecutor(requested, failures) });
    let winnerRun: Promise<MaterializeOnceResult> | undefined;
    let loserRun: Promise<MaterializeOnceResult> | undefined;
    let loserSettled = false;
    try {
      const from = await dbNow();
      winnerRun = materializeBuiltinMembershipOnce(winner.client);
      const inside = await within(winner.atCommit, 10_000, "winner reaching COMMIT");
      // Non-vacuity: the winner's own open transaction already holds every effect and the marker.
      expect(inside).toMatchObject({ marker: 1, builtinEdges: fx.expectedEdges.length });

      const loserStart = Date.now();
      loserRun = materializeBuiltinMembershipOnce(loserClient).finally(() => {
        loserSettled = true;
      });
      const observed = await awaitServiceBlockedBehind(winner.pid()!, () => loserSettled);
      const waitingOn = await ungrantedLocks(observed.pid);
      const releasedAfter = Date.now() - loserStart;
      expect(observed).toMatchObject({ premature: false, count: 1, waiting: "Lock" });
      expect(observed.blockers).toContain(winner.pid());
      expect(waitingOn).toEqual([{ relation: "teams", mode: "ShareRowExclusiveLock" }]);
      expect(releasedAfter).toBeLessThan(2_000);

      winner.release();
      const [w, l] = await within(Promise.all([winnerRun, loserRun]), 10_000, "racing owners");
      const to = await dbNow();

      // Exactly one completion: the winner reconciled; the loser saw the committed marker after its lock.
      expect(w).toEqual({ ok: true, ran: true });
      expect(l).toEqual({ ok: true, ran: false });
      expect(failures).toEqual([]);
      expect(requested).toEqual([[PRODUCTION_LOCK_TIMEOUT]]);
      expect(winner.releases).toEqual([undefined]);
      const after = await postureState();
      expectExactMaterialization(fx, before, after, { from, to });

      // A fresh post-commit call is ran:false and changes nothing.
      expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: false });
      expect(await postureState()).toEqual(after);
    } finally {
      winner.release();
      await Promise.allSettled([winnerRun, loserRun]);
    }
  }, CASE_TIMEOUT_MS);

  it("slow contender: winner held past the loser's production 2s lock cap → loser exact 55P03 with no effects; winner commits; fresh loser ran:false", async () => {
    const fx = await postureFleet("none");
    const before = await postureState();
    const winner = heldWinner();
    const requested: unknown[][] = [];
    const failures: SqlFailure[] = [];
    const loserClient = new PgClient({ decorateSessionExecutor: observingExecutor(requested, failures) });
    let winnerRun: Promise<MaterializeOnceResult> | undefined;
    let loserRun: Promise<MaterializeOnceResult> | undefined;
    let loserSettled = false;
    try {
      const from = await dbNow();
      winnerRun = materializeBuiltinMembershipOnce(winner.client);
      const inside = await within(winner.atCommit, 10_000, "winner reaching COMMIT");
      expect(inside).toMatchObject({ marker: 1, builtinEdges: fx.expectedEdges.length });

      const loserStart = Date.now();
      loserRun = materializeBuiltinMembershipOnce(loserClient).finally(() => {
        loserSettled = true;
      });
      const observed = await awaitServiceBlockedBehind(winner.pid()!, () => loserSettled);
      expect(observed).toMatchObject({ premature: false, count: 1, waiting: "Lock" });
      expect(observed.blockers).toContain(winner.pid());

      // The winner stays held while the loser's own 2s lock cap expires.
      const l = await within(loserRun, 10_000, "loser lock timeout");
      const loserElapsed = Date.now() - loserStart;
      const midway = await postureState();
      const heldMs = Date.now() - inside.heldAt;

      expect(l).toEqual({ ok: false, error: `transaction SQL failed: ${LOCK_TIMEOUT_MESSAGE}` });
      expect(failures).toEqual([{ code: "55P03", message: LOCK_TIMEOUT_MESSAGE }]);
      expect(requested).toEqual([[PRODUCTION_LOCK_TIMEOUT]]);
      // No partial writes of the loser's own; the winner's are still uncommitted.
      expect(midway).toEqual(before);
      // Client-side elapsed includes setup, so it bounds the server's 2000ms wait from above.
      expect(loserElapsed).toBeGreaterThanOrEqual(1_950);
      expect(loserElapsed).toBeLessThan(10_000);
      expect(heldMs).toBeGreaterThan(2_000);

      winner.release();
      const w = await within(winnerRun, 10_000, "winner COMMIT");
      const to = await dbNow();
      expect(w).toEqual({ ok: true, ran: true });
      expect(winner.releases).toEqual([undefined]);
      const after = await postureState();
      expectExactMaterialization(fx, before, after, { from, to });

      const fresh: SqlFailure[] = [];
      expect(await materializeBuiltinMembershipOnce(new PgClient({ decorateSessionExecutor: observingExecutor([], fresh) }))).toEqual({ ok: true, ran: false });
      expect(fresh).toEqual([]);
      expect(await postureState()).toEqual(after);
    } finally {
      winner.release();
      await Promise.allSettled([winnerRun, loserRun]);
    }
  }, CASE_TIMEOUT_MS);
});

/**
 * AC-06 late fault: a BEFORE INSERT trigger on the marker row — the LAST write — that reports what
 * the same transaction has already written (builtin groups, builtin edges, materialization audits)
 * and then raises. The message is the progress witness: rollback is proved over real prior writes.
 */
async function installLateFault(): Promise<void> {
  await query(`create or replace function stagingmark5_late_fault() returns trigger language plpgsql as $$
    begin
      raise exception 'stagingmark5 late fault: builtin groups=% builtin edges=% materialization audits=%',
        (select count(*) from groups where is_builtin),
        (select count(*) from group_members gm join groups g on g.id = gm.group_id where g.is_builtin),
        (select count(*) from audit_log where action = 'access.builtin_materialized');
    end $$`);
  await query(`create trigger stagingmark5_late_fault before insert on migration_markers
    for each row when (new.name = 'pret4_builtin_materialize') execute function stagingmark5_late_fault()`);
}

/** AC-06 audit fault: an ordinary error on every materialization audit insert, nothing else. */
async function installAuditFault(): Promise<void> {
  await query(`create or replace function stagingmark5_audit_fault() returns trigger language plpgsql as $$
    begin
      raise exception 'stagingmark5 audit fault';
    end $$`);
  await query(`create trigger stagingmark5_audit_fault before insert on audit_log
    for each row when (new.action = 'access.builtin_materialized') execute function stagingmark5_audit_fault()`);
}

describe("STAGINGMARK-5 AC-06 — failures are atomic and retryable; the audit alone is best-effort", () => {
  it("runtime squatter refusal is atomic: exact P0001 preflight refusal, nothing changes, retry after removal succeeds", async () => {
    const fx = await postureFleet("partitioned");
    const [, , , emptyTeam] = fx.teamIds;
    const squatter = await group(emptyTeam, "external");
    const before = await postureState();
    const { client, failures } = recordingDb();

    const result = await materializeBuiltinMembershipOnce(client);

    expect(result).toEqual({ ok: false, error: `transaction SQL failed: ${SQUATTER_MESSAGE}` });
    expect(failures).toEqual([{ code: "P0001", message: SQUATTER_MESSAGE }]);
    expect(await postureState()).toEqual(before);

    await query("delete from groups where id = $1", [squatter]);
    const retryBefore = await postureState();
    const from = await dbNow();
    expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: true });
    const to = await dbNow();
    expectExactMaterialization(fx, retryBefore, await postureState(), { from, to });
  }, CASE_TIMEOUT_MS);

  it("mutation failure rolls back then retries: a late fault after real group/edge/audit writes leaves nothing, and the retry stamps", async () => {
    const fx = await postureFleet("partitioned");
    const before = await postureState();
    const witness =
      `stagingmark5 late fault: builtin groups=${fx.teamIds.length * 2} ` +
      `builtin edges=${fx.expectedEdges.length} materialization audits=${fx.expectedAudits.length}`;
    // Non-vacuity: every witnessed count differs from the pre-call state.
    expect(builtinsById(before).size).toBeLessThan(fx.teamIds.length * 2);
    expect(builtinEdges(before).length).not.toBe(fx.expectedEdges.length);
    expect(before.audits).toEqual([]);

    const { client, failures } = recordingDb();
    let result: MaterializeOnceResult;
    try {
      await installLateFault();
      result = await materializeBuiltinMembershipOnce(client);
    } finally {
      await dropTestFaults();
    }

    expect(result).toEqual({ ok: false, error: `transaction SQL failed: ${witness}` });
    expect(failures).toEqual([{ code: "P0001", message: witness }]);
    const rolledBack = await postureState();
    expect(rolledBack).toEqual(before);

    const from = await dbNow();
    expect(await materializeBuiltinMembershipOnce(db())).toEqual({ ok: true, ran: true });
    const to = await dbNow();
    expectExactMaterialization(fx, rolledBack, await postureState(), { from, to });
  }, CASE_TIMEOUT_MS);

  it("audit failure does not block materialization: ordinary audit error is noticed per changed group, marker and membership complete exactly", async () => {
    const fx = await postureFleet("none");
    const before = await postureState();
    const pinned = controlledDb();
    let result: MaterializeOnceResult;
    const from = await dbNow();
    try {
      await installAuditFault();
      result = await materializeBuiltinMembershipOnce(pinned.client);
    } finally {
      await dropTestFaults();
    }
    const to = await dbNow();

    expect(result).toEqual({ ok: true, ran: true });
    expect(pinned.releases).toEqual([undefined]);
    const after = await postureState();
    expect(after.audits).toEqual([]);
    // Everything but the audit is exact: same expectations, with an empty audit set.
    expectExactMaterialization({ ...fx, expectedAudits: [] }, before, after, { from, to });
    // Witness that the frozen best-effort handler really caught an audit error for each changed group.
    const idOf = new Map([...builtinsById(after).values()].map((g) => [`${g.team_id}/${g.slug}`, g.id]));
    expect([...pinned.notices].sort()).toEqual(
      fx.expectedAudits.map((a) => `access.builtin_materialized audit failed for group ${idOf.get(a.group)}: stagingmark5 audit fault`).sort()
    );
  }, CASE_TIMEOUT_MS);
});
