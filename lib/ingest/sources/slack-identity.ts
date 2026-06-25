import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";
import { setMemberIdentity } from "@/lib/identity/member-identities";

/**
 * Best-effort Slack → member reconciliation: for each Slack user whose email matches a roster
 * member (or a git-alias email), record a `member_identities` row keyed by the Slack user id, so
 * Slack content can be attributed to the right person. Needs the `users:read.email` scope to get
 * emails; without it this is a no-op and admins map identities manually. Non-force: never overrides
 * a deliberate manual mapping.
 */

export interface SlackUser {
  id: string;
  displayName: string;
  email?: string;
}

export interface SlackIdentitySyncResult {
  scanned: number; // users with an email considered
  mapped: number; // identities created/updated
  skipped: number; // email didn't resolve to a member, or a conflicting manual mapping exists
}

export async function syncSlackIdentities(
  admin: SupabaseClient,
  teamId: string,
  users: SlackUser[]
): Promise<SlackIdentitySyncResult> {
  const res: SlackIdentitySyncResult = { scanned: 0, mapped: 0, skipped: 0 };
  const withEmail = users.filter((u) => u.id && u.email);
  if (withEmail.length === 0) return res;

  const map = await buildIdentityMap(admin, teamId);
  for (const u of withEmail) {
    res.scanned++;
    const memberId = resolveMember(map, { email: u.email });
    if (!memberId) {
      res.skipped++;
      continue;
    }
    const r = await setMemberIdentity(
      admin,
      teamId,
      memberId,
      { provider: "slack", externalId: u.id, handle: u.displayName, email: u.email },
      { actor: { kind: "system" } }
    );
    if (r.conflict) res.skipped++;
    else res.mapped++;
  }
  return res;
}
