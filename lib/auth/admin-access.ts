import { isRestrictedTier } from "@/lib/auth/visibility";

/**
 * Gate for the whole `/admin` subtree (attribution health, audit log, usage/spend, DataBrowser,
 * pm-sync) and the Social surface. `members.role` and `members.tier` are INDEPENDENT columns with no
 * DB constraint coupling them, so `role='admin', tier='external'` is representable — and one
 * member-write mistake would otherwise hand a client/consultant collaborator the entire internal admin
 * surface. With no RLS backstop (CLAUDE.md §5), admin access must require BOTH an admin role AND an
 * unrestricted (`team`) tier, failing CLOSED on any other/unknown tier. Mirrors the
 * `/api/v1/attribution` route gate (`memberTier === "team" && memberRole === "admin"`).
 */
export function canAccessAdmin(member: {
  role?: string | null;
  tier?: string | null;
}): boolean {
  return member.role === "admin" && !isRestrictedTier(member.tier ?? "");
}
