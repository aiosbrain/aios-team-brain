import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "./pool";

/**
 * Run `fn` inside a single Postgres transaction on a dedicated pooled client.
 * BEGIN → fn → COMMIT, with ROLLBACK on any throw. Used by the inbound PM-sync
 * apply/adopt paths (brain-api v1.4), whose loop-prevention invariant requires
 * `tasks.status` and the `task_pm_links` bookkeeping to move atomically.
 *
 * Postgres-backend only: the queries `fn` issues MUST run on the passed client
 * (raw SQL), not through the supabase-compat adapter (whose queries would use
 * other pooled connections outside this transaction).
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // the connection is being released anyway; the original error wins
    }
    throw err;
  } finally {
    client.release();
  }
}
