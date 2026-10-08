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
 * Run a lock-ACQUISITION step on the ambient `withTransaction` connection with bounded waits.
 *
 * `lock_timeout` is set transaction-locally for exactly this step and then restored to whatever the
 * caller had, so ordinary writes later in the transaction keep their own budget
 * (`statement_timeout`) and a caller that already bounded its waits is not loosened. Scopes nest:
 * an inner scope reads the outer bound as its prior value and restores to it. On failure the
 * setting is NOT restored: a failed lock statement has aborted the transaction, the only thing left
 * to do is roll back, and the rollback discards the transaction-local value with everything else.
 *
 * Meaningful only inside a transaction. Outside one, `set_config(…, true)` ends with its own
 * statement and each call may land on a different pooled connection — but a transaction-scoped
 * lock taken there is released immediately too, so there is no wait worth bounding.
 *
 * Keep the step to the acquisitions themselves (and the reads that decide them). The Google Drive
 * commit path routes every outer wait through here: the identity authority, the connection
 * authority rows, the project rows, the provider and path identities, the item-attribution
 * advisories and the item rows (`lib/ingest/gdrive-commit-locks`, `lib/integrations/gdrive-authority`).
 */
export async function withBoundedLockWaits<T>(
  acquire: () => Promise<T>,
  timeout: string = LOCK_ACQUISITION_TIMEOUT
): Promise<T> {
  const prior = await runSql<{ lock_timeout: string }>("show lock_timeout");
  const priorValue = prior.rows[0]?.lock_timeout ?? "0";
  await runSql("select set_config('lock_timeout', $1, true)", [timeout]);
  const result = await acquire();
  await runSql("select set_config('lock_timeout', $1, true)", [priorValue]);
  return result;
}

/** `withBoundedLockWaits` for ONE lock-acquiring statement. */
export async function acquireWithLockTimeout<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
  timeout: string = LOCK_ACQUISITION_TIMEOUT
): Promise<SqlResult<T>> {
  return withBoundedLockWaits(() => runSql<T>(text, params), timeout);
}
