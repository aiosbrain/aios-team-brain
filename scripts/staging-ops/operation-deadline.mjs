export const OPERATION_TIMEOUT_DEFAULT_MS = 15 * 60_000;
export const RECOVERY_TIMEOUT_DEFAULT_MS = 10 * 60_000;
export const CLEANUP_TIMEOUT_DEFAULT_MS = 2 * 60_000;

export class StagingDeadlineExceededError extends Error {
  constructor(label) {
    super(`${label} exhausted its total time budget`);
    this.name = "StagingDeadlineExceededError";
    this.code = "STAGING_OPERATION_TIMEOUT";
  }
}

/**
 * One non-renewing, monotonic allowance shared by every child operation in a phase.
 * A child can narrow its parent's deadline, never extend it.
 */
export function createOperationBudget(label, durationMs, { parent = null, now = () => performance.now() } = {}) {
  const bounded = finiteDeadlineMs(`${label} budget`, durationMs, OPERATION_TIMEOUT_DEFAULT_MS, { min: 1, max: 60 * 60_000 });
  const startedAt = now();
  const expiresAt = Math.min(startedAt + bounded, parent?.expiresAt ?? Number.POSITIVE_INFINITY);
  const budget = {
    label, startedAt, expiresAt,
    remaining(capMs = Number.POSITIVE_INFINITY, operation = label) {
      const remaining = Math.floor(expiresAt - now());
      if (!Number.isFinite(remaining) || remaining < 1) throw new StagingDeadlineExceededError(operation);
      const cap = Number.isFinite(capMs) ? Math.max(1, Math.floor(capMs)) : remaining;
      return Math.min(remaining, cap);
    },
    assert(operation = label) { budget.remaining(Number.POSITIVE_INFINITY, operation); return budget; },
    child(childLabel, childDurationMs) { return createOperationBudget(childLabel, childDurationMs, { parent: budget, now }); },
  };
  return Object.freeze(budget);
}

export function remainingBudgetMs(budget, capMs, operation) {
  return budget ? budget.remaining(capMs, operation) : capMs;
}

/** Actively cancel owned transports at the absolute boundary; disarm waits for cancellation. */
export function armBudgetWatchdog(budget, terminate) {
  let expired = false;
  let termination = Promise.resolve();
  const timeoutMs = budget.remaining(Number.POSITIVE_INFINITY, `${budget.label} watchdog`);
  const timer = setTimeout(() => {
    expired = true;
    const error = new StagingDeadlineExceededError(budget.label);
    termination = Promise.resolve().then(() => terminate(error));
    termination.catch(() => {});
  }, timeoutMs);
  timer.unref?.();
  return Object.freeze({
    get expired() { return expired; },
    async disarm() { clearTimeout(timer); await termination; },
  });
}

/**
 * One owner for every watchdog protecting a lock-owning database session.
 *
 * Expiry aborts the work fenced by the session; it never destroys the session itself. The caller
 * must await that work's containment before ordinary cleanup can release the locks. Recovery then
 * transfers ownership atomically: every enclosing action/tick timer is retired before a fresh
 * recovery timer and signal are installed on the SAME healthy session.
 */
export function createSessionWatchdogOwner(cancel = () => {}, { signal = null } = {}) {
  const active = new Set();
  const wrap = (budget) => {
    const controller = new AbortController();
    let reason = null;
    const watchdog = armBudgetWatchdog(budget, async (error) => {
      reason = error;
      controller.abort(error);
      await cancel(error);
    });
    const ownedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let disarmed = false;
    const handle = Object.freeze({
      get expired() { return watchdog.expired; },
      get reason() { return reason; },
      signal: ownedSignal,
      async disarm() {
        if (disarmed) return;
        disarmed = true;
        active.delete(handle);
        await watchdog.disarm();
      },
    });
    active.add(handle);
    return handle;
  };
  const disarmAll = async () => {
    const handles = [...active];
    await Promise.all(handles.map((handle) => handle.disarm()));
    return handles;
  };
  return Object.freeze({
    arm(budget) { return wrap(budget); },
    async transferTo(budget) {
      await disarmAll();
      return wrap(budget);
    },
    disarmAll,
    get size() { return active.size; },
  });
}

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
  // User-configured budgets were already validated at >=1000 ms. Derived REMAINING time can
  // legitimately be 999 ms (or less) after preflight; refusing that remainder bypasses the
  // watchdog/recovery path instead of enforcing the actual absolute deadline.
  const bounded = finiteDeadlineMs("Postgres operation timeout", timeoutMs, OPERATION_TIMEOUT_DEFAULT_MS, { min: 1 });
  const connection = finiteDeadlineMs("Postgres connection timeout", connectionTimeoutMillis, Math.min(10_000, bounded), { min: 1 });
  return {
    connectionString,
    connectionTimeoutMillis: connection,
    // Server-side cancellation is load-bearing. `query_timeout` merely rejects a client promise
    // while PostgreSQL can continue working on the same session underneath recovery.
    statement_timeout: bounded,
    lock_timeout: Math.min(bounded, 60_000),
    // An exported snapshot is intentionally idle while pg_dump/psql run. Expiring that idle
    // transaction at the operation boundary drops session advisory locks before TERM/KILL and
    // group-absence confirmation finish. The operation watchdog and subprocess budgets bound that
    // wait; active SQL remains subject to the real server-side statement/lock timeouts above.
    idle_in_transaction_session_timeout: 0,
  };
}

/** Rebudget the SAME session for recovery without reconnecting and losing its advisory locks. */
export async function configurePostgresDeadline(client, timeoutMs) {
  const bounded = finiteDeadlineMs("Postgres operation timeout", timeoutMs, OPERATION_TIMEOUT_DEFAULT_MS, { min: 1 });
  await client.query("SELECT set_config('statement_timeout',$1,false), set_config('lock_timeout',$2,false), set_config('idle_in_transaction_session_timeout','0',false)", [
    `${bounded}ms`, `${Math.min(bounded, 60_000)}ms`,
  ]);
  return bounded;
}

export function neo4jTransactionConfig(timeoutMs) {
  return { timeout: finiteDeadlineMs("Neo4j operation timeout", timeoutMs, OPERATION_TIMEOUT_DEFAULT_MS) };
}
