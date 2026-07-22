import "server-only";

/**
 * Tier-visibility choke-point for dashboard reads (CLAUDE.md §5). There is NO RLS, so this
 * app-code filter is the SOLE enforcement that an `external`-tier viewer never sees `team`/`admin`
 * content. Route every dashboard `items` read through here — the dashboard-tier-filter guard
 * enforces it.
 */

export type ViewerTier = "team" | "external";

/**
 * Fail-CLOSED tier check (audit #275 hardening). Only the `team` tier is unrestricted; EVERY other
 * value — `external` today, and any future/unknown tier the enum might grow (e.g. `admin`) or a bad
 * cast might smuggle in — is treated as restricted and gets the external-only filter. Use this at every
 * tier-scoped read that can't route through the query-builder choke-points above (raw-SQL builders,
 * API routes), instead of the fail-OPEN `tier === "external"` idiom (which leaves an unknown tier
 * unfiltered → leak). There is no RLS backstop, so this is sole enforcement.
 */
export function isRestrictedTier(tier: string): boolean {
  return tier !== "team";
}

/**
 * Restrict an items query to what `tier` may see: external → only `access='external'`.
 * `Q` is a free generic (no recursive constraint) so the supabase-js builder's deeply
 * recursive type doesn't trigger TS2589; the `.eq` shape is asserted by a localized cast.
 */
export function visibleItems<Q>(query: Q, tier: ViewerTier): Q {
  if (tier === "team") return query;
  return (query as { eq(column: string, value: string): Q }).eq("access", "external");
}

/** Whether a viewer of `tier` may see a single item of `access` (for by-id reads). */
export function canSeeAccess(tier: ViewerTier, access: string): boolean {
  return tier === "team" || access === "external";
}

/**
 * Restrict a `decisions` query to what `tier` may see: external → only `audience='external'`.
 * Decisions carry their tier in the `audience` column (not `access`); same SOLE-enforcement
 * rule as items on the postgres target (no RLS). Route dashboard decision reads through here.
 */
export function visibleDecisions<Q>(query: Q, tier: ViewerTier): Q {
  if (tier === "team") return query;
  return (query as { eq(column: string, value: string): Q }).eq("audience", "external");
}

/**
 * Restrict a `tasks` query to what `tier` may see: external → only `audience='external'`.
 * Tasks carry their tier in the `audience` column (inherited from the materializing item's
 * `access`); same SOLE-enforcement rule as items/decisions on the postgres target (no RLS).
 * Route every tier-scoped task read (retrieval, the v1 pull API, dashboard boxes) through here.
 */
export function visibleTasks<Q>(query: Q, tier: ViewerTier): Q {
  if (tier === "team") return query;
  return (query as { eq(column: string, value: string): Q }).eq("audience", "external");
}

/**
 * Restrict a Social Brain content query (`social_opportunities` / `content_plans` /
 * `content_variants`) to what `tier` may see: external → only `access='external'`. Every one of
 * these rows carries an `access` tier inherited from its source evidence (opportunity → plan →
 * variant), so the SAME sole-enforcement rule as items applies — a public-tier consumer must never
 * see team-sourced content. Route every tier-scoped Social read through here (no RLS backstop).
 */
export function visibleByAccess<Q>(query: Q, tier: ViewerTier): Q {
  if (tier === "team") return query;
  return (query as { eq(column: string, value: string): Q }).eq("access", "external");
}

/**
 * Role-scoped visibility for `query_log` reads (CLAUDE.md §5). `query_log` rows carry a
 * `member_id`; in postgres mode there is NO RLS, so this app-code filter is the SOLE thing
 * stopping a non-admin from reading the whole team's questions and `cost_usd`. Admins see the
 * team-wide log; everyone else (lead, member) sees only their own rows. Route every dashboard
 * `query_log` read through here — the query-log-visibility guard enforces it.
 *
 * `Q` is a free generic (no recursive constraint) so the supabase-js builder's deeply recursive
 * type doesn't trigger TS2589; the `.eq` shape is asserted by a localized cast.
 */
export interface QueryLogViewer {
  isAdmin: boolean;
  memberId: string;
}

export function scopeQueryLog<Q>(query: Q, viewer: QueryLogViewer): Q {
  if (viewer.isAdmin) return query;
  return (query as { eq(column: string, value: string): Q }).eq("member_id", viewer.memberId);
}
