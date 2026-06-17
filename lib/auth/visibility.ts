import "server-only";

/**
 * Tier-visibility choke-point for dashboard reads (CLAUDE.md §5). In postgres mode there is
 * NO RLS, so this app-code filter is the SOLE enforcement that an `external`-tier viewer never
 * sees `team`/`admin` content; in supabase mode it's defense-in-depth alongside RLS. Route
 * every dashboard `items` read through here — the dashboard-tier-filter guard enforces it.
 */

export type ViewerTier = "team" | "external";

/**
 * Restrict an items query to what `tier` may see: external → only `access='external'`.
 * `Q` is a free generic (no recursive constraint) so the supabase-js builder's deeply
 * recursive type doesn't trigger TS2589; the `.eq` shape is asserted by a localized cast.
 */
export function visibleItems<Q>(query: Q, tier: ViewerTier): Q {
  if (tier !== "external") return query;
  return (query as { eq(column: string, value: string): Q }).eq("access", "external");
}

/** Whether a viewer of `tier` may see a single item of `access` (for by-id reads). */
export function canSeeAccess(tier: ViewerTier, access: string): boolean {
  return tier === "team" || access === "external";
}
