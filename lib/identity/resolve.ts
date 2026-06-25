import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Shared identity resolution: git/provider author identity → roster `member_id` for a team.
 * Extracted from lib/codebases/ingest.ts so codebase contributions AND per-member cost
 * attribution (lib/metrics/members.ts, lib/costs/*) resolve identities the SAME way — one
 * resolver, not two drifting copies. Uses the `member_emails` alias table for explicit
 * git-author aliases (e.g. GitHub noreply emails).
 */

export interface IdentityMap {
  /** lower-cased email (roster + aliases) → member_id, exact matches only */
  byEmail: Map<string, string>;
  /** lower-cased actor_handle → member_id */
  byHandle: Map<string, string>;
  /** email domains present in the roster (gates the local-part → handle heuristic) */
  emailDomains: Set<string>;
  /** `<provider>:<external_id_lc>` → member_id, from member_identities (Slack/Linear/… user ids) */
  byProviderId: Map<string, string>;
}

function providerKey(provider: string, externalId: string): string {
  return `${provider.trim().toLowerCase()}:${externalId.trim().toLowerCase()}`;
}

export interface AuthorIdentity {
  email?: string | null;
  /** the source's author key (may be an email or a bare handle) */
  key?: string | null;
}

/** Build lookup tables mapping author identity → member_id for the team. */
export async function buildIdentityMap(
  supabase: SupabaseClient,
  teamId: string
): Promise<IdentityMap> {
  const { data } = await supabase
    .from("members")
    .select("id, email, actor_handle")
    .eq("team_id", teamId);
  const byEmail = new Map<string, string>();
  const byHandle = new Map<string, string>();
  const emailDomains = new Set<string>();
  for (const r of (data ?? []) as {
    id: string;
    email: string | null;
    actor_handle: string | null;
  }[]) {
    if (r.email) {
      const email = r.email.toLowerCase();
      byEmail.set(email, r.id);
      const domain = email.split("@", 2)[1];
      if (domain) emailDomains.add(domain);
    }
    if (r.actor_handle) byHandle.set(r.actor_handle.toLowerCase(), r.id);
  }

  // Fold in explicit git-author aliases (e.g. GitHub noreply emails) as EXACT byEmail matches.
  // Deliberately NOT added to emailDomains — alias domains like users.noreply.github.com are
  // shared, so widening the handle heuristic with them would re-introduce cross-author
  // misattribution (the bug PR #11 closed).
  const { data: aliases } = await supabase
    .from("member_emails")
    .select("email, member_id")
    .eq("team_id", teamId);
  for (const a of (aliases ?? []) as { email: string; member_id: string }[]) {
    if (a.email) byEmail.set(a.email.toLowerCase(), a.member_id);
  }

  // Cross-provider identities (Slack/Linear/… user ids). Keyed by (provider, external_id); any
  // email carried on the row is also folded into byEmail as a secondary exact match.
  const byProviderId = new Map<string, string>();
  const { data: identities } = await supabase
    .from("member_identities")
    .select("provider, external_id, email, member_id")
    .eq("team_id", teamId);
  for (const i of (identities ?? []) as { provider: string; external_id: string; email: string | null; member_id: string }[]) {
    if (i.provider && i.external_id) byProviderId.set(providerKey(i.provider, i.external_id), i.member_id);
    if (i.email) byEmail.set(i.email.toLowerCase(), i.member_id);
  }

  return { byEmail, byHandle, emailDomains, byProviderId };
}

/** Resolve a provider's stable user id (e.g. a Slack `Uxxx`) to a roster member_id, or null. */
export function resolveByProviderId(map: IdentityMap, provider: string, externalId: string): string | null {
  if (!externalId) return null;
  return map.byProviderId.get(providerKey(provider, externalId)) ?? null;
}

/**
 * Resolve one author identity to a roster member_id, or null. Exact email match first; only
 * derive a handle from an email local-part when that email's domain is already in the roster
 * (otherwise external contributors like alex@gmail.com could be misattributed to an internal
 * actor_handle "alex"); then an explicit non-email handle key.
 */
export function resolveMember(map: IdentityMap, identity: AuthorIdentity): string | null {
  const email = (identity.email ?? "").trim().toLowerCase();
  const keyLc = (identity.key ?? "").trim().toLowerCase();
  const [localPart, domain] = email.includes("@") ? email.split("@", 2) : ["", ""];
  const handleFromTeamDomain =
    localPart && domain && map.emailDomains.has(domain) ? map.byHandle.get(localPart) : undefined;
  const explicitHandle = keyLc && !keyLc.includes("@") ? map.byHandle.get(keyLc) : undefined;
  return (
    map.byEmail.get(email) ??
    map.byEmail.get(keyLc) ??
    handleFromTeamDomain ??
    explicitHandle ??
    null
  );
}

/** Convenience: build the map once and resolve a batch of identities to member_ids. */
export async function resolveMembers(
  supabase: SupabaseClient,
  teamId: string,
  identities: AuthorIdentity[]
): Promise<(string | null)[]> {
  const map = await buildIdentityMap(supabase, teamId);
  return identities.map((id) => resolveMember(map, id));
}
