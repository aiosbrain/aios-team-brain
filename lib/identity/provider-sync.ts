import "server-only";
import type { DbClient } from "@/lib/db/types";
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

export interface ProviderIdentitySyncOptions {
  /**
   * Accept ONLY an exact match against the ROSTER — `members.email` and the `member_emails` aliases — and only when
   * exactly ONE member claims that email (AIO-1170 spec line 90, AC-07). Deliberately NOT the shared identity map:
   * that map also folds in the local-part → handle guess AND every provider identity row's email, so a guess made
   * for Plane or Linear (which writes `email: u.email` on its row) would come back as an "exact" Slack match, and it
   * keeps only the last writer when two members claim one email. Off by default so unrelated providers keep their
   * behavior; Slack turns it on.
   */
  exactEmailOnly?: boolean;
}

/** email → the distinct roster members that claim it (`members.email` and `member_emails` aliases only). */
async function rosterCandidatesByEmail(admin: DbClient, teamId: string): Promise<Map<string, Set<string>>> {
  const byEmail = new Map<string, Set<string>>();
  const add = (email: string | null | undefined, memberId: string): void => {
    const key = (email ?? "").trim().toLowerCase();
    if (!key) return;
    const claimants = byEmail.get(key) ?? new Set<string>();
    claimants.add(memberId);
    byEmail.set(key, claimants);
  };
  const { data: members, error: membersError } = await admin.from("members").select("id, email").eq("team_id", teamId);
  if (membersError) throw new Error(`identity roster read: ${membersError.message}`);
  for (const m of (members ?? []) as { id: string; email: string | null }[]) add(m.email, m.id);
  const { data: aliases, error: aliasesError } = await admin.from("member_emails").select("email, member_id").eq("team_id", teamId);
  if (aliasesError) throw new Error(`identity aliases read: ${aliasesError.message}`);
  for (const a of (aliases ?? []) as { email: string | null; member_id: string }[]) add(a.email, a.member_id);
  return byEmail;
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

  // Exact mode reads the roster strictly (a failed read aborts the sync rather than reading as "no candidates").
  const roster = opts.exactEmailOnly ? await rosterCandidatesByEmail(admin, teamId) : null;
  const map = roster ? null : await buildIdentityMap(admin, teamId);
  for (const u of withEmail) {
    res.scanned++;
    const claimants = roster?.get((u.email ?? "").trim().toLowerCase());
    const memberId = roster
      ? (claimants?.size === 1 ? [...claimants][0] : null)
      : resolveMember(map!, { email: u.email });
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
