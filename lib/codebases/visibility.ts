import "server-only";
import type { ViewerTier } from "@/lib/auth/visibility";

/**
 * Tier gate for codebase analytics (CLAUDE.md §5). Codebase intel is team-tier only —
 * there is no per-row `access` column, so an `external`-tier viewer must see NOTHING.
 * In postgres mode there is no RLS, so this app-code check is the SOLE enforcement;
 * the codebases-tier-filter guard asserts every read helper routes through it.
 *
 * ViewerTier is owned by lib/auth/visibility (the canonical tier vocabulary); re-export
 * it so callers here have one source of truth.
 */

export type { ViewerTier };

/** Whether a viewer of this tier may see any codebase analytics at all. */
export function canSeeCodebases(tier: ViewerTier): boolean {
  return tier === "team";
}
