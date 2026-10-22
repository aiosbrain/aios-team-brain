import { describe, expect, it } from "vitest";
import type {
  TransactionCapableDbClient,
  TransactionSession,
} from "@/lib/db/types";
import { TransactionExecutionError } from "@/lib/db/pg/tx";
import { runContextTransaction } from "@/lib/projects/context/transaction";

function transactionFixture(firstFailure: unknown): {
  db: TransactionCapableDbClient;
  attempts: () => number;
} {
  let attempts = 0;
  const session = {} as TransactionSession;
  const db = {
    from() {
      throw new Error("unused builder");
    },
    async rpc() {
      throw new Error("unused rpc");
    },
    async transaction<T>(operation: (bound: TransactionSession) => Promise<T>): Promise<T> {
      attempts += 1;
      if (attempts === 1) throw firstFailure;
      return operation(session);
    },
  } satisfies TransactionCapableDbClient;
  return { db, attempts: () => attempts };
}

function uniqueViolation(sql: string, unknownCommit = false): TransactionExecutionError {
  return new TransactionExecutionError("duplicate key", {
    code: "23505",
    sql,
    unknownCommit,
  });
}

describe("context transaction retry classification", () => {
  it.each([
    "INSERT INTO items (team_id) VALUES ($1)",
    "  insert into project_context_memberships (unit_id) values ($1)",
  ])("A13-06: retries one supported INSERT target once: %s", async (sql) => {
    const fixture = transactionFixture(uniqueViolation(sql));

    await expect(runContextTransaction(fixture.db, async (_session, attempt) => attempt)).resolves.toBe(2);
    expect(fixture.attempts()).toBe(2);
  });

  it.each([
    "INSERT INTO archived_items (team_id) VALUES ($1)",
    "SELECT 'items'",
  ])("A13-06: does not retry a 23505 mentioning items outside the supported target: %s", async (sql) => {
    const failure = uniqueViolation(sql);
    const fixture = transactionFixture(failure);

    await expect(runContextTransaction(fixture.db, async () => "unexpected")).rejects.toBe(failure);
    expect(fixture.attempts()).toBe(1);
  });

  it("A13-06: does not retry an ordinary nonretryable SQL failure", async () => {
    const failure = new TransactionExecutionError("ordinary failure", {
      code: "22012",
      sql: "SELECT 1 / 0",
    });
    const fixture = transactionFixture(failure);

    await expect(runContextTransaction(fixture.db, async () => "unexpected")).rejects.toBe(failure);
    expect(fixture.attempts()).toBe(1);
  });

  it("A13-06: does not retry an unknown COMMIT outcome", async () => {
    const failure = new TransactionExecutionError("outcome unknown", {
      code: "40001",
      unknownCommit: true,
    });
    const fixture = transactionFixture(failure);

    await expect(runContextTransaction(fixture.db, async () => "unexpected")).rejects.toBe(failure);
    expect(fixture.attempts()).toBe(1);
  });
});
