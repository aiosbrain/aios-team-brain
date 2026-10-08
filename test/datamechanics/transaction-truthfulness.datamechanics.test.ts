import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { db } from "./helpers";
import { afterTransactionCommit, getPool, runSql, withTransaction } from "@/lib/db/pg/pool";
import { pgClient } from "@/lib/db/pg/client";
import { TransactionExecutionError } from "@/lib/db/pg/tx";

/**
 * Transaction truthfulness against REAL PostgreSQL — the counterpart of
 * `test/pg-ambient-transaction.test.ts`, whose connection is a model.
 *
 * Spec. A transaction boundary reports success only for writes the server confirmed durable.
 * Every assertion below reads the outcome from a DIFFERENT connection (`getPool().query`), which
 * under READ COMMITTED sees a row only once it is actually committed — so "the function returned"
 * is never what is being measured.
 *
 *   · ambient success / rollback                    — the baseline both ways;
 *   · SILENT COMMIT→ROLLBACK                         — a swallowed failure aborts the transaction and
 *     PostgreSQL answers COMMIT with the tag ROLLBACK; the scope must throw, not return;
 *   · joined success                                — a session opened inside the ambient scope uses
 *     its connection (it can see the scope's uncommitted row) and commits with it;
 *   · joined rollback                               — the session's own failure undoes only its work;
 *   · outer rollback after inner success            — a released savepoint is not a commit;
 *   · failed savepoint recovery                     — the scope is doomed even if its caller swallows.
 */

const slug = (): string => `tx-${randomUUID().slice(0, 12)}`;

/** Read through a pool connection that is NOT the transaction's: committed rows only. */
async function committed(teamSlug: string): Promise<boolean> {
  const { rowCount } = await getPool().query("select 1 from teams where slug = $1", [teamSlug]);
  return rowCount === 1;
}

const insertTeam = (teamSlug: string) =>
  runSql("insert into teams (slug, name) values ($1, 'Tx truthfulness')", [teamSlug]);

/** An effect that records whether the named row was durable at the moment it ran. */
function effectProbe(teamSlug: string): { ran: boolean[]; register: () => Promise<void> } {
  const ran: boolean[] = [];
  return { ran, register: () => afterTransactionCommit(async () => { ran.push(await committed(teamSlug)); }) };
}

describe("transaction truthfulness: the ambient scope (real Postgres)", () => {
  it("success is durable, and the post-commit effect runs only once it is", async () => {
    const a = slug();
    const effect = effectProbe(a);
    await withTransaction(async () => {
      await insertTeam(a);
      await effect.register();
      expect(await committed(a), "not visible to another connection before COMMIT").toBe(false);
    });
    expect(await committed(a)).toBe(true);
    expect(effect.ran, "ran exactly once, and saw the committed row").toEqual([true]);
  });

  it("a thrown callback leaves nothing behind and runs no effect", async () => {
    const a = slug();
    const effect = effectProbe(a);
    await expect(
      withTransaction(async () => {
        await insertTeam(a);
        await effect.register();
        throw new Error("writer failed");
      })
    ).rejects.toThrow("writer failed");
    expect(await committed(a)).toBe(false);
    expect(effect.ran).toEqual([]);
  });

  it("SILENT COMMIT→ROLLBACK: a swallowed raw-statement failure is reported, not hidden", async () => {
    const a = slug();
    const effect = effectProbe(a);
    const error = await withTransaction(async () => {
      await insertTeam(a);
      await runSql("select 1/0").catch(() => undefined); // best-effort, swallowed
      await effect.register();
      return "reported as done";
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/COMMIT was resolved as ROLLBACK/);
    expect((error as TransactionExecutionError).unknownCommit).toBe(false);
    expect(await committed(a), "the write the caller was about to report is gone").toBe(false);
    expect(effect.ran).toEqual([]);
  });

  it("SILENT COMMIT→ROLLBACK: a swallowed query-builder ENVELOPE on the unbound client, the same", async () => {
    // The adapter returns `{ error }` instead of throwing, so ignoring it takes no `catch` at all —
    // which is how a best-effort write on the shared client ends up aborting an enclosing writer.
    const a = slug();
    const error = await withTransaction(async () => {
      await insertTeam(a);
      const { error: envelope } = await db().from("teams").insert({ slug: "Not A Valid Slug", name: "x" });
      expect(envelope, "the fixture must actually fail").not.toBeNull();
      return "reported as done";
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/COMMIT was resolved as ROLLBACK/);
    expect(await committed(a)).toBe(false);
  });

  it("the pool stays usable after a resolved rollback (the connection was left clean)", async () => {
    await withTransaction(async () => { await runSql("select 1/0").catch(() => undefined); }).catch(() => undefined);
    const a = slug();
    await withTransaction(() => insertTeam(a));
    expect(await committed(a)).toBe(true);
  });
});

describe("transaction truthfulness: sessions joined to the ambient scope (real Postgres)", () => {
  it("joined success: the session shares the scope's connection and commits with it", async () => {
    const a = slug();
    const b = slug();
    await withTransaction(async () => {
      await insertTeam(a);
      const inner = await pgClient().transaction(async (session) => {
        // Only the SAME connection can see the scope's uncommitted row.
        const seen = await session.executeSql("select 1 from teams where slug = $1", [a]);
        expect(seen.rowCount, "a joined session must read the enclosing transaction's writes").toBe(1);
        const { error } = await session.db.from("teams").insert({ slug: b, name: "Joined" });
        expect(error).toBeNull();
        return { ok: true as const };
      });
      expect(inner).toEqual({ ok: true });
      expect(await committed(b), "a released savepoint is not yet a commit").toBe(false);
    });
    expect(await committed(a)).toBe(true);
    expect(await committed(b)).toBe(true);
  });

  it("joined rollback: an unsanctioned ok:false undoes the session's work and nothing else", async () => {
    const a = slug();
    const b = slug();
    await withTransaction(async () => {
      await insertTeam(a);
      const inner = await pgClient().transaction(async (session) => {
        await session.db.from("teams").insert({ slug: b, name: "Joined" });
        return { ok: false as const, error: "domain refusal" };
      });
      expect(inner).toEqual({ ok: false, error: "domain refusal" });
    });
    expect(await committed(a), "the enclosing writer's row survives the session's rollback").toBe(true);
    expect(await committed(b)).toBe(false);
  });

  it("joined rollback: a SWALLOWED envelope failure is tracked, undone, and the scope carries on", async () => {
    const a = slug();
    const b = slug();
    const c = slug();
    let inner: unknown;
    await withTransaction(async () => {
      await insertTeam(a);
      inner = await pgClient().transaction(async (session) => {
        await session.db.from("teams").insert({ slug: b, name: "Joined" });
        await session.db.from("teams").insert({ slug: "Not A Valid Slug", name: "x" }); // envelope ignored
        return { ok: true as const };
      }).catch((caught) => caught);
      // Recovered by the savepoint rollback: the enclosing transaction is NOT aborted.
      await insertTeam(c);
    });
    expect(inner).toBeInstanceOf(TransactionExecutionError);
    expect(inner).toMatchObject({ code: "23514" });
    expect(await committed(a)).toBe(true);
    expect(await committed(b), "the session's earlier write went with its rollback").toBe(false);
    expect(await committed(c)).toBe(true);
  });

  it("OUTER ROLLBACK AFTER INNER SUCCESS: the session's write and effect are not reported", async () => {
    const a = slug();
    const b = slug();
    const effect = effectProbe(b);
    await expect(
      withTransaction(async () => {
        await insertTeam(a);
        const inner = await pgClient().transaction(async (session) => {
          await session.db.from("teams").insert({ slug: b, name: "Joined" });
          await effect.register();
          return { ok: true as const };
        });
        expect(inner).toEqual({ ok: true });
        throw new Error("enclosing writer failed afterwards");
      })
    ).rejects.toThrow("enclosing writer failed afterwards");
    expect(await committed(a)).toBe(false);
    expect(await committed(b)).toBe(false);
    expect(effect.ran).toEqual([]);
  });

  it("FAILED SAVEPOINT RECOVERY dooms the scope even when its caller swallows the session's error", async () => {
    // Deterministic way to make recovery fail on a healthy server: the session ends the transaction
    // underneath itself, so its `ROLLBACK TO SAVEPOINT` has no transaction block to act in.
    const a = slug();
    const effect = effectProbe(a);
    const error = await withTransaction(async () => {
      await insertTeam(a);
      await effect.register();
      await pgClient().transaction(async (session) => {
        await session.executeSql("ROLLBACK");
        throw new Error("session failed after losing its transaction");
      }).catch(() => undefined); // swallowed by the enclosing writer
      return "reported as done";
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(TransactionExecutionError);
    expect((error as Error).message).toMatch(/session failed after losing its transaction; rollback also failed/);
    expect(await committed(a)).toBe(false);
    expect(effect.ran).toEqual([]);
    // The doomed connection was destroyed, not returned: the pool still serves a clean transaction.
    const b = slug();
    await withTransaction(() => insertTeam(b));
    expect(await committed(b)).toBe(true);
  });

  it("with no ambient scope a session still owns its own BEGIN/COMMIT (the pre-existing behaviour)", async () => {
    const a = slug();
    const result = await pgClient().transaction(async (session) => {
      await session.db.from("teams").insert({ slug: a, name: "Standalone" });
      return { ok: true as const };
    });
    expect(result).toEqual({ ok: true });
    expect(await committed(a)).toBe(true);
  });
});
