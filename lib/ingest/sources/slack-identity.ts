import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { syncProviderIdentities, type ProviderIdentitySyncResult } from "@/lib/identity/provider-sync";

/**
 * Slack → member reconciliation: thin wrapper over the shared `syncProviderIdentities` (provider
 * "slack"). Maps each Slack user whose email matches a roster member to a `member_identities` row
 * keyed by the Slack user id, so Slack content attributes to the right person. Needs the
 * `users:read.email` scope for emails; without it this is a no-op and admins map identities manually.
 */

export interface SlackUser {
  id: string;
  displayName: string;
  email?: string;
}

export type SlackIdentitySyncResult = ProviderIdentitySyncResult;

export async function syncSlackIdentities(
  admin: SupabaseClient,
  teamId: string,
  users: SlackUser[]
): Promise<SlackIdentitySyncResult> {
  return syncProviderIdentities(admin, teamId, "slack", users);
}
