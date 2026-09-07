import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { DbClient, TransactionSession } from "@/lib/db/types";
import {
  runPgClientTransaction,
  TransactionExecutionError,
  type PgTransactionFactory,
} from "@/lib/db/pg/tx";

type QueryFailure = Error & { code?: string };

function fakeFactory(
  fail: (sql: string) => QueryFailure | null = () => null
): { factory: PgTransactionFactory; sql: string[]; release: ReturnType<typeof vi.fn> } {
  const sql: string[] = [];
  const release = vi.fn();
  const client = {
    async query(text: string) {
      sql.push(text);
      const error = fail(text);
      if (error) throw error;
      return { rows: [], rowCount: 0 };
    },
    release,
  } as unknown as PoolClient;
  return {
    sql,
    release,
    factory: {
      connect: async () => client,
      makeBoundClient: () => ({}) as DbClient,
    },
  };
}

function sqlError(message: string, code = "XX000"): QueryFailure {
  return Object.assign(new Error(message), { code });
}

describe("dedicated transaction protocol", () => {
  it("A13-06: transaction session construction failure destroys the checked-out connection", async () => {
    const fixture = fakeFactory();
    fixture.factory.makeBoundClient = () => {
      throw new Error("bound client construction failed");
    };

    await expect(runPgClientTransaction(fixture.factory, async () => ({ ok: true }))).rejects.toThrow(
      "bound client construction failed"
    );
    expect(fixture.sql).toEqual([]);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("A13-06: returned ok:false rolls back a prior mutation and releases a healthy session normally", async () => {
    const fixture = fakeFactory();
    const result = await runPgClientTransaction(fixture.factory, async (session) => {
      await session.executeSql("INSERT SENTINEL");
      return { ok: false, error: "domain failure" };
    });
    expect(result).toEqual({ ok: false, error: "domain failure" });
    expect(fixture.sql).toEqual(["BEGIN", "INSERT SENTINEL", "ROLLBACK"]);
    expect(fixture.release).toHaveBeenCalledWith();
  });

  it("A13-06: a swallowed executor error rejects success and rolls back", async () => {
    const fixture = fakeFactory((sql) =>
      sql === "BROKEN" ? sqlError("executor exploded", "40001") : null
    );
    await expect(
      runPgClientTransaction(fixture.factory, async (session) => {
        await session.executeSql("BROKEN").catch(() => undefined);
        return { ok: true };
      })
    ).rejects.toMatchObject({ code: "40001" });
    expect(fixture.sql).toEqual(["BEGIN", "BROKEN", "ROLLBACK"]);
    expect(fixture.release).toHaveBeenCalledWith();
  });

  it("A13-06: swallowed SQL and later control failures preserve both diagnostics and destroy", async () => {
    const fixture = fakeFactory((sql) => {
      if (sql === "BROKEN") return sqlError("primary SQL exploded", "23505");
      if (sql.startsWith("SAVEPOINT")) return sqlError("savepoint control exploded", "08006");
      return null;
    });

    const error = await runPgClientTransaction(fixture.factory, async (session) => {
      await session.executeSql("BROKEN").catch(() => undefined);
      await session.optionalAudit(async () => "written", "fallback").catch(() => "ignored");
      return { ok: true };
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect(error).toMatchObject({ code: "23505", sql: "BROKEN" });
    expect((error as Error).message).toContain("primary SQL exploded");
    expect((error as Error).message).toContain("savepoint control exploded");
    const combined = (error as Error & { cause?: unknown }).cause;
    expect(combined).toBeInstanceOf(AggregateError);
    expect(Array.from((combined as AggregateError).errors, messageOfTestError)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("primary SQL exploded"),
        expect.stringContaining("savepoint control exploded"),
      ])
    );
    expect(fixture.sql.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(fixture.sql).not.toContain("COMMIT");
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("A13-06: a connection-class executor failure destroys even after full rollback succeeds", async () => {
    const fixture = fakeFactory((sql) =>
      sql === "BROKEN CONNECTION" ? sqlError("connection lost", "08006") : null
    );
    await expect(
      runPgClientTransaction(fixture.factory, async (session) => {
        await session.executeSql("BROKEN CONNECTION");
        return { ok: true };
      })
    ).rejects.toMatchObject({ code: "08006" });
    expect(fixture.sql).toEqual(["BEGIN", "BROKEN CONNECTION", "ROLLBACK"]);
    expect(fixture.release).toHaveBeenCalledTimes(1);
    expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it.each(["BEGIN", "COMMIT"])(
    "A13-06: failed %s destroys the connection",
    async (control) => {
      const fixture = fakeFactory((sql) =>
        sql === control ? sqlError(`${control} control failure`, "08006") : null
      );
      await expect(
        runPgClientTransaction(fixture.factory, async () => ({ ok: true }))
      ).rejects.toThrow(control);
      expect(fixture.release).toHaveBeenCalledTimes(1);
      expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
      if (control === "COMMIT") expect(fixture.sql).not.toContain("ROLLBACK");
    }
  );

  it("A13-06: failed full ROLLBACK preserves the primary diagnostic and destroys", async () => {
    const fixture = fakeFactory((sql) =>
      sql === "ROLLBACK" ? sqlError("cleanup broke", "08006") : null
    );
    await expect(
      runPgClientTransaction(fixture.factory, async () => {
        throw new Error("primary callback failure");
      })
    ).rejects.toThrow(/primary callback failure; rollback also failed: cleanup broke/);
    expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("A13-13: optional audit SQL failure is cleared only after rollback-to and release", async () => {
    let failed = false;
    const fixture = fakeFactory((sql) => {
      if (sql === "AUDIT INSERT" && !failed) {
        failed = true;
        return sqlError("audit deadlock", "40P01");
      }
      return null;
    });
    const result = await runPgClientTransaction(fixture.factory, async (session) => {
      const optional = await session.optionalAudit(
        () => session.executeSql("AUDIT INSERT").then(() => "written"),
        "fallback"
      );
      await session.executeSql("DURABLE WRITE");
      return { ok: true, optional };
    });
    expect(result.optional).toBe("fallback");
    expect(fixture.sql.some((sql) => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
    expect(fixture.sql.some((sql) => sql.startsWith("RELEASE SAVEPOINT"))).toBe(true);
    expect(fixture.sql.at(-1)).toBe("COMMIT");
    expect(fixture.release).toHaveBeenCalledWith();
  });

  it("A13-13: failed savepoint recovery is fatal and destroys the session", async () => {
    const fixture = fakeFactory((sql) => {
      if (sql === "AUDIT INSERT") return sqlError("audit failed", "40001");
      if (sql.startsWith("ROLLBACK TO SAVEPOINT")) return sqlError("recovery failed", "08006");
      return null;
    });
    await expect(
      runPgClientTransaction(fixture.factory, async (session) => {
        await session.optionalAudit(
          () => session.executeSql("AUDIT INSERT"),
          { rows: [], rowCount: 0 }
        );
        return { ok: true };
      })
    ).rejects.toThrow(/optional audit recovery failed/);
    expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("A13-06/13: optional-audit connection loss stays fatal even if savepoint controls answer", async () => {
    const fixture = fakeFactory((sql) =>
      sql === "AUDIT INSERT" ? sqlError("audit connection lost", "08006") : null
    );
    await expect(
      runPgClientTransaction(fixture.factory, async (session) => {
        await session.optionalAudit(
          () => session.executeSql("AUDIT INSERT"),
          { rows: [], rowCount: 0 }
        );
        return { ok: true };
      })
    ).rejects.toMatchObject({ code: "08006" });
    expect(fixture.sql.some((sql) => sql.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);
    expect(fixture.sql).toContain("ROLLBACK");
    expect(fixture.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("A13-06: a completed session cannot be reused", async () => {
    const fixture = fakeFactory();
    let escaped: TransactionSession | undefined;
    await runPgClientTransaction(fixture.factory, async (session) => {
      escaped = session;
      return { ok: true };
    });
    await expect(escaped!.executeSql("SELECT escaped")).rejects.toThrow(
      "transaction-session-completed"
    );
  });

  it("A13-06: unknown COMMIT outcome is explicitly non-replayable", async () => {
    const fixture = fakeFactory((sql) =>
      sql === "COMMIT" ? sqlError("socket closed", "08006") : null
    );
    const error = await runPgClientTransaction(fixture.factory, async () => ({ ok: true })).catch(
      (caught) => caught
    );
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as TransactionExecutionError).unknownCommit).toBe(true);
  });
});

function messageOfTestError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
