import "server-only";
import type { DbClient } from "@/lib/db/types";
import { buildIdentityMap } from "@/lib/identity/resolve";
import { setMemberIdentity } from "@/lib/identity/member-identities";
import type { IdentityMap } from "@/lib/identity/resolve";
import { withIdentityMutationBoundary } from "@/lib/identity/authority";

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

/** Provider-verified account linking is deliberately stricter than general author resolution.
 * Only an exact roster/alias address may create a durable mapping; display names, handles and the
 * legacy same-domain local-part heuristic are not Google login evidence. */
export function resolveConfirmedEmail(map: IdentityMap, email: string | null | undefined): string | null {
  const normalized = (email ?? "").trim().toLowerCase();
  if (!normalized || map.ambiguousEmails?.has(normalized)) return null;
  return map.byEmail.get(normalized) ?? null;
}

export async function syncProviderIdentities(
  admin: DbClient,
  teamId: string,
  provider: string,
  users: ProviderUser[]
): Promise<ProviderIdentitySyncResult> {
  const withEmail = users.filter((u) => u.id && u.email);
  if (withEmail.length === 0) return { scanned: 0, mapped: 0, skipped: 0 };

  return withIdentityMutationBoundary(teamId, async () => {
    // Hold the team-wide writer lock from the complete supporting read through the final mapping
    // mutation. This makes the bounded provider batch one coherent identity snapshot: a concurrent
    // alias/roster/manual-map writer cannot invalidate the email decision between read and insert.
    const map = await buildIdentityMap(admin, teamId, { strict: true });
    const res: ProviderIdentitySyncResult = { scanned: 0, mapped: 0, skipped: 0 };
    for (const u of withEmail) {
      res.scanned++;
      const memberId = resolveConfirmedEmail(map, u.email);
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
  });
}
