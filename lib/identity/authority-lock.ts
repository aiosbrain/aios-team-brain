import "server-only";

import { runSql } from "@/lib/db/pg/pool";

/**
 * THE team identity-authority advisory boundary (`${teamId}:identity-authority`), transaction-scoped and
 * re-entrant. Its one implementation lives here, with no other dependency, so an owner that must take the
 * boundary first — the access writers' audience narrowing (AIO-1167 R93) — can do so without importing the
 * identity resolver graph. `lib/identity/authority` re-exports it; every existing caller is unchanged.
 */
export async function lockIdentityAuthority(teamId: string): Promise<void> {
  await runSql(`select pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `${teamId}:identity-authority`,
  ]);
}
