import "server-only";
import { pgClient } from "@/lib/db/pg/client";
import type { DbClient } from "@/lib/db/types";

/**
 * Service-role data client — the Postgres adapter. There is no RLS, so access
 * control lives entirely in app code. ONLY for the machine-auth sync path
 * (lib/ingest, /api/v1/*) and seed scripts. Never import from client code; the
 * "server-only" guard makes that a build error.
 */
export function adminClient(): DbClient {
  return pgClient() as unknown as DbClient;
}
