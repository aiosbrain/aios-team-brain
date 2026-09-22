import "server-only";
import type { DbClient } from "@/lib/db/types";

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
  /** Exact keys observed for more than one member. They fail closed instead of last-row-wins. */
  ambiguousEmails?: ReadonlySet<string>;
  ambiguousProviderIds?: ReadonlySet<string>;
  /** Durable mapping authority, including unlink tombstones. Presence blocks heuristic fallback. */
  providerIdentityStates?: ReadonlyMap<string, "linked" | "unlinked">;
  /** Active/invited human-or-connector rows participating in this complete snapshot. */
  activeMemberIds?: ReadonlySet<string>;
}

function providerKey(provider: string, externalId: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  // Google subject and permission ids are opaque identifiers, not human handles. Preserve their
  // exact bytes so differently-cased accounts cannot collapse into one attribution authority.
  const normalizedExternalId = normalizedProvider === "gdrive"
    ? externalId.trim()
    : externalId.trim().toLowerCase();
  return `${normalizedProvider}:${normalizedExternalId}`;
}

export interface AuthorIdentity {
  email?: string | null;
  /** the source's author key (may be an email or a bare handle) */
  key?: string | null;
}

/** Build lookup tables mapping author identity → member_id for the team. */
export async function buildIdentityMap(
  db: DbClient,
  teamId: string,
  opts: { strict?: boolean } = {},
): Promise<IdentityMap> {
  const { data, error: membersError } = await db
    .from("members")
    .select("id, email, actor_handle, status")
    .eq("team_id", teamId);
  if (opts.strict && membersError) throw new Error(`identity members read failed: ${membersError.message}`);
  const byEmail = new Map<string, string>();
  const byHandle = new Map<string, string>();
  const emailDomains = new Set<string>();
  const ambiguousEmails = new Set<string>();
  const activeMemberIds = new Set<string>();
  const assignUnique = (
    target: Map<string, string>, ambiguous: Set<string>, key: string, memberId: string,
  ) => {
    if (ambiguous.has(key)) return;
    const prior = target.get(key);
    if (prior && prior !== memberId) {
      target.delete(key);
      ambiguous.add(key);
      return;
    }
    target.set(key, memberId);
  };
  for (const r of (data ?? []) as {
    id: string;
    email: string | null;
    actor_handle: string | null;
    status?: string | null;
  }[]) {
    if (r.status === "disabled") continue;
    activeMemberIds.add(r.id);
    if (r.email) {
      const email = r.email.toLowerCase();
      assignUnique(byEmail, ambiguousEmails, email, r.id);
      const domain = email.split("@", 2)[1];
      if (domain) emailDomains.add(domain);
    }
    if (r.actor_handle) byHandle.set(r.actor_handle.toLowerCase(), r.id);
  }

  // Fold in explicit git-author aliases (e.g. GitHub noreply emails) as EXACT byEmail matches.
  // Deliberately NOT added to emailDomains — alias domains like users.noreply.github.com are
  // shared, so widening the handle heuristic with them would re-introduce cross-author
  // misattribution (the bug PR #11 closed).
  const { data: aliases, error: aliasesError } = await db
    .from("member_emails")
    .select("email, member_id")
    .eq("team_id", teamId);
  if (opts.strict && aliasesError) throw new Error(`identity aliases read failed: ${aliasesError.message}`);
  for (const a of (aliases ?? []) as { email: string; member_id: string }[]) {
    if (a.email && activeMemberIds.has(a.member_id)) {
      assignUnique(byEmail, ambiguousEmails, a.email.toLowerCase(), a.member_id);
    }
  }

  // Cross-provider identities (Slack/Linear/… user ids). Keyed by (provider, external_id); any
  // email carried on the row is also folded into byEmail as a secondary exact match.
  const byProviderId = new Map<string, string>();
  const ambiguousProviderIds = new Set<string>();
  const { data: identities, error: identitiesError } = await db
    .from("member_identities")
    .select("provider, external_id, email, member_id")
    .eq("team_id", teamId);
  if (opts.strict && identitiesError) throw new Error(`provider identities read failed: ${identitiesError.message}`);
  for (const i of (identities ?? []) as { provider: string; external_id: string; email: string | null; member_id: string }[]) {
    if (!activeMemberIds.has(i.member_id)) continue;
    if (i.provider && i.external_id) {
      assignUnique(byProviderId, ambiguousProviderIds, providerKey(i.provider, i.external_id), i.member_id);
    }
    if (i.email) assignUnique(byEmail, ambiguousEmails, i.email.toLowerCase(), i.member_id);
  }

  const providerIdentityStates = new Map<string, "linked" | "unlinked">();
  const { data: mappingStates, error: mappingStatesError } = await db
    .from("member_identity_mapping_state")
    .select("provider, external_id, state")
    .eq("team_id", teamId);
  if (opts.strict && mappingStatesError) {
    throw new Error(`provider identity authority read failed: ${mappingStatesError.message}`);
  }
  for (const state of (mappingStates ?? []) as {
    provider: string;
    external_id: string;
    state: "linked" | "unlinked";
  }[]) {
    if (state.provider && state.external_id && (state.state === "linked" || state.state === "unlinked")) {
      providerIdentityStates.set(providerKey(state.provider, state.external_id), state.state);
    }
  }

  return {
    byEmail, byHandle, emailDomains, byProviderId, ambiguousEmails, ambiguousProviderIds,
    providerIdentityStates, activeMemberIds,
  };
}

/** Resolve a provider's stable user id (e.g. a Slack `Uxxx`) to a roster member_id, or null. */
export function resolveByProviderId(map: IdentityMap, provider: string, externalId: string): string | null {
  if (!externalId) return null;
  const key = providerKey(provider, externalId);
  if (map.ambiguousProviderIds?.has(key)) return null;
  return map.byProviderId.get(key) ?? null;
}

export function providerIdentityState(
  map: IdentityMap,
  provider: string,
  externalId: string,
): "linked" | "unlinked" | null {
  if (!externalId) return null;
  return map.providerIdentityStates?.get(providerKey(provider, externalId)) ?? null;
}

/** How an identity resolved — the attribution CONFIDENCE. `email`/`handle` are exact matches;
 *  `heuristic` is the softer email-local-part → team-handle guess; `unresolved` is no match. */
export type ResolveMethod = "email" | "handle" | "heuristic" | "unresolved";

/**
 * Resolve one author identity to a roster member_id AND report HOW it matched (the confidence the
 * attribution-health layer surfaces). Precedence — exact email match first; only derive a handle from
 * an email local-part when that email's domain is already in the roster (otherwise external
 * contributors like alex@gmail.com could be misattributed to an internal actor_handle "alex"); then an
 * explicit non-email handle key. `resolveMember` delegates here, so the resolution logic lives once.
 */
export function resolveMemberDetailed(
  map: IdentityMap,
  identity: AuthorIdentity
): { memberId: string | null; method: ResolveMethod } {
  const email = (identity.email ?? "").trim().toLowerCase();
  const keyLc = (identity.key ?? "").trim().toLowerCase();
  const [localPart, domain] = email.includes("@") ? email.split("@", 2) : ["", ""];
  const byEmail = !map.ambiguousEmails?.has(email)
    ? map.byEmail.get(email) ?? (
      keyLc && !map.ambiguousEmails?.has(keyLc) ? map.byEmail.get(keyLc) : undefined
    )
    : undefined;
  if (byEmail) return { memberId: byEmail, method: "email" };
  if (localPart && domain && map.emailDomains.has(domain)) {
    const h = map.byHandle.get(localPart);
    if (h) return { memberId: h, method: "heuristic" };
  }
  if (keyLc && !keyLc.includes("@")) {
    const h = map.byHandle.get(keyLc);
    if (h) return { memberId: h, method: "handle" };
  }
  return { memberId: null, method: "unresolved" };
}

/** Resolve one author identity to a roster member_id, or null. Thin wrapper over
 *  `resolveMemberDetailed` — same precedence, result unchanged. */
export function resolveMember(map: IdentityMap, identity: AuthorIdentity): string | null {
  return resolveMemberDetailed(map, identity).memberId;
}
