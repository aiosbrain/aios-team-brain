import "server-only";
import { runSql, type SqlResult } from "./pool";

/**
 * The wait bound for acquiring an OUTER serialization lock on the ambient transaction — the same
 * value the session engine gives item and ingest-identity acquisition
 * (`lib/projects/context/transaction`). Past it PostgreSQL raises 55P03 (lock_not_available),
 * which callers already classify as a non-retryable lock timeout.
 */
export const LOCK_ACQUISITION_TIMEOUT = "10s";

/**
 * Run ONE lock-acquiring statement on the ambient `withTransaction` connection with a bounded wait.
 *
 * `lock_timeout` is set transaction-locally for exactly this statement and then restored to
 * whatever the caller had, so ordinary writes later in the transaction keep their own budget
 * (`statement_timeout`) and a caller that already bounded its waits is not loosened. On failure the
 * setting is NOT restored: a failed lock statement has aborted the transaction, the only thing left
 * to do is roll back, and the rollback discards the transaction-local value with everything else.
 *
 * Meaningful only inside a transaction. Outside one, `set_config(…, true)` ends with its own
 * statement and each call may land on a different pooled connection — but a transaction-scoped
 * lock taken there is released immediately too, so there is no wait worth bounding.
 *
 * NOT YET CALLED (AIO-1167 remediation, blocker 4). The outer locks it is for — the identity
 * authority, Drive provider, item-attribution and ingest-path advisory locks, and the connection
 * authority row lock — are acquired from `lib/ingest/index.ts` and its callees, and the composed
 * order across them is being settled with the owner of that file. This is the bounded acquisition
 * that patch will route them through.
 */
export async function acquireWithLockTimeout<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  timeout: string = LOCK_ACQUISITION_TIMEOUT
): Promise<SqlResult<T>> {
  const prior = await runSql<{ lock_timeout: string }>("show lock_timeout");
  const priorValue = prior.rows[0]?.lock_timeout ?? "0";
  await runSql("select set_config('lock_timeout', $1, true)", [timeout]);
  const result = await runSql<T>(text, params);
  await runSql("select set_config('lock_timeout', $1, true)", [priorValue]);
  return result;
}
