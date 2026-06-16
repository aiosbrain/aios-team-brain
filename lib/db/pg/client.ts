import "server-only";
import { PgQuery } from "./query-builder";
import { runSql } from "./pool";

/**
 * Minimal Supabase-shaped data client backed by `pg`. Exposes `.from()` and the
 * `.rpc()` calls the app makes. It is cast to `SupabaseClient` at the factory
 * boundary (lib/supabase/*) so the ~34 existing call sites need no changes;
 * auth is handled separately by lib/auth (this client has no `.auth`).
 */
export class PgClient {
  from<T = unknown>(table: string): PgQuery<T> {
    return new PgQuery<T>(table);
  }

  async rpc(
    fn: string,
    args: Record<string, unknown> = {}
  ): Promise<{ data: unknown; error: { message: string } | null }> {
    try {
      if (fn === "rate_limit_hit") {
        const { rows } = await runSql<{ result: number }>(
          `SELECT rate_limit_hit($1, $2) AS result`,
          [args.p_bucket, args.p_window_start]
        );
        return { data: rows[0]?.result ?? 0, error: null };
      }
      throw new Error(`pg-adapter: unsupported rpc "${fn}"`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "rpc failed";
      console.error(`[pg] rpc ${fn}: ${message}`);
      return { data: null, error: { message } };
    }
  }
}

let singleton: PgClient | undefined;

/** Shared stateless data client (the pg Pool underneath handles concurrency). */
export function pgClient(): PgClient {
  if (!singleton) singleton = new PgClient();
  return singleton;
}
