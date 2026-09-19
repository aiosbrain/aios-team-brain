import "server-only";
import type { DbClient } from "@/lib/db/types";
import type { SlackCutoverDiscovery } from "@/lib/identity/slack-cutover-provenance";

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
  db: DbClient,
  teamId: string,
  opts: { strict?: boolean } = {}
): Promise<IdentityMap> {
  const { data, error: membersError } = await db
    .from("members")
    .select("id, email, actor_handle")
    .eq("team_id", teamId);
  if (opts.strict && membersError) throw new Error(`identity members read: ${membersError.message}`);
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
  const { data: aliases, error: aliasesError } = await db
    .from("member_emails")
    .select("email, member_id")
    .eq("team_id", teamId);
  if (opts.strict && aliasesError) throw new Error(`identity aliases read: ${aliasesError.message}`);
  for (const a of (aliases ?? []) as { email: string; member_id: string }[]) {
    if (a.email) byEmail.set(a.email.toLowerCase(), a.member_id);
  }

  // Cross-provider identities (Slack/Linear/… user ids). Keyed by (provider, external_id); any
  // email carried on the row is also folded into byEmail as a secondary exact match.
  const byProviderId = new Map<string, string>();
  const { data: identities, error: identitiesError } = await db
    .from("member_identities")
    .select("provider, external_id, email, member_id")
    .eq("team_id", teamId);
  if (opts.strict && identitiesError) throw new Error(`identity provider read: ${identitiesError.message}`);
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
 * Inactive Slack lookup for the coordinated identity/credit cutover. The caller must supply a
 * team-scoped snapshot of current member_identities rows, marking only live rows as live. Audit,
 * archived and quarantine records must not be supplied as live mappings. This pure helper cannot
 * certify the discovery adapter's historical completeness or the freshness of its DB snapshot.
 */
export interface SlackAccountMapping {
  teamId: string;
  provider: string;
  externalId: string;
  memberId: string;
  state: "live" | "archived" | "quarantined";
}

export interface SlackLegacyEvidenceReview {
  teamId: string;
  /** Reviewable evidence for the complete legacy disposition scan, including a zero-finding scan. */
  evidenceId: string;
  unresolvedOrQuarantined: readonly { userId: string; evidenceId: string }[];
}

export interface SlackAccountLookupInput {
  teamId: string;
  /** Qualified WORKSPACE:USER or legacy plain USER. */
  externalId: string;
  /** Supply only when this item's workspace was verified from source provenance. */
  verifiedItemWorkspaceId?: string;
  mappings: readonly SlackAccountMapping[];
  /** Required only for a plain ID without verified item workspace. */
  discovery?: SlackCutoverDiscovery;
  legacyEvidenceReview?: SlackLegacyEvidenceReview;
}

export type SlackAccountLookupStatus =
  | "resolved" | "invalid_input" | "no_mapping" | "conflicting_mapping"
  | "incomplete_provenance" | "conflicting_provenance" | "ambiguous_workspaces"
  | "unknown_account" | "unmapped_account" | "mismatched_member"
  | "unresolved_legacy_evidence";

export interface SlackAccountLookupResult {
  status: SlackAccountLookupStatus;
  memberId: string | null;
  accountId: string | null;
}

const slackIdPart = /^[A-Z0-9]+$/;
const evidenceId = /^[A-Za-z0-9_-]+$/;
const isEvidenceId = (value: unknown): value is string => typeof value === "string" && evidenceId.test(value);
const isPart = (value: unknown): value is string => typeof value === "string" && slackIdPart.test(value);
const blockedSlackLookup = (status: Exclude<SlackAccountLookupStatus, "resolved">): SlackAccountLookupResult =>
  ({ status, memberId: null, accountId: null });

/** Exact qualified lookup; legacy compatibility is admitted only by a complete, evidenced closed world. */
export function lookupSlackAccount(input: SlackAccountLookupInput): SlackAccountLookupResult {
  if (!isEvidenceId(input.teamId) || typeof input.externalId !== "string") return blockedSlackLookup("invalid_input");
  const parts = input.externalId.split(":");
  if (parts.length > 2 || parts.some((part) => !isPart(part)) ||
      (input.verifiedItemWorkspaceId !== undefined && !isPart(input.verifiedItemWorkspaceId))) {
    return blockedSlackLookup("invalid_input");
  }
  const userId = parts[parts.length - 1];
  const qualifiedWorkspace = parts.length === 2 ? parts[0] : null;
  if (qualifiedWorkspace && input.verifiedItemWorkspaceId && qualifiedWorkspace !== input.verifiedItemWorkspaceId) {
    return blockedSlackLookup("invalid_input");
  }

  // Case/provider variants are collision evidence, never aliases. Raw rows are never mapping
  // candidates, even when the old generic provider map could have resolved them.
  const live = input.mappings.filter((row) => row.state === "live" && row.teamId === input.teamId);
  const mappingFor = (accountId: string): { memberId: string | null; status: "no_mapping" | "conflicting_mapping" | "resolved" } => {
    const variants = live.filter((row) => row.provider.trim().toLowerCase() === "slack" &&
      row.externalId.trim().toUpperCase() === accountId);
    if (variants.length > 1 || variants.some((row) => row.provider !== "slack" || row.externalId !== accountId || !isEvidenceId(row.memberId))) {
      return { memberId: null, status: "conflicting_mapping" };
    }
    return variants.length === 1
      ? { memberId: variants[0].memberId, status: "resolved" }
      : { memberId: null, status: "no_mapping" };
  };
  const resolveExact = (accountId: string): SlackAccountLookupResult => {
    const mapping = mappingFor(accountId);
    return mapping.status === "resolved"
      ? { status: "resolved", memberId: mapping.memberId, accountId }
      : blockedSlackLookup(mapping.status);
  };

  if (qualifiedWorkspace || input.verifiedItemWorkspaceId) {
    return resolveExact(`${qualifiedWorkspace ?? input.verifiedItemWorkspaceId}:${userId}`);
  }

  const discovery = input.discovery;
  const census = discovery?.historicalSourceCensus;
  const review = input.legacyEvidenceReview;
  if (!census || !review || !isEvidenceId(census.evidenceId) || !isEvidenceId(review.evidenceId) ||
      census.teamId !== input.teamId || review.teamId !== input.teamId || census.sources.length === 0) {
    return blockedSlackLookup("incomplete_provenance");
  }
  const workspaces = new Set<string>();
  const sourceIds = new Map<string, string>();
  for (const source of census.sources) {
    if (!isEvidenceId(source.sourceId) || !isEvidenceId(source.evidenceId) || !isPart(source.workspaceId)) {
      return blockedSlackLookup("incomplete_provenance");
    }
    if (sourceIds.has(source.sourceId) && sourceIds.get(source.sourceId) !== source.workspaceId) {
      return blockedSlackLookup("conflicting_provenance");
    }
    sourceIds.set(source.sourceId, source.workspaceId);
    workspaces.add(source.workspaceId);
  }
  const inventories = new Map<string, Map<string, string | null>>();
  for (const inventory of discovery.workspaceAccountInventories) {
    if (inventory.teamId !== input.teamId || !isPart(inventory.workspaceId) || !isEvidenceId(inventory.evidenceId) ||
        !workspaces.has(inventory.workspaceId) || inventories.has(inventory.workspaceId)) {
      return blockedSlackLookup("conflicting_provenance");
    }
    const accounts = new Map<string, string | null>();
    for (const account of inventory.accounts) {
      if (!isPart(account.userId) || !isEvidenceId(account.evidenceId) ||
          (account.memberId !== null && !isEvidenceId(account.memberId)) || accounts.has(account.userId)) {
        return blockedSlackLookup("conflicting_provenance");
      }
      accounts.set(account.userId, account.memberId);
    }
    inventories.set(inventory.workspaceId, accounts);
  }
  if ([...workspaces].some((workspace) => !inventories.has(workspace))) {
    return blockedSlackLookup("incomplete_provenance");
  }
  if (review.unresolvedOrQuarantined.some((record) => !isPart(record.userId) || !isEvidenceId(record.evidenceId))) {
    return blockedSlackLookup("conflicting_provenance");
  }
  if (review.unresolvedOrQuarantined.some((record) => record.userId === userId) ||
      live.some((row) => row.provider.trim().toLowerCase() === "slack" && row.externalId.trim().toUpperCase() === userId)) {
    return blockedSlackLookup("unresolved_legacy_evidence");
  }

  const observed = [...inventories].filter(([, accounts]) => accounts.has(userId));
  if (observed.length > 1) return blockedSlackLookup("ambiguous_workspaces");
  if (observed.length === 0) return blockedSlackLookup("unknown_account");
  const [workspace, accounts] = observed[0];
  const observedMemberId = accounts.get(userId);
  if (observedMemberId === null) return blockedSlackLookup("unmapped_account");
  const accountId = `${workspace}:${userId}`;
  const mapping = mappingFor(accountId);
  if (mapping.status !== "resolved") return blockedSlackLookup(mapping.status);
  if (mapping.memberId !== observedMemberId) return blockedSlackLookup("mismatched_member");
  // An existing qualified row in an unenumerated workspace, or absent from an allegedly
  // complete inventory, disproves the closed world for every legacy ID. Check all live rows;
  // a row for another user cannot silently authorize this user's compatibility lookup.
  const seenAccounts = new Set<string>();
  for (const row of live) {
    if (row.provider.trim().toLowerCase() !== "slack" || !row.externalId.includes(":")) continue;
    const rowParts = row.externalId.split(":");
    const canonical = rowParts.length === 2 && row.provider === "slack" &&
      rowParts.every(isPart) && row.externalId === `${rowParts[0]}:${rowParts[1]}`;
    if (!canonical || seenAccounts.has(row.externalId) || !workspaces.has(rowParts[0]) ||
        !inventories.get(rowParts[0])?.has(rowParts[1]) ||
        inventories.get(rowParts[0])?.get(rowParts[1]) !== row.memberId) {
      return blockedSlackLookup("conflicting_provenance");
    }
    seenAccounts.add(row.externalId);
  }
  return { status: "resolved", memberId: mapping.memberId, accountId };
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
  const byEmail = map.byEmail.get(email) ?? (keyLc ? map.byEmail.get(keyLc) : undefined);
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
