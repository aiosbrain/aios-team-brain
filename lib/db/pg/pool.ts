import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, types, type PoolClient, type PoolConfig } from "pg";
import type { SqlQueryResult } from "@/lib/db/types";

/**
 * Singleton pg Pool for DB_BACKEND=postgres. Reads DATABASE_URL (Railway/any
 * standard Postgres). SSL is enabled when the URL asks for it or PGSSL=require,
 * with relaxed verification for managed providers that use self-signed chains.
 */

// Override date/time type parsers to return strings instead of Date objects.
// By default node-postgres parses timestamptz/date/timestamp into JavaScript
// Date objects, but the application types them all as `string`. Setting
// string-returning parsers here is the single normalization point that closes
// the #134 gotcha — every consumer through runSql (and therefore PgQuery) gets
// the raw wire-format string, never a Date object.
//
// OID 1082 (date)       → YYYY-MM-DD
// OID 1114 (timestamp)  → YYYY-MM-DD HH:MM:SS.ssssss
// OID 1184 (timestamptz) → ISO-8601 with offset (e.g. ...+08:00 or ...Z)
types.setTypeParser(1082, (val: string) => val);
types.setTypeParser(1114, (val: string) => val);
types.setTypeParser(1184, (val: string) => val);

let pool: Pool | undefined;

/** One ambient `withTransaction` scope: its connection plus the state a joined session may set. */
interface AmbientTransaction {
  readonly client: PoolClient;
  /** Set when a joined session left the connection uncertain — the scope may then only roll back. */
  doomed: { cause: unknown } | null;
  /** Diagnostic effects that must observe the commit (cache invalidation), run after COMMIT. */
  readonly afterCommit: Array<() => Promise<void>>;
}
const transactionClient = new AsyncLocalStorage<AmbientTransaction>();

/** Parse an int from env, falling back to `fallback` when unset/blank/NaN. `0` is honored (disables). */
function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Build the pg Pool config from env, with **liveness timeouts** that a single wedged connection
 * would otherwise defeat (the 2026-07-13 outage): a pooled backend got stuck holding `tasks`
 * ACCESS SHARE with an implicit transaction open, and — with no server- or pool-side timeout — held
 * that lock indefinitely, so the next deploy's schema `ALTER` queued behind it and every query
 * queued behind the ALTER. These bound that class:
 *   • `idle_in_transaction_session_timeout` — Postgres kills a backend that opens a transaction and
 *     then goes idle (a leaked/zombie txn), releasing its locks. A HEALTHY `withTransaction` never
 *     idles (BEGIN→queries→COMMIT with no external awaits), so only a stuck one is reaped.
 *   • `statement_timeout` — caps any single runaway statement so it can't hold locks forever.
 *   • `connectionTimeoutMillis` — a checkout fails fast instead of hanging when the pool is
 *     exhausted, so a lock pile-up degrades to fast errors that recover, not a total hang.
 *   • `keepAlive` — TCP keepalive so a dead peer's socket is reaped instead of lingering.
 * All are env-overridable; `0` disables (Postgres/pg semantics). The schema loader sets its OWN
 * `lock_timeout` (scripts/pg-load-schema.mjs) so a migration can't be the one that wedges the queue.
 */
export function buildPoolConfig(env: NodeJS.ProcessEnv = process.env): PoolConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DB_BACKEND=postgres requires DATABASE_URL to be set (the Postgres connection string)."
    );
  }

  const wantsSsl =
    /\bsslmode=require\b/.test(connectionString) ||
    env.PGSSL === "require" ||
    env.PGSSLMODE === "require";

  return {
    connectionString,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    max: intFromEnv(env.PG_POOL_MAX, 10),
    idleTimeoutMillis: 30_000,
    // App queries are all short; a leaked/zombie transaction is the failure mode we cap.
    statement_timeout: intFromEnv(env.PG_STATEMENT_TIMEOUT_MS, 30_000),
    idle_in_transaction_session_timeout: intFromEnv(env.PG_IDLE_TX_TIMEOUT_MS, 60_000),
    connectionTimeoutMillis: intFromEnv(env.PG_CONNECT_TIMEOUT_MS, 10_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
}

export function getPool(): Pool {
  if (pool) return pool;

  pool = new Pool(buildPoolConfig());

  pool.on("error", (err) => {
    // A pooled idle client errored (e.g. server restart). Log; pg will recycle.
    console.error("[pg] idle client error:", err.message);
  });

  return pool;
}

export type SqlResult<T> = SqlQueryResult<T>;

export async function runSql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<SqlResult<T>> {
  const res = await (transactionClient.getStore()?.client ?? getPool()).query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}

/**
 * The connection of the enclosing `withTransaction`, if any. Read ONLY by the session transaction
 * engine (`lib/db/pg/tx`), which joins it behind a savepoint instead of checking out a second
 * connection: a second connection could neither see this transaction's uncommitted item nor take
 * the row lock it already holds, so an item/context writer called from here would deadlock on itself.
 */
export function ambientTransactionClient(): PoolClient | undefined {
  return transactionClient.getStore()?.client;
}

/** A joined session could not prove the connection healthy: the enclosing scope must not COMMIT. */
export function doomAmbientTransaction(cause: unknown): void {
  const ambient = transactionClient.getStore();
  if (ambient && !ambient.doomed) ambient.doomed = { cause };
}

/**
 * Run a diagnostic/nonfatal effect only once the surrounding write is durable: after the enclosing
 * `withTransaction` commits, or immediately when there is none. A fault never rejects the committed
 * result, and nothing runs when the transaction rolls back.
 */
export async function afterTransactionCommit(effect: () => Promise<void>): Promise<void> {
  const ambient = transactionClient.getStore();
  if (ambient) {
    ambient.afterCommit.push(effect);
    return;
  }
  try {
    await effect();
  } catch (error) {
    console.warn("[pg] post-commit effect failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * Run all `runSql`/`PgQuery` calls made by `fn` on one PostgreSQL transaction.
 *
 * The async-local binding is deliberately below the PostgREST-shaped adapter: existing single
 * writers can gain a real transaction without growing a second query API. Nested callers reuse the
 * outer transaction, which keeps route composition predictable and prevents accidental commits.
 */
export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactionClient.getStore()) return fn();
  const client = await getPool().connect();
  const ambient: AmbientTransaction = { client, doomed: null, afterCommit: [] };
  let result: T;
  // Set when COMMIT or ROLLBACK itself failed. This scope now carries the item/context writers the
  // session engine used to commit on its own connection, so it keeps that engine's disposal rule:
  // a connection whose transaction state is unknown is destroyed, never returned to the pool.
  let uncertain: { cause: unknown } | null = null;
  try {
    await client.query("BEGIN");
    result = await transactionClient.run(ambient, fn);
    if (ambient.doomed) throw ambient.doomed.cause;
    try {
      await client.query("COMMIT");
    } catch (error) {
      uncertain = { cause: error };
      throw error;
    }
  } catch (error) {
    if (!uncertain) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        uncertain = { cause: rollbackError };
      }
    }
    throw error;
  } finally {
    const broken = ambient.doomed ?? uncertain;
    client.release(
      broken ? (broken.cause instanceof Error ? broken.cause : new Error(String(broken.cause))) : undefined
    );
  }
  for (const effect of ambient.afterCommit) {
    try {
      await effect();
    } catch (error) {
      console.warn("[pg] post-commit effect failed:", error instanceof Error ? error.message : error);
    }
  }
  return result;
}
