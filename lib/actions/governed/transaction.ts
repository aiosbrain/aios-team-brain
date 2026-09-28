import "server-only";
import type { PoolClient } from "pg";
import { getPool } from "@/lib/db/pg/pool";
import { GovernedError } from "./errors";
const active = new WeakMap<PoolClient, object>();
export const MAX_TRANSACTION_MS = 15_000;
export function assertTransactionActive(client: PoolClient): void {
  if (!active.has(client)) throw new GovernedError("unavailable", 503);
}
/** Capture this checkout generation, never merely the reusable PoolClient. */
export function transactionGuard(client: PoolClient): () => void {
  const generation = active.get(client);
  return () => {
    if (!generation || active.get(client) !== generation)
      throw new GovernedError("unavailable", 503);
  };
}
/**
 * A wall-clock deadline, including idle callback time. Expiry destroys (never
 * returns) the connection, so PostgreSQL rolls back its claim and effects. The
 * bound context is invalidated first; a late callback cannot use a recycled
 * connection. SQL/lock timeouts are additional, independent bounds.
 */
export async function governedTransaction<T>(
  fn: (c: PoolClient) => Promise<T>,
  timeoutMs = MAX_TRANSACTION_MS,
): Promise<T> {
  let client: PoolClient | undefined;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onClientError: (() => void) | undefined;
  try {
    client = await getPool().connect();
    const c = client;
    active.set(c, {});
    const connectionFailed = new Promise<never>((_, reject) => {
      onClientError = () => {
        active.delete(c);
        if (!released) {
          released = true;
          c.release(true);
        }
        reject(new GovernedError("unavailable", 503));
      };
      // A server-terminated checked-out connection emits error even while the
      // callback is idle. Handle it here rather than crashing the process.
      c.on("error", onClientError);
    });
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        active.delete(c);
        released = true;
        c.release(true);
        reject(new GovernedError("unavailable", 503));
      }, timeoutMs);
    });
    const work = (async () => {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout='1500ms'");
      await c.query("SET LOCAL statement_timeout='15000ms'");
      const result = await fn(c);
      assertTransactionActive(c);
      await c.query("COMMIT");
      return result;
    })();
    return await Promise.race([work, expired, connectionFailed]);
  } catch (error) {
    if (client && !released) {
      active.delete(client);
      try {
        await client.query("ROLLBACK");
      } catch {
        if (!released) {
          released = true;
          client.release(true);
        }
      }
    }
    if (error instanceof GovernedError) throw error;
    throw new GovernedError("unavailable", 503);
  } finally {
    if (timer) clearTimeout(timer);
    if (client) {
      if (onClientError) client.removeListener("error", onClientError);
      active.delete(client);
      if (!released) client.release();
    }
  }
}
