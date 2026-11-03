import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "@/lib/db/types";

/**
 * Transaction TRUTHFULNESS for the ambient scope (`lib/db/pg/pool.withTransaction`) and the session
 * transactions that JOIN it (`lib/db/pg/tx.runPgClientTransaction`).
 *
 * Spec. A transaction boundary may report success only for work PostgreSQL confirmed durable:
 *
 *   1. The proof of a commit is the server's COMMIT command tag. In a transaction that has already
 *      failed, PostgreSQL answers COMMIT with the tag ROLLBACK and no error — so "the call returned"
 *      is not evidence. A resolved ROLLBACK, a reply with no tag, and a failed COMMIT call all fail.
 *   2. Post-commit effects run only after that confirmation, and never for a rolled-back scope.
 *   3. A session opened inside an ambient transaction joins its connection behind a savepoint. Its
 *      own failure rolls back to the savepoint and leaves the enclosing transaction usable; a
 *      savepoint that cannot be recovered dooms the enclosing transaction, which then cannot commit
 *      even if its caller swallows the error.
 *   4. A joined session's success is provisional: when the enclosing transaction rolls back, nothing
 *      it wrote is reported and none of its post-commit effects run.
 *   5. When rollback cleanup itself fails, the PRIMARY error is still the one thrown; the cleanup
 *      failure only decides that the connection is destroyed instead of reused.
 *
 * The connection below is a small model of the one PostgreSQL rule everything here turns on: a failed
 * statement aborts the transaction, later statements are refused (25P02) until a rollback, ROLLBACK TO
 * SAVEPOINT recovers, and COMMIT in the aborted state silently rolls back. The real-Postgres
 * counterpart is `test/datamechanics/transaction-truthfulness.datamechanics.test.ts`.
 */

type QueryFailure = Error & { code?: string };
const sqlError = (message: string, code: string): QueryFailure => Object.assign(new Error(message), { code });

class FakeConnection {
  readonly sql: string[] = [];
  /** Bound parameters, index-aligned with `sql`. */
  readonly params: unknown[][] = [];
  readonly release = vi.fn();
  private aborted = false;
  private open = false;

  constructor(
    private readonly fail: (sql: string) => QueryFailure | null = () => null,
    /** Replace the COMMIT reply wholesale (an unconfirmed outcome). */
    private readonly commitReply: Record<string, unknown> | null = null
  ) {}

  async query(text: string, params: unknown[] = []): Promise<Record<string, unknown>> {
    this.sql.push(text);
    this.params.push(params);
    const scripted = this.fail(text);
    if (scripted) {
      if (this.open) this.aborted = true;
      throw scripted;
    }
    const tag = text.trim().split(/\s+/)[0].toUpperCase();
    if (text === "BEGIN") {
      this.open = true;
      this.aborted = false;
      return { rows: [], rowCount: null, command: "BEGIN" };
    }
    if (text === "COMMIT") {
      const lost = this.aborted;
      this.open = false;
      this.aborted = false;
      // The rule under test: no error, and the tag tells the truth.
      return this.commitReply ?? { rows: [], rowCount: null, command: lost ? "ROLLBACK" : "COMMIT" };
    }
    if (text === "ROLLBACK") {
      this.open = false;
      this.aborted = false;
      return { rows: [], rowCount: null, command: "ROLLBACK" };
    }
    if (text.startsWith("ROLLBACK TO SAVEPOINT")) {
      this.aborted = false;
      return { rows: [], rowCount: null, command: "ROLLBACK" };
    }
    if (this.aborted) {
      throw sqlError("current transaction is aborted, commands ignored until end of transaction block", "25P02");
    }
    return { rows: [], rowCount: 0, command: tag };
  }
}

const h = vi.hoisted(() => ({ connection: null as unknown, connects: 0 }));

// `pool.ts` builds its own `pg.Pool`; replacing the driver is the only seam that reaches the real
// `withTransaction` (a partial mock of the pool module would not change its internal `getPool`).
vi.mock("pg", () => ({
  Pool: class {
    on(): void {}
    async connect(): Promise<unknown> {
      h.connects++;
      return h.connection;
    }
  },
  types: { setTypeParser(): void {} },
}));

import { afterTransactionCommit, runSql, withTransaction } from "@/lib/db/pg/pool";
import { acquireWithLockTimeout, LOCK_ACQUISITION_TIMEOUT } from "@/lib/db/pg/bounded-lock";
import {
  runPgClientTransaction,
  TransactionExecutionError,
  withTransaction as withClientTransaction,
  type PgTransactionFactory,
} from "@/lib/db/pg/tx";

function use(connection: FakeConnection): FakeConnection {
  h.connection = connection;
  h.connects = 0;
  return connection;
}

/** No `connect` seam: the session must find the ambient connection on its own. */
const joining: PgTransactionFactory = { makeBoundClient: () => ({}) as DbClient };

const SAVEPOINT = /^SAVEPOINT auditfix13_joined_\d+$/;
const ROLLBACK_TO = /^ROLLBACK TO SAVEPOINT auditfix13_joined_\d+$/;
const RELEASE = /^RELEASE SAVEPOINT auditfix13_joined_\d+$/;

function expectReused(connection: FakeConnection): void {
  expect(connection.release).toHaveBeenCalledTimes(1);
  expect(connection.release.mock.calls[0][0]).toBeUndefined();
}

function expectDestroyed(connection: FakeConnection): void {
  expect(connection.release).toHaveBeenCalledTimes(1);
  expect(connection.release.mock.calls[0][0]).toBeInstanceOf(Error);
}

/** Registers an effect and returns the log it writes to, stamped with the last statement it saw. */
function effectProbe(connection: FakeConnection): { ran: string[]; register: () => Promise<void> } {
  const ran: string[] = [];
  return {
    ran,
    register: () => afterTransactionCommit(async () => { ran.push(`after ${connection.sql.at(-1)}`); }),
  };
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://unit:unit@127.0.0.1:1/unit");
});

describe("ambient transaction: a commit is what PostgreSQL confirms", () => {
  it("success commits once, then runs post-commit effects, and reuses the connection", async () => {
    const c = use(new FakeConnection());
    const effect = effectProbe(c);
    const result = await withTransaction(async () => {
      await runSql("WRITE");
      await effect.register();
      expect(effect.ran, "an effect must not run before the commit").toEqual([]);
      return 7;
    });
    expect(result).toBe(7);
    expect(c.sql).toEqual(["BEGIN", "WRITE", "COMMIT"]);
    expect(effect.ran).toEqual(["after COMMIT"]);
    expectReused(c);
  });

  it("a thrown callback rolls back, rethrows, and runs no effect", async () => {
    const c = use(new FakeConnection());
    const effect = effectProbe(c);
    const boom = new Error("boom");
    await expect(
      withTransaction(async () => {
        await runSql("WRITE");
        await effect.register();
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(c.sql).toEqual(["BEGIN", "WRITE", "ROLLBACK"]);
    expect(effect.ran).toEqual([]);
    expectReused(c);
  });

  it("SILENT COMMIT→ROLLBACK: a swallowed statement failure can no longer be reported as success", async () => {
    // The shape of the real hazard: a best-effort write whose error is swallowed leaves the
    // transaction aborted, the callback returns normally, and PostgreSQL turns COMMIT into ROLLBACK.
    const c = use(new FakeConnection((sql) => (sql === "BEST EFFORT" ? sqlError("check violated", "23514") : null)));
    const effect = effectProbe(c);
    const error = await withTransaction(async () => {
      await runSql("DURABLE WRITE");
      await runSql("BEST EFFORT").catch(() => undefined);
      await effect.register();
      return "reported as done";
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/COMMIT was resolved as ROLLBACK/);
    expect((error as TransactionExecutionError).unknownCommit).toBe(false);
    expect(effect.ran, "no post-commit effect for work that was rolled back").toEqual([]);
    // The server already ended the transaction: no second ROLLBACK, and the clean connection is reused.
    expect(c.sql).toEqual(["BEGIN", "DURABLE WRITE", "BEST EFFORT", "COMMIT"]);
    expectReused(c);
  });

  it.each([
    ["no command tag", { rows: [], rowCount: 0 }],
    ["an unrelated tag", { rows: [], rowCount: 0, command: "SELECT" }],
  ])("a COMMIT reply with %s is unconfirmed: fails, suppresses effects, destroys the connection", async (_name, reply) => {
    const c = use(new FakeConnection(undefined, reply));
    const effect = effectProbe(c);
    const error = await withTransaction(async () => {
      await effect.register();
      return 1;
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/COMMIT was not confirmed/);
    expect((error as TransactionExecutionError).unknownCommit).toBe(true);
    expect(effect.ran).toEqual([]);
    expect(c.sql).toEqual(["BEGIN", "COMMIT"]);
    expectDestroyed(c);
  });

  it("a COMMIT call that fails is an unknown outcome: unknownCommit, code kept, no ROLLBACK, destroyed", async () => {
    const c = use(new FakeConnection((sql) => (sql === "COMMIT" ? sqlError("socket closed", "08006") : null)));
    const effect = effectProbe(c);
    const error = await withTransaction(async () => {
      await effect.register();
      return 1;
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect(error).toMatchObject({ unknownCommit: true, code: "08006" });
    expect((error as Error).message).toContain("COMMIT failed; outcome unknown and will not be replayed: socket closed");
    expect(c.sql).toEqual(["BEGIN", "COMMIT"]);
    expect(effect.ran).toEqual([]);
    expectDestroyed(c);
  });

  it("when ROLLBACK cleanup also fails, the PRIMARY error is thrown and the connection is destroyed", async () => {
    const c = use(new FakeConnection((sql) => (sql === "ROLLBACK" ? sqlError("cleanup broke", "08006") : null)));
    const primary = new Error("primary callback failure");
    await expect(withTransaction(async () => { throw primary; })).rejects.toBe(primary);
    expect(c.sql).toEqual(["BEGIN", "ROLLBACK"]);
    expectDestroyed(c);
  });

  it("with no enclosing transaction a post-commit effect runs immediately and cannot throw outward", async () => {
    const ran: string[] = [];
    await afterTransactionCommit(async () => { ran.push("now"); });
    await expect(afterTransactionCommit(async () => { throw new Error("diagnostic failed"); })).resolves.toBeUndefined();
    expect(ran).toEqual(["now"]);
  });
});

describe("joined session: one connection, a savepoint, and no success of its own", () => {
  it("success joins the ambient connection — no second checkout, no nested BEGIN/COMMIT", async () => {
    const c = use(new FakeConnection());
    const result = await withTransaction(async () => {
      await runSql("OUTER BEFORE");
      const inner = await runPgClientTransaction(joining, async (session) => {
        await session.executeSql("INNER WRITE");
        return { ok: true as const, wrote: 1 };
      });
      await runSql("OUTER AFTER");
      return inner;
    });
    expect(result).toEqual({ ok: true, wrote: 1 });
    expect(h.connects, "a joined session must not check out a second connection").toBe(1);
    expect(c.sql).toEqual([
      "BEGIN",
      "OUTER BEFORE",
      expect.stringMatching(SAVEPOINT),
      "INNER WRITE",
      expect.stringMatching(RELEASE),
      "OUTER AFTER",
      "COMMIT",
    ]);
    expectReused(c);
  });

  it("an unsanctioned ok:false rolls back to the savepoint and leaves the enclosing transaction usable", async () => {
    const c = use(new FakeConnection());
    const result = await withTransaction(async () => {
      const inner = await runPgClientTransaction(joining, async (session) => {
        await session.executeSql("INNER WRITE");
        return { ok: false as const, error: "domain refusal" };
      });
      await runSql("OUTER AFTER");
      return inner;
    });
    expect(result).toEqual({ ok: false, error: "domain refusal" });
    expect(c.sql).toEqual([
      "BEGIN",
      expect.stringMatching(SAVEPOINT),
      "INNER WRITE",
      expect.stringMatching(ROLLBACK_TO),
      expect.stringMatching(RELEASE),
      "OUTER AFTER",
      "COMMIT",
    ]);
    expectReused(c);
  });

  it("a SWALLOWED inner failure is still caught by the tracker, rolled back, and recoverable outside", async () => {
    const c = use(new FakeConnection((sql) => (sql === "INNER BROKEN" ? sqlError("duplicate key", "23505") : null)));
    const outcome = await withTransaction(async () => {
      const inner = await runPgClientTransaction(joining, async (session) => {
        await session.executeSql("INNER BROKEN").catch(() => undefined);
        return { ok: true as const };
      }).catch((caught) => caught);
      // The savepoint rollback recovered the transaction, so the enclosing writer may carry on.
      await runSql("OUTER AFTER");
      return inner;
    });
    expect(outcome).toBeInstanceOf(TransactionExecutionError);
    expect(outcome).toMatchObject({ code: "23505", sql: "INNER BROKEN" });
    expect(c.sql).toEqual([
      "BEGIN",
      expect.stringMatching(SAVEPOINT),
      "INNER BROKEN",
      expect.stringMatching(ROLLBACK_TO),
      expect.stringMatching(RELEASE),
      "OUTER AFTER",
      "COMMIT",
    ]);
    expectReused(c);
  });

  it("FAILED SAVEPOINT RECOVERY dooms the enclosing transaction even when its caller swallows the error", async () => {
    const c = use(new FakeConnection((sql) => {
      if (sql === "INNER BROKEN") return sqlError("duplicate key", "23505");
      if (sql.startsWith("ROLLBACK TO SAVEPOINT")) return sqlError("recovery failed", "08006");
      return null;
    }));
    const effect = effectProbe(c);
    const error = await withTransaction(async () => {
      await effect.register();
      await runPgClientTransaction(joining, async (session) => {
        await session.executeSql("INNER BROKEN");
        return { ok: true as const };
      }).catch(() => undefined); // the enclosing writer ignores it …
      return "reported as done"; // … and tries to report success
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/duplicate key; rollback also failed: recovery failed/);
    expect(c.sql).not.toContain("COMMIT");
    expect(c.sql.at(-1)).toBe("ROLLBACK");
    expect(effect.ran).toEqual([]);
    expectDestroyed(c);
  });

  it("OUTER ROLLBACK AFTER INNER SUCCESS: the joined session's work and effects go with it", async () => {
    const c = use(new FakeConnection());
    const effect = effectProbe(c);
    const boom = new Error("enclosing writer failed after the session succeeded");
    await expect(
      withTransaction(async () => {
        const inner = await runPgClientTransaction(joining, async (session) => {
          await session.executeSql("INNER WRITE");
          await effect.register(); // registered from INSIDE the joined session
          return { ok: true as const };
        });
        expect(inner).toEqual({ ok: true });
        throw boom;
      })
    ).rejects.toBe(boom);
    expect(c.sql).toEqual([
      "BEGIN",
      expect.stringMatching(SAVEPOINT),
      "INNER WRITE",
      expect.stringMatching(RELEASE),
      "ROLLBACK",
    ]);
    expect(effect.ran, "a released savepoint is not a commit").toEqual([]);
    expectReused(c);
  });

  it("inner success followed by a swallowed OUTER failure is a resolved rollback, not a commit", async () => {
    const c = use(new FakeConnection((sql) => (sql === "OUTER BEST EFFORT" ? sqlError("audit failed", "23514") : null)));
    const effect = effectProbe(c);
    const error = await withTransaction(async () => {
      await runPgClientTransaction(joining, async (session) => {
        await session.executeSql("INNER WRITE");
        await effect.register();
        return { ok: true as const };
      });
      await runSql("OUTER BEST EFFORT").catch(() => undefined);
      return "reported as done";
    }).catch((caught) => caught);
    expect((error as Error).message).toMatch(/COMMIT was resolved as ROLLBACK/);
    expect(effect.ran).toEqual([]);
    expect(c.sql.at(-1)).toBe("COMMIT");
    expectReused(c);
  });

  it("nested ambient scopes share the one transaction and commit exactly once", async () => {
    const c = use(new FakeConnection());
    const result = await withTransaction(() => withTransaction(async () => { await runSql("WRITE"); return "inner"; }));
    expect(result).toBe("inner");
    expect(c.sql).toEqual(["BEGIN", "WRITE", "COMMIT"]);
    expect(h.connects).toBe(1);
  });
});

describe("bounded lock acquisition on the ambient transaction", () => {
  const LOCK = "select pg_advisory_xact_lock(hashtextextended($1,0))";
  const SET = "select set_config('lock_timeout', $1, true)";

  it("bounds exactly the lock statement, then restores the caller's own lock_timeout", async () => {
    const c = use(new FakeConnection());
    await withTransaction(async () => {
      await acquireWithLockTimeout(LOCK, ["team:item:1"]);
      await runSql("ORDINARY WRITE");
    });
    expect(c.sql).toEqual(["BEGIN", "show lock_timeout", SET, LOCK, SET, "ORDINARY WRITE", "COMMIT"]);
    // The model connection reports no prior setting, i.e. PostgreSQL's default of "0" (no limit).
    expect(c.params[2]).toEqual([LOCK_ACQUISITION_TIMEOUT]);
    expect(c.params[3]).toEqual(["team:item:1"]);
    expect(c.params[4], "restored to what the caller had, not left bounded for ordinary writes").toEqual(["0"]);
    expect(LOCK_ACQUISITION_TIMEOUT).toBe("10s");
  });

  it("a timed-out acquisition is not followed by a restore: the transaction is lost and rolls back", async () => {
    const c = use(new FakeConnection((sql) => (sql === LOCK ? sqlError("canceling statement due to lock timeout", "55P03") : null)));
    await expect(withTransaction(() => acquireWithLockTimeout(LOCK, ["team:item:1"]))).rejects.toMatchObject({ code: "55P03" });
    expect(c.sql).toEqual(["BEGIN", "show lock_timeout", SET, LOCK, "ROLLBACK"]);
    expectReused(c);
  });
});

describe("raw-client transaction helper: the same tag check", () => {
  it("a swallowed statement failure surfaces as a resolved rollback", async () => {
    const c = use(new FakeConnection((sql) => (sql === "BEST EFFORT" ? sqlError("check violated", "23514") : null)));
    const error = await withClientTransaction(async (client) => {
      await client.query("DURABLE WRITE");
      await client.query("BEST EFFORT").catch(() => undefined);
      return "reported as done";
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/COMMIT was resolved as ROLLBACK/);
    expect(c.sql).toEqual(["BEGIN", "DURABLE WRITE", "BEST EFFORT", "COMMIT"]);
    expectReused(c);
  });

  it("an unconfirmed COMMIT reply fails and destroys the connection", async () => {
    const c = use(new FakeConnection(undefined, { rows: [] }));
    const error = await withClientTransaction(async () => 1).catch((caught) => caught);
    expect(error).toMatchObject({ unknownCommit: true });
    expectDestroyed(c);
  });

  it("a confirmed COMMIT still returns the callback's result", async () => {
    const c = use(new FakeConnection());
    await expect(withClientTransaction(async (client) => { await client.query("WRITE"); return 3; })).resolves.toBe(3);
    expect(c.sql).toEqual(["BEGIN", "WRITE", "COMMIT"]);
    expectReused(c);
  });
});
