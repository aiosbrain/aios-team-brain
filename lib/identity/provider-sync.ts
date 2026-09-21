import "server-only";
import type { DbClient } from "@/lib/db/types";
import { buildIdentityMap, resolveMemberDetailed } from "@/lib/identity/resolve";
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

export interface ProviderIdentitySyncOptions {
  /**
   * Accept ONLY an exact roster or alias email match. The resolver's softer fallbacks — an email's local part
   * matched to a team actor_handle, and a bare handle — are guesses, and a wrong guess is a mis-credit. Off by
   * default so unrelated providers keep their behavior; Slack turns it on (AIO-1170 spec, AC-07).
   */
  exactEmailOnly?: boolean;
}

export async function syncProviderIdentities(
  admin: DbClient,
  teamId: string,
  provider: string,
  users: ProviderUser[],
  opts: ProviderIdentitySyncOptions = {}
): Promise<ProviderIdentitySyncResult> {
  const res: ProviderIdentitySyncResult = { scanned: 0, mapped: 0, skipped: 0 };
  const withEmail = users.filter((u) => u.id && u.email);
  if (withEmail.length === 0) return res;

  const map = await buildIdentityMap(admin, teamId);
  for (const u of withEmail) {
    res.scanned++;
    const resolved = resolveMemberDetailed(map, { email: u.email });
    const memberId = opts.exactEmailOnly && resolved.method !== "email" ? null : resolved.memberId;
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
