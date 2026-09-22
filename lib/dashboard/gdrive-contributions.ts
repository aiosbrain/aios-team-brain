import { providerIdentityState, resolveByProviderId, type IdentityMap } from "@/lib/identity/resolve";

export interface GoogleDriveContributionEvidence {
  id: string;
  itemId: string;
  memberId: string;
  provider: "gdrive";
  title: string;
  role: string;
  at: string;
  sourceUrl: string | null;
  sourceId: string | null;
}

interface ContributionRef {
  external_id?: unknown;
  email?: unknown;
  display_name?: unknown;
  role?: unknown;
  at?: unknown;
}

const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";

/**
 * Convert retained Google source observations into person/time/role evidence. This is intentionally
 * pure so replay, timezone and identity behavior stay testable independently of the Timeline query.
 * Display names are never identity keys; provider permission id wins, then exact confirmed email.
 */
export function googleDriveContributionEvidence(
  frontmatter: Record<string, unknown>,
  itemId: string,
  identities: IdentityMap,
  correction: { memberIdLocked?: boolean | null; memberId?: string | null } = {},
): GoogleDriveContributionEvidence[] {
  if (text(frontmatter.source).toLowerCase() !== "gdrive") return [];
  // A manual correction is the final attribution authority. `member_id_locked=true` with a null
  // member is an explicit "credit nobody" decision; a non-null lock deliberately collapses every
  // retained role/time observation to that person without discarding the distinct roles.
  if (correction.memberIdLocked && !correction.memberId) return [];
  const refs = Array.isArray(frontmatter.contributions)
    ? frontmatter.contributions as ContributionRef[]
    : [];
  const seen = new Set<string>();
  const rows: GoogleDriveContributionEvidence[] = [];
  for (const raw of refs) {
    if (!raw || typeof raw !== "object") continue;
    const externalId = text(raw.external_id);
    const email = text(raw.email).toLowerCase();
    const role = text(raw.role).toLowerCase();
    const parsedAt = new Date(text(raw.at));
    if (!role || !Number.isFinite(parsedAt.getTime())) continue;
    const at = parsedAt.toISOString(); // UTC grouping policy; equivalent offsets become instants.
    const hasMappingAuthority = externalId
      ? providerIdentityState(identities, "gdrive", externalId) !== null
      : false;
    const exactEmail = !hasMappingAuthority && email && !identities.ambiguousEmails?.has(email)
      ? identities.byEmail.get(email) ?? null
      : null;
    const resolvedMemberId =
      // Preserve the established `gdrive` provider namespace. The external id carries its kind
      // (`permission:<id>`), keeping Drive permission ids distinct from OAuth subjects.
      (externalId ? resolveByProviderId(identities, "gdrive", externalId) : null) ??
      exactEmail;
    const memberId = correction.memberIdLocked ? correction.memberId ?? null : resolvedMemberId;
    if (!memberId) continue;
    const identity = externalId || email;
    const id = `${itemId}:${identity}:${role}:${at}`;
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({
      id,
      itemId,
      memberId,
      provider: "gdrive",
      title: text(frontmatter.title) || "Google document",
      role,
      at,
      sourceUrl: text(frontmatter.source_url) || null,
      sourceId: text(frontmatter.source_id) || null,
    });
  }
  return rows;
}
