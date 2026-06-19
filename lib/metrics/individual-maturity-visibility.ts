import "server-only";
import type { ViewerTier } from "@/lib/auth/visibility";

/**
 * Tier gate for agentic-maturity analytics (CLAUDE.md §5). Maturity intel is
 * team-tier only — there is no per-row `access` column, so an `external`-tier
 * viewer must see NOTHING. In postgres mode there is no RLS, so this app-code
 * check is the SOLE enforcement; the maturity-tier-filter guard asserts every
 * read helper in lib/metrics/maturity.ts routes through it.
 */

export type { ViewerTier };

/** Whether a viewer of this tier may see any agentic-maturity analytics. */
export function canSeeMaturity(tier: ViewerTier): boolean {
  return tier === "team";
}
