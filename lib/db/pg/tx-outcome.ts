import "server-only";

/**
 * What a transaction boundary may truthfully report. Kept apart from `tx.ts` so `pool.ts` — which
 * `tx.ts` imports — can share the one error class and the one COMMIT classifier without a cycle.
 */

export class TransactionExecutionError extends Error {
  readonly code?: string;
  readonly sql?: string;
  readonly unknownCommit: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; code?: string; sql?: string; unknownCommit?: boolean } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "TransactionExecutionError";
    this.code = options.code;
    this.sql = options.sql;
    this.unknownCommit = options.unknownCommit ?? false;
  }
}

export type CommitOutcome = "committed" | "rolled-back" | "unconfirmed";

/**
 * Classify the server's reply to COMMIT by its COMMAND TAG.
 *
 * PostgreSQL does not raise an error when COMMIT is sent in a transaction that has already failed:
 * it ends the transaction and answers with the tag `ROLLBACK`. To a caller that only awaits the
 * call, that is indistinguishable from a commit — every write is gone and the function returns
 * normally. Only `COMMIT` is a commit. A reply with no tag, or any other tag, proves nothing and is
 * treated as unconfirmed rather than given the benefit of the doubt.
 */
export function commitOutcome(reply: unknown): CommitOutcome {
  const tag = (reply as { command?: unknown } | null | undefined)?.command;
  if (typeof tag !== "string") return "unconfirmed";
  const upper = tag.toUpperCase();
  if (upper === "COMMIT") return "committed";
  return upper === "ROLLBACK" ? "rolled-back" : "unconfirmed";
}

/**
 * `null` when the reply confirms a commit; otherwise the error the boundary must throw.
 *
 *   · rolled-back  — a KNOWN outcome: nothing is durable and the server has already ended the
 *                    transaction, so the connection is clean. `unknownCommit` stays false.
 *   · unconfirmed  — the outcome cannot be established. `unknownCommit` is true, exactly as for a
 *                    COMMIT whose call failed: never replayed, and the connection is not reused.
 */
export function commitRefusal(reply: unknown): TransactionExecutionError | null {
  const outcome = commitOutcome(reply);
  if (outcome === "committed") return null;
  if (outcome === "rolled-back") {
    return new TransactionExecutionError(
      "COMMIT was resolved as ROLLBACK: a statement in this transaction had already failed, so nothing was committed"
    );
  }
  const tag = (reply as { command?: unknown } | null | undefined)?.command;
  return new TransactionExecutionError(
    `COMMIT was not confirmed (command tag ${typeof tag === "string" ? JSON.stringify(tag) : "missing"}); ` +
      "outcome unknown and will not be replayed",
    { unknownCommit: true }
  );
}
