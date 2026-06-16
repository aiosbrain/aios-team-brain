import "server-only";
import { Pool } from "pg";

/**
 * Singleton pg Pool for DB_BACKEND=postgres. Reads DATABASE_URL (Railway/any
 * standard Postgres). SSL is enabled when the URL asks for it or PGSSL=require,
 * with relaxed verification for managed providers that use self-signed chains.
 */

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DB_BACKEND=postgres requires DATABASE_URL to be set (the Postgres connection string)."
    );
  }

  const wantsSsl =
    /\bsslmode=require\b/.test(connectionString) ||
    process.env.PGSSL === "require" ||
    process.env.PGSSLMODE === "require";

  pool = new Pool({
    connectionString,
    ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });

  pool.on("error", (err) => {
    // A pooled idle client errored (e.g. server restart). Log; pg will recycle.
    console.error("[pg] idle client error:", err.message);
  });

  return pool;
}

export interface SqlResult<T> {
  rows: T[];
  rowCount: number;
}

export async function runSql<T = Record<string, unknown>>(
  text: string,
  params: unknown[]
): Promise<SqlResult<T>> {
  const res = await getPool().query(text, params);
  return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
}
