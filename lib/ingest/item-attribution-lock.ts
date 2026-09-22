import "server-only";

import { runSql } from "@/lib/db/pg/pool";

/**
 * Canonical serialization point for every writer that can change item attribution or any
 * attribution-derived ledger. Callers must acquire broader team/mapping authority locks first, then
 * this advisory lock, then the item row lock. Keeping the key and ordering in one owner prevents an
 * ingest, correction and repair from each implementing a subtly different boundary.
 */
export async function lockItemAttribution(teamId: string, itemId: string): Promise<void> {
  await runSql(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `${teamId}:item:${itemId}`,
  ]);
}
