import { pgClient } from "@/lib/db/pg/client";
import type { DbClient } from "@/lib/db/types";

/**
 * Data client for server components and server actions — the Postgres adapter.
 * Access control is enforced in app code (there is no RLS); auth is handled
 * separately by lib/auth. Kept async so the many `await serverClient()` call
 * sites are unchanged.
 */
export async function serverClient(): Promise<DbClient> {
  return pgClient() as unknown as DbClient;
}
