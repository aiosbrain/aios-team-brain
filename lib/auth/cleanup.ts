import "server-only";
import { runSql } from "@/lib/db/pg/pool";

/**
 * Housekeeping for the two single-use/expiring auth tables. Both `auth_tokens` (magic-link /
 * invite tokens) and `oauth_states` (Slack-connect nonces) are write-once, ephemeral rows —
 * nothing ever reads a used or expired one again — so they're pure accumulation without this.
 * Deletes rows that are done being useful:
 *   - already consumed (`used_at is not null`), or
 *   - expired for at least 7 days (`expires_at < now() - interval '7 days'` — a short grace
 *     window past expiry in case an ops investigation needs a recently-expired row).
 *
 * Raw `runSql` (not the `DbClient` adapter) to match `lib/auth/pg-login.ts`, which this module is
 * the housekeeping counterpart to — no `DbClient` is threaded through either. Best-effort by
 * contract at the call sites (scheduler tick, `issueMagicToken`); this function itself still lets
 * a real DB error propagate so a caller that awaits it directly (e.g. a test) sees the failure.
 */

export interface PurgeResult {
  authTokens: number;
  oauthStates: number;
}

export async function purgeExpiredAuthRows(): Promise<PurgeResult> {
  const tokens = await runSql(
    `delete from auth_tokens where used_at is not null or expires_at < now() - interval '7 days'`,
    []
  );
  const states = await runSql(
    `delete from oauth_states where expires_at < now() - interval '7 days' or used_at is not null`,
    []
  );
  return { authTokens: tokens.rowCount, oauthStates: states.rowCount };
}
