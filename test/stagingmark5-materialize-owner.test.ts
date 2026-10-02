import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { DbClient, TransactionCapableDbClient, TransactionSession } from "@/lib/db/types";
import { runPgClientTransaction, type PgTransactionFactory } from "@/lib/db/pg/tx";
import { PgClient } from "@/lib/db/pg/client";
import { getPool, runSql } from "@/lib/db/pg/pool";
import { materializeBuiltinMembershipOnce } from "@/lib/access/groups";

/**
 * STAGINGMARK-5 / AIO-1132 — Stage 1 unit controls for the bounded runtime owner.
 * Spec: docs/design/stagingmark5-runtime-owner.md (v2.2), "Service-owned transaction design" 1–6,
 * AC-07 (command order on one connection) and AC-11 (fail closed: missing capability, nested
 * call, wrong cardinality, non-boolean result; no global-pool escape, no public RPC).
 *
 * The REAL transaction engine (`runPgClientTransaction`) and the REAL bound `PgClient` run here;
 * only the PoolClient is fake, so BEGIN/ROLLBACK/COMMIT/release are the engine's own decisions,
 * not this file's. Real-PG counterparts live in test/datamechanics/stagingmark5-runtime-owner.
 */

// Any reach for the process pool is an escape this owner must never take (spec step 2).
vi.mock("@/lib/db/pg/pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/pg/pool")>()),
  getPool: vi.fn(() => {
    throw new Error("global-pool-escape");
  }),
  runSql: vi.fn(async () => {
    throw new Error("global-pool-escape");
  }),
}));

const FUNCTION_SQL = "SELECT materialize_builtin_membership_once() AS result";
const ISOLATION_SQL = "SET TRANSACTION ISOLATION LEVEL READ COMMITTED";
const STATEMENT_SQL = "SELECT set_config('statement_timeout', $1, true)";
const LOCK_SQL = "SELECT set_config('lock_timeout', $1, true)";
const PREFIX = [
  { sql: "BEGIN", params: [] },
  { sql: ISOLATION_SQL, params: [] },
  { sql: STATEMENT_SQL, params: ["120000ms"] },
  { sql: LOCK_SQL, params: ["2000ms"] },
  { sql: FUNCTION_SQL, params: [] },
];
const PID = 4242;

type Fault = Error & { code?: string };

/** A fake PoolClient driven through the real engine; records every statement with its backend PID. */
function engineDb(opts: { rows?: unknown[]; selectError?: Fault; commitError?: Fault } = {}) {
  const log: { pid: number; sql: string; params: unknown[] }[] = [];
  const release = vi.fn();
  const client = {
    processID: PID,
    async query(text: string, params: unknown[] = []) {
      log.push({ pid: PID, sql: text, params });
      if (text === "COMMIT" && opts.commitError) throw opts.commitError;
      if (text === FUNCTION_SQL) {
        if (opts.selectError) throw opts.selectError;
        const rows = opts.rows ?? [{ result: true }];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    release,
  } as unknown as PoolClient;
  let connects = 0;
  const factory: PgTransactionFactory = {
    connect: async () => {
      connects++;
      return client;
    },
    makeBoundClient: (executor, reportFailure) => new PgClient({ executor, reportFailure, bound: true }),
  };
  const outerCalls: string[] = [];
  const db = {
    from: (table: string) => {
      outerCalls.push(`from:${table}`);
      throw new Error(`outer builder use is not part of the owner: ${table}`);
    },
    rpc: async (fn: string) => {
      outerCalls.push(`rpc:${fn}`);
      throw new Error(`public RPC is not part of the owner: ${fn}`);
    },
    transaction: <T>(fn: (session: TransactionSession) => Promise<T>) => runPgClientTransaction(factory, fn),
  } as unknown as TransactionCapableDbClient;
  return { db, log, release, outerCalls, connects: () => connects };
}

const sqlError = (message: string, code: string): Fault => Object.assign(new Error(message), { code });

beforeEach(() => {
  vi.mocked(getPool).mockClear();
  vi.mocked(runSql).mockClear();
});

function expectNoPoolEscape() {
  expect(vi.mocked(getPool)).not.toHaveBeenCalled();
  expect(vi.mocked(runSql)).not.toHaveBeenCalled();
}

describe("STAGINGMARK-5 AC-07 (order) — one owned transaction, one connection, required statement order", () => {
  it("success true: BEGIN → READ COMMITTED → 120000ms/2000ms local caps → one function SELECT → COMMIT, all on one PID", async () => {
    const f = engineDb({ rows: [{ result: true }] });
    const result = await materializeBuiltinMembershipOnce(f.db);
    expect(result).toEqual({ ok: true, ran: true });
    expect(f.log.map(({ sql, params }) => ({ sql, params }))).toEqual([...PREFIX, { sql: "COMMIT", params: [] }]);
    expect(new Set(f.log.map((e) => e.pid))).toEqual(new Set([PID]));
    expect(f.log.filter((e) => e.sql === FUNCTION_SQL)).toHaveLength(1);
    expect(f.connects()).toBe(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledWith();
    expect(f.outerCalls).toEqual([]);
    expectNoPoolEscape();
  });

  it("success false (already stamped) is ok:true, ran:false — never a failure, never a run", async () => {
    const f = engineDb({ rows: [{ result: false }] });
    expect(await materializeBuiltinMembershipOnce(f.db)).toEqual({ ok: true, ran: false });
    expect(f.log.map((e) => e.sql)).toEqual([...PREFIX.map((p) => p.sql), "COMMIT"]);
  });

  it("a SQL refusal returns the engine-prefixed frozen text and rolls back — no COMMIT, healthy release", async () => {
    const f = engineDb({ selectError: sqlError("PRET-6 refused: frozen", "P0001") });
    const result = await materializeBuiltinMembershipOnce(f.db);
    expect(result).toEqual({ ok: false, error: "transaction SQL failed: PRET-6 refused: frozen" });
    expect(f.log.map((e) => e.sql)).toEqual([...PREFIX.map((p) => p.sql), "ROLLBACK"]);
    expect(f.release).toHaveBeenCalledWith();
    expectNoPoolEscape();
  });
});

describe("STAGINGMARK-5 AC-11 — the owner fails closed", () => {
  it("a client without transaction capability is refused before any statement or pool checkout", async () => {
    const calls: string[] = [];
    const plain = {
      from: (table: string) => {
        calls.push(`from:${table}`);
        throw new Error("must not be used");
      },
      rpc: async (fn: string) => {
        calls.push(`rpc:${fn}`);
        return { data: true, error: null };
      },
    } as unknown as DbClient;
    const result = await materializeBuiltinMembershipOnce(plain);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/transaction-capability-required/);
    expect((result as { ran?: boolean }).ran).toBeUndefined();
    expect(calls).toEqual([]);
    expectNoPoolEscape();
  });

  it("a nested call on a transaction-bound PgClient is refused by the existing guard — no statement, no pool escape", async () => {
    const executed: string[] = [];
    const bound = new PgClient({
      executor: async (text: string) => {
        executed.push(text);
        return { rows: [{ result: true }], rowCount: 1 } as never;
      },
      bound: true,
    });
    const result = await materializeBuiltinMembershipOnce(bound);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/transaction-session-already-bound/);
    expect((result as { ran?: boolean }).ran).toBeUndefined();
    expect(executed).toEqual([]);
    expectNoPoolEscape();
  });

  const malformed: [string, unknown[]][] = [
    ["zero rows", []],
    ["two rows", [{ result: true }, { result: true }]],
    ["null result", [{ result: null }]],
    ["string result", [{ result: "true" }]],
    ["missing result column", [{ materialize_builtin_membership_once: true }]],
  ];
  for (const [label, rows] of malformed) {
    it(`${label}: named failure, rolled back BEFORE COMMIT, connection released healthy`, async () => {
      const f = engineDb({ rows });
      const result = await materializeBuiltinMembershipOnce(f.db);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/malformed result/);
      expect((result as { ran?: boolean }).ran).toBeUndefined();
      expect(f.log.map((e) => e.sql)).toEqual([...PREFIX.map((p) => p.sql), "ROLLBACK"]);
      expect(f.log.some((e) => e.sql === "COMMIT")).toBe(false);
      expect(f.release).toHaveBeenCalledTimes(1);
      expect(f.release).toHaveBeenCalledWith();
      expectNoPoolEscape();
    });
  }
});

describe("STAGINGMARK-5 — unacknowledged COMMIT is uncertain, not a failure with known rollback", () => {
  it("reports outcomeUnknown:true with truthful text, destroys the connection, never replays the SELECT", async () => {
    const f = engineDb({ rows: [{ result: true }], commitError: sqlError("socket hang up", "ECONNRESET") });
    const result = await materializeBuiltinMembershipOnce(f.db);
    expect(result.ok).toBe(false);
    expect(result.outcomeUnknown).toBe(true);
    expect((result as { ran?: boolean }).ran).toBeUndefined();
    expect(result.error).toMatch(/outcome unknown/i);
    expect(result.error).not.toMatch(/did not stamp|rolled back|not stamped/i);
    expect(f.log.map((e) => e.sql)).toEqual([...PREFIX.map((p) => p.sql), "COMMIT"]);
    expect(f.log.filter((e) => e.sql === FUNCTION_SQL)).toHaveLength(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.release.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(f.connects()).toBe(1);
  });

  it("an ordinary known-rollback failure carries no outcomeUnknown flag", async () => {
    const f = engineDb({ selectError: sqlError("lock timeout", "55P03") });
    const result = await materializeBuiltinMembershipOnce(f.db);
    expect(result.ok).toBe(false);
    expect("outcomeUnknown" in result).toBe(false);
  });
});
