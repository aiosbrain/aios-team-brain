import "server-only";
import {
  PgQuery,
  type PgEnvelopeInterceptor,
} from "./query-builder";
import { runSql } from "./pool";
import { runPgClientTransaction } from "./tx";
import type {
  DbClient,
  SqlExecutor,
  TransactionCapableDbClient,
  TransactionSession,
} from "@/lib/db/types";

export interface PgClientOptions {
  /** Defaults to the process pool. A bound transaction supplies its PoolClient executor here. */
  executor?: SqlExecutor;
  /** Receives executor/envelope failures even when the public adapter returns `{error}`. */
  reportFailure?: (error: unknown, sql?: string) => void;
  /** Per-client instrumentation seam used by real-PG fault/barrier tests. */
  envelopeInterceptor?: PgEnvelopeInterceptor;
  /** Decorate each newly bound session executor without global mutable hooks. */
  decorateSessionExecutor?: (executor: SqlExecutor) => SqlExecutor;
  /** Factory-owned marker: a bound client cannot recursively begin or escape a transaction. */
  bound?: boolean;
}

/**
 * The data client backed by `pg`. A normal instance uses the pool; a transaction-bound instance is
 * constructed only by `transaction()` and sends builder, count/head, RETURNING and RPC statements
 * through the same dedicated connection executor.
 */
export class PgClient implements TransactionCapableDbClient {
  private readonly executor: SqlExecutor;
  private readonly reportFailure?: (error: unknown, sql?: string) => void;
  private readonly envelopeInterceptor?: PgEnvelopeInterceptor;
  private readonly decorateSessionExecutor?: (executor: SqlExecutor) => SqlExecutor;
  private readonly bound: boolean;

  constructor(options: PgClientOptions = {}) {
    this.executor = options.executor ?? runSql;
    this.reportFailure = options.reportFailure;
    this.envelopeInterceptor = options.envelopeInterceptor;
    this.decorateSessionExecutor = options.decorateSessionExecutor;
    this.bound = options.bound ?? false;
  }

  from<T = unknown>(table: string): PgQuery<T> {
    return new PgQuery<T>(
      table,
      this.executor,
      this.reportFailure,
      this.envelopeInterceptor
    );
  }

  async rpc(
    fn: string,
    args: Record<string, unknown> = {}
  ): Promise<{ data: unknown; error: { message: string } | null }> {
    let sql: string | undefined;
    try {
      if (fn === "rate_limit_hit") {
        sql = `SELECT rate_limit_hit($1, $2) AS result`;
        const { rows } = await this.executor<{ result: number }>(sql, [
          args.p_bucket,
          args.p_window_start,
        ]);
        return { data: rows[0]?.result ?? 0, error: null };
      }
      if (fn === "reconcile_codebase_findings") {
        sql = `SELECT reconcile_codebase_findings($1, $2, $3, $4::jsonb) AS result`;
        const { rows } = await this.executor<{ result: Record<string, number> }>(sql, [
          args.p_team_id,
          args.p_codebase_id,
          args.p_metrics_id,
          JSON.stringify(args.p_health),
        ]);
        return { data: rows[0]?.result ?? {}, error: null };
      }
      if (fn === "decide_codebase_finding") {
        sql = `SELECT decide_codebase_finding($1, $2, $3, $4, $5, $6, $7, $8) AS result`;
        const { rows } = await this.executor<{
          result: { finding_id: string; status: string };
        }>(sql, [
          args.p_team_id,
          args.p_codebase_id,
          args.p_finding_id,
          args.p_actor_member_id,
          args.p_owner_member_id,
          args.p_decision_status,
          args.p_reason,
          args.p_expires_at,
        ]);
        return { data: rows[0]?.result ?? {}, error: null };
      }
      throw new Error(`pg-adapter: unsupported rpc "${fn}"`);
    } catch (err) {
      this.reportFailure?.(err, sql);
      const message = err instanceof Error ? err.message : "rpc failed";
      console.error(`[pg] rpc ${fn}: ${message}`);
      return { data: null, error: { message } };
    }
  }

  async transaction<T>(fn: (session: TransactionSession) => Promise<T>): Promise<T> {
    if (this.bound) throw new Error("transaction-session-already-bound");
    return runPgClientTransaction(
      {
        decorateExecutor: this.decorateSessionExecutor,
        makeBoundClient: (executor, reportFailure): DbClient =>
          new PgClient({
            executor,
            reportFailure,
            envelopeInterceptor: this.envelopeInterceptor,
            decorateSessionExecutor: this.decorateSessionExecutor,
            bound: true,
          }),
      },
      fn
    );
  }
}

let singleton: PgClient | undefined;

/** Shared stateless data client (the pg Pool underneath handles concurrency). */
export function pgClient(): PgClient {
  if (!singleton) singleton = new PgClient();
  return singleton;
}
