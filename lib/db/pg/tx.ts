import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "./pool";
import type { DbClient, SqlExecutor, TransactionSession } from "@/lib/db/types";

type SqlStateError = Error & { code?: string };

interface RecordedFailure {
  readonly cause: unknown;
  readonly message: string;
  readonly code?: string;
  readonly sql?: string;
}

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

class FailureTracker {
  private failures: RecordedFailure[] = [];

  record(cause: unknown, sql?: string): void {
    const error = cause as Partial<SqlStateError> | null;
    this.failures.push({
      cause,
      message: error?.message ?? String(cause),
      code: typeof error?.code === "string" ? error.code : undefined,
      sql,
    });
  }

  get length(): number {
    return this.failures.length;
  }

  truncate(length: number): void {
    this.failures.length = length;
  }

  lastSince(index = 0): RecordedFailure | undefined {
    return this.failures.length > index ? this.failures[this.failures.length - 1] : undefined;
  }
}

/** Results in this weak set are the one intentional `ok:false` commit class: a human veto. */
const deliberateCommitResults = new WeakSet<object>();

export function commitPolicyRefusal<T extends object>(result: T): T {
  deliberateCommitResults.add(result);
  return result;
}

function returnedFailure(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { ok?: unknown }).ok === false);
}

interface LiveSession extends TransactionSession {
  readonly tracker: FailureTracker;
  readonly control: SqlExecutor;
  active: boolean;
  fatalControlFailure: unknown | null;
}

const transactionSessions = new WeakMap<
  DbClient,
  TransactionSession & { readonly active?: boolean }
>();

/** The only ambient lookup: exact-object metadata installed by the transaction factory. */
export function transactionSessionFor(db: DbClient): TransactionSession | null {
  const session = transactionSessions.get(db);
  return session && session.active !== false ? session : null;
}

/** Used only by an explicit delegating wrapper/fake factory to preserve exact-session metadata. */
export function bindTransactionSessionAlias(db: DbClient, session: TransactionSession): void {
  transactionSessions.set(db, session);
}

let savepointSerial = 0;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sqlStateOf(error: unknown): string | undefined {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

const NODE_CONNECTION_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_STREAM_DESTROYED",
]);

function isConnectionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = sqlStateOf(error);
  if (code?.startsWith("08") || (code && NODE_CONNECTION_CODES.has(code))) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause !== undefined && cause !== error ? isConnectionFailure(cause) : false;
}

function executionError(failure: RecordedFailure, prefix = "transaction SQL failed"): TransactionExecutionError {
  return new TransactionExecutionError(`${prefix}: ${failure.message}`, {
    cause: failure.cause,
    code: failure.code,
    sql: failure.sql,
  });
}

function withControlFailure(
  primary: unknown,
  controlFailure: unknown
): TransactionExecutionError {
  if (controlFailure === primary && primary instanceof TransactionExecutionError) return primary;
  const primaryError = primary instanceof Error ? primary : new Error(messageOf(primary));
  const control = controlFailure instanceof Error
    ? controlFailure
    : new Error(messageOf(controlFailure));
  return new TransactionExecutionError(
    `${primaryError.message}; transaction control also failed: ${control.message}`,
    {
      cause: new AggregateError([primaryError, control], "transaction primary and control failures"),
      code: sqlStateOf(primary),
      sql: primary instanceof TransactionExecutionError ? primary.sql : undefined,
      unknownCommit: primary instanceof TransactionExecutionError && primary.unknownCommit,
    }
  );
}

async function rollback(
  client: PoolClient,
  primary: unknown
): Promise<{ ok: true } | { ok: false; error: TransactionExecutionError }> {
  try {
    await client.query("ROLLBACK");
    return { ok: true };
  } catch (cleanup) {
    return {
      ok: false,
      error: new TransactionExecutionError(
        `${messageOf(primary)}; rollback also failed: ${messageOf(cleanup)}`,
        {
          cause: primary,
          code: sqlStateOf(primary),
          sql: primary instanceof TransactionExecutionError ? primary.sql : undefined,
          unknownCommit: primary instanceof TransactionExecutionError && primary.unknownCommit,
        }
      ),
    };
  }
}

function normalRelease(client: PoolClient): void {
  client.release();
}

function destroyRelease(client: PoolClient, cause: unknown): void {
  client.release(cause instanceof Error ? cause : new Error(messageOf(cause)));
}

export interface PgTransactionFactory {
  /** Explicit test seam; production omits it and uses the singleton pool checkout. */
  connect?: () => Promise<PoolClient>;
  decorateExecutor?: (executor: SqlExecutor) => SqlExecutor;
  makeBoundClient(
    executor: SqlExecutor,
    reportFailure: (error: unknown, sql?: string) => void
  ): DbClient;
}

/**
 * Transaction engine for PgClient. Query-builder errors are normally returned in envelopes, so
 * the tracker is checked independently of the callback's return/throw path before COMMIT.
 */
export async function runPgClientTransaction<T>(
  factory: PgTransactionFactory,
  fn: (session: TransactionSession) => Promise<T>
): Promise<T> {
  const client = factory.connect ? await factory.connect() : await getPool().connect();
  let begun = false;
  let released = false;
  const tracker = new FailureTracker();

  const control: SqlExecutor = async <R>(text: string, params: unknown[] = []) => {
    const result = await client.query(text, params);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  };

  const live: { session?: LiveSession } = {};
  const connectionExecutor: SqlExecutor = async <R>(text: string, params: unknown[] = []) => {
    const session = live.session;
    if (!session) throw new Error("transaction-session-not-initialized");
    if (!session.active) {
      const escaped = new Error("transaction-session-completed");
      tracker.record(escaped, text);
      throw escaped;
    }
    try {
      return await control<R>(text, params);
    } catch (error) {
      tracker.record(error, text);
      throw error;
    }
  };
  try {
    const decoratedExecutor = factory.decorateExecutor
      ? factory.decorateExecutor(connectionExecutor)
      : connectionExecutor;
    const executeSql: SqlExecutor = async <R>(text: string, params: unknown[] = []) => {
      try {
        return await decoratedExecutor<R>(text, params);
      } catch (error) {
        // Also captures a decorator-originated throw that never reached the connection executor.
        tracker.record(error, text);
        throw error;
      }
    };
    const db = factory.makeBoundClient(executeSql, (error, sql) => tracker.record(error, sql));

    const session: LiveSession = {
      db,
      executeSql,
      tracker,
      control,
      active: true,
      fatalControlFailure: null,
      async optionalAudit<R>(operation: () => Promise<R>, fallback: R): Promise<R> {
        if (!session.active) throw new Error("transaction-session-completed");
        const name = `auditfix13_optional_${++savepointSerial}`;
        try {
          await control(`SAVEPOINT ${name}`);
        } catch (error) {
          const fatal = new TransactionExecutionError(`optional audit SAVEPOINT failed: ${messageOf(error)}`, {
            cause: error,
            code: sqlStateOf(error),
          });
          session.fatalControlFailure = fatal;
          throw fatal;
        }

        const checkpoint = tracker.length;
        try {
          const value = await operation();
          const failure = tracker.lastSince(checkpoint);
          if (failure) throw executionError(failure, "optional audit statement failed");
          try {
            await control(`RELEASE SAVEPOINT ${name}`);
          } catch (error) {
            const fatal = new TransactionExecutionError(
              `optional audit RELEASE SAVEPOINT failed: ${messageOf(error)}`,
              { cause: error, code: sqlStateOf(error) }
            );
            session.fatalControlFailure = fatal;
            throw fatal;
          }
          return value;
        } catch (statementError) {
          if (session.fatalControlFailure) throw statementError;
          const scopedFailure = tracker.lastSince(checkpoint);
          const connectionLost =
            isConnectionFailure(statementError) || isConnectionFailure(scopedFailure?.cause);
          try {
            await control(`ROLLBACK TO SAVEPOINT ${name}`);
            await control(`RELEASE SAVEPOINT ${name}`);
          } catch (recoveryError) {
            const fatal = new TransactionExecutionError(
              `optional audit recovery failed after ${messageOf(statementError)}: ${messageOf(recoveryError)}`,
              { cause: statementError, code: sqlStateOf(recoveryError) }
            );
            session.fatalControlFailure = fatal;
            throw fatal;
          }
          if (connectionLost) {
            const fatal = new TransactionExecutionError(
              `optional audit connection failure is not recoverable: ${messageOf(statementError)}`,
              {
                cause: scopedFailure?.cause ?? statementError,
                code: scopedFailure?.code ?? sqlStateOf(statementError),
              }
            );
            session.fatalControlFailure = fatal;
            throw fatal;
          }
          // Recovery is proven healthy. Clear only errors introduced after this savepoint.
          tracker.truncate(checkpoint);
          return fallback;
        }
      },
    };
    live.session = session;
    transactionSessions.set(db, session);

    try {
      await control("BEGIN");
      begun = true;
    } catch (error) {
      session.active = false;
      destroyRelease(client, error);
      released = true;
      throw new TransactionExecutionError(`BEGIN failed: ${messageOf(error)}`, {
        cause: error,
        code: sqlStateOf(error),
      });
    }

    let result: T;
    try {
      result = await fn(session);
    } catch (callbackError) {
      const failure = tracker.lastSince();
      const primary = failure ? executionError(failure) : callbackError;
      const rb = await rollback(client, primary);
      session.active = false;
      if (!rb.ok || session.fatalControlFailure || isConnectionFailure(primary)) {
        const rollbackPrimary = !rb.ok ? rb.error : primary;
        const fatal = session.fatalControlFailure
          ? withControlFailure(rollbackPrimary, session.fatalControlFailure)
          : rollbackPrimary;
        destroyRelease(client, fatal);
        released = true;
        throw fatal;
      }
      normalRelease(client);
      released = true;
      throw primary;
    }

    const failure = tracker.lastSince();
    if (failure || session.fatalControlFailure) {
      const primary = failure
        ? executionError(failure)
        : new TransactionExecutionError(
            `transaction session control failed: ${messageOf(session.fatalControlFailure)}`,
            { cause: session.fatalControlFailure, code: sqlStateOf(session.fatalControlFailure) }
          );
      const rb = await rollback(client, primary);
      session.active = false;
      if (!rb.ok || session.fatalControlFailure || isConnectionFailure(primary)) {
        const rollbackPrimary = !rb.ok ? rb.error : primary;
        const fatal = failure && session.fatalControlFailure
          ? withControlFailure(rollbackPrimary, session.fatalControlFailure)
          : rollbackPrimary;
        destroyRelease(client, fatal);
        released = true;
        throw fatal;
      }
      normalRelease(client);
      released = true;
      throw primary;
    }

    if (returnedFailure(result) && !deliberateCommitResults.has(result as object)) {
      const rb = await rollback(client, "transaction callback returned ok:false");
      session.active = false;
      if (!rb.ok) {
        destroyRelease(client, rb.error);
        released = true;
        throw rb.error;
      }
      normalRelease(client);
      released = true;
      return result;
    }

    try {
      await control("COMMIT");
    } catch (error) {
      session.active = false;
      const unknown = new TransactionExecutionError(
        `COMMIT failed; outcome unknown and will not be replayed: ${messageOf(error)}`,
        { cause: error, code: sqlStateOf(error), unknownCommit: true }
      );
      destroyRelease(client, unknown);
      released = true;
      throw unknown;
    }
    session.active = false;
    normalRelease(client);
    released = true;
    return result;
  } finally {
    if (live.session) live.session.active = false;
    if (!released) {
      destroyRelease(
        client,
        new Error(begun ? "transaction ended with uncertain state" : "transaction setup did not complete")
      );
    }
  }
}

/**
 * Legacy raw-PoolClient transaction helper. Its callback/return semantics are unchanged; only
 * connection disposal is hardened so an uncertain session is never returned to the pool.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  let begun = false;
  let released = false;
  try {
    try {
      await client.query("BEGIN");
      begun = true;
    } catch (error) {
      destroyRelease(client, error);
      released = true;
      throw error;
    }
    try {
      const result = await fn(client);
      try {
        await client.query("COMMIT");
      } catch (error) {
        destroyRelease(client, error);
        released = true;
        throw error;
      }
      normalRelease(client);
      released = true;
      return result;
    } catch (error) {
      if (released) throw error;
      const rb = await rollback(client, error);
      if (!rb.ok) {
        destroyRelease(client, rb.error);
        released = true;
        throw rb.error;
      }
      if (isConnectionFailure(error)) {
        destroyRelease(client, error);
        released = true;
        throw error;
      }
      normalRelease(client);
      released = true;
      throw error;
    }
  } finally {
    if (begun && !released) destroyRelease(client, new Error("transaction ended with uncertain state"));
  }
}
