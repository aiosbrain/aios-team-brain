/**
 * Tier-scoped Graphiti group_ids. Graphiti has NO tier awareness — `/search` returns everything
 * in a group_id — so we encode team + access tier into the group_id and only ever search the
 * groups a viewer's tier may see. This is the SOLE tier enforcement for the graph (no RLS
 * backstop), mirroring CLAUDE.md §5. Pure functions — unit-tested.
 */

export type AccessTier = "team" | "external";

/** The group_id an episode is written to, from the source row's team + access tier. */
export function episodeGroupId(teamSlug: string, access: AccessTier): string {
  return `${teamSlug}:${access}`;
}

/**
 * The group_ids a viewer of `tier` may search. An `external` viewer sees ONLY external content;
 * a `team` viewer sees both. Never widen this without re-checking the tier-isolation invariant.
 */
export function visibleGroupIds(teamSlug: string, viewerTier: AccessTier): string[] {
  return viewerTier === "team"
    ? [episodeGroupId(teamSlug, "team"), episodeGroupId(teamSlug, "external")]
    : [episodeGroupId(teamSlug, "external")];
}
