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

// ── Per-project graph partitions (Phase C, spec §6) ──────────────────────────────────────────────
//
// Phase C replaces the tier suffix above with a PER-PROJECT partition: an episode is written to the
// graph of each project its item is tagged into, and a principal searches only the graphs of the
// projects the ORACLE says they can see (so the graph inherits the same partition model as the item
// store — the External group + project edges express what `_external` did). This module is the SINGLE
// AUTHORITY for that partition key; the projector (writer) and the read legs (arcs/retrieve) both go
// through it, so the scheme can never drift between who writes a partition and who searches it.
//
// ADDITIVE for now: `episodeGroupId`/`visibleGroupIds` above are UNCHANGED and still drive today's
// tier-scoped graph. The projector fan-out, the read-leg migration, and the one-time re-projection of
// the existing graph are LATER Phase C slices (each touches schema + LLM extraction cost, so each gets
// its own design doc). This slice just establishes the key scheme + the oracle→group-id mapping.

/**
 * The Graphiti group_id for one project's graph partition. Both ids are UUIDs; hyphens are STRIPPED —
 * not because a hyphen is invalid (`[A-Za-z0-9_-]` permits it) but to keep the id compact (`g_` + 32 +
 * `_p_` + 32 = 69 chars) and to sidestep Graphiti's group-id length limits the spec warns about (§6).
 * The `g_`/`_p_` separators use `_` for the same reason `episodeGroupId` does — a `:` kills the ingest
 * worker (validate_group_id gotcha, verified 2026-06-24). Fail LOUD on a malformed result (a non-UUID
 * id, or any char the strip didn't remove) rather than write an id the graph service will reject
 * mid-ingest. Pure.
 */
export function projectGroupId(teamId: string, projectId: string): string {
  const t = teamId.replace(/-/g, "");
  const p = projectId.replace(/-/g, "");
  const id = `g_${t}_p_${p}`;
  if (!VALID_GROUP_ID.test(id)) {
    throw new Error(`invalid per-project Graphiti group_id "${id}" — teamId/projectId must be UUIDs`);
  }
  return id;
}

/**
 * The per-project graph group_ids a principal may SEARCH: their oracle-visible project set mapped
 * through `projectGroupId`. The caller resolves the visible set from the SAME oracle the enforced
 * item reads use (`lib/access/oracle.visibleProjects`) and passes the project ids here — so the graph
 * read can never widen beyond the item read. Deduped; an EMPTY visible set → `[]` (searches nothing,
 * fail closed), never "search everything". Pure — no DB; the DB read is the caller's oracle call.
 */
export function graphGroupIdsForVisibleProjects(teamId: string, projectIds: Iterable<string>): string[] {
  return [...new Set(projectIds)].map((p) => projectGroupId(teamId, p));
}
