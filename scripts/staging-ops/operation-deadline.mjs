export const OPERATION_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const RECOVERY_TIMEOUT_DEFAULT_MS = 10 * 60_000;
export const CLEANUP_TIMEOUT_DEFAULT_MS = 2 * 60_000;

export function finiteDeadlineMs(name, value, defaultValue, { min = 1_000, max = 60 * 60_000 } = {}) {
  const parsed = value === undefined || value === null || value === "" ? defaultValue : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} milliseconds`);
  }
  return parsed;
}

/** Validate every budget together before a runner opens a database or mutates lifecycle state. */
export function stagingOperationDeadlines(env = process.env) {
  const operationMs = finiteDeadlineMs("STAGING_OPERATION_TIMEOUT_MS", env.STAGING_OPERATION_TIMEOUT_MS, OPERATION_TIMEOUT_DEFAULT_MS);
  return Object.freeze({
    operationMs,
    captureMs: finiteDeadlineMs("STAGING_CAPTURE_TIMEOUT_MS", env.STAGING_CAPTURE_TIMEOUT_MS, operationMs),
    recoveryMs: finiteDeadlineMs("STAGING_RECOVERY_TIMEOUT_MS", env.STAGING_RECOVERY_TIMEOUT_MS, RECOVERY_TIMEOUT_DEFAULT_MS),
    cleanupMs: finiteDeadlineMs("STAGING_CLEANUP_TIMEOUT_MS", env.STAGING_CLEANUP_TIMEOUT_MS, CLEANUP_TIMEOUT_DEFAULT_MS),
    connectionMs: finiteDeadlineMs("STAGING_DB_CONNECT_TIMEOUT_MS", env.STAGING_DB_CONNECT_TIMEOUT_MS, Math.min(10_000, operationMs)),
    terminateGraceMs: finiteDeadlineMs("STAGING_TERMINATE_GRACE_MS", env.STAGING_TERMINATE_GRACE_MS, 2_000, { min: 100, max: 30_000 }),
  });
}

export function postgresDeadlineConfig(connectionString, timeoutMs, connectionTimeoutMillis = Math.min(10_000, timeoutMs)) {
  const bounded = finiteDeadlineMs("Postgres operation timeout", timeoutMs, OPERATION_TIMEOUT_DEFAULT_MS);
  const connection = finiteDeadlineMs("Postgres connection timeout", connectionTimeoutMillis, Math.min(10_000, bounded));
  return {
    connectionString,
    connectionTimeoutMillis: connection,
    // Server-side cancellation is load-bearing. `query_timeout` merely rejects a client promise
    // while PostgreSQL can continue working on the same session underneath recovery.
    statement_timeout: bounded,
    lock_timeout: Math.min(bounded, 60_000),
    idle_in_transaction_session_timeout: bounded,
  };
}

/** Rebudget the SAME session for recovery without reconnecting and losing its advisory locks. */
export async function configurePostgresDeadline(client, timeoutMs) {
  const bounded = finiteDeadlineMs("Postgres operation timeout", timeoutMs, OPERATION_TIMEOUT_DEFAULT_MS);
  await client.query("SELECT set_config('statement_timeout',$1,false), set_config('lock_timeout',$2,false), set_config('idle_in_transaction_session_timeout',$1,false)", [
    `${bounded}ms`, `${Math.min(bounded, 60_000)}ms`,
  ]);
  return bounded;
}

export function neo4jTransactionConfig(timeoutMs) {
  return { timeout: finiteDeadlineMs("Neo4j operation timeout", timeoutMs, OPERATION_TIMEOUT_DEFAULT_MS) };
}

