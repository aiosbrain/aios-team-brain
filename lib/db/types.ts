/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * The data-client type used across the Team Brain. At runtime this is always the
 * Postgres adapter (`lib/db/pg/client`, `pgClient()`); this interface describes the
 * PostgREST-shaped surface the app calls (`.from(...).select()…`, `.rpc(...)`).
 *
 * Query rows are typed permissively (`any[]` for list reads, `any` for `.single()` /
 * `.maybeSingle()`), mirroring the previous schema-less client so the ~60 data-layer
 * call sites compile unchanged. Access control is enforced in app code (there is no
 * RLS) — see docs/ARCHITECTURE.md.
 */

/** The `{ data, error, count }` envelope every query resolves to (never rejects). */
export interface DbResult<T> {
  data: T;
  error: { message: string } | null;
  count: number | null;
}

/**
 * A PostgREST-shaped query builder: filter/shape methods chain and return the same
 * builder; awaiting it yields a list result. `.single()` / `.maybeSingle()` narrow to
 * a single-row result.
 */
export interface PgBuilder extends PromiseLike<DbResult<any[] | null>> {
  select(spec?: string, opts?: { count?: "exact"; head?: boolean }): PgBuilder;
  insert(values: unknown): PgBuilder;
  update(values: unknown): PgBuilder;
  upsert(values: unknown, opts?: { onConflict?: string }): PgBuilder;
  delete(): PgBuilder;
  eq(col: string, val: unknown): PgBuilder;
  neq(col: string, val: unknown): PgBuilder;
  gt(col: string, val: unknown): PgBuilder;
  gte(col: string, val: unknown): PgBuilder;
  lt(col: string, val: unknown): PgBuilder;
  lte(col: string, val: unknown): PgBuilder;
  in(col: string, val: unknown[]): PgBuilder;
  is(col: string, val: null): PgBuilder;
  like(col: string, val: string): PgBuilder;
  not(col: string, op: string, val: unknown): PgBuilder;
  textSearch(col: string, query: string, opts?: { type?: string; config?: string }): PgBuilder;
  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): PgBuilder;
  limit(n: number): PgBuilder;
  range(from: number, to: number): PgBuilder;
  single(): PromiseLike<DbResult<any>>;
  maybeSingle(): PromiseLike<DbResult<any>>;
}

export interface DbClient {
  from(table: string): PgBuilder;
  rpc(
    fn: string,
    args?: Record<string, unknown>
  ): Promise<{ data: any; error: { message: string } | null }>;
}

/** Result shape shared by the pool and a connection-bound SQL executor. */
export interface SqlQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/**
 * The narrow execution capability used by transaction-bound adapters.  It is structural on
 * purpose: tests and instrumented wrappers may decorate it without reconstructing PgClient or
 * reaching for the process-wide pool.
 */
export type SqlExecutor = <T = Record<string, unknown>>(
  text: string,
  params?: unknown[]
) => Promise<SqlQueryResult<T>>;

export interface TransactionSession {
  /** A PostgREST-shaped client whose every statement uses this session's one connection. */
  readonly db: DbClient;
  /** Raw SQL on the same connection (used only by owners whose query is not builder-expressible). */
  readonly executeSql: SqlExecutor;
  /**
   * Run exactly one best-effort audit statement/read behind a savepoint.  A successfully recovered
   * statement failure returns `fallback`; broken savepoint/session control remains fatal.
   */
  optionalAudit<T>(operation: () => Promise<T>, fallback: T): Promise<T>;
}

/** Explicit capability required by item/context operations. Plain DbClient wrappers fail closed. */
export interface TransactionCapableDbClient extends DbClient {
  transaction<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T>;
}

export function isTransactionCapableDbClient(
  db: DbClient
): db is TransactionCapableDbClient {
  return typeof (db as Partial<TransactionCapableDbClient>).transaction === "function";
}
