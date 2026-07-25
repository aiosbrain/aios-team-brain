/**
 * Tier-scoped Graphiti group_ids. Graphiti has NO tier awareness — `/search` returns everything
 * in a group_id — so we encode team + access tier into the group_id and only ever search the
 * groups a viewer's tier may see. This is the SOLE tier enforcement for the graph (no RLS
 * backstop), mirroring CLAUDE.md §5. Pure functions — unit-tested.
 */

export type AccessTier = "team" | "external";

/**
 * Graphiti's `validate_group_id` permits ONLY `[A-Za-z0-9_-]` — a `:` separator raises
 * GroupIdValidationError, which propagates out of the graph service's ingest worker (it catches
 * only CancelledError) and silently kills it for the whole process. So we join team + tier with
 * `_` (team slugs are `[a-z0-9-]`, never `_`, so this stays collision-free and reversible-by-eye)
 * and assert the result is valid — failing loud here beats a stalled worker. Verified live 2026-06-24.
 */
const VALID_GROUP_ID = /^[A-Za-z0-9_-]+$/;

/** The group_id an episode is written to, from the source row's team + access tier. */
export function episodeGroupId(teamSlug: string, access: AccessTier): string {
  const id = `${teamSlug}_${access}`;
  if (!VALID_GROUP_ID.test(id)) {
    throw new Error(`invalid Graphiti group_id "${id}" — team slug must match [A-Za-z0-9_-]`);
  }
  return id;
}

/**
 * Is this the EXTERNAL group? Used to make tier-cleanup side effects DIRECTION-AWARE: only a move OUT
 * of the external group can have leaked, so only that one justifies hard-purging the external caches
 * (purging on a widening would force a cold LLM re-synthesis for no isolation gain). The suffix test is
 * exact because a team slug is `[a-z0-9-]` and never contains `_` — see `episodeGroupId`. Pure.
 */
export function isExternalGroupId(groupId: string): boolean {
  return groupId.endsWith("_external");
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
