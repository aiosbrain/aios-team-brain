import "server-only";
import { Pool, types } from "pg";

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
