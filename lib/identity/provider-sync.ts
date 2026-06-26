import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildIdentityMap, resolveMember } from "@/lib/identity/resolve";
import { setMemberIdentity } from "@/lib/identity/member-identities";

/**
 * Best-effort reconcile a provider's users → roster members BY EMAIL, recording a `member_identities`
 * row keyed by the provider's stable user id — so that provider's content (Slack threads, Linear/Plane
 * issues, …) can be attributed to the right person. The one shared mapping used by every connector
 * (Slack/Linear/Plane). Non-force: never overrides a deliberate manual mapping. No-op when no emails
 * are available (the connector lacks the scope / endpoint) — admins then map manually.
 */

export interface ProviderUser {
  id: string;
  displayName?: string;
  email?: string;
}

export interface ProviderIdentitySyncResult {
  scanned: number; // users with an email considered
  mapped: number; // identities created/updated
  skipped: number; // email didn't resolve to a member, or a conflicting manual mapping exists
}

export async function syncProviderIdentities(
  admin: SupabaseClient,
  teamId: string,
  provider: string,
  users: ProviderUser[]
): Promise<ProviderIdentitySyncResult> {
  const res: ProviderIdentitySyncResult = { scanned: 0, mapped: 0, skipped: 0 };
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
      { provider, externalId: u.id, handle: u.displayName ?? "", email: u.email },
      { actor: { kind: "system" } }
    );
    if (r.conflict) res.skipped++;
    else res.mapped++;
  }
  return res;
}
