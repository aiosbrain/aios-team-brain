import type { AccessTier } from "./types";

/**
 * The evidence→tier-leak invariant (Social Brain, CLAUDE.md §5). An opportunity is generated FROM
 * brain knowledge (`items`), and its `access` decides how public any content derived from it can
 * become. The invariant: **an opportunity may be at most as public as its most-restrictive
 * evidence.** A `team`-tier evidence item therefore forbids an `external` (publicly visible)
 * opportunity — the exact shape of a leak (internal knowledge → public post). There is no RLS
 * backstop; this rule (enforced in lib/social/store.createOpportunity) is the sole guard.
 *
 * This module is the PURE decision so it is unit-testable; the store does the `items` lookup and
 * calls it. Fail-closed: an evidence id that resolves to no item is treated as restrictive, so a
 * leak can't be laundered through a bogus/dangling reference.
 */

export class TierLeakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TierLeakError";
  }
}

/** Publicness rank — `external` is more public (higher) than `team`. */
const RANK: Record<AccessTier, number> = { team: 1, external: 2 };

/**
 * Does `requested` access exceed what the evidence permits? `evidenceAccess` is the tier of each
 * resolved item-evidence row; `missing` is how many referenced item ids resolved to no row.
 * With no item evidence at all (empty + missing 0) nothing is constrained — a manual opportunity
 * not tied to internal items may be `external`.
 */
export function violatesEvidenceTier(
  requested: AccessTier,
  evidenceAccess: AccessTier[],
  missing: number
): boolean {
  return RANK[requested] > RANK[evidenceCeiling(evidenceAccess, missing)];
}

/**
 * The most-public tier an opportunity built from this evidence may hold. `team` if any evidence is
 * team-tier OR any referenced item is missing (fail-closed); `external` only when every cited item
 * resolved and is itself external. Callers that discover from multi-item sources (e.g. narrative
 * arcs, whose evidence spans several items of possibly-mixed tier) use this to pick a tier-SAFE
 * `access` up front, so `createOpportunity` never has to reject them for over-exposure.
 */
export function evidenceCeiling(evidenceAccess: AccessTier[], missing: number): AccessTier {
  const anyRestrictive = missing > 0 || evidenceAccess.some((a) => a === "team");
  return anyRestrictive ? "team" : "external";
}
